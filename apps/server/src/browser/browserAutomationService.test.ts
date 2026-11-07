import { decodeBrowserPageScriptPreparation } from "@octant/contracts/browser-page-script";
import { Schema } from "effect";
import { HubMemberId, UtcTimestamp } from "@octant/contracts";
import {
  decodeOwnerBrowserControlId,
  OwnerBrowserNativeTarget,
} from "@octant/contracts/owner-browser";
function importPlanId() {
  const result = decodeBrowserPageScriptPreparation({
    status: "prepared",
    planId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  if (result.status !== "prepared") throw new Error("expected prepared");
  return result.planId;
}
import type {
  BrowserActionRequest,
  BrowserCaptureId,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserThreadId,
  ToolActionAuthority,
  ToolActionRequest,
  WindowId,
} from "@octant/contracts";
import {
  decodeBrowserAutomationFailure,
  decodeWindowId,
  MAX_BROWSER_THREAD_CONTEXTS,
} from "@octant/contracts";
import { decodeBrowserCredentialCommand } from "@octant/contracts/browser-credential-use";
import { decodeToolActionRequest } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserAutomationService,
  createBrowserToolCallAuthorityService,
} from "./browserAutomationService";
import { createBrowserAppManagedTools, type BrowserModelBinding } from "./browserAppManagedTools";
import type { KeepBrowserCaptureInput, RecordBrowserStepInput } from "./browserCaptureService";
import {
  BrowserNavigationBlockedError,
  BrowserRecordingUnavailableError,
  type BrowserRuntimePort,
} from "./browserRuntimePort";

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
    readonly authority?: ToolActionAuthority;
    readonly ownerControl?: BrowserRuntimePort["ownerControl"];
    readonly access?: boolean;
    readonly pageScriptPolicy?: ConstructorParameters<
      typeof BrowserAutomationService
    >[0]["pageScriptPolicy"];
    readonly recordExternalContentIngestion?: ConstructorParameters<
      typeof BrowserAutomationService
    >[0]["recordExternalContentIngestion"];
    readonly captures?: ConstructorParameters<typeof BrowserAutomationService>[0]["captures"];
    readonly agentDownloadsEnabled?: boolean;
    readonly downloads?: ConstructorParameters<typeof BrowserAutomationService>[0]["downloads"];
    readonly observed?: Partial<Awaited<ReturnType<BrowserRuntimePort["act"]>>>;
    readonly unattended?: boolean;
    readonly delegatedProfileIsCurrent?: () => boolean;
    readonly sharedRuntime?: boolean;
    readonly describePoint?: BrowserRuntimePort["describePoint"];
  } = {},
) {
  const contexts = new Set<BrowserContextId>();
  const revokedThreads = new Set<BrowserThreadId>();
  let processExit: (() => void) | undefined;
  let personInput: ((contextId: BrowserContextId) => void) | undefined;
  let expire: (() => void) | undefined;
  const timers: Array<{ delay: number; run: () => void }> = [];
  let now = Date.parse("2026-07-27T20:00:00.000Z");
  const runtime: BrowserRuntimePort = {
    ...(options.ownerControl === undefined ? {} : { ownerControl: options.ownerControl }),
    available: vi.fn(async () => true),
    nativeAvailable: vi.fn(async () => true),
    createContext: vi.fn(async (contextId) => void contexts.add(contextId)),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    ...(options.describePoint === undefined ? {} : { describePoint: options.describePoint }),
    validateCredentialFill: vi.fn(async () => true),
    runPageScript: vi.fn(async () => ({ status: "refused" as const, effect: "none" as const })),
    act: vi.fn(async (contextId, input) => {
      if (!contexts.has(contextId)) throw new Error("missing context");
      return {
        url: input.target ?? "https://example.com/start",
        title: contextId === contextOne ? "Thread one" : "Thread two",
        contentHash: String(contextId),
        // Every action's picture reaches the model; only an explicit
        // screenshot is ever a candidate for a thread capture.
        screenshotDataUrl: "data:image/png;base64,AAAA",
        ...options.observed,
      };
    }),
    peek: vi.fn(async (contextId) => {
      if (!contexts.has(contextId)) throw new Error("missing context");
      return {
        url: "https://example.com/driven",
        title: "Driven by hand",
        screenshotDataUrl: "data:image/jpeg;base64,AAAA",
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
    onPersonInput: (listener) => {
      personInput = listener;
      return () => {
        personInput = undefined;
      };
    },
  };
  const ids = [contextOne, "30000000-0000-4000-8000-000000000002"];
  const service = new BrowserAutomationService({
    runtime,
    ...(options.pageScriptPolicy === undefined
      ? {}
      : { pageScriptPolicy: options.pageScriptPolicy }),
    authority: {
      canAccessWindow: () => options.access ?? true,
      resolve: (threadId) =>
        revokedThreads.has(threadId)
          ? undefined
          : threadId === threadOne
            ? (options.authority ?? authorityOne)
            : threadId === threadTwo
              ? authorityTwo
              : undefined,
    },
    ...(options.recordExternalContentIngestion === undefined
      ? {}
      : { recordExternalContentIngestion: options.recordExternalContentIngestion }),
    ...(options.captures === undefined ? {} : { captures: options.captures }),
    ...(options.agentDownloadsEnabled === undefined
      ? {}
      : { agentDownloadsEnabled: () => options.agentDownloadsEnabled === true }),
    ...(options.downloads === undefined ? {} : { downloads: options.downloads }),
    ...(options.unattended === true ? { isUnattendedScope: () => true } : {}),
    ...(options.delegatedProfileIsCurrent === undefined
      ? {}
      : { delegatedProfileIsCurrent: options.delegatedProfileIsCurrent }),
    ...(options.sharedRuntime === true ? { sharedRuntime: true } : {}),
    uuid: () => ids.shift() ?? crypto.randomUUID(),
    clock: () => new Date(now).toISOString(),
    now: () => now,
    schedule: (delay, callback) => {
      timers.push({ delay, run: callback });
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
    timers,
    expire: () => expire?.(),
    processExit: () => processExit?.(),
    personTyped: (contextId: BrowserContextId = contextOne) => personInput?.(contextId),
    revoke: (threadId: BrowserThreadId) => void revokedThreads.add(threadId),
    runtime,
    service,
  };
}

describe("BrowserAutomationService", () => {
  it("opens an explicitly delegated signed-in context and withholds a revoked in-flight observation", async () => {
    let current = true;
    const f = harness({ unattended: true, delegatedProfileIsCurrent: () => current });
    const opened = await f.service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy: { ...policy, profile: { kind: "personal" } },
    });
    expect(opened.context?.state).toBe("active");
    vi.mocked(f.runtime.act).mockImplementation(async () => {
      current = false;
      return { url: "https://example.com", extractedText: "must be withheld" };
    });
    const result = await f.service.act({
      windowId,
      threadId: threadOne,
      request: request(),
      capturedBy: "agent",
    });
    expect(result.observation).toBeUndefined();
    expect(result.failure?.category).toBe("unauthorized");
    await f.service.close();
  });

  it("closes only its own contexts when a delegated service borrows the native runtime", async () => {
    const f = harness({ sharedRuntime: true });
    await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
    await f.service.close();
    expect(f.runtime.closeAll).not.toHaveBeenCalled();
    expect(f.runtime.closeContext).toHaveBeenCalledWith(contextOne);
  });
  it.each([
    { mode: "work" as const, unattended: false, dedicated: false },
    { mode: "code" as const, unattended: true, dedicated: false },
    { mode: "code" as const, unattended: false, dedicated: true },
  ])(
    "does not offer an owner target for excluded resource %j",
    async ({ mode, unattended, dedicated }) => {
      const authority = { ...authorityOne, mode };
      const ownerControl = vi.fn<NonNullable<BrowserRuntimePort["ownerControl"]>>(async () => ({
        status: "refused",
      }));
      const f = harness({ authority, unattended, ownerControl });
      vi.mocked(f.runtime.createContext).mockImplementationOnce(async (id) => {
        f.contexts.add(id);
        return "native-live";
      });
      await f.service.create({
        windowId,
        threadId: threadOne,
        action: action(authority),
        policy,
        dedicated,
      });
      const host = f.service.ownerBrowserHost({
        hostMemberId: () =>
          Schema.decodeUnknownSync(HubMemberId)("a7880000-0000-4000-8000-000000000001"),
        threadTitle: () => "Synthetic task",
      });
      expect(await host.targets()).toEqual([]);
      expect(ownerControl).not.toHaveBeenCalled();
      await f.service.close();
    },
  );

  it("does not let an old delayed native release hand back a successor's person hold", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const authority = { ...authorityOne, mode: "code" as const };
    const target = Schema.decodeUnknownSync(OwnerBrowserNativeTarget)({
      targetVersion: "a".repeat(64),
      documentRevision: 1,
      origin: "https://example.com",
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstId = decodeOwnerBrowserControlId("a7880000-0000-4000-8000-000000000002");
    const secondId = decodeOwnerBrowserControlId("a7880000-0000-4000-8000-000000000003");
    const ownerControl = vi.fn<NonNullable<BrowserRuntimePort["ownerControl"]>>(async (command) => {
      if (command.operation === "inspect") return { status: "target", target };
      if (command.operation === "claim") return { status: "claimed" };
      if (command.operation === "release") {
        if (command.controlId === firstId) {
          entered.resolve();
          await release.promise;
        }
        return { status: "released" };
      }
      return { status: "refused" };
    });
    const f = harness({ authority, ownerControl });
    try {
      vi.mocked(f.runtime.createContext).mockImplementationOnce(async (id) => {
        f.contexts.add(id);
        return "native-live";
      });
      await f.service.create({ windowId, threadId: threadOne, action: action(authority), policy });
      const host = f.service.ownerBrowserHost({
        hostMemberId: () =>
          Schema.decodeUnknownSync(HubMemberId)("a7880000-0000-4000-8000-000000000001"),
        threadTitle: () => "Synthetic task",
      });
      const page = (await host.targets())[0]?.target;
      if (page === undefined) throw new Error("Expected native page");
      expect(
        await host.claim(
          page,
          firstId,
          "First owner",
          Schema.decodeUnknownSync(UtcTimestamp)(new Date(now + 60_000).toISOString()),
        ),
      ).toBe(true);
      const old = host.release(page, firstId, "hand-back");
      await entered.promise;
      clock.mockReturnValue(now + 61_000);
      expect(
        await host.claim(
          page,
          secondId,
          "Second owner",
          Schema.decodeUnknownSync(UtcTimestamp)(new Date(now + 120_000).toISOString()),
        ),
      ).toBe(true);
      release.resolve();
      await old;
      expect(f.service.inspectThread(windowId, threadOne).ownerController?.name).toBe(
        "Second owner",
      );
      expect(f.service.inspectThread(windowId, threadOne).waitingForPerson).toBe("take-over");
    } finally {
      release.resolve();
      await f.service.close();
      clock.mockRestore();
    }
  });

  it("keeps the person hold when revocation overlaps a delayed native handback", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const authority = { ...authorityOne, mode: "code" as const };
    const target = Schema.decodeUnknownSync(OwnerBrowserNativeTarget)({
      targetVersion: "a".repeat(64),
      documentRevision: 1,
      origin: "https://example.com",
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const revokeRelease = Promise.withResolvers<void>();
    const firstId = decodeOwnerBrowserControlId("a7880000-0000-4000-8000-000000000002");
    let releases = 0;
    const ownerControl = vi.fn<NonNullable<BrowserRuntimePort["ownerControl"]>>(async (command) => {
      if (command.operation === "inspect") return { status: "target", target };
      if (command.operation === "claim") return { status: "claimed" };
      if (command.operation === "release") {
        if (releases++ === 0) {
          entered.resolve();
          await release.promise;
        } else {
          await revokeRelease.promise;
        }
        return { status: "released" };
      }
      return { status: "refused" };
    });
    const f = harness({ authority, ownerControl });
    try {
      vi.mocked(f.runtime.createContext).mockImplementationOnce(async (id) => {
        f.contexts.add(id);
        return "native-live";
      });
      await f.service.create({ windowId, threadId: threadOne, action: action(authority), policy });
      const host = f.service.ownerBrowserHost({
        hostMemberId: () =>
          Schema.decodeUnknownSync(HubMemberId)("a7880000-0000-4000-8000-000000000001"),
        threadTitle: () => "Synthetic task",
      });
      const page = (await host.targets())[0]?.target;
      if (page === undefined) throw new Error("Expected native page");
      expect(
        await host.claim(
          page,
          firstId,
          "First owner",
          Schema.decodeUnknownSync(UtcTimestamp)(new Date(now + 60_000).toISOString()),
        ),
      ).toBe(true);
      const old = host.release(page, firstId, "hand-back");
      await entered.promise;
      const revoke = host.release(page, firstId, "revoke");
      release.resolve();
      await old;
      expect(f.service.inspectThread(windowId, threadOne).waitingForPerson).toBe("take-over");
      revokeRelease.resolve();
      await revoke;
    } finally {
      release.resolve();
      revokeRelease.resolve();
      await f.service.close();
      clock.mockRestore();
    }
  });

  it("keeps a person hold when native owner release is refused and combines request and resource lifetimes", async () => {
    const authority = { ...authorityOne, mode: "code" as const };
    const target = Schema.decodeUnknownSync(OwnerBrowserNativeTarget)({
      targetVersion: "a".repeat(64),
      documentRevision: 1,
      origin: "https://example.com",
    });
    const started = Promise.withResolvers<AbortSignal>();
    const settle = Promise.withResolvers<void>();
    const ownerControl = vi.fn<NonNullable<BrowserRuntimePort["ownerControl"]>>(
      async (command, signal) => {
        if (command.operation === "inspect") return { status: "target", target };
        if (command.operation === "claim") return { status: "claimed" };
        if (command.operation === "release") return { status: "refused" };
        if (command.operation === "frame") {
          started.resolve(signal);
          await settle.promise;
        }
        return { status: "refused" };
      },
    );
    const f = harness({ authority, ownerControl });
    vi.mocked(f.runtime.createContext).mockImplementationOnce(async (id) => {
      f.contexts.add(id);
      return "native-live";
    });
    await f.service.create({ windowId, threadId: threadOne, action: action(authority), policy });
    const host = f.service.ownerBrowserHost({
      hostMemberId: () =>
        Schema.decodeUnknownSync(HubMemberId)("a7880000-0000-4000-8000-000000000001"),
      threadTitle: () => "Synthetic Code task",
    });
    const page = (await host.targets())[0]?.target;
    if (page === undefined) throw new Error("Expected eligible native page");
    const id = decodeOwnerBrowserControlId("a7880000-0000-4000-8000-000000000002");
    expect(
      await host.claim(
        page,
        id,
        "Synthetic owner phone",
        Schema.decodeUnknownSync(UtcTimestamp)(new Date(Date.now() + 60_000).toISOString()),
      ),
    ).toBe(true);
    expect(f.service.inspectThread(windowId, threadOne).ownerController?.name).toBe(
      "Synthetic owner phone",
    );
    expect(await host.release(page, id, "hand-back")).toEqual({ status: "refused" });
    expect(f.service.inspectThread(windowId, threadOne).waitingForPerson).toBe("take-over");
    const caller = new AbortController();
    const pending = host.frame(page, id, 1, caller.signal);
    const signal = await started.promise;
    await f.service.close();
    expect(caller.signal.aborted).toBe(false);
    expect(signal.aborted).toBe(true);
    settle.resolve();
    await pending;
  });
  it("refuses an unknown account identity before opening a native page", async () => {
    const f = harness();
    const account = {
      kind: "account" as const,
      profileId: "40000000-0000-4000-8000-000000000002" as never,
    };
    const list = vi.fn(
      async (): Promise<
        ReadonlyArray<{ profile: typeof account; label: string; sizeBytes: number }>
      > => [],
    );
    Object.defineProperty(f.runtime, "profiles", {
      value: { list, clear: async () => undefined, syncExtensions: async () => undefined },
      configurable: true,
    });
    expect(
      await f.service.create({
        windowId,
        threadId: threadOne,
        action: action(),
        policy: { ...policy, profile: account },
      }),
    ).toMatchObject({ failure: { reason: "profile-unavailable" } });
    expect(f.runtime.createContext).not.toHaveBeenCalled();
    list.mockResolvedValue([{ profile: account, label: "Work account", sizeBytes: 0 }]);
    expect(
      await f.service.create({
        windowId,
        threadId: threadOne,
        action: action(),
        policy: { ...policy, profile: account },
      }),
    ).toMatchObject({ status: "running", context: { policy: { profile: account } } });
    await f.service.close();
  });

  it("rechecks Full access after native realm preparation and cancels the unstarted script when revoked", async () => {
    let full = true;
    const f = harness({ pageScriptPolicy: () => (full ? "full-access" : "approval-gated") });
    let finishPrepare:
      | ((value: {
          readonly status: "prepared";
          readonly planId: import("@octant/contracts/browser-page-script").BrowserPageScriptPlanId;
        }) => void)
      | undefined;
    const prepared = new Promise<{
      readonly status: "prepared";
      readonly planId: import("@octant/contracts/browser-page-script").BrowserPageScriptPlanId;
    }>((resolve) => {
      finishPrepare = resolve;
    });
    const planId = importPlanId();
    const calls: string[] = [];
    if (f.runtime.runPageScript === undefined) throw new Error("native script fake missing");
    vi.mocked(f.runtime.runPageScript).mockImplementation(async (command) => {
      calls.push(command.operation);
      return command.operation === "prepare" ? prepared : { status: "cancelled", effect: "none" };
    });
    await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const observed = await f.service.act({
      windowId,
      threadId: threadOne,
      capturedBy: "agent",
      request: request(),
    });
    expect(observed.failure).toBeUndefined();
    expect(observed.observation).toBeDefined();
    const run = f.service.runScript({
      windowId,
      threadId: threadOne,
      contextId: contextOne,
      source: "document.body.dataset.effect='ran'",
      expectedObservationRevision: observed.observation?.revision ?? 0,
      turnExecutionPolicy: "full-access",
      callerIsCurrent: () => true,
    });
    await vi.waitFor(() => expect(calls).toEqual(["prepare"]));
    full = false;
    finishPrepare?.({ status: "prepared", planId });
    expect(await run).toMatchObject({
      status: "refused",
      effect: "none",
      reason: "full-access-required",
    });
    expect(calls).toEqual(["prepare", "cancel"]);
    await f.service.close();
  });

  it("refuses a stale observation even when its new revision is obtained from the public snapshot", async () => {
    const f = harness({ pageScriptPolicy: () => "full-access" });
    const native = f.runtime.runPageScript;
    if (native === undefined) throw new Error("expected native script fake");
    vi.mocked(native).mockImplementation(async (command) =>
      command.operation === "prepare"
        ? { status: "prepared", planId: importPlanId() }
        : { status: "completed", effect: "possible", valueJson: "42" },
    );
    await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const observed = await f.service.act({
      windowId,
      threadId: threadOne,
      capturedBy: "agent",
      request: request(),
    });
    const input = {
      windowId,
      threadId: threadOne,
      contextId: contextOne,
      source: "42",
      turnExecutionPolicy: "full-access" as const,
      callerIsCurrent: () => true,
    };
    expect(
      (
        await f.service.runScript({
          ...input,
          expectedObservationRevision: observed.observation?.revision ?? 0,
        })
      ).status,
    ).toBe("completed");
    const exposed = f.service.inspectThread(windowId, threadOne).observation;
    expect(exposed?.stale).toBe(true);
    expect(
      await f.service.runScript({ ...input, expectedObservationRevision: exposed?.revision ?? 0 }),
    ).toMatchObject({ status: "refused", effect: "none", reason: "stale" });
    expect(native).toHaveBeenCalledTimes(2);
    await f.service.close();
  });

  it("records only script provenance before publishing page data and withholds it when journaling refuses", async () => {
    let refuse = false;
    const record = vi.fn(
      (): import("../context/externalContentIngestionStore").ExternalContentIngestionResult =>
        refuse
          ? { kind: "refused", reason: "contended" }
          : {
              kind: "recorded",
              taint: { externalContentIngested: true, ingestedSources: ["browser-observation"] },
            },
    );
    const f = harness({
      pageScriptPolicy: () => "full-access",
      recordExternalContentIngestion: record,
    });
    const native = f.runtime.runPageScript;
    if (native === undefined) throw new Error("expected native script fake");
    vi.mocked(native).mockImplementation(async (command) =>
      command.operation === "prepare"
        ? { status: "prepared", planId: importPlanId() }
        : { status: "completed", effect: "possible", valueJson: '"private-script-result"' },
    );
    await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const observed = await f.service.act({
      windowId,
      threadId: threadOne,
      capturedBy: "agent",
      request: request(),
    });
    record.mockClear();
    refuse = true;
    const receipt = await f.service.runScript({
      windowId,
      threadId: threadOne,
      contextId: contextOne,
      source: "document.body.textContent",
      expectedObservationRevision: observed.observation?.revision ?? 0,
      turnExecutionPolicy: "full-access",
      callerIsCurrent: () => true,
    });
    expect(receipt).toMatchObject({ status: "refused", effect: "possible" });
    expect(record).toHaveBeenCalledOnce();
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-script-result");
    expect(JSON.stringify(record.mock.calls)).not.toContain("document.body.textContent");
    expect(JSON.stringify(receipt)).not.toContain("private-script-result");
    await f.service.close();
  });

  it("withholds a completed script value when a person takes and hands back the page during its reply", async () => {
    const f = harness({ pageScriptPolicy: () => "full-access" });
    let finish:
      | ((value: import("@octant/contracts/browser-page-script").BrowserPageScriptReceipt) => void)
      | undefined;
    const result = new Promise<
      import("@octant/contracts/browser-page-script").BrowserPageScriptReceipt
    >((resolve) => {
      finish = resolve;
    });
    const native = f.runtime.runPageScript;
    if (native === undefined) throw new Error("native script fake missing");
    vi.mocked(native).mockImplementation(async (command) =>
      command.operation === "prepare" ? { status: "prepared", planId: importPlanId() } : result,
    );
    await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const observed = await f.service.act({
      windowId,
      threadId: threadOne,
      capturedBy: "agent",
      request: request(),
    });
    const pending = f.service.runScript({
      windowId,
      threadId: threadOne,
      contextId: contextOne,
      source: "document.body.textContent",
      expectedObservationRevision: observed.observation?.revision ?? 0,
      turnExecutionPolicy: "full-access",
      callerIsCurrent: () => true,
    });
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    f.service.takeOver(windowId, threadOne);
    f.service.handBack(windowId, threadOne);
    finish?.({ status: "completed", effect: "possible", valueJson: '"late-private-page-value"' });
    const receipt = await pending;
    expect(receipt).toMatchObject({ status: "refused", effect: "possible" });
    expect(JSON.stringify(receipt)).not.toContain("late-private-page-value");
    await f.service.close();
  });

  it("withholds a peek that overlaps a fill epoch even after release and defers handing the page back", async () => {
    const f = harness();
    vi.mocked(f.runtime.createContext).mockImplementation(async (id) => {
      f.contexts.add(id);
      return "native-live";
    });
    await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
    await f.service.act({ windowId, request: request() });
    const releasePerson = f.service.holdForPerson(windowId, threadOne);
    const target = await f.service.credentialUseTarget(
      windowId,
      decodeBrowserCredentialCommand({
        kind: "list-browser-credential-grants",
        contextId: contextOne,
        threadId: threadOne,
        mode: "work",
      }),
      true,
    );
    if (target.kind !== "browser-credential-target") throw new Error("Expected native held target");
    const peek = f.runtime.peek;
    if (peek === undefined) throw new Error("Expected peek");
    let finish:
      | ((value: {
          readonly url: string;
          readonly title: string;
          readonly screenshotDataUrl: string;
        }) => void)
      | undefined;
    vi.mocked(peek).mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.advance(10_000);
    const pending = f.service.peekThread(windowId, threadOne);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const held = f.service.holdCredentialFill(
      windowId,
      target.target,
      "00000000-0000-4000-8000-000000000099",
    );
    if (held.kind !== "held") throw new Error("Expected fill hold");
    releasePerson?.();
    expect(held.signal.aborted).toBe(true);
    expect(f.service.inspectThread(windowId, threadOne).waitingForPerson).toBe("sign-in");
    held.release();
    finish?.({
      url: "https://example.com",
      title: "overlapping-private-observation",
      screenshotDataUrl: "data:image/jpeg;base64,PRIVATE",
    });
    const result = await pending;
    expect(JSON.stringify(result)).not.toContain("overlapping-private-observation");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.waitingForPerson).toBeUndefined();
  });

  it.each([false, true])(
    "refuses credential metadata for headless or unattended contexts",
    async (unattended) => {
      const f = harness({ unattended });
      if (unattended)
        vi.mocked(f.runtime.createContext).mockImplementation(async (id) => {
          f.contexts.add(id);
          return "native-live";
        });
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      f.service.holdForPerson(windowId, threadOne);
      const command = decodeBrowserCredentialCommand({
        kind: "list-browser-credential-grants",
        contextId: contextOne,
        threadId: threadOne,
        mode: "work",
      });
      expect(await f.service.credentialUseTarget(windowId, command, true)).toMatchObject({
        reason: unattended ? "unauthorized" : "unsupported",
      });
    },
  );

  it("verifies a held native target after its address await and refuses stale ownership", async () => {
    const f = harness();
    vi.mocked(f.runtime.createContext).mockImplementation(async (id) => {
      f.contexts.add(id);
      return "native-live";
    });
    await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const command = decodeBrowserCredentialCommand({
      kind: "list-browser-credential-grants",
      contextId: contextOne,
      threadId: threadOne,
      mode: "work",
    });
    expect(await f.service.credentialUseTarget(windowId, command, true)).toMatchObject({
      reason: "hold-required",
    });
    f.service.holdForPerson(windowId, threadOne);
    expect(await f.service.credentialUseTarget(otherWindowId, command, true)).toMatchObject({
      reason: "unauthorized",
    });
    expect(await f.service.credentialUseTarget(windowId, command, true)).toMatchObject({
      kind: "browser-credential-target",
      target: {
        topOrigin: "https://example.com",
        frame: { kind: "top", origin: "https://example.com" },
      },
    });
    const peek = f.runtime.peek;
    if (peek === undefined) throw new Error("Missing fixture peek");
    vi.mocked(peek).mockImplementation(async () => {
      f.revoke(threadOne);
      return { url: "https://example.com" };
    });
    expect(await f.service.credentialUseTarget(windowId, command, true)).toMatchObject({
      reason: "stale",
    });
  });

  it("uses current thread authority and deadline for human presentation without an agent observation", async () => {
    const fixture = harness();
    vi.spyOn(fixture.runtime, "createContext").mockImplementation(async (id) => {
      fixture.contexts.add(id);
      return "native-live";
    });
    await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const peek = fixture.runtime.peek;
    if (peek === undefined) throw new Error("Expected fixture peek");
    const peeks = vi.mocked(peek).mock.calls.length;
    expect(fixture.service.ownsHumanPresentation(windowId, contextOne, threadOne)).toBe(true);
    expect(fixture.service.ownsHumanPresentation(otherWindowId, contextOne, threadOne)).toBe(false);
    expect(fixture.service.ownsHumanPresentation(windowId, contextOne, threadTwo)).toBe(false);
    fixture.advance(policy.sessionTimeoutMs);
    expect(fixture.service.ownsHumanPresentation(windowId, contextOne, threadOne)).toBe(false);
    expect(vi.mocked(peek).mock.calls).toHaveLength(peeks);
  });

  it("refuses to create a context when the window is not scoped to the thread", async () => {
    const fixture = harness({ access: false });
    const result = await fixture.service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy,
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { category: "unauthorized" },
    });
    expect(fixture.runtime.createContext).not.toHaveBeenCalled();
  });

  it("fails closed when the default authority cannot read thread taint", () => {
    const authorityService = createBrowserToolCallAuthorityService(
      { canAccessWindow: () => true, resolve: () => authorityOne },
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

  it("shows a fresh picture of a page the person drives, without recording an action", async () => {
    const { advance, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const before = service.inspectThread(windowId, threadOne);
    advance(2_000);

    const peeked = await service.peekThread(windowId, threadOne);

    expect(runtime.peek).toHaveBeenCalledTimes(1);
    expect(peeked.observation?.screenshotDataUrl).toBe("data:image/jpeg;base64,AAAA");
    expect(peeked.observation?.url).toBe("https://example.com/driven");
    expect(peeked.observation?.stale).toBe(false);
    expect(peeked.evidence).toEqual(before.evidence);
    // Asked again at once, the picture stands and the runtime is left alone.
    await service.peekThread(windowId, threadOne);
    expect(runtime.peek).toHaveBeenCalledTimes(1);
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

  it("resolves a snapshot ref on the server and refuses one the latest snapshot did not list", async () => {
    const { runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    vi.mocked(runtime.act).mockResolvedValueOnce({
      url: "https://example.com/start",
      snapshot: '- button "Save" [ref=e1]',
      snapshotRefs: [{ ref: "e1", selector: "#save", role: "button", name: "Save" }],
    });
    const read = await service.act({
      windowId,
      request: request({ kind: "snapshot", target: undefined }),
    });
    expect(read.observation?.snapshot).toBe('- button "Save" [ref=e1]');

    const unknown = await service.act({
      windowId,
      request: request({ kind: "click", target: undefined, ref: "e2" }),
    });
    expect(unknown.failure?.category).toBe("stale");
    expect(runtime.act).toHaveBeenCalledTimes(1);

    await service.act({
      windowId,
      request: request({ kind: "click", target: undefined, ref: "e1" }),
    });
    expect(runtime.act).toHaveBeenLastCalledWith(
      contextOne,
      expect.objectContaining({
        kind: "click",
        target: "#save",
        expected: { role: "button", name: "Save", url: "https://example.com/start" },
      }),
      expect.anything(),
    );

    await service.act({ windowId, request: request() });
    const afterNavigation = await service.act({
      windowId,
      request: request({ kind: "click", target: undefined, ref: "e1" }),
    });
    expect(afterNavigation.failure?.category).toBe("stale");
  });

  it("answers an audit in its shaped form, naming a finding by the ref the latest snapshot gave its element", async () => {
    const ingested = vi.fn(() => ({ kind: "recorded" as const }));
    const { runtime, service } = harness({ recordExternalContentIngestion: ingested as never });
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    vi.mocked(runtime.act).mockResolvedValueOnce({
      url: "https://example.com/start",
      snapshot: '- textbox [ref=e1]\n- button "Save" [ref=e2]',
      snapshotRefs: [
        { ref: "e1", selector: "#name", role: "textbox", name: "" },
        { ref: "e2", selector: "#save", role: "button", name: "Save" },
      ],
    });
    await service.act({ windowId, request: request({ kind: "snapshot", target: undefined }) });
    vi.mocked(runtime.act).mockResolvedValueOnce({
      url: "https://example.com/start",
      title: "Start",
      audit: {
        kind: "accessibility",
        reading: {
          findings: [
            { rule: "field-name", selector: "#name", role: "textbox" },
            {
              rule: "color-contrast",
              selector: "main > p",
              text: "Faint",
              detail: { ratio: 2.1, required: 4.5 },
            },
          ],
          found: [
            { rule: "field-name", count: 1 },
            { rule: "color-contrast", count: 1 },
          ],
          touch: false,
          contrastNotMeasured: 0,
          frames: 0,
          truncated: false,
        },
      },
    });
    const audited = await service.act({
      windowId,
      capturedBy: "agent",
      request: request({ kind: "audit", target: undefined, auditKind: "accessibility" }),
    });
    expect(audited.failure).toBeUndefined();
    expect(audited.observation?.change).toBeUndefined();
    expect(audited.observation?.audit).toMatchObject({
      kind: "accessibility",
      findings: [
        { rule: "field-name", ref: "e1" },
        { rule: "color-contrast", selector: "main > p", text: "Faint" },
      ],
    });
    // Reading the page as outside content marks the thread, as any read does.
    expect(ingested).toHaveBeenCalledTimes(2);
    // The audit changed nothing, so the snapshot's refs still act.
    expect(service.snapshotRefs(windowId, threadOne).map((entry) => entry.ref)).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("refuses an audit the Browser cannot run rather than answering as if the page were clean", async () => {
    const { service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const refused = await service.act({
      windowId,
      capturedBy: "agent",
      request: request({ kind: "audit", target: undefined, auditKind: "performance" }),
    });
    expect(refused.failure).toEqual({
      category: "unavailable",
      message: "This Browser cannot audit pages.",
    });
    expect(refused.observation?.audit).toBeUndefined();
  });

  it("refuses an upload that did not come with the agent tool's approved files", async () => {
    const { runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const refused = await service.act({
      windowId,
      request: request({ kind: "upload", target: "#file", files: ["/etc/hosts"] }),
    });
    expect(refused.failure?.category).toBe("policy-denied");
    expect(runtime.act).not.toHaveBeenCalled();
    await service.act({
      windowId,
      request: request({ kind: "upload", target: "#file", files: ["notes.txt"] }),
      uploadFiles: ["/workspace/notes.txt"],
    });
    expect(runtime.act).toHaveBeenLastCalledWith(
      contextOne,
      expect.objectContaining({ kind: "upload", files: ["/workspace/notes.txt"] }),
      expect.anything(),
    );
  });

  it("keeps an upload's copies until the page closes, so a later action can still send them", async () => {
    const { service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const release = vi.fn(async () => undefined);
    await service.act({
      windowId,
      request: request({ kind: "upload", target: "#file", files: ["notes.txt"] }),
      uploadFiles: ["/staging/notes.txt"],
      releaseUpload: release,
    });
    await service.act({ windowId, request: request({ kind: "click", target: "#send" }) });
    expect(release).not.toHaveBeenCalled();
    await service.stop(windowId, threadOne, contextOne);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["revoked", "stale"] as const)(
    "withholds further page effects after attached upload permission becomes %s",
    async (reason) => {
      const { runtime, service } = harness();
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      const stop = new AbortController();
      let current = true;
      const release = vi.fn(async () => undefined);
      await service.act({
        windowId,
        request: request({ kind: "upload", target: "#file", files: ["report.txt"] }),
        uploadFiles: ["/staging/report.txt"],
        releaseUpload: release,
        uploadSignal: stop.signal,
        uploadIsCurrent: () => current,
      });
      expect(runtime.act).toHaveBeenCalledOnce();
      current = false;
      if (reason === "revoked") stop.abort();
      const refused = await service.act({
        windowId,
        request: request({ kind: "click", target: "#send" }),
      });
      expect(refused.failure).toBeDefined();
      expect(refused.observation).toBeUndefined();
      expect(runtime.act).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(runtime.closeContext).toHaveBeenCalledOnce());
      expect(release).toHaveBeenCalledOnce();
      await service.close();
    },
  );

  describe("downloads", () => {
    const click = () => request({ kind: "click", target: "#get" });

    it("asks the runtime to hold a download only for the agent tool, with the switch on", async () => {
      const on = harness({ agentDownloadsEnabled: true });
      await on.service.create({ windowId, threadId: threadOne, action: action(), policy });
      await on.service.act({
        windowId,
        request: click(),
        capturedBy: "agent",
        holdDownloads: true,
      });
      expect(on.runtime.act).toHaveBeenLastCalledWith(
        contextOne,
        expect.objectContaining({ downloads: "hold" }),
        expect.anything(),
      );
      // A person's own action in the pane, or an agent turn that may not hold, never does.
      await on.service.act({ windowId, request: click() });
      await on.service.act({ windowId, request: click(), capturedBy: "agent" });
      await on.service.act({ windowId, request: click(), holdDownloads: true });
      for (const call of vi.mocked(on.runtime.act).mock.calls.slice(1)) {
        expect(call[1]).not.toHaveProperty("downloads");
      }
      const off = harness({ agentDownloadsEnabled: false });
      await off.service.create({ windowId, threadId: threadOne, action: action(), policy });
      await off.service.act({
        windowId,
        request: click(),
        capturedBy: "agent",
        holdDownloads: true,
      });
      expect(off.runtime.act).toHaveBeenLastCalledWith(
        contextOne,
        expect.not.objectContaining({ downloads: expect.anything() }),
        expect.anything(),
      );
    });

    it("reports what the runtime holds, journals a stopped file, and saves only an id it reported", async () => {
      const refused = vi.fn();
      const { service } = harness({
        agentDownloadsEnabled: true,
        downloads: { saved: vi.fn(), refused },
        observed: {
          downloads: [
            {
              state: "held",
              downloadId: "d1",
              name: "a.pdf",
              sizeBytes: 3,
              mediaType: "application/pdf",
            },
            { state: "refused", name: "big.bin", reason: "too-large" },
          ],
        },
      });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      const acted = await service.act({
        windowId,
        request: request({ kind: "click", target: "#get" }),
        capturedBy: "agent",
        holdDownloads: true,
      });
      expect(acted.observation?.downloads).toHaveLength(2);
      expect(refused).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: threadOne, origin: "https://example.com" }),
        expect.objectContaining({ name: "big.bin", reason: "too-large" }),
      );
      const ask = vi.fn();
      const unknown = await service.saveDownload({
        windowId,
        threadId: threadOne,
        downloadId: "d9",
        workspaceRoot: "/workspace",
        ask,
      });
      expect(unknown).toEqual({ status: "refused", error: "download-not-found" });
      const otherWindow = await service.saveDownload({
        windowId: otherWindowId,
        threadId: threadOne,
        downloadId: "d1",
        workspaceRoot: "/workspace",
        ask,
      });
      expect(otherWindow).toEqual({ status: "refused", error: "download-not-found" });
      expect(ask).not.toHaveBeenCalled();
    });
  });

  it("keeps a page open while the person signs in past its session limit, one hand-off at a time", async () => {
    const fixture = harness();
    await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const release = fixture.service.holdForPerson(windowId, threadOne);
    expect(release).toBeDefined();
    expect(fixture.service.holdForPerson(windowId, threadOne)).toBeUndefined();
    expect(fixture.service.inspectThread(windowId, threadOne).waitingForPerson).toBe("sign-in");
    fixture.advance(400_000);
    fixture.expire();
    expect(fixture.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
    release?.();
    expect(fixture.service.inspectThread(windowId, threadOne).waitingForPerson).toBeUndefined();
    fixture.advance(150_000);
    fixture.expire();
    await Promise.resolve();
    expect(fixture.service.inspectThread(windowId, threadOne).context?.state).toBe("expired");
  });

  describe("person and agent together", () => {
    const withRef = {
      url: "https://example.com/start",
      snapshot: '- textbox "Name" [ref=e1]',
      snapshotRefs: [{ ref: "e1", selector: "#name", role: "textbox", name: "Name" }],
    };
    const agent = { capturedBy: "agent" } as const;

    async function snapshotted(fixture: ReturnType<typeof harness>) {
      await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
      vi.mocked(fixture.runtime.act).mockResolvedValueOnce(withRef);
      await fixture.service.act({
        windowId,
        request: request({ kind: "snapshot", target: undefined }),
        ...agent,
      });
    }

    it("drops the agent's refs when the person types, refuses its next keystroke, and says so once", async () => {
      const fixture = harness();
      await snapshotted(fixture);
      fixture.personTyped();

      const refused = await fixture.service.act({
        windowId,
        request: request({ kind: "type", target: undefined, ref: "e1", value: "Ada" }),
        ...agent,
      });
      expect(refused.failure?.category).toBe("stale");
      expect(refused.failure?.message).toMatch(/person used the page/);
      expect(refused.personUsedPage).toBe("used");
      // Only the snapshot reached the runtime: the person's text is untouched.
      expect(fixture.runtime.act).toHaveBeenCalledTimes(1);

      // A selector does not get around it: the field is the person's too.
      const bySelector = await fixture.service.act({
        windowId,
        request: request({ kind: "press", target: undefined, value: "Enter" }),
        ...agent,
      });
      expect(bySelector.failure?.category).toBe("stale");
      expect(bySelector.personUsedPage).toBeUndefined();

      // Reading the page is allowed and still says it, once.
      const read = await fixture.service.act({
        windowId,
        request: request({ kind: "extract-text", target: undefined }),
        ...agent,
      });
      expect(read.failure).toBeUndefined();

      vi.mocked(fixture.runtime.act).mockResolvedValueOnce(withRef);
      const fresh = await fixture.service.act({
        windowId,
        request: request({ kind: "snapshot", target: undefined }),
        ...agent,
      });
      expect(fresh.personUsedPage).toBeUndefined();
      const typed = await fixture.service.act({
        windowId,
        request: request({ kind: "type", target: undefined, ref: "e1", value: "Ada" }),
        ...agent,
      });
      expect(typed.failure).toBeUndefined();
    });

    it("leaves the action in flight to finish and keeps a snapshot it overlapped stale", async () => {
      const fixture = harness();
      await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
      let finish!: () => void;
      vi.mocked(fixture.runtime.act).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(withRef);
          }),
      );
      const reading = fixture.service.act({
        windowId,
        request: request({ kind: "snapshot", target: undefined }),
        ...agent,
      });
      await vi.waitFor(() => expect(fixture.runtime.act).toHaveBeenCalledTimes(1));
      fixture.personTyped();
      finish();
      expect((await reading).failure).toBeUndefined();
      const click = await fixture.service.act({
        windowId,
        request: request({ kind: "click", target: undefined, ref: "e1" }),
        ...agent,
      });
      expect(click.failure?.category).toBe("stale");
    });

    it("counts the person's relayed action on a headless page as using it", async () => {
      const fixture = harness();
      await snapshotted(fixture);
      await fixture.service.act({ windowId, request: request({ kind: "click", target: "#x" }) });
      const refused = await fixture.service.act({
        windowId,
        request: request({ kind: "click", target: undefined, ref: "e1" }),
        ...agent,
      });
      expect(refused.failure?.category).toBe("stale");
      // A screenshot refresh is not the person using the page.
      const calm = harness();
      await snapshotted(calm);
      await calm.service.act({
        windowId,
        request: request({ kind: "screenshot", target: undefined }),
      });
      const ok = await calm.service.act({
        windowId,
        request: request({ kind: "click", target: undefined, ref: "e1" }),
        ...agent,
      });
      expect(ok.failure).toBeUndefined();
    });

    it("holds the agent out while the person has the page, and keeps the page open", async () => {
      const fixture = harness();
      await snapshotted(fixture);
      const taken = fixture.service.takeOver(windowId, threadOne);
      expect(taken.waitingForPerson).toBe("take-over");
      expect(fixture.service.inspectThread(windowId, threadOne).waitingForPerson).toBe("take-over");
      // The same hold: no sign-in ask can start under it, and a second take-over is the same one.
      expect(fixture.service.holdForPerson(windowId, threadOne)).toBeUndefined();
      expect(fixture.service.takeOver(windowId, threadOne).waitingForPerson).toBe("take-over");
      fixture.advance(400_000);
      fixture.expire();
      expect(fixture.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
    });

    it("answers the first acting call after hand back with a fresh snapshot instead of running it", async () => {
      const fixture = harness();
      await snapshotted(fixture);
      fixture.service.takeOver(windowId, threadOne);
      const handed = fixture.service.handBack(windowId, threadOne);
      expect(handed.waitingForPerson).toBeUndefined();

      vi.mocked(fixture.runtime.act).mockResolvedValueOnce(withRef);
      const answered = await fixture.service.act({
        windowId,
        request: request({ kind: "click", target: undefined, ref: "e1" }),
        ...agent,
      });
      expect(answered.failure).toBeUndefined();
      expect(answered.personUsedPage).toBe("handed-back");
      expect(answered.observation?.snapshot).toBe('- textbox "Name" [ref=e1]');
      expect(fixture.runtime.act).toHaveBeenLastCalledWith(
        contextOne,
        expect.objectContaining({ kind: "snapshot" }),
        expect.anything(),
      );
      // Its refs are good again, and it is not told twice.
      const next = await fixture.service.act({
        windowId,
        request: request({ kind: "click", target: undefined, ref: "e1" }),
        ...agent,
      });
      expect(next.failure).toBeUndefined();
      expect(next.personUsedPage).toBeUndefined();
    });

    it("never runs an agent call that was queued when the person took over", async () => {
      const fixture = harness();
      await snapshotted(fixture);
      let finish!: () => void;
      vi.mocked(fixture.runtime.act).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ url: "https://example.com/start" });
          }),
      );
      const running = fixture.service.act({
        windowId,
        request: request({ kind: "scroll", target: undefined }),
        ...agent,
      });
      await vi.waitFor(() => expect(fixture.runtime.act).toHaveBeenCalledTimes(2));
      // Admitted by the tool before the person took the page, then waits its turn.
      const queued = fixture.service.act({
        windowId,
        request: request({ kind: "extract-text", target: undefined }),
        ...agent,
      });
      fixture.service.takeOver(windowId, threadOne);
      finish();
      await running;
      const refused = await queued;
      expect(refused.failure?.category).toBe("unavailable");
      expect(refused.failure?.message).toMatch(/took over the page, so this call did not run/);
      expect(fixture.runtime.act).toHaveBeenCalledTimes(2);
    });

    it("refuses to take over with no page, from another window, for a routine, or under a sign-in ask", async () => {
      const none = harness();
      expect(none.service.takeOver(windowId, threadOne).failure?.category).toBe("unavailable");
      expect(none.service.handBack(windowId, threadOne).failure?.category).toBe("unavailable");

      const fixture = harness();
      await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
      expect(fixture.service.takeOver(otherWindowId, threadOne).failure?.category).toBe(
        "unavailable",
      );
      expect(fixture.service.takeOver(windowId, threadTwo).failure?.category).toBe("unavailable");
      expect(fixture.service.inspectThread(windowId, threadOne).waitingForPerson).toBeUndefined();

      const release = fixture.service.holdForPerson(windowId, threadOne);
      expect(fixture.service.takeOver(windowId, threadOne).failure?.message).toMatch(/sign in/);
      // Hand back never ends the agent's own sign-in ask; only its card does.
      expect(fixture.service.handBack(windowId, threadOne).waitingForPerson).toBe("sign-in");
      release?.();

      const routine = harness({ unattended: true });
      await routine.service.create({ windowId, threadId: threadOne, action: action(), policy });
      expect(routine.service.takeOver(windowId, threadOne).failure?.category).toBe("unauthorized");
      expect(routine.service.inspectThread(windowId, threadOne).waitingForPerson).toBeUndefined();

      const revoked = harness();
      await revoked.service.create({ windowId, threadId: threadOne, action: action(), policy });
      revoked.revoke(threadOne);
      expect(revoked.service.takeOver(windowId, threadOne).failure?.category).toBe("unauthorized");
    });
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

  describe("thread captures", () => {
    const captureId = "a0000000-0000-4000-8000-000000000001" as BrowserCaptureId;
    const keep = () =>
      vi.fn(async (_input: KeepBrowserCaptureInput) => ({
        status: "kept" as const,
        captureId,
      }));

    it("keeps an explicit screenshot the agent tool took, after the thread is tainted", async () => {
      const order: string[] = [];
      const captures = { keep: keep() };
      captures.keep.mockImplementation(async () => {
        order.push("keep");
        return { status: "kept" as const, captureId };
      });
      const { service } = harness({
        captures,
        recordExternalContentIngestion: () => {
          order.push("taint");
          return {
            kind: "recorded" as const,
            taint: { externalContentIngested: true, ingestedSources: ["browser-observation"] },
          };
        },
      });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      const completed = await service.act({
        windowId,
        request: request({ kind: "screenshot" }),
        capturedBy: "agent",
      });

      expect(order).toEqual(["taint", "keep"]);
      expect(captures.keep).toHaveBeenCalledWith({
        threadId: threadOne,
        dataUrl: "data:image/png;base64,AAAA",
        url: "https://example.com/start",
        title: "Thread one",
        takenBy: "agent",
        providerInstanceId: authorityOne.providerInstanceId,
        correlationId: action().correlationId,
      });
      expect(completed.observation?.capture).toEqual({ status: "kept", captureId });
    });

    it("records the profile of a signed-in page with the capture it keeps", async () => {
      const captures = { keep: keep() };
      const { service } = harness({ captures });
      await service.create({
        windowId,
        threadId: threadOne,
        action: action(),
        policy: { ...policy, profile: { kind: "personal" } },
      });
      await service.act({
        windowId,
        request: request({ kind: "screenshot" }),
        capturedBy: "agent",
      });
      expect(captures.keep).toHaveBeenCalledWith(
        expect.objectContaining({ profile: { kind: "personal" } }),
      );
    });

    it("keeps a screenshot the person took in the pane", async () => {
      const captures = { keep: keep() };
      const { service } = harness({ captures });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      await service.act({
        windowId,
        request: request({ kind: "screenshot" }),
        capturedBy: "person",
      });
      expect(captures.keep).toHaveBeenCalledWith(expect.objectContaining({ takenBy: "person" }));
    });

    it("keeps nothing for the picture that follows any other action", async () => {
      const captures = { keep: keep() };
      const { service } = harness({ captures });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      const completed = await service.act({
        windowId,
        request: request({ kind: "navigate" }),
        capturedBy: "agent",
      });
      expect(captures.keep).not.toHaveBeenCalled();
      expect(completed.observation?.capture).toBeUndefined();
    });

    it("keeps nothing when the caller does not say who asked", async () => {
      const captures = { keep: keep() };
      const { service } = harness({ captures });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      await service.act({ windowId, request: request({ kind: "screenshot" }) });
      expect(captures.keep).not.toHaveBeenCalled();
    });

    it("keeps nothing for the picture a preview peek takes", async () => {
      const captures = { keep: keep() };
      const { service } = harness({ captures });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      await service.peekThread(windowId, threadOne);
      expect(captures.keep).not.toHaveBeenCalled();
    });

    it("still completes the screenshot and says why a capture was not kept", async () => {
      const refused = {
        keep: vi.fn(async () => ({ status: "not-kept" as const, reason: "too-large" as const })),
      };
      const refusing = harness({ captures: refused });
      await refusing.service.create({ windowId, threadId: threadOne, action: action(), policy });
      const completed = await refusing.service.act({
        windowId,
        request: request({ kind: "screenshot" }),
        capturedBy: "agent",
      });
      expect(completed.failure).toBeUndefined();
      expect(completed.observation?.screenshotDataUrl).toBe("data:image/png;base64,AAAA");
      expect(completed.observation?.capture).toEqual({ status: "not-kept", reason: "too-large" });

      const throwing = harness({
        captures: {
          keep: vi.fn(async () => {
            throw new Error("disk is gone");
          }),
        },
      });
      await throwing.service.create({ windowId, threadId: threadOne, action: action(), policy });
      const survived = await throwing.service.act({
        windowId,
        request: request({ kind: "screenshot" }),
        capturedBy: "agent",
      });
      expect(survived.failure).toBeUndefined();
      expect(survived.observation?.capture).toEqual({ status: "not-kept", reason: "unavailable" });
    });

    it("says no picture was kept when the runtime withholds the screenshot", async () => {
      const captures = { keep: keep() };
      const { runtime, service } = harness({ captures });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      // The runtime leaves the picture out on its own judgement, for example
      // when a frame on the page holds a credential field.
      vi.mocked(runtime.act).mockResolvedValueOnce({
        url: "https://example.com/sign-in",
        title: "Sign in",
        contentHash: "withheld",
      });
      const completed = await service.act({
        windowId,
        request: request({ kind: "screenshot" }),
        capturedBy: "person",
      });

      expect(completed.failure).toBeUndefined();
      expect(captures.keep).not.toHaveBeenCalled();
      expect(completed.observation?.capture).toEqual({ status: "not-kept", reason: "no-picture" });
    });

    describe("recordings", () => {
      const recorded = {
        status: "recorded" as const,
        dataUrl: "data:image/png;base64,BBBB",
        frames: 6,
        durationMs: 1_500,
        truncated: "size-limit" as const,
      };

      it("keeps the agent's recording with its frames, and leaves the page's revision where it was", async () => {
        const captures = {
          keep: vi.fn(async (input: KeepBrowserCaptureInput) => ({
            status: "kept" as const,
            captureId,
            ...(input.recording === undefined ? {} : { recording: input.recording }),
          })),
          recordStep: vi.fn(),
        };
        const { runtime, service } = harness({ captures });
        await service.create({ windowId, threadId: threadOne, action: action(), policy });
        const read = await service.act({ windowId, request: request(), capturedBy: "agent" });
        const revision = read.observation?.revision;
        const started = await service.act({
          windowId,
          request: request({ kind: "record-start" }),
          capturedBy: "agent",
        });
        vi.mocked(runtime.act).mockResolvedValueOnce({
          url: "https://example.com/start",
          title: "Thread one",
          contentHash: "after",
          recording: recorded,
        });
        const stopped = await service.act({
          windowId,
          request: request({ kind: "record-stop" }),
          capturedBy: "agent",
        });

        expect(started.observation?.revision).toBe(revision);
        expect(stopped.observation?.revision).toBe(revision);
        expect(captures.keep).toHaveBeenCalledOnce();
        expect(captures.keep).toHaveBeenCalledWith(
          expect.objectContaining({
            dataUrl: recorded.dataUrl,
            recording: { frames: 6, durationMs: 1_500, truncated: "size-limit" },
            takenBy: "agent",
          }),
        );
        expect(stopped.observation?.capture).toEqual({
          status: "kept",
          captureId,
          recording: { frames: 6, durationMs: 1_500, truncated: "size-limit" },
        });
        // Starting and stopping a recording are not steps of the proof.
        expect(captures.recordStep).toHaveBeenCalledOnce();
      });

      it("ends a recording the agent discards and keeps nothing of it", async () => {
        const captures = { keep: keep() };
        const { runtime, service } = harness({ captures });
        await service.create({ windowId, threadId: threadOne, action: action(), policy });
        vi.mocked(runtime.act).mockResolvedValueOnce({
          url: "https://example.com/start",
          title: "Thread one",
          recording: recorded,
        });
        const stopped = await service.act({
          windowId,
          request: request({ kind: "record-stop" }),
          capturedBy: "agent",
          discardRecording: true,
        });

        // The stop reached the runtime, so the screencast ended.
        expect(vi.mocked(runtime.act).mock.calls.at(-1)?.[1]).toMatchObject({
          kind: "record-stop",
        });
        expect(stopped.failure).toBeUndefined();
        expect(captures.keep).not.toHaveBeenCalled();
        expect(stopped.observation?.capture).toBeUndefined();
      });

      it("keeps a recording under the address of the tab it recorded, not the tab in front", async () => {
        const captures = { keep: keep() };
        const { runtime, service } = harness({ captures });
        await service.create({ windowId, threadId: threadOne, action: action(), policy });
        vi.mocked(runtime.act).mockResolvedValueOnce({
          url: "https://example.com/other",
          title: "Other tab",
          recording: {
            ...recorded,
            truncated: "tab-changed",
            url: "https://example.com/start",
            title: "Recorded tab",
          },
        });
        await service.act({
          windowId,
          request: request({ kind: "record-stop" }),
          capturedBy: "agent",
        });

        expect(captures.keep).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "https://example.com/start",
            title: "Recorded tab",
            recording: { frames: 6, durationMs: 1_500, truncated: "tab-changed" },
          }),
        );
      });

      it("records only for the agent's own call, never for the pane or an unnamed caller", async () => {
        const captures = { keep: keep() };
        const { runtime, service } = harness({ captures });
        await service.create({ windowId, threadId: threadOne, action: action(), policy });
        for (const capturedBy of ["person", undefined] as const) {
          const refused = await service.act({
            windowId,
            request: request({ kind: "record-start" }),
            ...(capturedBy === undefined ? {} : { capturedBy }),
          });
          expect(refused.failure).toMatchObject({ category: "policy-denied" });
        }
        expect(runtime.act).not.toHaveBeenCalled();
        expect(captures.keep).not.toHaveBeenCalled();
      });

      it("says in words when the Browser cannot record", async () => {
        const { runtime, service } = harness();
        await service.create({ windowId, threadId: threadOne, action: action(), policy });
        vi.mocked(runtime.act).mockRejectedValueOnce(new BrowserRecordingUnavailableError());
        const refused = await service.act({
          windowId,
          request: request({ kind: "record-start" }),
          capturedBy: "agent",
        });
        expect(refused.failure).toEqual({
          category: "unavailable",
          message: "This Browser cannot record the page.",
        });
      });

      it("keeps nothing when the recording showed a credential field or painted nothing", async () => {
        for (const status of ["withheld", "empty"] as const) {
          const captures = { keep: keep() };
          const { runtime, service } = harness({ captures });
          await service.create({ windowId, threadId: threadOne, action: action(), policy });
          vi.mocked(runtime.act).mockResolvedValueOnce({
            url: "https://example.com/sign-in",
            recording: { status },
          });
          const stopped = await service.act({
            windowId,
            request: request({ kind: "record-stop" }),
            capturedBy: "agent",
          });
          expect(captures.keep).not.toHaveBeenCalled();
          expect(stopped.observation?.capture).toEqual({
            status: "not-kept",
            reason: "no-picture",
          });
        }
      });
    });
  });

  describe("thread proof steps", () => {
    const recorder = () => vi.fn((_input: RecordBrowserStepInput) => undefined);
    const withSnapshot = async (harnessed: ReturnType<typeof harness>): Promise<void> => {
      await harnessed.service.create({ windowId, threadId: threadOne, action: action(), policy });
      vi.mocked(harnessed.runtime.act).mockResolvedValueOnce({
        url: "https://example.com/form",
        snapshot: '- textbox "Email" [ref=e1]',
        snapshotRefs: [{ ref: "e1", selector: "#email", role: "textbox", name: "Email" }],
      });
      await harnessed.service.act({
        windowId,
        request: request({ kind: "snapshot", target: undefined }),
        capturedBy: "agent",
      });
    };

    it("records the agent's action by role and name, never by what it typed", async () => {
      const recordStep = recorder();
      const harnessed = harness({ captures: { keep: vi.fn(), recordStep } });
      await withSnapshot(harnessed);
      await harnessed.service.act({
        windowId,
        request: request({ kind: "type", target: undefined, ref: "e1", value: "hunter2" }),
        capturedBy: "agent",
      });

      const typed = recordStep.mock.calls.at(-1)?.[0];
      expect(typed?.facts).toMatchObject({
        operation: "type",
        element: { role: "textbox", name: "Email" },
      });
      expect(JSON.stringify(recordStep.mock.calls)).not.toContain("hunter2");
      expect(typed?.providerInstanceId).toBe(authorityOne.providerInstanceId);
    });

    it("records a refused action with its failure category and no result line", async () => {
      const recordStep = recorder();
      const harnessed = harness({ captures: { keep: vi.fn(), recordStep } });
      await withSnapshot(harnessed);
      await harnessed.service.act({
        windowId,
        request: request({ kind: "click", target: undefined, ref: "e9" }),
        capturedBy: "agent",
      });
      const refused = recordStep.mock.calls.at(-1)?.[0];
      expect(refused?.facts).toMatchObject({ operation: "click", failure: "stale" });
      expect(refused?.facts.change).toBeUndefined();
    });

    it("names the capture a kept screenshot produced", async () => {
      const captureId = "a0000000-0000-4000-8000-000000000009" as BrowserCaptureId;
      const recordStep = recorder();
      const harnessed = harness({
        captures: { keep: vi.fn(async () => ({ status: "kept" as const, captureId })), recordStep },
      });
      await harnessed.service.create({ windowId, threadId: threadOne, action: action(), policy });
      await harnessed.service.act({
        windowId,
        request: request({ kind: "screenshot" }),
        capturedBy: "agent",
      });
      expect(recordStep.mock.calls.at(-1)?.[0].facts).toMatchObject({
        operation: "screenshot",
        captureId,
      });
    });

    it("records nothing for the person's pane or a caller that names no one", async () => {
      const recordStep = recorder();
      const { service } = harness({ captures: { keep: vi.fn(), recordStep } });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      await service.act({ windowId, request: request(), capturedBy: "person" });
      await service.act({ windowId, request: request() });
      expect(recordStep).not.toHaveBeenCalled();
    });

    it("records through the service object itself, as the host's capture service needs", async () => {
      const seen: string[] = [];
      // A class method reads its own private state, so it fails when called loose.
      const captures = {
        label: "capture-service",
        keep: vi.fn(),
        recordStep(this: { readonly label: string }) {
          seen.push(this.label);
        },
      };
      const { service } = harness({ captures });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      await service.act({ windowId, request: request(), capturedBy: "agent" });
      expect(seen).toEqual(["capture-service"]);
    });

    it("lets the action succeed when the step cannot be recorded", async () => {
      const { service } = harness({
        captures: {
          keep: vi.fn(),
          recordStep: () => {
            throw new Error("journal is gone");
          },
        },
      });
      await service.create({ windowId, threadId: threadOne, action: action(), policy });
      const completed = await service.act({ windowId, request: request(), capturedBy: "agent" });
      expect(completed.failure).toBeUndefined();
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

  it("switches the task's shared Browser only after staging and saving its choice", async () => {
    const fixture = harness();
    await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
    await fixture.service.act({ windowId, request: request() });
    let saved = false;
    const bind = vi.fn(() => {
      expect(saved).toBe(true);
      expect(fixture.service.inspectThread(windowId, threadOne).context?.contextId).toBe(
        contextOne,
      );
    });
    const result = await fixture.service.switchTaskProfile({
      windowId,
      threadId: threadOne,
      action: action(),
      profile: { kind: "personal" },
      expectedContextId: contextOne,
      isCurrent: () => true,
      save: async (commit) => {
        commit(() => {
          saved = true;
        });
        return { status: "saved" };
      },
      bind,
    });
    expect(result.status).toBe("changed");
    const current = fixture.service.inspectThread(windowId, threadOne);
    expect(current.context?.contextId).not.toBe(contextOne);
    expect(current.context?.policy.profile).toEqual({ kind: "personal" });
    expect(fixture.contexts.has(contextOne)).toBe(false);
    expect(fixture.contexts.size).toBe(1);
    expect(bind).toHaveBeenCalledOnce();
    expect(fixture.service.snapshotRefs(windowId, threadOne)).toEqual([]);
    await fixture.service.close();
  });

  it.each(["creation", "storage", "revision"] as const)(
    "keeps the original shared page and choice when %s fails",
    async (failure) => {
      const fixture = harness();
      await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
      await fixture.service.act({ windowId, request: request() });
      let current = true;
      if (failure === "creation")
        vi.mocked(fixture.runtime.createContext).mockRejectedValueOnce(
          new Error("Native profile unavailable"),
        );
      if (failure === "revision")
        vi.mocked(fixture.runtime.act).mockImplementationOnce(async () => {
          current = false;
          return { url: "https://example.com/start", title: "Replacement" };
        });
      const save = vi.fn(async () => ({
        status: "refused" as const,
        failure: { category: "failed" as const, message: "Storage write failed." },
      }));
      const bind = vi.fn();
      const result = await fixture.service.switchTaskProfile({
        windowId,
        threadId: threadOne,
        action: action(),
        profile: { kind: "personal" },
        expectedContextId: contextOne,
        isCurrent: () => current,
        save,
        bind,
      });
      expect(result.status).toBe("refused");
      const original = fixture.service.inspectThread(windowId, threadOne);
      expect(original.context?.contextId).toBe(contextOne);
      expect(original.context?.policy.profile).toBeUndefined();
      expect(fixture.contexts.size).toBe(1);
      expect(fixture.contexts.has(contextOne)).toBe(true);
      expect(bind).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(failure === "storage" ? 1 : 0);
      await fixture.service.close();
    },
  );

  it.each(["input", "take-over", "stop", "authority", "task"] as const)(
    "refuses a %s change during delayed persistence before writing or retiring the original page",
    async (change) => {
      const fixture = harness();
      await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
      await fixture.service.act({ windowId, request: request() });
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let entered = false;
      let current = true;
      const persist = vi.fn();
      const bind = vi.fn();
      const switching = fixture.service.switchTaskProfile({
        windowId,
        threadId: threadOne,
        action: action(),
        profile: { kind: "personal" },
        expectedContextId: contextOne,
        isCurrent: () => current,
        bind,
        save: async (commit) => {
          entered = true;
          await ready; // Like Work's asynchronous Project-folder authorization.
          return commit(persist)
            ? { status: "saved" }
            : {
                status: "refused",
                failure: { category: "stale", message: "Changed before commit." },
              };
        },
      });
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(fixture.service.inspectThread(windowId, threadOne).context?.contextId).toBe(
        contextOne,
      );
      if (change === "input") fixture.personTyped();
      if (change === "take-over") fixture.service.takeOver(windowId, threadOne);
      if (change === "stop") await fixture.service.releaseThread(windowId, threadOne);
      if (change === "authority") fixture.revoke(threadOne);
      if (change === "task") current = false;
      finish();
      expect((await switching).status).toBe("refused");
      expect(persist).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(fixture.contexts.size).toBe(change === "stop" ? 0 : 1);
      if (change !== "stop") expect(fixture.contexts.has(contextOne)).toBe(true);
      await fixture.service.close();
    },
  );

  it("acknowledges a completed switch when a later edit changes the task before save resolves", async () => {
    const fixture = harness();
    await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
    let current = true;
    const persisted = vi.fn();
    const result = await fixture.service.switchTaskProfile({
      windowId,
      threadId: threadOne,
      action: action(),
      profile: { kind: "personal" },
      expectedContextId: contextOne,
      isCurrent: () => current,
      bind: vi.fn(),
      save: async (commit) => {
        expect(commit(persisted)).toBe(true);
        current = false; // A subsequent thread edit is not a failed profile switch.
        return { status: "saved" };
      },
    });
    expect(result.status).toBe("changed");
    expect(persisted).toHaveBeenCalledOnce();
    expect(fixture.contexts.has(contextOne)).toBe(false);
    expect(fixture.service.inspectThread(windowId, threadOne).context?.policy.profile).toEqual({
      kind: "personal",
    });
    await fixture.service.close();
  });

  it("leaves a person handoff and an unavailable profile untouched", async () => {
    const fixture = harness();
    await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const release = fixture.service.holdForPerson(windowId, threadOne);
    const save = vi.fn(async () => ({ status: "saved" as const }));
    const input = {
      windowId,
      threadId: threadOne,
      action: action(),
      profile: { kind: "personal" as const },
      expectedContextId: contextOne,
      isCurrent: () => true,
      save,
      bind: vi.fn(),
    };
    expect((await fixture.service.switchTaskProfile(input)).status).toBe("refused");
    release?.();
    vi.mocked(fixture.runtime.nativeAvailable!).mockResolvedValue(false);
    expect((await fixture.service.switchTaskProfile(input)).status).toBe("refused");
    expect(save).not.toHaveBeenCalled();
    expect(fixture.contexts.has(contextOne)).toBe(true);
    await fixture.service.close();
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

  describe("bounded idle lifetime", () => {
    it.each([
      "navigate",
      "snapshot",
      "extract-text",
      "screenshot",
      "observe-diagnostics",
      "tab-list",
    ] as const)(
      "renews on an authorized explicit %s operation past the original deadline",
      async (kind) => {
        const f = harness();
        await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
        f.advance(240_000);
        await f.service.act({
          windowId,
          capturedBy: "agent",
          request: request({
            kind,
            target: kind === "navigate" ? "https://example.com" : undefined,
          }),
        });
        f.advance(120_000);
        f.expire();
        expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
        f.advance(180_000);
        f.expire();
        await vi.waitFor(() => expect(f.contexts.size).toBe(0));
        await f.service.close();
      },
    );

    it.each(["snapshot", "extract-text", "screenshot", "wait", "observe-diagnostics"] as const)(
      "renews explicit terminal %s activity without retaining captures or extending a person hold",
      async (kind) => {
        const captures = { keep: vi.fn() };
        const f = harness({ captures });
        await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
        f.advance(240_000);
        const result = await f.service.act({
          windowId,
          activityBy: "agent",
          request: request({ kind }),
        });
        expect(result.failure).toBeUndefined();
        f.advance(120_000);
        f.expire();
        expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
        expect(captures.keep).not.toHaveBeenCalled();
        await f.service.takeOver(windowId, threadOne);
        f.advance(600_000);
        const held = await f.service.act({
          windowId,
          activityBy: "agent",
          request: request({ kind }),
        });
        expect(held.failure?.category).toBe("unavailable");
        f.advance(60_000);
        f.expire();
        await vi.waitFor(() => expect(f.contexts.size).toBe(0));
        await f.service.close();
      },
    );

    it("keeps an actively used task alive beyond ten minutes, then expires after real idle", async () => {
      const f = harness();
      await f.service.create({
        windowId,
        threadId: threadOne,
        action: action(),
        policy: { ...policy, sessionTimeoutMs: 600_000 },
      });
      for (let turn = 0; turn < 2; turn += 1) {
        f.advance(540_000);
        expect(
          (await f.service.act({ windowId, capturedBy: "agent", request: request() })).failure,
        ).toBeUndefined();
      }
      f.expire();
      expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
      f.advance(600_000);
      f.expire();
      await vi.waitFor(() => expect(f.contexts.size).toBe(0));
      await f.service.close();
    });

    it.each(["stale", "credential"] as const)("does not renew for a %s refusal", async (reason) => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      f.advance(240_000);
      if (reason === "credential")
        vi.mocked(f.runtime.inspectTarget).mockResolvedValueOnce({ sensitive: true });
      const refused = await f.service.act({
        windowId,
        capturedBy: "agent",
        refuseStaleRevision: true,
        request:
          reason === "stale"
            ? request({ expectedObservationRevision: 99 })
            : request({ kind: "type", target: "#password", value: "harmless-fixture" }),
      });
      expect(refused.failure?.category).toBe(reason === "stale" ? "stale" : "credential-protected");
      f.advance(60_000);
      f.expire();
      await vi.waitFor(() => expect(f.contexts.size).toBe(0));
      await f.service.close();
    });

    it.each(["expiry", "revoke"] as const)(
      "settles delayed capture storage on %s and never publishes late page output",
      async (reason) => {
        let finish!: () => void;
        const f = harness({
          captures: {
            keep: async () => {
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
              return {
                status: "kept",
                captureId: "a0000000-0000-4000-8000-000000000001" as BrowserCaptureId,
              };
            },
          },
        });
        await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
        const answer = f.service.act({
          windowId,
          capturedBy: "agent",
          request: request({ kind: "screenshot" }),
        });
        let settled = false;
        void answer.then(() => {
          settled = true;
        });
        await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
        try {
          if (reason === "expiry") {
            f.advance(policy.sessionTimeoutMs);
            f.expire();
          } else {
            f.revoke(threadOne);
            f.service.inspectThread(windowId, threadOne);
          }
          await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
          const result = await answer;
          expect(result.observation).toBeUndefined();
          expect(result.evidence).toEqual([]);
          finish();
          await Promise.resolve();
          expect(f.service.inspectThread(windowId, threadOne).observation).toBeUndefined();
          expect(f.service.snapshotRefs(windowId, threadOne)).toEqual([]);
        } finally {
          finish();
          await answer;
          await f.service.close();
        }
      },
    );

    it("a prior agent action completing during take-over cannot renew the person's hold", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      let finish!: () => void;
      vi.mocked(f.runtime.act).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { url: "https://example.com", title: "Agent finished" };
      });
      const answer = f.service.act({ windowId, capturedBy: "agent", request: request() });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      f.service.takeOver(windowId, threadOne);
      f.advance(600_000);
      finish();
      await answer;
      f.advance(60_000);
      f.expire();
      await vi.waitFor(() => expect(f.contexts.size).toBe(0));
      await f.service.close();
    });

    it("an unresponsive credential inspection settles on expiry without typing or renewing", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      let finish!: () => void;
      vi.mocked(f.runtime.inspectTarget).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { sensitive: false };
      });
      f.advance(240_000);
      const typing = f.service.act({
        windowId,
        capturedBy: "agent",
        request: request({ kind: "type", target: "#name", value: "Ada" }),
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const queued = f.service.act({ windowId, capturedBy: "agent", request: request() });
      f.advance(60_000);
      f.expire();
      expect((await typing).failure?.category).toBe("context-expired");
      await queued;
      finish();
      expect(f.runtime.act).not.toHaveBeenCalled();
      expect(f.contexts.size).toBe(0);
      await f.service.close();
    });

    it("does not use a late credential inspection after authority changes", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      let finish!: () => void;
      vi.mocked(f.runtime.inspectTarget).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { sensitive: false };
      });
      const typing = f.service.act({
        windowId,
        capturedBy: "agent",
        request: request({ kind: "type", target: "#name", value: "Ada" }),
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      f.revoke(threadOne);
      finish();
      const result = await typing;
      expect(result.failure?.category).toBe("unauthorized");
      expect(result.observation).toBeUndefined();
      expect(f.runtime.act).not.toHaveBeenCalled();
      await f.service.close();
    });

    it("a hung point inspection releases the action queue on expiry", async () => {
      let finish!: () => void;
      const f = harness({
        describePoint: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { status: "no-element" };
        },
      });
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      const pointed = f.service.describePoint({
        windowId,
        threadId: threadOne,
        contextId: contextOne,
        point: { x: 0.5, y: 0.5 },
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const queued = f.service.act({ windowId, capturedBy: "agent", request: request() });
      f.advance(policy.sessionTimeoutMs);
      f.expire();
      expect(await pointed).toEqual({ status: "unavailable" });
      await queued;
      finish();
      expect(f.runtime.act).not.toHaveBeenCalled();
      await f.service.close();
    });

    it("a passive preview settles at expiry and cannot publish a late image", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      let finish!: () => void;
      vi.mocked(f.runtime.peek!).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          url: "https://example.com",
          title: "Late private image",
          screenshotDataUrl: "data:image/png;base64,AAAA",
        };
      });
      const preview = f.service.peekThread(windowId, threadOne);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      f.advance(policy.sessionTimeoutMs);
      f.expire();
      await preview;
      finish();
      await Promise.resolve();
      expect(f.service.inspectThread(windowId, threadOne).observation).toBeUndefined();
      expect(f.contexts.size).toBe(0);
      await f.service.close();
    });

    it("queued work does not renew an unresponsive operation or execute after expiry", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      let finish!: () => void;
      vi.mocked(f.runtime.act).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { url: "https://example.com", title: "Late" };
      });
      const first = f.service.act({ windowId, capturedBy: "agent", request: request() });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      f.advance(240_000);
      const queued = f.service.act({ windowId, capturedBy: "agent", request: request() });
      f.advance(60_000);
      f.expire();
      expect((await first).failure?.category).toBe("context-expired");
      await queued;
      finish();
      expect(f.runtime.act).toHaveBeenCalledOnce();
      expect(f.contexts.size).toBe(0);
      await f.service.close();
    });

    it("late input and take-over cannot revive a page past its idle deadline", async () => {
      for (const gesture of ["input", "take-over"] as const) {
        const f = harness();
        await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
        f.advance(policy.sessionTimeoutMs);
        if (gesture === "input") f.personTyped();
        else f.service.takeOver(windowId, threadOne);
        await vi.waitFor(() => expect(f.contexts.size).toBe(0));
        expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("expired");
        await f.service.close();
      }
    });

    it("preserves take-over input retention and early/late release grace", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      f.service.takeOver(windowId, threadOne);
      f.advance(600_000);
      f.personTyped();
      f.advance(600_000);
      f.expire();
      expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
      f.advance(60_000);
      f.expire();
      await vi.waitFor(() => expect(f.contexts.size).toBe(0));
      await f.service.close();
      for (const releaseAt of [0, 600_000]) {
        const held = harness();
        await held.service.create({ windowId, threadId: threadOne, action: action(), policy });
        const release = held.service.holdForPerson(windowId, threadOne)!;
        held.advance(releaseAt);
        release();
        const remaining = Math.max(policy.sessionTimeoutMs - releaseAt, 120_000);
        held.advance(remaining - 1);
        held.expire();
        expect(held.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
        held.advance(1);
        held.expire();
        await vi.waitFor(() => expect(held.contexts.size).toBe(0));
        await held.service.close();
      }
    });

    it("renews on ordinary native person input but not on passive previews or denied actions", async () => {
      const active = harness();
      await active.service.create({ windowId, threadId: threadOne, action: action(), policy });
      active.advance(240_000);
      active.personTyped();
      active.advance(120_000);
      expect(active.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
      await active.service.close();
      for (const kind of ["peek", "denied"] as const) {
        const f = harness();
        await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
        f.advance(240_000);
        if (kind === "peek") await f.service.peekThread(windowId, threadOne);
        else
          await f.service.act({
            windowId,
            capturedBy: "agent",
            request: request({ target: "https://unapproved.example" }),
          });
        f.advance(60_000);
        f.expire();
        await vi.waitFor(() => expect(f.contexts.size).toBe(0));
        await f.service.close();
      }
    });

    it("an old queued timer rechecks a renewed deadline instead of expiring active work", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      const initial = f.timers.at(-1)!;
      f.advance(240_000);
      await f.service.act({ windowId, capturedBy: "agent", request: request() });
      f.advance(60_000);
      initial.run();
      expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
      await f.service.close();
    });

    it("an already queued timer cannot restart expiry scheduling after an explicit stop", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      const timer = f.timers.at(-1)!;
      await f.service.stop(windowId, threadOne, contextOne);
      const count = f.timers.length;
      f.advance(policy.sessionTimeoutMs);
      timer.run();
      expect(f.timers).toHaveLength(count);
      expect(f.service.inspectThread(windowId, threadOne).context).toBeUndefined();
      await f.service.close();
    });

    it("bounds creating state and closes a late native creation instead of reviving it", async () => {
      const f = harness();
      let finish!: () => void;
      vi.mocked(f.runtime.createContext).mockImplementationOnce(async (id) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        f.contexts.add(id);
      });
      const creation = f.service.create({
        windowId,
        threadId: threadOne,
        action: action(),
        policy,
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(f.timers.at(-1)?.delay).toBe(policy.sessionTimeoutMs);
      f.advance(policy.sessionTimeoutMs);
      f.expire();
      expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("expired");
      expect((await creation).context?.state).toBe("expired");
      finish();
      await vi.waitFor(() => expect(f.contexts.size).toBe(0));
      await f.service.close();
    });

    it.each(["availability", "creation"] as const)(
      "refuses a late %s result even when the expiry timer has not run",
      async (phase) => {
        const f = harness();
        if (phase === "availability") {
          vi.mocked(f.runtime.available).mockImplementationOnce(async () => {
            f.advance(policy.sessionTimeoutMs);
            return true;
          });
        } else {
          vi.mocked(f.runtime.createContext).mockImplementationOnce(async (id) => {
            f.advance(policy.sessionTimeoutMs);
            f.contexts.add(id);
          });
        }
        const result = await f.service.create({
          windowId,
          threadId: threadOne,
          action: action(),
          policy,
        });
        expect(result.context?.state).toBe("expired");
        expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("expired");
        await vi.waitFor(() => expect(f.contexts.size).toBe(0));
        if (phase === "availability") expect(f.runtime.createContext).not.toHaveBeenCalled();
        await f.service.close();
      },
    );

    it("starts idle at activation, and never renews from a late action completion or input", async () => {
      const f = harness();
      vi.mocked(f.runtime.createContext).mockImplementationOnce(async (id) => {
        f.advance(240_000);
        f.contexts.add(id);
      });
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      f.advance(120_000);
      expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("active");
      vi.mocked(f.runtime.act).mockImplementationOnce(async () => {
        f.advance(policy.sessionTimeoutMs + 1);
        return { url: "https://example.com", title: "Late answer" };
      });
      const result = await f.service.act({ windowId, capturedBy: "agent", request: request() });
      expect(result.failure?.category).toBe("context-expired");
      f.personTyped();
      expect(f.service.inspectThread(windowId, threadOne).context?.state).toBe("expired");
      await f.service.close();
    });

    it("held agent calls do not extend the normal idle clock beyond the release grace", async () => {
      const f = harness();
      await f.service.create({ windowId, threadId: threadOne, action: action(), policy });
      const release = f.service.holdForPerson(windowId, threadOne)!;
      f.advance(240_000);
      await f.service.act({ windowId, capturedBy: "agent", request: request() });
      release();
      f.advance(120_000);
      f.expire();
      await vi.waitFor(() => expect(f.contexts.size).toBe(0));
      await f.service.close();
    });
  });

  it("proactively destroys an expired context without waiting for another request", async () => {
    const { advance, contexts, expire, runtime, service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    advance(policy.sessionTimeoutMs);
    expire();
    await vi.waitFor(() =>
      expect(service.inspectThread(windowId, threadOne)).toMatchObject({
        status: "stale",
        context: { state: "expired" },
        failure: { category: "context-expired" },
        evidence: [],
      }),
    );
    expect(runtime.closeContext).toHaveBeenCalledWith(contextOne);
    expect(contexts.has(contextOne)).toBe(false);
  });

  it("keeps only the former profile on an expired page and clears it on stop or reopening", async () => {
    const fixture = harness();
    await fixture.service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy: { ...policy, profile: { kind: "personal" } },
    });
    await fixture.service.act({ windowId, request: request() });
    fixture.advance(policy.sessionTimeoutMs);
    fixture.expire();
    await vi.waitFor(() => expect(fixture.contexts.size).toBe(0));
    const expired = fixture.service.inspectThread(windowId, threadOne);
    expect(expired.failure).toMatchObject({
      category: "context-expired",
      message: expect.stringContaining('profile "personal"'),
    });
    expect(expired.observation).toBeUndefined();
    expect(expired.evidence).toEqual([]);
    expect(fixture.service.inspectThread(otherWindowId, threadOne).failure).toBeUndefined();
    expect(fixture.service.inspectThread(windowId, threadTwo).failure).toBeUndefined();
    await fixture.service.releaseThread(windowId, threadOne);
    expect(fixture.service.inspectThread(windowId, threadOne).failure).toBeUndefined();
    await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
    fixture.advance(policy.sessionTimeoutMs);
    fixture.expire();
    await vi.waitFor(() => expect(fixture.contexts.size).toBe(0));
    const reopened = await fixture.service.create({
      windowId,
      threadId: threadOne,
      action: action(),
      policy,
    });
    expect(reopened.context?.state).toBe("active");
    expect(fixture.service.inspectThread(windowId, threadOne).failure).toBeUndefined();
    await fixture.service.close();
  });

  it("does not reveal the expired profile after authority revocation or profile clearing", async () => {
    for (const clear of ["authority", "profile", "window", "host"] as const) {
      const fixture = harness();
      await fixture.service.create({
        windowId,
        threadId: threadOne,
        action: action(),
        policy: { ...policy, profile: { kind: "personal" } },
      });
      fixture.advance(policy.sessionTimeoutMs);
      fixture.expire();
      await vi.waitFor(() => expect(fixture.contexts.size).toBe(0));
      if (clear === "authority") fixture.revoke(threadOne);
      if (clear === "profile") await fixture.service.closeProfile({ kind: "personal" });
      if (clear === "window") await fixture.service.revokeWindow(windowId);
      if (clear === "host") await fixture.service.close();
      const inspected = fixture.service.inspectThread(windowId, threadOne);
      expect(inspected.context).toBeUndefined();
      expect(inspected.failure?.category).not.toBe("context-expired");
      expect(JSON.stringify(inspected)).not.toContain("personal");
      await fixture.service.close();
    }
  });

  it("bounds expiry receipts and forgets the oldest window's metadata", async () => {
    const fixture = harness();
    const windows = Array.from({ length: 257 }, (_, index) =>
      decodeWindowId(`ba000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    );
    for (const scopedWindow of windows) {
      await fixture.service.create({
        windowId: scopedWindow,
        threadId: threadOne,
        action: action(),
        policy,
      });
      fixture.advance(policy.sessionTimeoutMs);
      fixture.expire();
    }
    const first = windows[0];
    const last = windows.at(-1);
    if (first === undefined || last === undefined) throw Error("Missing test window");
    expect(fixture.service.inspectThread(first, threadOne).failure).toBeUndefined();
    expect(fixture.service.inspectThread(last, threadOne).failure?.category).toBe(
      "context-expired",
    );
    await fixture.service.close();
  });

  it("carries a real tool page's expired profile across turns without reopening it", async () => {
    const fixture = harness();
    const modelBindings = new Map<string, BrowserModelBinding>();
    const makeTools = () =>
      createBrowserAppManagedTools({
        windowId,
        threadId: threadOne,
        mode: "work",
        modelId: "model-a",
        resolveModelId: () => "model-a",
        resolveAuthority: () => authorityOne,
        modelBindings,
        executionPolicy: "approval-gated",
        browser: {
          inspectThread: fixture.service.inspectThread.bind(fixture.service),
          create: fixture.service.create.bind(fixture.service),
          act: fixture.service.act.bind(fixture.service),
          releaseThread: fixture.service.releaseThread.bind(fixture.service),
        },
        approvals: { request: async () => "approved" },
        uuid: () => crypto.randomUUID(),
      });
    const call = (tools: ReturnType<typeof makeTools>, input: Record<string, unknown>) =>
      tools.execute({ name: "octant_browser", inputJson: JSON.stringify(input) });
    await call(makeTools(), {
      operation: "navigate",
      url: "https://example.com/start",
      profile: "personal",
    });
    fixture.advance(600_001);
    fixture.expire();
    await vi.waitFor(() => expect(fixture.contexts.size).toBe(0));
    for (const operation of ["snapshot", "read-page", "screenshot"]) {
      expect(await call(makeTools(), { operation })).toMatchObject({
        isError: true,
        result: {
          failure: {
            category: "context-expired",
            message: expect.stringContaining('profile "personal"'),
          },
        },
      });
    }
    expect(fixture.runtime.createContext).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.act).toHaveBeenCalledTimes(1);
    await call(makeTools(), {
      operation: "navigate",
      url: "https://example.com/start",
      profile: "personal",
    });
    expect(fixture.runtime.createContext).toHaveBeenCalledTimes(2);
    expect(fixture.service.inspectThread(windowId, threadOne).failure).toBeUndefined();
    await fixture.service.close();
  });

  it("says when Continue leaves the real Browser tool on an unapproved site", async () => {
    const fixture = harness();
    vi.mocked(fixture.runtime.createContext).mockImplementation(async (contextId) => {
      fixture.contexts.add(contextId);
      return "native-live";
    });
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId: threadOne,
      mode: "work",
      modelId: "model-a",
      resolveModelId: () => "model-a",
      resolveAuthority: () => authorityOne,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      browser: {
        inspectThread: fixture.service.inspectThread.bind(fixture.service),
        create: fixture.service.create.bind(fixture.service),
        act: fixture.service.act.bind(fixture.service),
        releaseThread: fixture.service.releaseThread.bind(fixture.service),
        holdForPerson: fixture.service.holdForPerson.bind(fixture.service),
      },
      approvals: {
        request: async (input) => {
          if (input.signIn !== undefined)
            vi.mocked(fixture.runtime.act).mockRejectedValueOnce(
              new BrowserNavigationBlockedError("https://identity.example/private?code=secret"),
            );
          return "approved";
        },
      },
      uuid: () => crypto.randomUUID(),
    });
    const call = (input: Record<string, unknown>) =>
      tools.execute({ name: "octant_browser", inputJson: JSON.stringify(input) });
    await call({ operation: "navigate", url: "https://example.com/start", profile: "personal" });
    const answer = await call({ operation: "sign-in" });
    expect(answer).toMatchObject({
      isError: true,
      result: {
        failure: {
          category: "policy-denied",
          reason: "origin-not-approved",
          message: expect.stringContaining(
            "The person left the page on an unapproved site after Continue.",
          ),
        },
      },
    });
    expect(JSON.stringify(answer)).not.toContain("secret");
    expect(JSON.stringify(answer)).not.toContain("identity.example");
    expect(
      fixture.service.inspectThread(windowId, threadOne).context?.policy.allowedOrigins,
    ).toEqual(["https://example.com"]);
    expect(fixture.runtime.createContext).toHaveBeenCalledTimes(1);
    await fixture.service.close();
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
    first.advance(policy.sessionTimeoutMs);
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

  it("explains a new site's approval without navigating outside the existing origin", async () => {
    const fixture = harness();
    await fixture.service.create({ windowId, threadId: threadOne, action: action(), policy });
    const refused = await fixture.service.act({
      windowId,
      request: request({ target: "https://other.example/private?code=secret" }),
    });
    expect(refused.failure).toMatchObject({
      category: "policy-denied",
      reason: "origin-not-approved",
      message: expect.stringContaining("Call stop, then navigate"),
    });
    expect(refused.failure?.message).toContain("sign-in");
    expect(JSON.stringify(refused.failure)).not.toContain("secret");
    expect(fixture.runtime.act).not.toHaveBeenCalled();
    await fixture.service.close();
  });

  it("names the refused origin when a navigation redirects outside the allowlist", async () => {
    const { runtime, service } = harness();
    vi.mocked(runtime.act).mockRejectedValueOnce(
      new BrowserNavigationBlockedError("https://www.example.com/"),
    );
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const failed = await service.act({ windowId, request: request() });
    expect(failed.failure).toMatchObject({
      category: "policy-denied",
      reason: "origin-not-approved",
      message: expect.stringContaining("Call stop, then navigate"),
    });
    expect(failed.failure?.message).toContain("sign-in");
    expect(decodeBrowserAutomationFailure(failed.failure)).toEqual(failed.failure);
  });

  it("carries what the page logged and failed to load into the observation", async () => {
    // The runtime collects these, and the contract carries them, so the only
    // place they can be lost is this conversion. A regression here makes
    // observe-diagnostics answer an empty shell while the runtime still holds
    // the evidence, which is why the assertion is on the observation's own
    // fields rather than on the runtime call.
    const { runtime, service } = harness();
    vi.mocked(runtime.act).mockResolvedValueOnce({
      url: "https://example.com/driven",
      title: "Driven",
      contentHash: "hash",
      consoleErrors: [{ text: "Uncaught TypeError", url: "https://example.com/app.js" }],
      failedRequests: [
        { url: "https://example.com/api", method: "POST", failure: "net::ERR_FAILED" },
      ],
    });
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const result = await service.act({ windowId, request: request() });

    expect(result.observation?.consoleErrors).toEqual([
      { text: "Uncaught TypeError", url: "https://example.com/app.js" },
    ]);
    expect(result.observation?.failedRequests).toEqual([
      { url: "https://example.com/api", method: "POST", failure: "net::ERR_FAILED" },
    ]);
  });

  it("leaves the diagnostics fields absent when the runtime did not collect them", async () => {
    // Absent is not the same claim as empty: an empty array asserts the page
    // logged nothing, which the runtime never said. Ordinary actions must keep
    // the payload shape they already had.
    const { service } = harness();
    await service.create({ windowId, threadId: threadOne, action: action(), policy });
    const result = await service.act({ windowId, request: request() });

    expect(result.observation?.consoleErrors).toBeUndefined();
    expect(result.observation?.failedRequests).toBeUndefined();
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

  it("caps a thread inspect when overlapping stops leave more contexts than the contract allows", async () => {
    const { runtime, service } = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runtime.closeContext).mockImplementation(async () => held);

    for (let i = 0; i < MAX_BROWSER_THREAD_CONTEXTS + 1; i += 1) {
      const created = await service.create({
        windowId,
        threadId: threadOne,
        action: action(),
        policy,
      });
      const contextId = created.context?.contextId;
      expect(contextId).toBeDefined();
      if (contextId === undefined) throw new Error("expected a created context");
      void service.stop(windowId, threadOne, contextId);
      await vi.waitFor(() => {
        expect(service.inspectThread(windowId, threadOne).context?.state).toBe("stopping");
      });
    }

    const snapshot = service.inspectThread(windowId, threadOne);
    expect(snapshot.contexts?.length).toBe(MAX_BROWSER_THREAD_CONTEXTS);
    release();
  });
});
