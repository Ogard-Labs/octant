import {
  decodeCodeCheckoutId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  type CodeThread,
  type ProviderFailure,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { describe, expect, it, vi } from "vitest";
import {
  CodeTurnRunner,
  MAX_CODE_TURN_EVENT_BYTES,
  type CodeProviderPort,
  type CodeTurnEvent,
  type CodeTurnOutcome,
  type CodeTurnRunnerInput,
} from "./codeTurnRunner";

const now = "2026-07-21T00:00:00.000Z";
const providerInstanceId = decodeProviderInstanceId("87000000-0000-4000-8000-000000000001");
const sessionId = decodeProviderSessionId("87000000-0000-4000-8000-000000000002");

describe("CodeTurnRunner", () => {
  it("subscribes before send and acquires Code in the exact checkout with thread authority", async () => {
    let subscribed = false;
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = fakeConnection({
      subscribe: Effect.sync(() => {
        subscribed = true;
        return Stream.fromQueue(queue);
      }),
      send: vi.fn(() =>
        Effect.gen(function* () {
          expect(subscribed).toBe(true);
          yield* Queue.offer(queue, event({ kind: "text-delta", text: "hello" }));
          yield* Queue.offer(queue, event({ kind: "completed" }));
        }),
      ),
    });
    const acquire = vi.fn(() => Effect.succeed(connection));
    const events: CodeTurnEvent[] = [];
    const outcomes: CodeTurnOutcome[] = [];
    const runner = new CodeTurnRunner();

    await Effect.runPromise(
      Effect.scoped(
        runner.run(
          input({
            provider: { acquire },
            persistEvent: (next) => Effect.sync(() => events.push(next)),
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(acquire).toHaveBeenCalledWith({
      instanceId: providerInstanceId,
      mode: "code",
      projectRoot: "/private/worktrees/exact",
      permissionPersistence: "current-session",
    });
    expect(connection.start).toHaveBeenCalledWith({
      sessionId,
      modelId: decodeProviderModelId("model-a"),
      executionPolicy: "approval-gated",
    });
    expect(events).toContainEqual(expect.objectContaining({ category: "message", text: "hello" }));
    expect(outcomes.at(-1)).toBe("completed");
  });

  it("reconciles provider file, diff, and successful tool claims as observations, never proof", async () => {
    const providerEvents = [
      event({ kind: "file-change", path: "src/a.ts", change: "modified" }),
      event({ kind: "diff", diff: "diff --git a/src/a.ts b/src/a.ts" }),
      event({ kind: "tool-success", toolCallId: "tool-1", summary: "Edited src/a.ts" }),
      event({ kind: "completed" }),
    ];
    const connection = fakeConnection({
      subscribe: Effect.succeed(Stream.fromIterable(providerEvents)),
    });
    const reconcileObservation = vi.fn(() =>
      Effect.succeed({ status: "confirmed" as const, summary: "Checkout rescan completed." }),
    );
    const observed: CodeTurnEvent[] = [];

    await Effect.runPromise(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            reconcileObservation,
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
          }),
        ),
      ),
    );

    expect(reconcileObservation).toHaveBeenCalledTimes(3);
    expect(reconcileObservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        checkoutRoot: "/private/worktrees/exact",
        claim: providerEvents[0],
      }),
    );
    expect(observed.filter((entry) => entry.category === "observation")).toHaveLength(3);
    expect(observed.filter((entry) => entry.category === "observation")).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerClaimIsMutationProof: false })]),
    );
  });

  it("names the tool once in an approval prompt", async () => {
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([
          event({
            kind: "approval-request",
            requestId: "request-1",
            action: "Edit",
            description: "Claude requests permission to use Edit.",
          }),
          event({ kind: "completed" }),
        ]),
      ),
    });
    const observed: CodeTurnEvent[] = [];

    await Effect.runPromise(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
            persistOutcome: () => Effect.void,
          }),
        ),
      ),
    );

    expect(observed).toContainEqual(
      expect.objectContaining({
        category: "approval",
        text: "Claude requests permission to use Edit.",
      }),
    );
  });

  it("keeps the turn waiting when provider completion follows unresolved reconciliation", async () => {
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([
          event({ kind: "file-change", path: "src/a.ts", change: "modified" }),
          event({ kind: "completed" }),
        ]),
      ),
    });
    const outcomes: CodeTurnOutcome[] = [];
    const observed: CodeTurnEvent[] = [];

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            reconcileObservation: () =>
              Effect.succeed({ status: "waiting", summary: "Checkout scan is unavailable." }),
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(outcomes).toEqual(["waiting"]);
    expect(observed).not.toContainEqual(expect.objectContaining({ category: "completion" }));
  });

  it("bounds normalized provider payloads and fails closed at the discrete event budget", async () => {
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([
          event({ kind: "reasoning-delta", text: "x".repeat(MAX_CODE_TURN_EVENT_BYTES * 2) }),
          // Streaming deltas are free; only discrete events consume the budget.
          event({ kind: "text-delta", text: "still free" }),
          event({ kind: "text-delta", text: "still free" }),
          event({ kind: "task-progress", taskId: "task-1", status: "in-progress", summary: "ok" }),
          event({ kind: "task-progress", taskId: "task-1", status: "in-progress", summary: "ok" }),
          event({ kind: "task-progress", taskId: "task-1", status: "completed", summary: "over" }),
        ]),
      ),
    });
    const observed: CodeTurnEvent[] = [];
    const outcomes: CodeTurnOutcome[] = [];
    const runner = new CodeTurnRunner({ maxEvents: 2 });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(Buffer.byteLength(observed[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_CODE_TURN_EVENT_BYTES,
    );
    expect(outcomes.at(-1)).toBe("failed");
    expect(connection.interrupt).toHaveBeenCalledWith(sessionId);
  });

  it("bounds upstream claim text and the complete serialized observation event", async () => {
    const upstreamLimit = MAX_CODE_TURN_EVENT_BYTES * 4;
    const rawDiff = "x".repeat(upstreamLimit * 2);
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([event({ kind: "diff", diff: rawDiff }), event({ kind: "completed" })]),
      ),
    });
    const reconcileObservation = vi.fn(
      (_request: Parameters<CodeTurnRunnerInput["reconcileObservation"]>[0]) =>
        Effect.succeed({
          status: "confirmed" as const,
          summary: `verified:${"y".repeat(upstreamLimit)}`,
        }),
    );
    const observed: CodeTurnEvent[] = [];

    await Effect.runPromise(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            reconcileObservation,
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
          }),
        ),
      ),
    );

    const reconciledClaim = reconcileObservation.mock.calls[0]?.[0].claim;
    expect(reconciledClaim?.kind).toBe("diff");
    if (reconciledClaim?.kind !== "diff") throw new Error("Expected a diff claim.");
    expect(Buffer.byteLength(reconciledClaim.diff, "utf8")).toBeLessThanOrEqual(upstreamLimit);
    expect(Buffer.byteLength(JSON.stringify(observed[0]), "utf8")).toBeLessThanOrEqual(
      MAX_CODE_TURN_EVENT_BYTES,
    );
  });

  it("sanitizes paths, diffs, and tool payloads before reconciliation or persistence", async () => {
    const checkoutRoot = "/private/worktrees/exact";
    const secret = "private-token";
    const providerEvents = [
      event({ kind: "file-change", path: `${checkoutRoot}/src/a.ts`, change: "modified" }),
      event({ kind: "diff", diff: `+TOKEN=${secret}` }),
      event({ kind: "tool-success", toolCallId: "tool-1", summary: `wrote ${secret}` }),
      event({
        kind: "tool-request",
        requestId: "tool-request-1",
        toolName: "octant_test",
        inputJson: JSON.stringify({ token: secret, path: `${checkoutRoot}/src/a.ts` }),
      }),
      event({ kind: "completed" }),
    ];
    const connection = fakeConnection({
      subscribe: Effect.succeed(Stream.fromIterable(providerEvents)),
    });
    const sanitizeProviderEvent = vi.fn(
      ({ event: providerEvent }: { readonly event: ProviderRuntimeEvent }) => {
        if (providerEvent.kind === "file-change") {
          return Effect.succeed({ ...providerEvent, path: "src/a.ts" });
        }
        if (providerEvent.kind === "diff") {
          return Effect.succeed({ ...providerEvent, diff: "+TOKEN=[REDACTED]" });
        }
        if (providerEvent.kind === "tool-success") {
          return Effect.succeed({ ...providerEvent, summary: "wrote [REDACTED]" });
        }
        if (providerEvent.kind === "tool-request") {
          return Effect.succeed({
            ...providerEvent,
            inputJson: JSON.stringify({ token: "[REDACTED]", path: "src/a.ts" }),
          });
        }
        return Effect.succeed(providerEvent);
      },
    );
    const reconcileObservation = vi.fn(
      (_request: Parameters<CodeTurnRunnerInput["reconcileObservation"]>[0]) =>
        Effect.succeed({ status: "confirmed" as const, summary: "Verified." }),
    );
    const observed: CodeTurnEvent[] = [];

    await Effect.runPromise(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            sanitizeProviderEvent,
            reconcileObservation,
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
          }),
        ),
      ),
    );

    const persisted = JSON.stringify(observed);
    const reconciledClaims = JSON.stringify(
      reconcileObservation.mock.calls.map(([request]) => request.claim),
    );
    expect(sanitizeProviderEvent).toHaveBeenCalledTimes(providerEvents.length);
    expect(persisted).not.toContain(checkoutRoot);
    expect(persisted).not.toContain(secret);
    expect(reconciledClaims).not.toContain(checkoutRoot);
    expect(reconciledClaims).not.toContain(secret);
    expect(persisted).toContain("src/a.ts");
    expect(persisted).toContain("[REDACTED]");
  });

  it("normalizes interactive and progress events under the immutable thread authority", async () => {
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([
          event({ kind: "tool-start", toolCallId: "tool-1", toolName: "shell" }),
          event({
            kind: "approval-request",
            requestId: "approval-1",
            action: "write",
            description: "Modify src/a.ts",
          }),
          event({
            kind: "user-input-request",
            requestId: "question-1",
            prompt: "Choose a target",
            options: ["A", "B"],
          }),
          event({ kind: "usage", inputTokens: 10, outputTokens: 20 }),
          event({
            kind: "child-agent-activity",
            childAgentId: "child-1",
            status: "running",
            summary: "Reviewing",
          }),
          event({
            kind: "tool-request",
            requestId: "app-tool-1",
            toolName: "octant_test",
            inputJson: "{}",
          }),
          event({ kind: "completed" }),
        ]),
      ),
    });
    const observed: CodeTurnEvent[] = [];
    const authorityThread = thread({ executionPolicy: "plan" });

    await Effect.runPromise(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            thread: authorityThread,
            provider: { acquire: () => Effect.succeed(connection) },
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
          }),
        ),
      ),
    );

    expect(observed.map((entry) => entry.category)).toEqual([
      "tool",
      "approval",
      "question",
      "usage",
      "child-activity",
      "tool",
      "completion",
    ]);
    expect(observed[1]).toMatchObject({
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    });
    expect(connection.answerApproval).not.toHaveBeenCalled();
    expect(connection.answerTool).toHaveBeenCalledWith({
      sessionId,
      requestId: "app-tool-1",
      resultJson: JSON.stringify({ error: "tool-unavailable" }),
      isError: true,
    });
  });

  it("executes each declared app-managed tool request once and returns a bounded answer", async () => {
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([
          event({
            kind: "tool-request",
            requestId: "browser-request-1",
            toolName: "octant_browser",
            inputJson: JSON.stringify({ operation: "read-page" }),
          }),
          event({
            kind: "tool-request",
            requestId: "browser-request-1",
            toolName: "octant_browser",
            inputJson: JSON.stringify({ operation: "read-page" }),
          }),
          event({ kind: "completed" }),
        ]),
      ),
    });
    const execute = vi.fn(async () => ({ result: { text: "Ready" } }));
    const observed: CodeTurnEvent[] = [];
    const definition = {
      name: "octant_browser",
      inputSchema: {
        type: "object",
        properties: { operation: { type: "string" } },
        required: ["operation"],
      },
    } as const;

    await Effect.runPromise(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            appManagedTools: { definitions: [definition], execute },
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
          }),
        ),
      ),
    );

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ tools: [definition] }));
    expect(execute).toHaveBeenCalledOnce();
    expect(connection.answerTool).toHaveBeenCalledOnce();
    expect(connection.answerTool).toHaveBeenCalledWith({
      sessionId,
      requestId: "browser-request-1",
      resultJson: JSON.stringify({ text: "Ready" }),
      isError: false,
    });
    expect(observed).toContainEqual(
      expect.objectContaining({
        category: "tool",
        toolName: "octant_browser",
        status: "completed",
      }),
    );
  });

  it("normalizes provider failure and records the run as failed", async () => {
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([
          event({
            kind: "failed",
            failure: { category: "provider-failed", message: "Provider process died." },
          }),
        ]),
      ),
    });
    const observed: CodeTurnEvent[] = [];
    const outcomes: CodeTurnOutcome[] = [];

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(observed).toContainEqual(
      expect.objectContaining({ category: "failure", text: "Provider process died." }),
    );
    expect(outcomes.at(-1)).toBe("failed");
  });

  it("journals the provider's reason with a turn that fails before it says anything", async () => {
    const refused: ProviderFailure = {
      category: "unavailable",
      message: "Claude runtime binary was not found on this Mac.",
    };
    const outcomes: Array<readonly [CodeTurnOutcome, string | undefined]> = [];

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.fail(refused) },
            persistOutcome: (next, failure) =>
              Effect.sync(() => {
                outcomes.push([next, failure?.message]);
              }),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(outcomes).toEqual([["failed", "Claude runtime binary was not found on this Mac."]]);
  });

  it("treats the timeout as provider inactivity, not total turn duration", async () => {
    // Real-clock test: a 40ms idle window with events every 15ms must survive
    // well past 40ms of wall time, then die once the stream goes quiet.
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = fakeConnection({
      subscribe: Effect.succeed(Stream.fromQueue(queue)),
      send: vi.fn(() =>
        Effect.gen(function* () {
          for (let index = 0; index < 6; index += 1) {
            yield* Effect.sleep(15);
            yield* Queue.offer(queue, event({ kind: "text-delta", text: `tick ${index}` }));
          }
          // ~90ms of activity, then silence.
        }),
      ),
    });
    const outcomes: CodeTurnOutcome[] = [];
    const observed: CodeTurnEvent[] = [];
    const runner = new CodeTurnRunner({ timeoutMs: 40 });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        runner.run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            persistEvent: (next) => Effect.sync(() => observed.push(next)),
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(observed.filter((next) => next.category === "message")).toHaveLength(6);
    expect(outcomes.at(-1)).toBe("interrupted");
    expect(connection.interrupt).toHaveBeenCalledWith(sessionId);
  });

  it("records cancellation as interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcomes: CodeTurnOutcome[] = [];
    const provider: CodeProviderPort = { acquire: vi.fn() };

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider,
            signal: controller.signal,
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(outcomes).toEqual(["interrupted"]);
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("cleans up without starting or sending when cancellation arrives during acquisition", async () => {
    const controller = new AbortController();
    const acquired = Effect.runSync(Deferred.make<void>());
    const connection = fakeConnection({ subscribe: Effect.succeed(Stream.never) });
    const acquire = vi.fn(() => Deferred.await(acquired).pipe(Effect.as(connection)));
    const outcomes: CodeTurnOutcome[] = [];
    const fiber = Effect.runFork(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire },
            signal: controller.signal,
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());

    controller.abort();
    Effect.runSync(Deferred.succeed(acquired, undefined));
    const exit = await Effect.runPromise(Fiber.await(fiber));

    expect(exit._tag).toBe("Failure");
    expect(outcomes.at(-1)).toBe("interrupted");
    expect(connection.start).not.toHaveBeenCalled();
    expect(connection.send).not.toHaveBeenCalled();
    expect(connection.stop).toHaveBeenCalledWith(sessionId);
  });

  it("records a provider stream that dies without a terminal event as waiting", async () => {
    const outcomes: CodeTurnOutcome[] = [];
    const connection = fakeConnection({
      subscribe: Effect.succeed(
        Stream.fromIterable([event({ kind: "text-delta", text: "partial" })]),
      ),
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(outcomes.at(-1)).toBe("waiting");
    expect(connection.stop).toHaveBeenCalledWith(sessionId);
  });

  it("downgrades provider completion to waiting when session cleanup cannot be confirmed", async () => {
    const outcomes: CodeTurnOutcome[] = [];
    const connection = fakeConnection({
      subscribe: Effect.succeed(Stream.fromIterable([event({ kind: "completed" })])),
      stop: vi.fn(() =>
        Effect.fail({ category: "provider-failed", message: "Provider stop failed." } as const),
      ),
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        new CodeTurnRunner().run(
          input({
            provider: { acquire: () => Effect.succeed(connection) },
            persistOutcome: (next) => Effect.sync(() => outcomes.push(next)),
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(outcomes).toEqual(["waiting"]);
    expect(connection.stop).toHaveBeenCalledWith(sessionId);
  });
});

function thread(overrides: Partial<CodeThread> = {}): CodeThread {
  return {
    id: decodeCodeThreadId("87000000-0000-4000-8000-000000000010"),
    projectId: "87000000-0000-4000-8000-000000000011" as never,
    bindingRevisionId: "87000000-0000-4000-8000-000000000012" as never,
    repositoryId: decodeCodeRepositoryId(`repo_${"a".repeat(64)}`),
    checkoutId: decodeCodeCheckoutId("87000000-0000-4000-8000-000000000013"),
    title: "Runner",
    lifecycle: "active",
    providerInstanceId,
    modelId: decodeProviderModelId("model-a"),
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/test",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as CodeThread;
}

function input(overrides: Partial<CodeTurnRunnerInput> = {}): CodeTurnRunnerInput {
  return {
    thread: thread(),
    sessionId,
    checkoutRoot: "/private/worktrees/exact",
    prompt: "Implement the task.",
    provider: { acquire: () => Effect.die("provider not supplied") },
    sanitizeProviderEvent: ({ event: providerEvent }) => Effect.succeed(providerEvent),
    reconcileObservation: () =>
      Effect.succeed({ status: "not-confirmed" as const, summary: "No authoritative change." }),
    persistEvent: () => Effect.void,
    persistOutcome: () => Effect.void,
    ...overrides,
  };
}

function fakeConnection(
  overrides: Partial<ProviderConnection> & Pick<ProviderConnection, "subscribe">,
): ProviderConnection {
  const { subscribe, ...methods } = overrides;
  return {
    subscribe,
    start: vi.fn(() => Effect.succeed({ sessionId })),
    resume: vi.fn(() => Effect.succeed({ sessionId })),
    send: vi.fn(() => Effect.void),
    interrupt: vi.fn(() => Effect.void),
    stop: vi.fn(() => Effect.void),
    answerApproval: vi.fn(() => Effect.void),
    answerUserInput: vi.fn(() => Effect.void),
    answerTool: vi.fn(() => Effect.void),
    ...methods,
  };
}

function event(
  value: { readonly kind: ProviderRuntimeEvent["kind"] } & Readonly<Record<string, unknown>>,
): ProviderRuntimeEvent {
  return {
    instanceId: providerInstanceId,
    sessionId,
    sequence: 1,
    correlationId: "87000000-0000-4000-8000-000000000099",
    occurredAt: now,
    ...value,
  } as ProviderRuntimeEvent;
}
