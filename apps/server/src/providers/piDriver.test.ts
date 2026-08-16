import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
  type ProviderFailure,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makePiDriver, type PiClientPort } from "./piDriver";
import type { PiProcessPort, PiRpcConnection } from "./piProcess";
import type { PiRpcEvent } from "./piRpcClient";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000701");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000702");
const modelId = "anthropic/claude-sonnet" as ProviderModelId;
const root = "/tmp/octant-pi-driver";

class FakeClient implements PiClientPort {
  readonly events = new Set<(event: PiRpcEvent) => void>();
  readonly responses: Array<{ id: string; response: Record<string, unknown> }> = [];
  readonly request = vi.fn(async (type: string, fields: Record<string, unknown> = {}) => {
    if (type === "get_available_models") {
      return {
        type: "response" as const,
        command: type,
        success: true,
        data: {
          models: [
            {
              provider: "anthropic",
              id: "claude-sonnet",
              name: "Claude Sonnet",
              reasoning: true,
              contextWindow: 200000,
            },
          ],
        },
      };
    }
    if (type === "get_state") {
      return {
        type: "response" as const,
        command: type,
        success: true,
        data: { sessionId: "pi-source-1", sessionFile: "/managed/sessions/pi-source-1.jsonl" },
      };
    }
    if (type === "set_model") {
      expect(fields).toEqual({ provider: "anthropic", modelId: "claude-sonnet" });
    }
    return { type: "response" as const, command: type, success: true };
  });
  readonly respondToUi = vi.fn(async (id: string, response: Record<string, unknown>) => {
    this.responses.push({ id, response });
  });
  onEvent(listener: (event: PiRpcEvent) => void) {
    this.events.add(listener);
    return () => {
      this.events.delete(listener);
    };
  }
  emit(event: PiRpcEvent) {
    for (const listener of this.events) listener(event);
  }
}

function fixture() {
  const client = new FakeClient();
  const starts: Array<Record<string, unknown>> = [];
  let active = 0;
  let released = 0;
  const connection = {
    version: "0.80.10",
    pid: 701,
    root,
    rpc: {} as PiRpcConnection["rpc"],
    exited: new Promise<void>(() => undefined),
  } satisfies PiRpcConnection;
  const processPort: PiProcessPort = {
    start: (input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          starts.push(input);
          active += 1;
          return connection;
        }),
        () =>
          Effect.sync(() => {
            active -= 1;
            released += 1;
          }),
      ),
  };
  const registry = new ProviderRuntimeRegistry();
  const driver = makePiDriver({
    instanceId,
    binaryPath: "/opt/homebrew/bin/pi",
    piHome: "/managed/pi",
    process: processPort,
    runtimeRegistry: registry,
    clientFactory: () => client,
    clock: () => "2026-07-18T06:00:00.000Z",
    correlationId: () => "80000000-0000-4000-8000-000000000703",
    requestId: (() => {
      let id = 0;
      return () => `approval-${++id}`;
    })(),
  });
  return { driver, client, starts, registry, active: () => active, released: () => released };
}

function deferredExit() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    resolve = resolveExit;
    reject = rejectExit;
  });
  return { exited, resolve, reject };
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

