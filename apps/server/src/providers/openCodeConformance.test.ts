import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import {
  runProviderConformance,
  runSessionCompactionConformance,
} from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import type { Event } from "@opencode-ai/sdk/v2/types";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  adaptBetaOpenCodeEvent,
  makeOpenCodeDriver,
  OpenCodeRouteError,
  type OpenCodeClientPort,
} from "./openCodeDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000201");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000202");
const modelId = "anthropic/claude-sonnet" as ProviderModelId;
const projectRoot = "/tmp/octant-conformance";

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  action: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("Expected a process platform descriptor.");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("OpenCode provider conformance", () => {
  it("passes the provider-neutral lifecycle, capability, resume, and cleanup harness", async () => {
    const source = new EventSourceFixture();
    const registry = new ProviderRuntimeRegistry();
    let released = false;
    const session = {
      id: "provider-session",
      slug: "s",
      projectID: "p",
      directory: projectRoot,
      title: "t",
      version: "1",
      time: { created: 1, updated: 1 },
    } as const;
    let managedUrl: string | undefined;
    let managedSessionId: string | undefined;
    const client: OpenCodeClientPort = {
      health: async () => ({ healthy: true, version: "1.18.0" }),
      providers: async () => ({ all: [provider()], connected: ["anthropic"] }),
      subscribe: async () => source,
      createSession: async () => session,
      getSession: async (id) => {
        if (id === "stale") throw new Error("not found");
        return session;
      },
      prompt: async ({ permission }) => {
        const hasManagedTools = permission.some(
          (rule) => rule.permission.startsWith("octant-") && rule.action === "allow",
        );
        for (const event of runtimeEvents(session.id)) source.emit(event);
        if (hasManagedTools && managedUrl !== undefined) {
          // Provider prompts return before the model's MCP call completes;
          // keep the fixture's request asynchronous so the conformance
          // harness can observe and answer the app-owned tool request.
          void invokeManagedTool(managedUrl, "octant_web_research", managedSessionId).then(
            () =>
              source.emit({ type: "session.idle", properties: { sessionID: session.id } } as Event),
            () =>
              source.emit({ type: "session.idle", properties: { sessionID: session.id } } as Event),
          );
        }
      },
      addMcpServer: async ({ url }) => {
        managedUrl = url;
        managedSessionId = await attestManagedBridge(url);
      },
      disconnectMcpServer: async () => undefined,
      abort: async () => {
        source.emit({
          type: "session.error",
          properties: {
            sessionID: session.id,
            error: { name: "MessageAbortedError", data: { message: "aborted" } },
          },
        } as Event);
      },
      replyPermission: async () => undefined,
      replyQuestion: async () => undefined,
      deleteSession: async () => undefined,
    };
    const driver = makeOpenCodeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/opencode",
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              isolatedConfiguration: true,
              authorization: "Basic redacted",
              pid: process.pid,
              url: new URL("http://127.0.0.1:1/"),
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      },
      runtimeRegistry: registry,
      clientFactory: () => client,
      idleLeaseMs: 0,
      permissionPersistence: () => "current-session",
      clock: () => "2026-07-15T00:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000203",
    });
    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
      resume: {
        sessionId,
        modelId,
        resumeCursor: { driverKind: "opencode", value: "provider-session" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId,
        resumeCursor: { driverKind: "opencode", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId, requestId: "unknown", approved: false },
      unknownUserInput: { sessionId, requestId: "unknown", answer: "none" },
      expectedEventKinds: [
        "text-delta",
        "reasoning-delta",
        "tool-start",
        "tool-success",
        "usage",
        "diff",
        "task-progress",
        "task-list",
        "approval-request",
        "user-input-request",
        "interrupted",
      ],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "protocol",
        unknownUserInput: "protocol",
      },
      isReleased: () => released,
    });
    const chatEvidence = await withProcessPlatform("darwin", () =>
      runProviderChatConformance({
        driver,
        probeInput: { instanceId },
        acquireInput: { instanceId, projectRoot },
        sessionStart: {
          sessionId,
          modelId,
          executionPolicy: "approval-gated",
          tools: [
            {
              name: "octant_web_research",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        },
        turn: {
          sessionId,
          prompt: "hello",
          attachments: [],
          tools: [
            {
              name: "octant_web_research",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        },
        isReleased: () => released,
      }),
    );
    recordProviderConformanceEvidence("opencode", evidence);
    recordProviderChatConformanceEvidence("opencode", chatEvidence);
    expect(evidence).toEqual({
      probed: true,
      capabilityHonest: true,
      usageCapabilityHonest: true,
      researchCapabilityHonest: true,
      citationsCapabilityHonest: true,
      streamedInOrder: true,
      interrupted: true,
      resumed: true,
      staleResumeRejected: true,
      unknownApprovalRejected: true,
      unknownUserInputRejected: true,
      failureClassified: true,
      released: true,
    });
    expect(chatEvidence).toMatchObject({ appManagedToolRoundTrip: true, released: true });
  });

  it("completes a Code turn from recorded 2.x session fixtures", async () => {
    const codeSource = new EventSourceFixture();
    const codeDriver = makeBetaHarnessDriver(codeSource, {
      onPrompt: (sessionId) => {
        for (const event of recordedBetaTurn(sessionId)) codeSource.emit(event);
      },
      onAbort: (sessionId) => {
        codeSource.emit({
          type: "session.error",
          properties: {
            sessionID: sessionId,
            error: { name: "MessageAbortedError", data: { message: "aborted" } },
          },
        } as Event);
      },
    });
    const codeEvidence = await runProviderConformance({
      driver: codeDriver.driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot, mode: "code" },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
      resume: {
        sessionId,
        modelId,
        resumeCursor: { driverKind: "opencode", value: "provider-session" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId,
        resumeCursor: { driverKind: "opencode", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId, requestId: "unknown", approved: false },
      unknownUserInput: { sessionId, requestId: "unknown", answer: "none" },
      expectedEventKinds: [
        "text-delta",
        "reasoning-delta",
        "tool-start",
        "tool-success",
        "usage",
        "diff",
        "task-progress",
        "task-list",
        "approval-request",
        "interrupted",
      ],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "protocol",
        unknownUserInput: "unsupported",
      },
      isReleased: codeDriver.isReleased,
    });
    expect(codeEvidence).toMatchObject({
      capabilityHonest: true,
      streamedInOrder: true,
      interrupted: true,
      resumed: true,
      released: true,
    });
  });

  it.each([
    ["opencode v2.2.0", "supported", true],
    ["opencode v2.0.22", "unavailable", false],
  ] as const)(
    "holds a %s runtime to its %s session compaction claim",
    async (version, claim, compacted) => {
      const source = new EventSourceFixture();
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const harness = makeBetaHarnessDriver(
        source,
        {
          onPrompt: (nativeId) => {
            for (const event of recordedBetaTurn(nativeId)) source.emit(event);
            source.emit(idleEvent(nativeId));
          },
          onAbort: () => undefined,
        },
        {
          version,
          compact: async (nativeId) => {
            // OpenCode answers the route at once and reports the rest as events.
            void held.then(() => {
              for (const event of recordedCompaction(nativeId)) source.emit(event);
            });
          },
        },
      );
      await expect(
        runSessionCompactionConformance({
          driver: harness.driver,
          probeInput: { instanceId },
          acquireInput: { instanceId, projectRoot, mode: "code" },
          sessionStart: {
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
          },
          turns: [
            {
              sessionId,
              prompt: "Remember the plan.",
              attachments: [],
              tools: [],
            },
            { sessionId, prompt: "Carry on.", attachments: [], tools: [] },
          ],
          resume: (handle) => ({
            sessionId: handle.sessionId,
            resumeCursor: handle.resumeCursor ?? {
              driverKind: "opencode",
              value: "provider-session",
            },
            executionPolicy: "approval-gated",
          }),
          compactionId: "80000000-0000-4000-8000-000000000204",
          releaseCompaction: () => release?.(),
          isReleased: harness.isReleased,
        }),
      ).resolves.toEqual({
        claim,
        compacted,
        turnRefusedWhileCompacting: compacted,
        released: true,
      });
    },
  );

  describe("a requested 2.x compaction that does not finish", () => {
    const compactOnce = async (
      onCompact: (nativeId: string, source: EventSourceFixture) => Promise<void>,
      stopFirst = false,
    ) => {
      const source = new EventSourceFixture();
      const harness = makeBetaHarnessDriver(
        source,
        { onPrompt: () => undefined, onAbort: () => undefined },
        {
          version: "opencode v2.2.0",
          compact: (nativeId) => onCompact(nativeId, source),
        },
      );
      return Effect.runPromise(
        Effect.scoped(
          harness.driver.acquire({ instanceId, projectRoot, mode: "code" }).pipe(
            Effect.flatMap((connection) =>
              Effect.gen(function* () {
                yield* connection.start({
                  sessionId,
                  modelId,
                  executionPolicy: "approval-gated",
                });
                const compact = connection.compact;
                if (compact === undefined) throw new Error("expected a compact operation");
                const compacting = yield* Effect.fork(
                  compact({
                    sessionId,
                    compactionId: "80000000-0000-4000-8000-000000000205",
                  }),
                );
                if (stopFirst) {
                  yield* Effect.sleep("20 millis");
                  yield* connection.stop(sessionId);
                }
                return yield* Effect.fromFiber(compacting);
              }),
            ),
          ),
        ),
      );
    };

    it("refuses as nothing to compact when OpenCode names it, as 2.2.0 does for a new session", async () => {
      await expect(
        compactOnce(async (nativeId, source) => {
          source.emit({
            type: "session.compaction.failed",
            properties: {
              sessionID: nativeId,
              reason: "manual",
              error: {
                type: "compaction.unavailable",
                message: "Nothing to compact yet",
              },
            },
          } as unknown as Event);
          source.emit(idleEvent(nativeId));
        }),
      ).resolves.toEqual({ kind: "refused", reason: "nothing-to-compact" });
    });

    it("says the session is unchanged when OpenCode reports another failure", async () => {
      await expect(
        compactOnce(async (nativeId, source) => {
          source.emit({
            type: "session.compaction.failed",
            properties: {
              sessionID: nativeId,
              reason: "manual",
              error: { type: "compaction.failed", message: "provider said no" },
            },
          } as unknown as Event);
          source.emit(idleEvent(nativeId));
        }),
      ).resolves.toEqual({
        kind: "failed",
        message: "OpenCode could not compact the session.",
        sessionMayHaveChanged: false,
      });
    });

    it("refuses as too old when the route is missing, and fails open when the answer is lost", async () => {
      await expect(
        compactOnce(async () => {
          throw new OpenCodeRouteError("missing", 404);
        }),
      ).resolves.toEqual({
        kind: "refused",
        reason: "runtime-version-unsupported",
      });
      await expect(
        compactOnce(async () => {
          throw new Error("socket closed");
        }),
      ).resolves.toMatchObject({ kind: "failed", sessionMayHaveChanged: true });
    });

    it("fails with the history possibly changed when the run ends without a report", async () => {
      await expect(
        compactOnce(async (nativeId, source) => {
          source.emit(idleEvent(nativeId));
        }),
      ).resolves.toMatchObject({ kind: "failed", sessionMayHaveChanged: true });
    });

    it("fails with the history possibly changed when the session is stopped mid-compaction", async () => {
      await expect(compactOnce(async () => undefined, true)).resolves.toMatchObject({
        kind: "failed",
        sessionMayHaveChanged: true,
      });
    });
  });

  it("folds a recorded 2.2.0 compaction report into the events the driver reads", () => {
    const calls = new Map<string, string>();
    expect(
      adaptBetaOpenCodeEvent(
        {
          type: "session.compaction.ended",
          data: { sessionID: "ses_1", reason: "manual", text: "summary" },
        },
        calls,
      ),
    ).toMatchObject({ type: "session.next.compaction.ended" });
    expect(
      adaptBetaOpenCodeEvent(
        {
          type: "session.compaction.failed",
          data: {
            sessionID: "ses_1",
            reason: "manual",
            inputID: "msg_1",
            error: {
              type: "compaction.unavailable",
              message: "Nothing to compact yet",
            },
          },
        },
        calls,
      ),
    ).toMatchObject({ type: "session.compaction.failed" });
    expect(
      adaptBetaOpenCodeEvent({
        type: "session.execution.succeeded",
        data: { sessionID: "ses_1" },
      }),
    ).toMatchObject({ type: "session.idle" });
  });

  it("reports file changes and compaction only from the 2.x release that was read", async () => {
    const claims = async (version: string) => {
      const harness = makeBetaHarnessDriver(
        new EventSourceFixture(),
        { onPrompt: () => undefined, onAbort: () => undefined },
        { version },
      );
      const probe = await Effect.runPromise(Effect.scoped(harness.driver.probe({ instanceId })));
      return {
        fileChanges: probe.capabilities.fileChanges,
        compaction: probe.capabilities.sessionCompaction,
      };
    };
    expect(await claims("opencode v2.2.0")).toEqual({
      fileChanges: "supported",
      compaction: { chat: "supported", work: "supported", code: "supported" },
    });
    expect(await claims("opencode v2.10.1")).toMatchObject({
      fileChanges: "supported",
    });
    expect(await claims("opencode v2.1.9")).toEqual({
      fileChanges: "unsupported",
      compaction: {
        chat: "unavailable",
        work: "unavailable",
        code: "unavailable",
      },
    });
  });

  it("offers a 2.x Chat turn once the jail serves a Git work tree", async () => {
    const chatSource = new EventSourceFixture();
    const chatDriver = makeBetaHarnessDriver(chatSource, {
      onPrompt: () => undefined,
      onAbort: () => undefined,
    });
    await Effect.runPromise(
      Effect.scoped(
        chatDriver.driver
          .acquire({ instanceId, projectRoot, mode: "chat" })
          .pipe(
            Effect.flatMap((connection) =>
              connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
            ),
          ),
      ),
    );
  });

  it("round-trips an app-managed tool on 2.x through the bridge OpenCode connected", async () => {
    const chatSource = new EventSourceFixture();
    const chatDriver = makeBetaHarnessDriver(chatSource, {
      onPrompt: (nativeId, bridge) => {
        if (bridge === undefined) return;
        // 2.0.22 names the calling session in `ai.opencode/sessionID`.
        void invokeManagedTool(bridge.url, "octant_web_research", bridge.session, {
          "ai.opencode/sessionID": nativeId,
        }).finally(() =>
          chatSource.emit({ type: "session.idle", properties: { sessionID: nativeId } } as Event),
        );
      },
      onAbort: () => undefined,
    });
    const tools = [
      {
        name: "octant_web_research",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
    const probe = await withProcessPlatform("darwin", () =>
      Effect.runPromise(Effect.scoped(chatDriver.driver.probe({ instanceId }))),
    );
    expect(probe.capabilities.appManagedTools).toBe("supported");
    const evidence = await withProcessPlatform("darwin", () =>
      runProviderChatConformance({
        driver: chatDriver.driver,
        probeInput: { instanceId },
        acquireInput: { instanceId, projectRoot, mode: "chat" },
        sessionStart: { sessionId, modelId, executionPolicy: "approval-gated", tools },
        turn: { sessionId, prompt: "hello", attachments: [], tools },
        isReleased: chatDriver.isReleased,
      }),
    );
    expect(evidence).toMatchObject({ appManagedToolRoundTrip: true, released: true });
  });

  it("reports app tools unsupported on 2.x when OpenCode refuses the MCP registration", async () => {
    const chatSource = new EventSourceFixture();
    const chatDriver = makeBetaHarnessDriver(
      chatSource,
      { onPrompt: () => undefined, onAbort: () => undefined },
      { mcp: "refused" },
    );
    const tools = [{ name: "octant_web_research", inputSchema: { type: "object" } }];
    const probe = await withProcessPlatform("darwin", () =>
      Effect.runPromise(Effect.scoped(chatDriver.driver.probe({ instanceId }))),
    );
    expect(probe.readiness).toBe("ready");
    expect(probe.capabilities.appManagedTools).toBe("unsupported");
    // The harness requires a turn with tools to fail as `unsupported` rather
    // than run without them.
    const evidence = await withProcessPlatform("darwin", () =>
      runProviderChatConformance({
        driver: chatDriver.driver,
        probeInput: { instanceId },
        acquireInput: { instanceId, projectRoot, mode: "chat" },
        sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
        turn: { sessionId, prompt: "hello", attachments: [], tools },
        isReleased: chatDriver.isReleased,
      }),
    );
    expect(evidence).toMatchObject({ appManagedToolRoundTrip: true, released: true });
  });
});

class EventSourceFixture implements AsyncIterable<Event> {
  readonly #events: Event[] = [];
  readonly #waiters: Array<(value: IteratorResult<Event>) => void> = [];
  emit(event: Event): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter({ value: event, done: false });
  }
  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: async () => {
        const event = this.#events.shift();
        if (event !== undefined) return { value: event, done: false };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

async function invokeManagedTool(
  url: string,
  name: string,
  existingSessionId: string | undefined,
  meta: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  let sessionId = existingSessionId;
  if (sessionId === undefined) {
    const initialize = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "open-code-fixture", version: "1" },
        },
      }),
    });
    if (!initialize.ok) throw new Error("Managed MCP fixture initialization failed.");
    sessionId = initialize.headers.get("mcp-session-id") ?? undefined;
    if (sessionId === undefined) throw new Error("Managed MCP fixture did not receive a session.");
  }
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  };
  if (existingSessionId === undefined) {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
  }
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name,
        arguments: { query: "hello" },
        _meta: { progressToken: 2, ...meta },
      },
    }),
  });
}

