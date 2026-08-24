import type {
  BrowserActionRequest,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserThreadId,
  ToolActionAuthority,
  ToolActionRequest,
  WindowId,
} from "@octant/contracts";
import { decodeToolActionRequest } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserAutomationService,
  createBrowserToolCallAuthorityService,
} from "./browserAutomationService";
import { BrowserNavigationBlockedError, type BrowserRuntimePort } from "./browserRuntimePort";

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const otherWindowId = "10000000-0000-4000-8000-000000000002" as WindowId;
const threadOne = "20000000-0000-4000-8000-000000000001" as BrowserThreadId;
const threadTwo = "20000000-0000-4000-8000-000000000002" as BrowserThreadId;
const contextOne = "30000000-0000-4000-8000-000000000001" as BrowserContextId;
const authorityOne: ToolActionAuthority = {
  hostId: "40000000-0000-4000-8000-000000000001" as any,
  mode: "work",
  projectId: "50000000-0000-4000-8000-000000000001" as any,
  rootId: "60000000-0000-4000-8000-000000000001" as any,
  providerInstanceId: "70000000-0000-4000-8000-000000000001" as any,
  extension: { kind: "core" },
};
const authorityTwo: ToolActionAuthority = {
  ...authorityOne,
  projectId: "50000000-0000-4000-8000-000000000002" as any,
  rootId: "60000000-0000-4000-8000-000000000002" as any,
};
const policy: BrowserContextPolicy = {
  profileMode: "isolated",
  allowedOrigins: ["https://example.com"],
  credentialFieldProtection: true,
  maxConcurrentTabs: 1,
  sessionTimeoutMs: 300_000,
};

function action(authority: ToolActionAuthority = authorityOne): ToolActionRequest {
  return {
    actionId: "80000000-0000-4000-8000-000000000001" as any,
    correlationId: "90000000-0000-4000-8000-000000000001" as any,
    capability: { id: "browser-automation" as any, version: 1 },
    authority,
    intent: "Open an isolated browser context.",
    approval: { kind: "not-required" },
  };
}

function request(overrides: Partial<BrowserActionRequest> = {}): BrowserActionRequest {
  return {
    actionId: action().actionId,
    contextId: contextOne,
    correlationId: action().correlationId,
    authority: authorityOne,
    kind: "navigate",
    target: "https://example.com/start",
    ...overrides,
  };
}

function harness(
  options: {
    readonly recordExternalContentIngestion?: ConstructorParameters<
      typeof BrowserAutomationService
    >[0]["recordExternalContentIngestion"];
  } = {},
) {
  const contexts = new Set<BrowserContextId>();
  const revokedThreads = new Set<BrowserThreadId>();
  let processExit: (() => void) | undefined;
  let expire: (() => void) | undefined;
  let now = Date.parse("2026-07-27T20:00:00.000Z");
  const runtime: BrowserRuntimePort = {
    available: vi.fn(async () => true),
    createContext: vi.fn(async (contextId) => void contexts.add(contextId)),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    act: vi.fn(async (contextId, input) => {
      if (!contexts.has(contextId)) throw new Error("missing context");
      return {
        url: input.target ?? "https://example.com/start",
        title: contextId === contextOne ? "Thread one" : "Thread two",
        contentHash: String(contextId),
      };
    }),
    closeContext: vi.fn(async (contextId) => void contexts.delete(contextId)),
    closeAll: vi.fn(async () => void contexts.clear()),
    onProcessExit: (listener) => {
      processExit = listener;
      return () => {
        processExit = undefined;
      };
    },
  };
  const ids = [contextOne, "30000000-0000-4000-8000-000000000002"];
  const service = new BrowserAutomationService({
    runtime,
    authority: {
      resolve: (threadId) =>
        revokedThreads.has(threadId)
          ? undefined
          : threadId === threadOne
            ? authorityOne
            : threadId === threadTwo
              ? authorityTwo
              : undefined,
    },
    ...(options.recordExternalContentIngestion === undefined
      ? {}
      : { recordExternalContentIngestion: options.recordExternalContentIngestion }),
    uuid: () => ids.shift() ?? crypto.randomUUID(),
    clock: () => "2026-07-27T20:00:00.000Z",
    now: () => now,
    schedule: (_delay, callback) => {
      expire = callback;
      return () => {
        expire = undefined;
      };
    },
  });
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    contexts,
    expire: () => expire?.(),
    processExit: () => processExit?.(),
    revoke: (threadId: BrowserThreadId) => void revokedThreads.add(threadId),
    runtime,
    service,
  };
}