describe("Pi provider driver", () => {
  it("probes model readiness without sending a prompt", async () => {
    const { driver, client, registry, starts, active, released } = fixture();
    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(result).toMatchObject({
      readiness: "ready",
      detectedVersion: "0.80.10",
      models: [
        {
          id: "anthropic/claude-sonnet",
          displayName: "Claude Sonnet",
          contextLimit: 200000,
          reasoning: "supported",
        },
      ],
      capabilities: {
        streaming: "supported",
        resume: "supported",
        interruption: "supported",
        approvals: "supported",
        userQuestions: "unsupported",
        nativeChildAgents: "unsupported",
      },
    });
    expect(client.request.mock.calls.map(([type]) => type)).toEqual([
      "get_available_models",
      "get_state",
    ]);
    expect(starts[0]).toMatchObject({
      root: "/managed/pi",
      mode: "chat",
      onProcessStarted: expect.any(Function),
    });
    expect(registry.observedState(instanceId)).toEqual(result);
    expect(active()).toBe(0);
    expect(released()).toBe(1);
  });

  it("streams ordered events and correlates approval answers", async () => {
    const { driver, client, starts } = fixture();
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const handle = await Effect.runPromise(
      connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    expect(starts[0]).toMatchObject({ onProcessStarted: expect.any(Function) });
    expect(handle.resumeCursor).toEqual({ driverKind: "pi", value: sessionId });
    expect(starts.at(-1)).toMatchObject({
      root,
      sessionId,
      executionPolicy: "approval-gated",
    });

    const collected = terminal(connection.events);
    await Effect.runPromise(
      connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
    );
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "think" },
    });
    client.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "write" });
    client.emit({
      type: "extension_ui_request",
      id: "pi-ui-1",
      method: "confirm",
      title: "Octant approval:tool-1:write",
      message: "Allow?",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Effect.runPromise(
      connection.answerApproval({ sessionId, requestId: "approval-1", approved: true }),
    );
    client.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "write",
      isError: false,
      result: {},
    });
    client.emit({ type: "agent_settled" });
    expect((await collected).map((event) => event.kind)).toEqual([
      "text-delta",
      "reasoning-delta",
      "tool-start",
      "approval-request",
      "tool-success",
      "completed",
    ]);
    expect(client.responses).toEqual([{ id: "pi-ui-1", response: { confirmed: true } }]);
    await Effect.runPromise(connection.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("rejects stale resumes, unknown answers, and Plan approvals", async () => {
    const { driver, client } = fixture();
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await expect(
      Effect.runPromise(
        connection.resume({
          sessionId,
          resumeCursor: { driverKind: "pi", value: "unknown" },
          executionPolicy: "approval-gated",
        }),
      ),
    ).rejects.toThrow(/stale-resume/);
    await Effect.runPromise(connection.start({ sessionId, modelId, executionPolicy: "plan" }));
    client.emit({
      type: "extension_ui_request",
      id: "unexpected",
      method: "confirm",
      title: "Octant approval:tool-1:write",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.responses).toEqual([{ id: "unexpected", response: { confirmed: false } }]);
    await expect(
      Effect.runPromise(
        connection.answerApproval({ sessionId, requestId: "unknown", approved: true }),
      ),
    ).rejects.toThrow(/protocol/);
    await expect(
      Effect.runPromise(
        connection.answerUserInput({ sessionId, requestId: "unknown", answer: "x" }),
      ),
    ).rejects.toThrow(/unsupported/);
    await Effect.runPromise(connection.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("fails an active turn exactly once when the owned Pi process disconnects", async () => {
    const client = new FakeClient();
    const processExit = deferredExit();
    const registry = new ProviderRuntimeRegistry();
    const processPort: PiProcessPort = {
      start: () =>
        Effect.acquireRelease(
          Effect.succeed({
            version: "0.80.10",
            pid: 702,
            root,
            rpc: {} as PiRpcConnection["rpc"],
            exited: processExit.exited,
          }),
          () => Effect.void,
        ),
    };
    const driver = makePiDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/pi",
      piHome: "/managed/pi",
      process: processPort,
      runtimeRegistry: registry,
      clientFactory: () => client,
      clock: () => "2026-07-18T06:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000703",
    });
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      driver
        .acquire({ instanceId, projectRoot: root, mode: "code" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await Effect.runPromise(
      connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const collected = terminal(connection.events);
    await Effect.runPromise(
      connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
    );
    processExit.reject(new Error("disconnected"));
    const events = await collected;
    expect(events.map((event) => event.kind)).toEqual(["failed"]);
    expect(events[0]).toMatchObject({
      kind: "failed",
      failure: { category: "interrupted" },
    });
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