async function attestManagedBridge(url: string): Promise<string> {
  const initialize = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "open-code-probe-fixture", version: "1" },
      },
    }),
  });
  if (!initialize.ok) throw new Error("Managed MCP fixture initialization failed.");
  const sessionId = initialize.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Managed MCP fixture did not receive a session.");
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  };
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  const listed = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  if (!listed.ok) throw new Error("Managed MCP fixture tools/list failed.");
  return sessionId;
}

function provider() {
  const model = {
    id: "claude-sonnet",
    providerID: "anthropic",
    name: "Claude Sonnet",
    api: { id: "x", url: "https://example.invalid", npm: "x" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: { low: {}, high: {} },
  } as const;
  return {
    id: "anthropic",
    name: "Anthropic",
    source: "config" as const,
    env: [],
    options: {},
    models: { [model.id]: model },
  };
}

function runtimeEvents(sourceId: string): ReadonlyArray<Event> {
  return [
    {
      type: "session.next.text.delta",
      properties: { id: "e1", sessionID: sourceId, messageID: "m", partID: "p", delta: "hello" },
    },
    {
      type: "session.next.reasoning.delta",
      properties: { id: "e2", sessionID: sourceId, messageID: "m", partID: "r", delta: "think" },
    },
    {
      type: "session.next.tool.called",
      properties: {
        id: "e3",
        sessionID: sourceId,
        messageID: "m",
        partID: "t",
        callID: "c",
        tool: "read",
        args: {},
      },
    },
    {
      type: "session.next.tool.success",
      properties: {
        id: "e4",
        sessionID: sourceId,
        messageID: "m",
        partID: "t",
        callID: "c",
        tool: "read",
        args: {},
        result: "ok",
        time: { start: 1, end: 2 },
      },
    },
    {
      type: "session.next.step.ended",
      properties: {
        id: "e5",
        sessionID: sourceId,
        messageID: "m",
        partID: "s",
        reason: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
    {
      type: "session.diff",
      properties: {
        sessionID: sourceId,
        diff: [{ file: "README.md", patch: "+x", additions: 1, deletions: 0 }],
      },
    },
    {
      type: "todo.updated",
      properties: {
        sessionID: sourceId,
        todos: [{ content: "test", status: "pending", priority: "medium" }],
      },
    },
    {
      type: "permission.asked",
      properties: {
        id: "permission",
        sessionID: sourceId,
        permission: "edit",
        patterns: ["*"],
        metadata: {},
        always: [],
      },
    },
    {
      type: "question.asked",
      properties: {
        id: "question",
        sessionID: sourceId,
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      },
    },
  ] as unknown as ReadonlyArray<Event>;
}

function idleEvent(sourceId: string): Event {
  return {
    type: "session.idle",
    properties: { sessionID: sourceId },
  } as unknown as Event;
}

/** What a 2.2.0 server reports for a manual compaction, after the folding the client does. */
function recordedCompaction(sourceId: string): ReadonlyArray<Event> {
  return [
    {
      type: "session.next.compaction.ended",
      properties: { sessionID: sourceId, reason: "manual", text: "summary" },
    },
    idleEvent(sourceId),
  ] as unknown as ReadonlyArray<Event>;
}

function recordedBetaTurn(sourceId: string): ReadonlyArray<Event> {
  return [
    {
      type: "session.next.text.delta",
      properties: {
        sessionID: sourceId,
        assistantMessageID: "m",
        textID: "t",
        delta: "hello",
      },
    },
    {
      type: "session.next.reasoning.delta",
      properties: {
        sessionID: sourceId,
        assistantMessageID: "m",
        textID: "r",
        delta: "think",
      },
    },
    {
      type: "session.next.tool.called",
      properties: {
        sessionID: sourceId,
        assistantMessageID: "m",
        callID: "c",
        tool: "read",
        input: {},
      },
    },
    {
      type: "session.next.tool.success",
      properties: {
        sessionID: sourceId,
        assistantMessageID: "m",
        callID: "c",
      },
    },
    {
      type: "session.next.step.ended",
      properties: {
        sessionID: sourceId,
        assistantMessageID: "m",
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
    {
      type: "session.diff",
      properties: {
        sessionID: sourceId,
        diff: [{ file: "README.md", patch: "+x", additions: 1, deletions: 0 }],
      },
    },
    {
      type: "todo.updated",
      properties: {
        sessionID: sourceId,
        todos: [{ content: "test", status: "pending", priority: "medium" }],
      },
    },
    {
      type: "permission.v2.asked",
      properties: {
        id: "permission",
        sessionID: sourceId,
        action: "edit",
        resources: ["*"],
      },
    },
  ] as unknown as ReadonlyArray<Event>;
}

function makeBetaHarnessDriver(
  source: EventSourceFixture,
  handlers: {
    readonly onPrompt: (
      sessionId: string,
      bridge: { readonly url: string; readonly session: string } | undefined,
    ) => void;
    readonly onAbort: (sessionId: string) => void;
  },
  options: {
    readonly mcp?: "refused";
    /** The runtime's `--version` line; 2.0.22 when unstated. */
    readonly version?: string;
    readonly compact?: (sessionId: string) => Promise<void>;
  } = {},
) {
  const version = options.version ?? "opencode v2.0.22";
  let released = false;
  let bridge: { readonly url: string; readonly session: string } | undefined;
  const launchScratch = realpathSync(mkdtempSync(join(tmpdir(), "octant-opencode-launch-")));
  const session = {
    id: "provider-session",
    directory: projectRoot,
    model: { id: "claude-sonnet", providerID: "anthropic" },
  };
  const client: OpenCodeClientPort = {
    health: async () => ({ healthy: true, version }),
    providers: async () => ({ all: [provider()], connected: ["anthropic"] }),
    subscribe: async () => source,
    createSession: async () => session,
    getSession: async (id) => {
      if (id === "stale") throw new Error("not found");
      return session;
    },
    prompt: async ({ sessionId: nativeId }) => {
      handlers.onPrompt(nativeId, bridge);
    },
    // A 2.x server connects to the bridge it is given, as 1.x does; a fixture
    // that never connects leaves the probe waiting out its attestation timeout.
    addMcpServer: async ({ url }) => {
      // A runtime without a supported MCP route refuses the registration, as
      // 2.0.22 answers the 1.x `POST /mcp` with 405.
      if (options.mcp === "refused") {
        throw new Error("OpenCode 2 MCP registration failed with status 405.");
      }
      bridge = { url, session: await attestManagedBridge(url) };
    },
    disconnectMcpServer: async () => undefined,
    abort: async (nativeId) => {
      handlers.onAbort(nativeId);
    },
    ...(options.compact === undefined ? {} : { compact: options.compact }),
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    deleteSession: async () => undefined,
  };
  return {
    isReleased: () => released,
    driver: makeOpenCodeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/opencode",
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              isolatedConfiguration: true,
              authorization: "Basic redacted",
              pid: process.pid,
              runtime: "beta" as const,
              version,
              temporaryDirectory: launchScratch,
              url: new URL("http://127.0.0.1:1/"),
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      clientFactory: () => client,
      idleLeaseMs: 0,
      permissionPersistence: () => "current-session",
      clock: () => "2026-07-15T00:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000203",
    }),
  };
}
