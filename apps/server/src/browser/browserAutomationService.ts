import type {
  BrowserActionRequest,
  BrowserAutomationFailure,
  BrowserAutomationSnapshot,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserContextRecord,
  BrowserObservation,
  BrowserThreadId,
  BrowserWorkspaceStatus,
  ThreadExternalContentTaint,
  ToolActionAuthority,
  ToolActionCancellation,
  ToolActionRequest,
  ToolEvidence,
  WindowId,
} from "@octant/contracts";
import { MAX_BROWSER_TABS_PER_CONTEXT, sameToolActionAuthority } from "@octant/contracts";
import {
  authorizeToolAction,
  canRequestToolCancellation,
  evaluateBrowserAction,
  evaluateProfileMode,
} from "@octant/domain";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import {
  BrowserNavigationBlockedError,
  type BrowserPointObservation,
  type BrowserRuntimePort,
} from "./browserRuntimePort";

export interface BrowserAuthorityResolver {
  resolve(threadId: BrowserThreadId, mode: "work" | "code"): ToolActionAuthority | undefined;
}

export interface BrowserAutomationServiceOptions {
  readonly runtime: BrowserRuntimePort;
  readonly authority: BrowserAuthorityResolver;
  /** Optional override; when omitted, a choke-point service wraps `authority`. */
  readonly toolCallAuthority?: ToolCallAuthorityService;
  readonly recordExternalContentIngestion?: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly now: () => number;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
}

interface OwnedContext {
  readonly windowId: WindowId;
  readonly threadId: BrowserThreadId;
  /**
   * A context created for one Open of its own rather than as the thread's
   * shared Browser context. It is deliberately invisible to
   * `#current`, so the Browser surface still reattaches to the thread's own
   * context and a second Local servers Open neither reuses nor replaces the
   * first server's session.
   */
  readonly dedicated: boolean;
  readonly action: ToolActionRequest;
  readonly abort: AbortController;
  actionTail: Promise<void>;
  cancelExpiry: (() => void) | undefined;
  record: BrowserContextRecord;
  status: BrowserWorkspaceStatus;
  observation: BrowserObservation | undefined;
  observationRevision: number;
  readonly evidence: ToolEvidence[];
  failure: BrowserAutomationFailure | undefined;
  creation?: Promise<void>;
}

const hostPolicy: BrowserContextPolicy = {
  profileMode: "isolated",
  allowedOrigins: [],
  credentialFieldProtection: true,
  maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
  sessionTimeoutMs: 600_000,
};
const MAX_RETAINED_BROWSER_EVIDENCE = 32;

export class BrowserAutomationService {
  readonly #runtime: BrowserRuntimePort;
  readonly #authority: BrowserAuthorityResolver;
  readonly #toolCalls: ToolCallAuthorityService;
  readonly #recordExternalContentIngestion:
    | ((input: RecordExternalContentIngestionInput) => ExternalContentIngestionResult)
    | undefined;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #schedule: (delayMs: number, callback: () => void) => () => void;
  readonly #contexts = new Map<BrowserContextId, OwnedContext>();
  readonly #removeProcessExitListener: (() => void) | undefined;