describe("BrowserAutomationService", () => {
  it("fails closed when the default authority cannot read thread taint", () => {
    const authorityService = createBrowserToolCallAuthorityService(
      { resolve: () => authorityOne },
      () => "2026-08-24T00:00:00.000Z",
    );
    const request = decodeToolActionRequest({
      actionId: action().actionId,
      correlationId: action().correlationId,
      capability: { id: "computer-use", version: 1 },
      authority: authorityOne,
      intent: "Observe the external application.",
      approval: { kind: "not-required" },
    });

    const decision = authorityService.authorize({
      threadId: String(threadOne),
      request,
      arguments: {
        allowlist: [{ actionKind: "screenshot", requiresApproval: false }],
        sensitiveFieldProtection: true,
        visibleStopControl: true,
        maxSessionDurationMs: 60_000,
        processOwnershipRequired: true,
      },
    });

    expect(decision).toMatchObject({
      kind: "prompt",
      reason: "taint-requires-fresh-confirmation",
    });
  });

  it("projects the runtime presentation selected for the owning window", async () => {
    const { runtime, service } = harness();
    vi.mocked(runtime.createContext).mockResolvedValueOnce("headless");

    const created = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy,
    });
    expect(created.context?.presentation).toBe("headless");
  });

  it("reattaches one current context per window and thread and releases only that scope", async () => {
    const { contexts, runtime, service } = harness();
    const first = await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const reused = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy,
    });
    const second = await service.create({
      windowId,
      threadId: threadTwo,
      action: action(authorityTwo),
      policy,
    });

    expect(reused.context?.contextId).toBe(first.context?.contextId);
    expect(runtime.createContext).toHaveBeenCalledTimes(2);
    expect(service.inspectThread(windowId, threadOne).context?.contextId).toBe(contextOne);

    await service.releaseThread(windowId, threadOne);

    expect(contexts.has(contextOne)).toBe(false);
    expect(service.inspectThread(windowId, threadOne)).toEqual({
      status: "ready",
      threadId: threadOne,
      evidence: [],
    });
    expect(service.inspectThread(windowId, threadTwo).context?.contextId).toBe(
      second.context?.contextId,
    );
  });

  it("joins an in-flight context creation before returning the shared active context", async () => {
    const { runtime, service } = harness();
    let releaseCreate!: () => void;
    vi.mocked(runtime.createContext).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCreate = resolve;
        }),
    );

    const first = service.create({ windowId, threadId: threadOne, action: action(), policy });
    await vi.waitFor(() => expect(releaseCreate).toBeTypeOf("function"));
    let secondSettled = false;
    const second = service
      .create({ windowId, threadId: threadOne, action: action(), policy })
      .finally(() => {
        secondSettled = true;
      });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseCreate();
    await expect(first).resolves.toMatchObject({ status: "running" });
    await expect(second).resolves.toMatchObject({
      status: "running",
      context: { contextId: contextOne, state: "active" },
    });
    expect(runtime.createContext).toHaveBeenCalledOnce();
  });

  it("joins the reserved shared context during an in-flight runtime availability probe", async () => {
    const { runtime, service } = harness();
    let releaseAvailability!: () => void;
    vi.mocked(runtime.available).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseAvailability = () => resolve(true);
        }),
    );

    const first = service.create({ windowId, threadId: threadOne, action: action(), policy });
    await vi.waitFor(() => expect(releaseAvailability).toBeTypeOf("function"));
    let secondSettled = false;
    const second = service
      .create({ windowId, threadId: threadOne, action: action(), policy })
      .finally(() => {
        secondSettled = true;
      });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(runtime.available).toHaveBeenCalledOnce();
    expect(runtime.createContext).not.toHaveBeenCalled();
    releaseAvailability();

    await expect(second).resolves.toMatchObject({
      status: "running",
      context: { contextId: contextOne, state: "active" },
    });
    await expect(first).resolves.toMatchObject({
      status: "running",
      context: { contextId: contextOne },
    });
    expect(runtime.createContext).toHaveBeenCalledOnce();
  });

  it("does not create an orphan context when its thread is released during availability", async () => {
    const { contexts, runtime, service } = harness();
    let releaseAvailability!: () => void;
    vi.mocked(runtime.available).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseAvailability = () => resolve(true);
        }),
    );

    const creating = service.create({ windowId, threadId: threadOne, action: action(), policy });
    await vi.waitFor(() => expect(releaseAvailability).toBeTypeOf("function"));
    await expect(service.releaseThread(windowId, threadOne)).resolves.toEqual({
      status: "ready",
      threadId: threadOne,
      evidence: [],
    });
    releaseAvailability();

    await expect(creating).resolves.toMatchObject({ status: "ready" });
    expect(runtime.createContext).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(0);
    expect(service.inspectThread(windowId, threadOne)).toEqual({
      status: "ready",
      threadId: threadOne,
      evidence: [],
    });
  });

  it("revalidates the original create authority after an availability wait", async () => {
    const { revoke, runtime, service } = harness();
    let releaseAvailability!: () => void;
    vi.mocked(runtime.available).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseAvailability = () => resolve(true);
        }),
    );

    const creating = service.create({ windowId, threadId: threadOne, action: action(), policy });
    await vi.waitFor(() => expect(releaseAvailability).toBeTypeOf("function"));
    revoke(threadOne);
    releaseAvailability();

    await expect(creating).resolves.toMatchObject({
      status: "failed",
      failure: { category: "unauthorized" },
    });
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("creates isolated contexts for two threads and prevents cross-thread control", async () => {
    const { runtime, service } = harness();
    const first = await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const second = await service.create({
      windowId,
      threadId: threadTwo,
      action: action(authorityTwo),
      policy,
    });

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(first.context?.contextId).not.toBe(second.context?.contextId);
    expect(runtime.createContext).toHaveBeenCalledTimes(2);

    const denied = await service.act({
      windowId,
      request: request({
        contextId: second.context!.contextId,
        authority: authorityOne,
      }),
    });
    expect(denied.failure?.category).toBe("unauthorized");
    expect(denied.context).toBeUndefined();
    expect(denied.observation).toBeUndefined();
    expect(denied.evidence).toEqual([]);
    expect(service.inspect(windowId, threadTwo, second.context!.contextId).status).toBe("running");
    expect(runtime.act).not.toHaveBeenCalled();
  });

  it("does not disclose or mutate a context through another window", async () => {
    const { service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const denied = service.inspect(otherWindowId, threadOne, contextOne);
    expect(denied.failure?.category).toBe("unauthorized");
    expect(denied.context).toBeUndefined();
    expect(denied.evidence).toEqual([]);
    expect(service.inspect(windowId, threadOne, contextOne).status).toBe("running");
  });

  it("does not disclose or stop a context through another thread in the same window", async () => {
    const { runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });

    const deniedInspect = service.inspect(windowId, threadTwo, contextOne);
    expect(deniedInspect.failure?.category).toBe("unauthorized");
    expect(deniedInspect.context).toBeUndefined();
    const deniedStop = await service.stop(windowId, threadTwo, contextOne);
    expect(deniedStop.failure?.category).toBe("unauthorized");
    expect(runtime.closeContext).not.toHaveBeenCalled();
    expect(service.inspect(windowId, threadOne, contextOne).status).toBe("running");
  });

  it("fails closed before creating a context when authority mismatches", async () => {
    const { runtime, service } = harness();
    const snapshot = await service.create({
      windowId,
      threadId: threadOne,
      action: action(authorityTwo),
      policy,
    });
    expect(snapshot.failure?.category).toBe("unauthorized");
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("denies unknown tools through the tool-call policy choke point before side effects", async () => {
    const { runtime, service } = harness();
    const invented = {
      ...action(),
      capability: { id: "model-invented-shell" as any, version: 1 },
    };
    const snapshot = await service.create({
      windowId,
      threadId: threadOne,
      action: invented,
      policy,
    });
    expect(snapshot.failure?.category).toBe("invalid");
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("re-resolves authority before effects and destroys a revoked context", async () => {
    const { contexts, revoke, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    revoke(threadOne);
    const denied = await service.act({ windowId, request: request() });
    expect(denied.failure?.category).toBe("unauthorized");
    expect(denied.context).toBeUndefined();
    expect(runtime.act).not.toHaveBeenCalled();
    expect(runtime.closeContext).toHaveBeenCalledWith(contextOne);
    expect(contexts.has(contextOne)).toBe(false);
  });

  it("does not disclose a stored observation after thread authority is revoked", async () => {
    const { revoke, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const observed = await service.act({ windowId, request: request() });
    expect(observed.observation?.title).toBe("Thread one");

    revoke(threadOne);
    const denied = service.inspectThread(windowId, threadOne);

    expect(denied).toMatchObject({
      status: "failed",
      failure: { category: "unauthorized" },
    });
    expect(denied.context).toBeUndefined();
    expect(denied.observation).toBeUndefined();
    expect(denied.evidence).toEqual([]);
    await vi.waitFor(() => expect(runtime.closeContext).toHaveBeenCalledWith(contextOne));
  });

  it("validates authority before reusing a current context", async () => {
    const { revoke, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    revoke(threadOne);

    const denied = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy,
    });

    expect(denied.failure?.category).toBe("unauthorized");
    expect(denied.context).toBeUndefined();
    expect(runtime.createContext).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(runtime.closeContext).toHaveBeenCalledWith(contextOne));
  });

  it("rejects an empty runtime navigation allowlist", async () => {
    const { runtime, service } = harness();
    const result = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy: { ...policy, allowedOrigins: [] },
    });
    expect(result.failure?.category).toBe("policy-denied");
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("denies disallowed navigation and sensitive-field typing before the side effect", async () => {
    const { runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });

    const deniedOrigin = await service.act({
      windowId,
      request: request({ target: "https://evil.example/phish" }),
    });
    expect(deniedOrigin.failure?.category).toBe("policy-denied");
    expect(runtime.act).not.toHaveBeenCalled();

    vi.mocked(runtime.inspectTarget).mockResolvedValueOnce({ sensitive: true });
    const deniedCredential = await service.act({
      windowId,
      request: request({ kind: "type", target: "#password", value: "secret" }),
    });
    expect(deniedCredential.failure?.category).toBe("credential-protected");
    expect(runtime.act).not.toHaveBeenCalled();

    const stopped = await service.stop(windowId, threadOne, contextOne);
    expect(stopped).toMatchObject({ status: "ready", context: { state: "stopped" } });
    expect(stopped.failure).toBeUndefined();
    expect(service.inspectThread(windowId, threadOne)).toEqual({
      status: "ready",
      threadId: threadOne,
      evidence: [],
    });
    expect(() => service.inspect(windowId, threadOne, contextOne)).toThrow(
      "Browser context is stale or unknown.",
    );
  });

  it("journals browser observations as tainting tool results once", async () => {
    const recordExternalContentIngestion = vi.fn(() => ({
      kind: "recorded" as const,
      taint: { externalContentIngested: true, ingestedSources: ["browser-observation"] },
    }));
    const { service } = harness({ recordExternalContentIngestion });
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const completed = await service.act({ windowId, request: request() });

    expect(completed.evidence).toHaveLength(1);
    expect(recordExternalContentIngestion).toHaveBeenCalledTimes(1);
    expect(recordExternalContentIngestion).toHaveBeenCalledWith({
      threadId: threadOne,
      provenance: { origin: "tool-result", sourceLabel: "browser-observation" },
      contentReference: completed.evidence[0]?.reference,
      correlationId: action().correlationId,
      authorized: true,
    });
  });

  it("records correlated evidence and marks process death stale", async () => {
    const { processExit, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const completed = await service.act({ windowId, request: request() });
    expect(completed.observation).toMatchObject({
      actionId: action().actionId,
      correlationId: action().correlationId,
      stale: false,
    });
    expect(completed.evidence).toHaveLength(1);
    expect(completed.evidence[0]).toMatchObject({
      actionId: action().actionId,
      correlationId: action().correlationId,
      authority: authorityOne,
    });

    processExit();
    expect(service.inspect(windowId, threadOne, contextOne).status).toBe("stale");
  });

  it("retains only a bounded tail of correlated evidence", async () => {
    const { service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });

    let latest;
    for (let index = 0; index < 40; index += 1) {
      latest = await service.act({
        windowId,
        request: request({ target: `https://example.com/${index}` }),
      });
    }

    expect(latest?.evidence).toHaveLength(32);
  });

  it("serializes user and agent actions against the shared context", async () => {
    const { runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    let finishFirst!: () => void;
    vi.mocked(runtime.act)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve({ url: "https://example.com/first", title: "First" });
          }),
      )
      .mockResolvedValueOnce({ url: "https://example.com/second", title: "Second" });

    const first = service.act({
      windowId,
      request: request({ target: "https://example.com/first" }),
    });
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf("function"));
    const second = service.act({
      windowId,
      request: request({ target: "https://example.com/second" }),
    });
    await Promise.resolve();
    expect(runtime.act).toHaveBeenCalledOnce();

    finishFirst();
    await expect(first).resolves.toMatchObject({ observation: { title: "First" } });
    await expect(second).resolves.toMatchObject({ observation: { title: "Second" } });
    expect(vi.mocked(runtime.act).mock.calls.map(([, input]) => input.target)).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
  });

  it("refreshes a stale web-preview action without executing it", async () => {
    const { runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const current = await service.act({ windowId, request: request() });
    vi.mocked(runtime.act).mockClear();

    const refreshed = await service.act({
      windowId,
      request: request({ expectedObservationRevision: 0 }),
    });

    expect(runtime.act).not.toHaveBeenCalled();
    expect(refreshed).toEqual(current);
    expect(refreshed.observation?.revision).toBe(1);
  });

  it("cancels and destroys the owned context", async () => {
    const { contexts, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const cancelled = await service.cancel({
      windowId,
      threadId: threadOne,
      contextId: contextOne,
      cancellation: {
        actionId: action().actionId,
        correlationId: action().correlationId,
        authority: authorityOne,
        reason: "user-requested",
      },
    });
    expect(cancelled.status).toBe("interrupted");
    expect(contexts.has(contextOne)).toBe(false);
    expect(runtime.closeContext).toHaveBeenCalledWith(contextOne);
    expect(service.inspectThread(windowId, threadOne)).toEqual({
      status: "ready",
      threadId: threadOne,
      evidence: [],
    });
    expect(() => service.inspect(windowId, threadOne, contextOne)).toThrow(
      "Browser context is stale or unknown.",
    );
  });

  it("proactively destroys an expired context without waiting for another request", async () => {
    const { contexts, expire, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    expire();
    await vi.waitFor(() =>
      expect(service.inspectThread(windowId, threadOne)).toEqual({
        status: "ready",
        threadId: threadOne,
        evidence: [],
      }),
    );
    expect(runtime.closeContext).toHaveBeenCalledWith(contextOne);
    expect(contexts.has(contextOne)).toBe(false);
  });

  it("reports synchronous reconnect inspection as stale when expiry is discovered", async () => {
    const { advance, contexts, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    advance(policy.sessionTimeoutMs);
    expect(service.inspect(windowId, threadOne, contextOne)).toMatchObject({
      status: "stale",
      context: { state: "expired", stopReason: "timeout" },
      failure: { category: "context-expired" },
    });
    await vi.waitFor(() => expect(contexts.has(contextOne)).toBe(false));
    expect(runtime.closeContext).toHaveBeenCalledWith(contextOne);
  });

  it("does not rewrite an explicitly stopped context as expired later", async () => {
    const { advance, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    await service.stop(windowId, threadOne, contextOne);
    advance(policy.sessionTimeoutMs);
    expect(service.inspectThread(windowId, threadOne)).toEqual({
      status: "ready",
      threadId: threadOne,
      evidence: [],
    });
  });

  it("deletes window-owned contexts after window authority is revoked", async () => {
    const { service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });

    await service.revokeWindow(windowId);

    expect(service.inspectThread(windowId, threadOne)).toEqual({
      status: "ready",
      threadId: threadOne,
      evidence: [],
    });
    expect(() => service.inspect(windowId, threadOne, contextOne)).toThrow(
      "Browser context is stale or unknown.",
    );
  });

  it("still expires and marks process death after a policy denial", async () => {
    const first = harness();
    await first.service.create({ windowId, threadId: threadOne, action: action(), policy });
    await first.service.act({
      windowId,
      request: request({ target: "https://evil.example/phish" }),
    });
    first.expire();
    await vi.waitFor(() => expect(first.contexts.has(contextOne)).toBe(false));

    const second = harness();
    await second.service.create({ windowId, threadId: threadOne, action: action(), policy });
    await second.service.act({
      windowId,
      request: request({ target: "https://evil.example/phish" }),
    });
    second.processExit();
    expect(second.service.inspect(windowId, threadOne, contextOne)).toMatchObject({
      status: "stale",
      failure: { category: "stale" },
    });
  });

  it("gives each dedicated context its own life beside the thread's shared one", async () => {
    // Opening a second classified local server must not take over or
    // destroy the first server's session.
    const { contexts, runtime, service } = harness();
    const shared = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy,
    });
    const first = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy: { ...policy, allowedOrigins: ["http://127.0.0.1:5173"] },
      dedicated: true,
    });
    const second = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy: { ...policy, allowedOrigins: ["http://127.0.0.1:4321"] },
      dedicated: true,
    });

    expect(runtime.createContext).toHaveBeenCalledTimes(3);
    const ids = [shared, first, second].map((snapshot) => snapshot.context?.contextId);
    expect(new Set(ids).size).toBe(3);
    for (const contextId of ids) {
      expect(contexts.has(contextId!)).toBe(true);
      expect(service.inspect(windowId, threadOne, contextId!).context?.state).toBe("active");
    }
    // The first server's context keeps the origin it was opened for.
    expect(first.context?.policy.allowedOrigins).toEqual(["http://127.0.0.1:5173"]);
    // The ordinary Browser surface still reattaches to the thread's own context.
    expect(service.inspectThread(windowId, threadOne).context?.contextId).toBe(
      shared.context?.contextId,
    );
  });

  it("accepts one localhost certificate only for a loopback HTTPS context", async () => {
    const { runtime, service } = harness();
    const accepted = await service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy: {
        ...policy,
        allowedOrigins: ["https://127.0.0.1:8443"],
        acceptsLocalCertificate: true,
      },
      dedicated: true,
    });
    expect(accepted.context?.state).toBe("active");
    expect(runtime.createContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acceptsLocalCertificate: true }),
      expect.anything(),
      expect.anything(),
    );

    const refused = await service.create({
      windowId,
      threadId: threadTwo,
      action: action(authorityTwo),
      policy: {
        ...policy,
        allowedOrigins: ["https://example.com"],
        acceptsLocalCertificate: true,
      },
      dedicated: true,
    });
    expect(refused.failure).toEqual({
      category: "policy-denied",
      message: "Browser context policy exceeds host limits.",
    });
  });

  it("names the refused origin when a navigation redirects outside the allowlist", async () => {
    const { runtime, service } = harness();
    vi.mocked(runtime.act).mockRejectedValueOnce(
      new BrowserNavigationBlockedError("https://www.example.com/"),
    );
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const failed = await service.act({ windowId, request: request() });
    expect(failed.failure).toEqual({
      category: "policy-denied",
      message:
        "The page moved to https://www.example.com, which is outside this session's allowed origin. Open https://www.example.com/ directly to browse it there.",
    });
  });

  it("normalizes runtime errors without exposing diagnostics", async () => {
    const { runtime, service } = harness();
    vi.mocked(runtime.act).mockRejectedValueOnce(new Error("private runtime diagnostics"));
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const failed = await service.act({ windowId, request: request() });
    expect(failed.failure).toEqual({
      category: "failed",
      message: "The browser action failed.",
    });
  });
});
