import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeOllamaDriver } from "./ollamaDriver";
import type { OllamaFetch } from "./ollamaEndpoint";
import { MemoryOllamaHistoryStore } from "./ollamaHistoryStore";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("90000000-0000-4000-8000-000000000711");
const sessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000712");
const modelId = "qwen3:latest" as ProviderModelId;
const root = "/tmp/octant-ollama";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ndjson(values: readonly unknown[]) {
  return new Response(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function driver(fetch: OllamaFetch, historyStore = new MemoryOllamaHistoryStore()) {
  const registry = new ProviderRuntimeRegistry();
  return {
    registry,
    driver: makeOllamaDriver({
      instanceId,
      configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
      runtimeRegistry: registry,
      fetch,
      historyStore,
      clock: () => "2026-07-18T09:00:00.000Z",
      correlationId: () => "90000000-0000-4000-8000-000000000713",
    }),
  };
}

async function terminal(events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>) {
  const items = await Effect.runPromise(
    Stream.runCollect(
      events.pipe(
        Stream.filter((event) => event.sessionId === sessionId),
        Stream.takeUntil((event) => ["completed", "interrupted", "failed"].includes(event.kind)),
      ),
    ),
  );
  return Array.from(items) as ProviderRuntimeEvent[];
}

describe("Ollama provider driver", () => {
  it("probes the native API without a prompt and records per-model capability truth", async () => {
    const fetch = vi.fn<OllamaFetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/version")) return json({ version: "0.31.2" });
      if (url.endsWith("/tags")) {
        return json({
          models: [{ model: "nomic-embed-text:latest" }, { model: "qwen3:latest" }],
        });
      }
      if (url.endsWith("/show")) {
        if (JSON.parse(String(init?.body)).model === "nomic-embed-text:latest") {
          return json({ capabilities: ["embedding"] });
        }
        return json({
          capabilities: ["completion", "thinking", "tools"],
          model_info: { "qwen3.context_length": 131072 },
        });
      }
      throw new Error("prompt endpoint must not be called");
    });
    const fixture = driver(fetch);
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe).toMatchObject({
      readiness: "ready",
      processState: "stopped",
      detectedVersion: "0.31.2",
      models: [{ id: modelId, reasoning: "supported", contextLimit: 131072 }],
      capabilities: {
        streaming: "unavailable",
        reasoning: "unavailable",
        usage: "unavailable",
        toolActivity: "unavailable",
      },
    });
    expect(fixture.registry.observedState(instanceId)).toEqual(probe);
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/chat"))).toBe(false);
  });

  it("streams normalized events and resumes exact Octant-owned bounded history", async () => {
    const requestBodies: unknown[] = [];
    const fetch = vi.fn<OllamaFetch>(async (input, init) => {
      if (!String(input).endsWith("/chat")) throw new Error("unexpected probe");
      requestBodies.push(JSON.parse(String(init?.body)));
      return ndjson([
        {
          model: "qwen3:latest",
          message: { role: "assistant", thinking: "think", content: "hello" },
          done: false,
        },
        {
          model: "qwen3:latest",
          message: { role: "assistant", content: " world" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 4,
          eval_count: 2,
        },
      ]);
    });
    const historyStore = new MemoryOllamaHistoryStore();
    const fixture = driver(fetch, historyStore);
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      fixture.driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const handle = await Effect.runPromise(
      connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    expect(handle.resumeCursor).toEqual({ driverKind: "ollama", value: sessionId });
    const first = terminal(connection.events);
    await Effect.runPromise(
      connection.send({ sessionId, prompt: "first", attachments: [], tools: [] }),
    );
    expect((await first).map((event) => event.kind)).toEqual([
      "reasoning-delta",
      "text-delta",
      "text-delta",
      "usage",
      "completed",
    ]);
    await Effect.runPromise(connection.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));

    const restarted = driver(fetch, historyStore);
    const restartedScope = await Effect.runPromise(Scope.make());
    const restartedConnection = await Effect.runPromise(
      restarted.driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, restartedScope)),
    );
    await Effect.runPromise(
      restartedConnection.resume({
        sessionId,
        resumeCursor: handle.resumeCursor!,
        executionPolicy: "plan",
      }),
    );
    const second = terminal(restartedConnection.events);
    await Effect.runPromise(
      restartedConnection.send({ sessionId, prompt: "second", attachments: [], tools: [] }),
    );
    await second;
    expect(requestBodies[1]).toMatchObject({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "hello world" },
        { role: "user", content: "second" },
      ],
    });
    await Effect.runPromise(restartedConnection.stop(sessionId));
    await Effect.runPromise(Scope.close(restartedScope, Exit.void));
    expect(fixture.registry.activeSessionCount(instanceId)).toBe(0);
    expect(restarted.registry.activeSessionCount(instanceId)).toBe(0);
  });

  it("fails the turn after normalizing a tool request that Octant cannot execute yet", async () => {
    const fetch = vi.fn<OllamaFetch>(async () =>
      ndjson([
        {
          model: "qwen3:latest",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "read_file", arguments: {} } }],
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 2,
          eval_count: 1,
        },
      ]),
    );
    const fixture = driver(fetch);
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      fixture.driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await Effect.runPromise(
      connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const events = terminal(connection.events);
    await Effect.runPromise(
      connection.send({ sessionId, prompt: "use a tool", attachments: [], tools: [] }),
    );
    expect((await events).map((event) => event.kind)).toEqual([
      "tool-start",
      "tool-failure",
      "usage",
      "failed",
    ]);
    await Effect.runPromise(connection.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("interrupts only the owned HTTP request and rejects stale or mismatched resume", async () => {
    const fetch = vi.fn<OllamaFetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    );
    const fixture = driver(fetch);
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      fixture.driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await expect(
      Effect.runPromise(
        connection.resume({
          sessionId,
          resumeCursor: { driverKind: "ollama", value: "unknown" },
          executionPolicy: "plan",
        }),
      ),
    ).rejects.toThrow(/stale-resume/);
    await Effect.runPromise(connection.start({ sessionId, modelId, executionPolicy: "plan" }));
    const collected = terminal(connection.events);
    await Effect.runPromise(
      connection.send({ sessionId, prompt: "wait", attachments: [], tools: [] }),
    );
    await Effect.runPromise(connection.interrupt(sessionId));
    expect((await collected).map((event) => event.kind)).toEqual(["interrupted"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