  constructor(options: BrowserAutomationServiceOptions) {
    this.#runtime = options.runtime;
    this.#authority = options.authority;
    this.#toolCalls =
      options.toolCallAuthority ??
      createBrowserToolCallAuthorityService(options.authority, options.clock);
    this.#recordExternalContentIngestion = options.recordExternalContentIngestion;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#now = options.now;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#removeProcessExitListener = this.#runtime.onProcessExit?.((contextIds) => {
      const affected = contextIds === undefined ? undefined : new Set(contextIds);
      for (const [contextId, owned] of this.#contexts) {
        if (affected !== undefined && !affected.has(contextId)) continue;
        if (owned.record.state !== "active" && owned.record.state !== "creating") continue;
        owned.abort.abort();
        owned.cancelExpiry?.();
        owned.cancelExpiry = undefined;
        owned.status = "stale";
        owned.failure = {
          category: "stale",
          message: "The owned browser process exited and this context is no longer usable.",
        };
        if (owned.observation !== undefined) {
          owned.observation = { ...owned.observation, stale: true };
        }
        owned.evidence.splice(0);
        owned.record = stoppedRecord(owned.record, this.#clock(), "error", "failed");
      }
    });
  }

  async create(input: {
    readonly windowId: WindowId;
    readonly threadId: BrowserThreadId;
    readonly action: ToolActionRequest;
    readonly policy: BrowserContextPolicy;
    /** True when this Open needs a context of its own. See `OwnedContext`. */
    readonly dedicated?: boolean | undefined;
  }): Promise<BrowserAutomationSnapshot> {
    const dedicated = input.dedicated === true;
    const denied = this.#authorizeCreate(input.action, input.policy, input.threadId);
    const current = this.#current(input.windowId, input.threadId);
    if (denied !== undefined) {
      if (current !== undefined && !this.#authorityIsActive(current)) {
        this.#revokeAuthority(current);
      }
      return failedSnapshot(input.threadId, denied, "failed");
    }
    // A dedicated Open never reconciles against the thread's shared context: it
    // must neither inherit that context's origin nor stop it to take the slot.
    if (!dedicated && current !== undefined) {
      if (!this.#authorityIsActive(current)) {
        this.#revokeAuthority(current);
        return failedSnapshot(
          input.threadId,
          { category: "unauthorized", message: "Browser context authority is no longer active." },
          "failed",
        );
      }
      if (current.record.state === "creating") await current.creation;
      if (!this.#authorityIsActive(current)) {
        this.#revokeAuthority(current);
        return failedSnapshot(
          input.threadId,
          { category: "unauthorized", message: "Browser context authority is no longer active." },
          "failed",
        );
      }
      return snapshot(current);
    }
    const contextId = this.#uuid() as BrowserContextId;
    const record: BrowserContextRecord = {
      contextId,
      threadId: input.threadId,
      actionId: input.action.actionId,
      correlationId: input.action.correlationId,
      authority: input.action.authority,
      policy: input.policy,
      state: "creating",
      createdAt: this.#clock() as BrowserContextRecord["createdAt"],
    };
    const owned: OwnedContext = {
      windowId: input.windowId,
      threadId: input.threadId,
      dedicated,
      action: input.action,
      abort: new AbortController(),
      actionTail: Promise.resolve(),
      cancelExpiry: undefined,
      record,
      status: "waiting",
      observation: undefined,
      observationRevision: 0,
      evidence: [],
      failure: undefined,
    };
    this.#contexts.set(contextId, owned);
    owned.creation = (async () => {
      try {
        if (!(await this.#runtime.available())) {
          owned.status = "unavailable";
          owned.failure = {
            category: "unavailable",
            message: "No supported host browser runtime is available.",
          };
          owned.record = stoppedRecord(owned.record, this.#clock(), "error", "failed");
          return;
        }
        if (owned.abort.signal.aborted || owned.record.state !== "creating") {
          await this.#safeClose(contextId);
          return;
        }
        const refreshedDenial = this.#authorizeCreate(input.action, input.policy, input.threadId);
        if (refreshedDenial !== undefined) {
          owned.status = "failed";
          owned.failure = refreshedDenial;
          owned.record = stoppedRecord(owned.record, this.#clock(), "authority-revoked", "failed");
          return;
        }
        const presentation = await this.#runtime.createContext(
          contextId,
          input.policy,
          owned.abort.signal,
          {
            windowId: input.windowId,
            threadId: input.threadId,
          },
        );
        if (owned.abort.signal.aborted || owned.record.state !== "creating") {
          await this.#safeClose(contextId);
          return;
        }
        owned.record = {
          ...record,
          ...(presentation === undefined ? {} : { presentation }),
          state: "active",
        };
        owned.status = "running";
        owned.cancelExpiry = this.#schedule(input.policy.sessionTimeoutMs, () => {
          void this.#expireContext(owned);
        });
      } catch {
        if (owned.record.state === "creating") {
          owned.status = owned.abort.signal.aborted ? "interrupted" : "failed";
          owned.failure = {
            category: owned.abort.signal.aborted ? "interrupted" : "failed",
            message: "The host could not create the isolated browser context.",
          };
          owned.record = stoppedRecord(
            owned.record,
            this.#clock(),
            "error",
            owned.abort.signal.aborted ? "stopped" : "failed",
          );
        }
        await this.#safeClose(contextId);
      }
    })();
    await owned.creation;
    const created = snapshot(owned);
    if (owned.record.state !== "active" && owned.record.state !== "creating") {
      this.#contexts.delete(contextId);
    }
    return created;
  }

  async act(input: {
    readonly windowId: WindowId;
    readonly request: BrowserActionRequest;
  }): Promise<BrowserAutomationSnapshot> {
    const owned = this.#contexts.get(input.request.contextId);
    if (owned === undefined) {
      throw new Error("Browser context is stale or unknown.");
    }
    if (owned.windowId !== input.windowId) {
      return failedSnapshot(
        owned.threadId,
        { category: "unauthorized", message: "Browser context belongs to another window." },
        "failed",
      );
    }
    return this.#queueAction(owned, () => this.#actOwned(owned, input));
  }

  async #actOwned(
    owned: OwnedContext,
    input: { readonly windowId: WindowId; readonly request: BrowserActionRequest },
  ): Promise<BrowserAutomationSnapshot> {
    if (owned.abort.signal.aborted || owned.record.state !== "active") {
      return this.#failure(
        owned,
        { category: "interrupted", message: "The browser context is no longer active." },
        "interrupted",
      );
    }
    const granted = this.#authority.resolve(owned.threadId, modeOf(owned.action.authority));
    if (granted === undefined || authorizeToolAction(owned.action, granted).kind !== "allowed") {
      owned.abort.abort();
      await this.#destroy(owned, "authority-revoked", "interrupted");
      return failedSnapshot(
        owned.threadId,
        { category: "unauthorized", message: "Browser action authority is no longer active." },
        "failed",
      );
    }
    if (
      input.request.actionId !== owned.record.actionId ||
      input.request.correlationId !== owned.record.correlationId ||
      !sameToolActionAuthority(input.request.authority, owned.record.authority)
    ) {
      return failedSnapshot(
        owned.threadId,
        { category: "unauthorized", message: "Browser action does not own this context." },
        "failed",
      );
    }
    if (this.#expired(owned)) {
      await this.#destroy(owned, "timeout", "stale");
      return this.#failure(
        owned,
        { category: "context-expired", message: "The browser context expired." },
        "stale",
      );
    }
    if (
      input.request.expectedObservationRevision !== undefined &&
      input.request.expectedObservationRevision !== owned.observation?.revision
    ) {
      return snapshot(owned);
    }
    const decision = evaluateBrowserAction(input.request, owned.record, granted);
    if (decision.kind === "denied") {
      return this.#failure(
        owned,
        { category: "policy-denied", message: decision.reason },
        "failed",
      );
    }
    if (
      (input.request.kind === "type" || input.request.kind === "press") &&
      owned.record.policy.credentialFieldProtection
    ) {
      try {
        const target = await this.#runtime.inspectTarget(
          owned.record.contextId,
          input.request.target ?? ":focus",
          owned.abort.signal,
        );
        if (target.sensitive) {
          return this.#failure(
            owned,
            {
              category: "credential-protected",
              message: "Octant will not type into a sensitive or credential field.",
            },
            "failed",
          );
        }
      } catch {
        return this.#failure(
          owned,
          { category: "failed", message: "Target inspection failed." },
          "failed",
        );
      }
    }
    try {
      const observed = await this.#runtime.act(
        owned.record.contextId,
        input.request,
        owned.abort.signal,
      );
      if (owned.abort.signal.aborted || owned.record.state !== "active") {
        return this.#failure(
          owned,
          { category: "interrupted", message: "The browser action was interrupted." },
          "interrupted",
        );
      }
      if (!this.#authorityIsActive(owned)) {
        await this.#destroy(owned, "authority-revoked", "interrupted");
        return failedSnapshot(
          owned.threadId,
          { category: "unauthorized", message: "Browser action authority was revoked." },
          "interrupted",
        );
      }
      const observation: BrowserObservation = {
        contextId: owned.record.contextId,
        actionId: owned.record.actionId,
        correlationId: owned.record.correlationId,
        authority: owned.record.authority,
        ...(observed.url === undefined ? {} : { url: observed.url }),
        ...(observed.title === undefined ? {} : { title: observed.title }),
        ...(observed.contentHash === undefined ? {} : { contentHash: observed.contentHash }),
        ...(observed.extractedText === undefined ? {} : { extractedText: observed.extractedText }),
        ...(observed.screenshotDataUrl === undefined
          ? {}
          : { screenshotDataUrl: observed.screenshotDataUrl }),
        ...(observed.viewport === undefined ? {} : { viewport: observed.viewport }),
        revision: ++owned.observationRevision,
        observedAt: this.#clock() as BrowserObservation["observedAt"],
        stale: false,
      };
      const evidence: ToolEvidence = {
        evidenceId: this.#uuid() as ToolEvidence["evidenceId"],
        actionId: owned.action.actionId,
        correlationId: owned.action.correlationId,
        authority: owned.action.authority,
        kind: "observation",
        reference: `browser-observation-${this.#uuid()}`,
        origin: "tool-result",
      };
      const ingested = this.#recordExternalContentIngestion?.({
        threadId: owned.threadId,
        provenance: { origin: "tool-result", sourceLabel: "browser-observation" },
        contentReference: evidence.reference,
        correlationId: owned.action.correlationId,
        authorized: true,
      });
      if (ingested?.kind === "refused") {
        return this.#failure(
          owned,
          { category: "failed", message: "The browser action failed." },
          "failed",
        );
      }
      owned.observation = observation;
      owned.evidence.push(evidence);
      if (owned.evidence.length > MAX_RETAINED_BROWSER_EVIDENCE) {
        owned.evidence.splice(0, owned.evidence.length - MAX_RETAINED_BROWSER_EVIDENCE);
      }
      owned.failure = undefined;
      owned.status = "running";
      return snapshot(owned);
    } catch (error) {
      const interrupted = owned.abort.signal.aborted;
      if (!interrupted && error instanceof BrowserNavigationBlockedError) {
        return this.#failure(
          owned,
          {
            category: "policy-denied",
            message: `The page moved to ${new URL(error.url).origin}, which is outside this session's allowed origin. Open ${error.url} directly to browse it there.`,
          },
          "failed",
        );
      }
      return this.#failure(
        owned,
        {
          category: interrupted ? "interrupted" : "failed",
          message: "The browser action failed.",
        },
        interrupted ? "interrupted" : "failed",
      );
    }
  }

  async cancel(input: {
    readonly windowId: WindowId;
    readonly threadId: BrowserThreadId;
    readonly contextId: BrowserContextId;
    readonly cancellation: ToolActionCancellation;
  }): Promise<BrowserAutomationSnapshot> {
    const owned = this.#contexts.get(input.contextId);
    if (owned === undefined) throw new Error("Browser context is stale or unknown.");
    if (
      owned.windowId !== input.windowId ||
      owned.threadId !== input.threadId ||
      !canRequestToolCancellation(owned.action, input.cancellation)
    ) {
      return failedSnapshot(
        input.threadId,
        { category: "unauthorized", message: "Browser cancellation authority is invalid." },
        "failed",
      );
    }
    owned.abort.abort();
    await this.#destroy(owned, input.cancellation.reason, "interrupted");
    owned.failure = { category: "interrupted", message: "Browser automation was cancelled." };
    return snapshot(owned);
  }

  async stop(
    windowId: WindowId,
    threadId: BrowserThreadId,
    contextId: BrowserContextId,
  ): Promise<BrowserAutomationSnapshot> {
    const owned = this.#contexts.get(contextId);
    if (owned === undefined) throw new Error("Browser context is stale or unknown.");
    if (owned.windowId !== windowId || owned.threadId !== threadId) {
      return failedSnapshot(
        threadId,
        {
          category: "unauthorized",
          message: "Browser context is not owned by this thread and window.",
        },
        "failed",
      );
    }
    await this.#destroy(owned, "user-requested", "ready");
    owned.failure = undefined;
    return snapshot(owned);
  }

  inspect(
    windowId: WindowId,
    threadId: BrowserThreadId,
    contextId: BrowserContextId,
  ): BrowserAutomationSnapshot {
    const owned = this.#contexts.get(contextId);
    if (owned === undefined) throw new Error("Browser context is stale or unknown.");
    if (owned.windowId !== windowId || owned.threadId !== threadId) {
      return failedSnapshot(
        threadId,
        {
          category: "unauthorized",
          message: "Browser context is not owned by this thread and window.",
        },
        "failed",
      );
    }
    if (!this.#authorityIsActive(owned)) {
      this.#revokeAuthority(owned);
      return failedSnapshot(
        threadId,
        { category: "unauthorized", message: "Browser context authority is no longer active." },
        "failed",
      );
    }
    if (this.#expired(owned)) {
      this.#markExpired(owned);
      const expired = snapshot(owned);
      void this.#safeClose(owned.record.contextId).finally(() => {
        this.#contexts.delete(owned.record.contextId);
      });
      return expired;
    }
    return snapshot(owned);
  }

  /**
   * Name the element under one point in a context this window owns.
   *
   * Every check `act` runs before touching a page runs here too: the context
   * must be this window's, on this thread, still active, and still holding the
   * authority it was created under. Describing changes nothing, but it reads a
   * page, and reading a page the caller is no longer entitled to see is exactly
   * what these checks exist to prevent. A runtime that cannot read its own page
   * reports the surface unavailable rather than guessing at an element.
   */
  async describePoint(input: {
    readonly windowId: WindowId;
    readonly threadId: BrowserThreadId;
    readonly contextId: BrowserContextId;
    readonly point: { readonly x: number; readonly y: number };
  }): Promise<BrowserPointObservation | { readonly status: "unavailable" }> {
    const owned = this.#contexts.get(input.contextId);
    if (
      owned === undefined ||
      owned.windowId !== input.windowId ||
      String(owned.threadId) !== String(input.threadId) ||
      owned.abort.signal.aborted ||
      owned.record.state !== "active"
    ) {
      return { status: "unavailable" };
    }
    const granted = this.#authority.resolve(owned.threadId, modeOf(owned.action.authority));
    if (granted === undefined || authorizeToolAction(owned.action, granted).kind !== "allowed") {
      return { status: "unavailable" };
    }
    const describe = this.#runtime.describePoint;
    if (describe === undefined) return { status: "unavailable" };
    return this.#queueAction(owned, async () => {
      try {
        return await describe(input.contextId, input.point, owned.abort.signal);
      } catch {
        return { status: "unavailable" as const };
      }
    });
  }

  inspectThread(windowId: WindowId, threadId: BrowserThreadId): BrowserAutomationSnapshot {
    const owned = this.#current(windowId, threadId);
    if (owned === undefined) return { status: "ready", threadId, evidence: [] };
    return this.inspect(windowId, threadId, owned.record.contextId);
  }

  async releaseThread(
    windowId: WindowId,
    threadId: BrowserThreadId,
  ): Promise<BrowserAutomationSnapshot> {
    const ownedContexts = [...this.#contexts.values()].filter(
      (owned) => owned.windowId === windowId && owned.threadId === threadId,
    );
    await Promise.all(
      ownedContexts.map(async (owned) => {
        await this.#destroy(owned, "user-requested", "ready");
        this.#contexts.delete(owned.record.contextId);
      }),
    );
    return { status: "ready", threadId, evidence: [] };
  }

  async revokeWindow(windowId: WindowId): Promise<void> {
    await Promise.all(
      [...this.#contexts.values()]
        .filter((owned) => owned.windowId === windowId)
        .map(async (owned) => {
          owned.abort.abort();
          await this.#destroy(owned, "authority-revoked", "interrupted");
        }),
    );
  }

  async close(): Promise<void> {
    this.#removeProcessExitListener?.();
    for (const owned of this.#contexts.values()) {
      owned.abort.abort();
      owned.cancelExpiry?.();
      owned.cancelExpiry = undefined;
      owned.record = stoppedRecord(owned.record, this.#clock(), "shutdown", "stopped");
      owned.status = "interrupted";
    }
    await this.#runtime.closeAll();
  }

  #authorizeCreate(
    request: ToolActionRequest,
    policy: BrowserContextPolicy,
    threadId: BrowserThreadId,
  ): BrowserAutomationFailure | undefined {
    if (request.approval.kind === "pending" || request.approval.kind === "denied") {
      return { category: "unauthorized", message: "Browser action approval is not active." };
    }
    // Unified choke point: domain policy + granted authority before any runtime port.
    const decision = this.#toolCalls.authorize({
      threadId,
      request,
      arguments: policy,
    });
    if (decision.kind === "deny" || decision.kind === "prompt") {
      return mapToolCallDenial(decision.reason, request);
    }
    if (evaluateProfileMode(policy.profileMode, hostPolicy).kind !== "allowed") {
      return {
        category: "policy-denied",
        message: "Existing-profile access is unavailable without an explicit host grant.",
      };
    }
    if (
      policy.allowedOrigins.length === 0 ||
      !policy.credentialFieldProtection ||
      policy.maxConcurrentTabs > hostPolicy.maxConcurrentTabs ||
      policy.sessionTimeoutMs > hostPolicy.sessionTimeoutMs ||
      (policy.acceptsLocalCertificate === true && !onlyLoopbackHttpsOrigins(policy.allowedOrigins))
    ) {
      return { category: "policy-denied", message: "Browser context policy exceeds host limits." };
    }
    return undefined;
  }

  async #queueAction<T>(owned: OwnedContext, action: () => Promise<T>): Promise<T> {
    const previous = owned.actionTail;
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    owned.actionTail = previous.catch(() => undefined).then(() => completed);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
    }
  }

  #expired(owned: OwnedContext): boolean {
    if (owned.record.state !== "active" && owned.record.state !== "creating") return false;
    return this.#now() - Date.parse(owned.record.createdAt) >= owned.record.policy.sessionTimeoutMs;
  }

  async #destroy(
    owned: OwnedContext,
    reason: BrowserContextRecord["stopReason"],
    status: BrowserWorkspaceStatus,
  ): Promise<void> {
    owned.abort.abort();
    owned.cancelExpiry?.();
    owned.cancelExpiry = undefined;
    owned.record = { ...owned.record, state: "stopping" };
    await this.#safeClose(owned.record.contextId);
    owned.record = stoppedRecord(
      owned.record,
      this.#clock(),
      reason ?? "error",
      reason === "timeout" ? "expired" : "stopped",
    );
    owned.status = status;
    this.#contexts.delete(owned.record.contextId);
  }

  /**
   * The thread's own Browser context. Dedicated contexts are excluded: they
   * belong to the one surface that opened them, so neither the Browser surface
   * nor a later create may attach to, reuse, or replace one.
   */
  #current(windowId: WindowId, threadId: BrowserThreadId): OwnedContext | undefined {
    return [...this.#contexts.values()].find(
      (owned) =>
        owned.windowId === windowId &&
        owned.threadId === threadId &&
        !owned.dedicated &&
        (owned.record.state === "active" || owned.record.state === "creating"),
    );
  }

  #authorityIsActive(owned: OwnedContext): boolean {
    const granted = this.#authority.resolve(owned.threadId, modeOf(owned.action.authority));
    return granted !== undefined && authorizeToolAction(owned.action, granted).kind === "allowed";
  }

  #revokeAuthority(owned: OwnedContext): void {
    owned.abort.abort();
    owned.cancelExpiry?.();
    owned.cancelExpiry = undefined;
    owned.record = stoppedRecord(owned.record, this.#clock(), "authority-revoked", "stopped");
    owned.status = "failed";
    owned.observation = undefined;
    owned.evidence.splice(0);
    owned.failure = {
      category: "unauthorized",
      message: "Browser context authority is no longer active.",
    };
    void this.#safeClose(owned.record.contextId).finally(() => {
      this.#contexts.delete(owned.record.contextId);
    });
  }

  async #expireContext(owned: OwnedContext): Promise<void> {
    if (owned.record.state !== "active" && owned.record.state !== "creating") return;
    this.#markExpired(owned);
    await this.#safeClose(owned.record.contextId);
    this.#contexts.delete(owned.record.contextId);
  }

  #markExpired(owned: OwnedContext): void {
    owned.abort.abort();
    owned.cancelExpiry?.();
    owned.cancelExpiry = undefined;
    owned.record = stoppedRecord(owned.record, this.#clock(), "timeout", "expired");
    owned.status = "stale";
    owned.failure = { category: "context-expired", message: "The browser context expired." };
  }

  async #safeClose(contextId: BrowserContextId): Promise<void> {
    try {
      await this.#runtime.closeContext(contextId);
    } catch {
      // The owned process may already be gone. State remains fail-closed.
    }
  }

  #failure(
    owned: OwnedContext,
    failure: BrowserAutomationFailure,
    status: BrowserWorkspaceStatus,
  ): BrowserAutomationSnapshot {
    owned.failure = failure;
    owned.status = status;
    return snapshot(owned);
  }
}

