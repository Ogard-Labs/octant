import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import { MemoryNativeHarnessTranscriptStore } from "../harness/nativeHarnessTranscriptStore";
import { makeOllamaDriver } from "./ollamaDriver";
import type { OllamaFetch } from "./ollamaEndpoint";
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

function reply(message: Record<string, unknown>) {
  return ndjson([
    {
      model: "qwen3:latest",
      message: { role: "assistant", ...message },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 1,
    },
  ]);
}

function driver(fetch: OllamaFetch, transcripts = new MemoryNativeHarnessTranscriptStore()) {
  const registry = new ProviderRuntimeRegistry();
  return {
    registry,
    driver: runOnNativeHarness(
      makeOllamaDriver({
        instanceId,
        configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
        runtimeRegistry: registry,
        fetch,
        clock: () => "2026-07-18T09:00:00.000Z",
      }),
      {
        instanceId,
        runtimeRegistry: registry,
        transcripts,
        clock: () => "2026-07-18T09:00:00.000Z",
        correlationId: () => "90000000-0000-4000-8000-000000000713",
      },
    ),
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

/** A local service with one model that reports the given capabilities. */
function service(capabilities: readonly string[], chat: (body: unknown) => Response) {
  return vi.fn<OllamaFetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/version")) return json({ version: "0.31.2" });
    if (url.endsWith("/tags")) return json({ models: [{ model: "qwen3:latest" }] });
    if (url.endsWith("/show")) return json({ capabilities });
    return chat(JSON.parse(String(init?.body)));
  });
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
        toolActivity: "unsupported",
        appManagedTools: "unsupported",
      },
    });
    expect(fixture.registry.observedState(instanceId)).toEqual(probe);
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/chat"))).toBe(false);
  });

  it("streams normalized events and resumes the conversation the harness journaled", async () => {
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
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const fixture = driver(fetch, transcripts);
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
    const first = terminal(Stream.unwrapScoped(connection.subscribe));
    await Effect.runPromise(
      connection.send({ sessionId, prompt: "first", attachments: [], tools: [] }),
    );
    const kinds = (await first).map((event) => event.kind);
    expect(kinds.filter((kind) => kind !== "usage")).toEqual([
      "reasoning-delta",
      "text-delta",
      "text-delta",
      "completed",
    ]);
    expect(kinds).toContain("usage");
    await Effect.runPromise(connection.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));

    const restarted = driver(fetch, transcripts);
    const restartedScope = await Effect.runPromise(Scope.make());
    const restartedConnection = await Effect.runPromise(
      restarted.driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, restartedScope)),
    );
    if (handle.resumeCursor === undefined) throw new Error("The session returned no cursor.");
    await Effect.runPromise(
      restartedConnection.resume({
        sessionId,
        resumeCursor: handle.resumeCursor,
        executionPolicy: "plan",
      }),
    );
    const second = terminal(Stream.unwrapScoped(restartedConnection.subscribe));
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

  it("sends a turn's image attachment with that turn only", async () => {
    const requestBodies: Array<{ readonly messages: ReadonlyArray<Record<string, unknown>> }> = [];
    const fetch = service(["completion", "vision"], (body) => {
      requestBodies.push(body as (typeof requestBodies)[number]);
      return reply({ content: "seen" });
    });
    const fixture = driver(fetch);
    await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      fixture.driver
        .acquire({ instanceId, projectRoot: root, mode: "chat" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await Effect.runPromise(
      connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    for (const turn of [
      {
        prompt: "describe",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "diagram.png",
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      },
      { prompt: "again", attachments: [] },
    ]) {
      const events = terminal(Stream.unwrapScoped(connection.subscribe));
      await Effect.runPromise(connection.send({ sessionId, ...turn, tools: [] }));
      expect((await events).at(-1)?.kind).toBe("completed");
    }
    const userMessages = (index: number) =>
      requestBodies[index]?.messages.filter((message) => message.role === "user");
    expect(userMessages(0)).toEqual([{ role: "user", content: "describe", images: ["AQID"] }]);
    expect(userMessages(1)).toEqual([
      { role: "user", content: "describe" },
      { role: "user", content: "again" },
    ]);
    await Effect.runPromise(connection.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("sends a vision turn whose photo is larger than the model's window counted as text", async () => {
    const fetch = vi.fn<OllamaFetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/version")) return json({ version: "0.31.2" });
      if (url.endsWith("/tags")) return json({ models: [{ model: "qwen3:latest" }] });
      if (url.endsWith("/show")) {
        return json({
          capabilities: ["completion", "vision"],
          model_info: { "qwen3.context_length": 131072 },
        });
      }
      JSON.parse(String(init?.body));
      return reply({ content: "seen" });
    });
    const fixture = driver(fetch);
    await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      fixture.driver
        .acquire({ instanceId, projectRoot: root, mode: "chat" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await Effect.runPromise(
      connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const events = terminal(Stream.unwrapScoped(connection.subscribe));
    // Ollama reads the photo as an image embedding; counting its bytes as
    // text tokens read as over a million and refused the turn.
    await Effect.runPromise(
      connection.send({
        sessionId,
        prompt: "describe",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "photo.png",
            mediaType: "image/png",
            bytes: new Uint8Array(300_000).fill(200),
          },
        ],
        tools: [],
      }),
    );
    expect((await events).at(-1)?.kind).toBe("completed");
    await Effect.runPromise(connection.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("never declares usage unsupported because one response carried no counts", async () => {
    const replies = [
      { prompt_eval_count: 4, eval_count: 2 },
      // A response without counts says nothing about the next one; reading it
      // as "never reports" would leave every unreported turn of this endpoint
      // out of a spend ceiling.
      {},
    ];
    const fetch = vi.fn<OllamaFetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/version")) return json({ version: "0.31.2" });
      if (url.endsWith("/tags")) return json({ models: [{ model: "qwen3:latest" }] });
      if (url.endsWith("/show")) return json({ capabilities: ["completion"] });
      return ndjson([
        {
          model: "qwen3:latest",
          message: { role: "assistant", content: "hello" },
          done: true,
          done_reason: "stop",
          ...replies.shift(),
        },
      ]);
    });
    const fixture = driver(fetch);
    await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      fixture.driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    // One session per reply, so each turn reaches its own terminal event.
    for (const turn of [
      { id: sessionId, prompt: "counted" },
      { id: decodeProviderSessionId("90000000-0000-4000-8000-000000000714"), prompt: "uncounted" },
    ]) {
      await Effect.runPromise(
        connection.start({ sessionId: turn.id, modelId, executionPolicy: "approval-gated" }),
      );
      const events = Effect.runPromise(
        Stream.runCollect(
          Stream.unwrapScoped(connection.subscribe).pipe(
            Stream.filter((event) => event.sessionId === turn.id),
            Stream.takeUntil((event) => event.kind === "completed" || event.kind === "failed"),
          ),
        ),
      );
      await Effect.runPromise(
        connection.send({ sessionId: turn.id, prompt: turn.prompt, attachments: [], tools: [] }),
      );
      await events;
      await Effect.runPromise(connection.stop(turn.id));
      expect(fixture.registry.observedState(instanceId)?.capabilities.usage).toBe("supported");
    }
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
    const collected = terminal(Stream.unwrapScoped(connection.subscribe));
    await Effect.runPromise(
      connection.send({ sessionId, prompt: "wait", attachments: [], tools: [] }),
    );
    await Effect.runPromise(connection.interrupt(sessionId));
    expect((await collected).map((event) => event.kind)).toEqual(["interrupted"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("Ollama Verify tools", () => {
  it("reports a model Ollama says takes no tools as Chat only without a generating request", async () => {
    const fetch = service(["completion"], () => {
      throw new Error("a model without tools must not be sent a chat request");
    });
    const fixture = driver(fetch);
    const result = await Effect.runPromise(
      Effect.scoped(fixture.driver.verifyToolCapability!({ instanceId, modelId })),
    );
    expect(result).toEqual({ instanceId, modelId, appManagedTools: "unsupported" });
  });

  it("verifies a model that calls the echo tool in one request", async () => {
    const bodies: unknown[] = [];
    const fetch = service(["completion", "tools"], (body) => {
      bodies.push(body);
      return reply({
        content: "",
        tool_calls: [
          { function: { name: "octant_capability_echo", arguments: { echo: "ready" } } },
        ],
      });
    });
    const fixture = driver(fetch);
    const result = await Effect.runPromise(
      Effect.scoped(fixture.driver.verifyToolCapability!({ instanceId, modelId })),
    );
    expect(result.appManagedTools).toBe("supported");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: "qwen3:latest",
      tools: [{ type: "function", function: { name: "octant_capability_echo" } }],
    });
  });

  it("reports a model that answers in text as unsupported and keeps a verification across a probe", async () => {
    const fetch = service(["completion", "tools"], () => reply({ content: "ready" }));
    const fixture = driver(fetch);
    const result = await Effect.runPromise(
      Effect.scoped(fixture.driver.verifyToolCapability!({ instanceId, modelId })),
    );
    expect(result.appManagedTools).toBe("unsupported");

    await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    fixture.registry.setVerifiedToolModels(instanceId, [modelId]);
    await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(fixture.registry.observedState(instanceId)?.verifiedToolModelIds).toEqual([modelId]);
  });

  it("reports an unreachable service as a failure rather than as Chat only", async () => {
    const fetch = vi.fn<OllamaFetch>(async () => {
      throw new TypeError("connection refused");
    });
    const fixture = driver(fetch);
    await expect(
      Effect.runPromise(
        Effect.scoped(fixture.driver.verifyToolCapability!({ instanceId, modelId })),
      ),
    ).rejects.toThrow(/unavailable/);
  });
});