function modeOf(authority: ToolActionAuthority): "work" | "code" {
  return authority.mode === "code" ? "code" : "work";
}

/**
 * Certificate acceptance is admitted only for a context that can reach nothing
 * but a loopback HTTPS origin. The host, not the renderer, decides that: a
 * request to accept a certificate for any other origin is refused outright
 * rather than quietly downgraded, so no context can be talked into trusting an
 * unverified certificate on the network.
 */
function onlyLoopbackHttpsOrigins(origins: ReadonlyArray<string>): boolean {
  return origins.every((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return false;
    }
    return (
      url.protocol === "https:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  });
}

export function createBrowserToolCallAuthorityService(
  authority: BrowserAuthorityResolver,
  clock?: () => string,
  readThreadTaint?: (threadId: string) => ThreadExternalContentTaint,
  readThreadProfileConstraints?: (threadId: string) =>
    | {
        readonly toolConstraints?: ReadonlyArray<string>;
        readonly profileDisplayName?: string;
      }
    | undefined,
): ToolCallAuthorityService {
  return new ToolCallAuthorityService({
    resolveGrantedAuthority: (threadId, mode) => {
      if (mode !== "work" && mode !== "code") return undefined;
      return authority.resolve(threadId as BrowserThreadId, mode);
    },
    resolveLiveFacts: ({ threadId, request }) => {
      const constraints = readThreadProfileConstraints?.(threadId);
      return {
        providerAppManagedTools: "supported" as const,
        host: { computerUseEnabled: true },
        executionPolicy: "approval-gated" as const,
        approvalSatisfied:
          request.approval.kind === "not-required" || request.approval.kind === "approved",
        // A caller that cannot supply the persisted taint projection is not
        // allowed to turn unknown provenance into authority. The production
        // server passes the projection reader explicitly; this fallback keeps
        // direct service construction fail-closed.
        externalContentIngested: readThreadTaint?.(threadId)?.externalContentIngested ?? true,
        ...(constraints?.toolConstraints === undefined
          ? {}
          : { toolConstraints: constraints.toolConstraints }),
        ...(constraints?.profileDisplayName === undefined
          ? {}
          : { profileDisplayName: constraints.profileDisplayName }),
      };
    },
    ...(clock === undefined ? {} : { clock }),
  });
}

function mapToolCallDenial(reason: string, request: ToolActionRequest): BrowserAutomationFailure {
  if (reason.startsWith("Profile ")) {
    return { category: "policy-denied", message: reason };
  }
  if (reason === "unknown-tool" || reason === "argument-schema-invalid") {
    return { category: "invalid", message: "Browser capability request is invalid." };
  }
  if (reason === "mode-capability-denied") {
    return { category: "policy-denied", message: "Browser automation requires Work or Code." };
  }
  if (
    reason === "granted-authority-missing" ||
    reason === "authority-mismatch" ||
    reason === "mcp-cannot-claim-core"
  ) {
    return { category: "unauthorized", message: "Browser action authority is invalid." };
  }
  if (reason === "provider-capability-unsupported") {
    return {
      category: "unavailable",
      message: "The provider does not support app-managed browser tools.",
    };
  }
  return {
    category: "policy-denied",
    message: `Browser tool call denied (${reason}) for ${request.capability.id}.`,
  };
}

function snapshot(owned: OwnedContext): BrowserAutomationSnapshot {
  return {
    status: owned.status,
    threadId: owned.threadId,
    context: owned.record,
    ...(owned.observation === undefined ? {} : { observation: owned.observation }),
    evidence: [...owned.evidence],
    ...(owned.failure === undefined ? {} : { failure: owned.failure }),
  };
}

function failedSnapshot(
  threadId: BrowserThreadId,
  failure: BrowserAutomationFailure,
  status: BrowserWorkspaceStatus,
): BrowserAutomationSnapshot {
  return { status, threadId, evidence: [], failure };
}

function stoppedRecord(
  record: BrowserContextRecord,
  stoppedAt: string,
  stopReason: NonNullable<BrowserContextRecord["stopReason"]>,
  state: BrowserContextRecord["state"],
): BrowserContextRecord {
  return {
    ...record,
    state,
    stoppedAt: stoppedAt as BrowserContextRecord["stoppedAt"],
    stopReason,
  };
}

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
