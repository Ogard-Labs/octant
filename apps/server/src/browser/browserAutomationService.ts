import type {
  BrowserActionRequest,
  BrowserAutomationFailure,
  BrowserAutomationSnapshot,
  BrowserCaptureOutcome,
  BrowserContextId,
  BrowserContextObservation,
  BrowserContextPolicy,
  BrowserContextRecord,
  BrowserObservation,
  BrowserThreadId,
  BrowserWorkspaceStatus,
  StoredBrowserProfile,
  ThreadExternalContentTaint,
  ToolActionAuthority,
  ToolActionCancellation,
  ToolActionRequest,
  ToolEvidence,
  WindowId,
} from "@octant/contracts";
import {
  MAX_BROWSER_TABS_PER_CONTEXT,
  MAX_BROWSER_THREAD_CONTEXTS,
  sameToolActionAuthority,
} from "@octant/contracts";
import {
  authorizeToolAction,
  browserCaptureTaker,
  canRequestToolCancellation,
  browserProfileKey,
  evaluateBrowserAction,
  evaluateBrowserProfileUse,
  storedBrowserProfile,
  type BrowserCaptureTaker,
  type BrowserPageSnapshotRef,
  type BrowserProfileCaller,
} from "@octant/domain";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import type { KeepBrowserCaptureInput } from "./browserCaptureService";
import {
  BrowserNavigationBlockedError,
  BrowserProfileUnavailableError,
  BrowserTargetStaleError,
  type BrowserPointObservation,
  type BrowserRuntimeAction,
  type BrowserRuntimePort,
} from "./browserRuntimePort";

export interface BrowserAuthorityResolver {
  resolve(
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ): ToolActionAuthority | undefined;
  canAccessWindow(
    windowId: WindowId,
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ): boolean;
}

export interface BrowserAutomationServiceOptions {
  readonly runtime: BrowserRuntimePort;
  readonly authority: BrowserAuthorityResolver;
  /** Optional override; when omitted, a choke-point service wraps `authority`. */
  readonly toolCallAuthority?: ToolCallAuthorityService;
  readonly recordExternalContentIngestion?: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  /**
   * Keeps an explicit screenshot as a thread capture. Absent on a host that
   * keeps none, and never reached for the thread-less Project browser.
   */
  readonly captures?: {
    readonly keep: (input: KeepBrowserCaptureInput) => Promise<BrowserCaptureOutcome>;
  };
  /**
   * Whether a scope is the host acting for a routine, a goal loop, or a
   * subagent's delivered result. Nobody sits there, so such a scope never opens
   * a signed-in page.
   */
  readonly isUnattendedScope?: (windowId: WindowId) => boolean;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly now: () => number;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
}

/** How long a picture of a page stays current before a preview may ask for another. */
const PEEK_INTERVAL_MS = 1_500;

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
  /**
   * What each ref of the latest snapshot names, and the page it was read on.
   * Refs live here, on the server, so an action can name only an element the
   * snapshot listed; a new snapshot replaces them and leaving the page drops
   * them.
   */
  refs:
    | { readonly url: string | undefined; readonly byRef: Map<string, BrowserPageSnapshotRef> }
    | undefined;
  /**
   * The page's text hash as last seen, kept apart from the observation: a
   * snapshot or a credential page carries none, and the next action still
   * needs it to say whether the page changed.
   */
  contentHash: string | undefined;
  /** When a preview last asked the runtime for a picture of the page. */
  peekedAt: number | undefined;
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
/** How many uploads' copies one context keeps for forms not yet sent. */
const MAX_STAGED_UPLOADS = 8;
/** The actions that name one element, and so may name it by a snapshot ref. */
const REF_ACTIONS: ReadonlySet<BrowserActionRequest["kind"]> = new Set([
  "click",
  "type",
  "wait",
  "extract-text",
  "hover",
  "select",
  "drag",
  "upload",
]);
const staleRefFailure: BrowserAutomationFailure = {
  category: "stale",
  message:
    "That ref is not on the page's latest snapshot, or the page changed since. Take a new snapshot and use its refs.",
};

export class BrowserAutomationService {
  readonly #runtime: BrowserRuntimePort;
  readonly #authority: BrowserAuthorityResolver;
  readonly #toolCalls: ToolCallAuthorityService;
  readonly #recordExternalContentIngestion:
    | ((input: RecordExternalContentIngestionInput) => ExternalContentIngestionResult)
    | undefined;
  readonly #captures: BrowserAutomationServiceOptions["captures"];
  readonly #isUnattendedScope: (windowId: WindowId) => boolean;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #schedule: (delayMs: number, callback: () => void) => () => void;
  readonly #contexts = new Map<BrowserContextId, OwnedContext>();
  /** Each context's staged upload copies, deleted when the context closes. */
  readonly #stagedUploads = new Map<BrowserContextId, Array<() => Promise<void>>>();
  readonly #removeProcessExitListener: (() => void) | undefined;

  constructor(options: BrowserAutomationServiceOptions) {
    this.#runtime = options.runtime;
    this.#authority = options.authority;
    this.#toolCalls =
      options.toolCallAuthority ??
      createBrowserToolCallAuthorityService(options.authority, options.clock);
    this.#recordExternalContentIngestion = options.recordExternalContentIngestion;
    this.#captures = options.captures;
    this.#isUnattendedScope = options.isUnattendedScope ?? (() => false);
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
        this.#releaseUploads(contextId);
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
    /**
     * Who is behind the request, for a page in a stored profile. A paired device
     * and a terminal grant name themselves; anything else is the person at a
     * local window unless the scope is the host acting alone.
     */
    readonly profileCaller?: Extract<BrowserProfileCaller, "remote-device" | "terminal-grant">;
  }): Promise<BrowserAutomationSnapshot> {
    const dedicated = input.dedicated === true;
    const current = this.#current(input.windowId, input.threadId);
    if (
      !this.#authority.canAccessWindow(input.windowId, input.threadId, input.action.authority.mode)
    ) {
      if (current !== undefined) this.#revokeAuthority(current);
      return failedSnapshot(
        input.threadId,
        { category: "unauthorized", message: "Browser thread is not owned by this window." },
        "failed",
      );
    }
    const denied = this.#authorizeCreate(input.action, input.policy, input.threadId);
    if (denied !== undefined) {
      if (current !== undefined && !this.#authorityIsActive(current)) {
        this.#revokeAuthority(current);
      }
      return failedSnapshot(input.threadId, denied, "failed");
    }
    const profileDenial = await this.#authorizeProfile(input);
    if (profileDenial !== undefined) return failedSnapshot(input.threadId, profileDenial, "failed");
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
      refs: undefined,
      contentHash: undefined,
      peekedAt: undefined,
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
      } catch (error) {
        if (owned.record.state === "creating") {
          owned.status = owned.abort.signal.aborted ? "interrupted" : "failed";
          owned.failure =
            error instanceof BrowserProfileUnavailableError
              ? { category: "unavailable", reason: "profile-unavailable", message: error.message }
              : {
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
    /**
     * Who asked. A screenshot is kept as a thread capture only when the caller
     * names the agent tool or the person's pane; an unnamed caller keeps none.
     */
    readonly capturedBy?: BrowserCaptureTaker;
    /**
     * For an upload: the absolute paths of the files the request names, as the
     * agent tool resolved them inside the thread's workspace after the person
     * approved. Nothing else supplies a path to a runtime.
     */
    readonly uploadFiles?: ReadonlyArray<string>;
    /**
     * Deletes the copies `uploadFiles` names. The service owns it from here:
     * a page reads an attached file when its form is sent, often in a later
     * action, so the copies stay until the context closes.
     */
    readonly releaseUpload?: () => Promise<void>;
    /**
     * Refuse an action whose expected revision is out of date as `stale`,
     * rather than answering with the page unchanged. The agent tool asks for
     * this; the person's pane does not.
     */
    readonly refuseStaleRevision?: boolean;
  }): Promise<BrowserAutomationSnapshot> {
    const owned = this.#contexts.get(input.request.contextId);
    if (owned === undefined || owned.windowId !== input.windowId) {
      if (input.releaseUpload !== undefined) void input.releaseUpload().catch(() => undefined);
    }
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
    try {
      return await this.#queueAction(owned, () => this.#actOwned(owned, input));
    } finally {
      if (input.releaseUpload !== undefined) this.#keepUpload(owned, input.releaseUpload);
    }
  }

  /**
   * Hold an upload's copies for as long as its context lives, so a later
   * action can still send the form they were attached to. A context that is
   * already closing releases them at once; past the bound, the oldest go.
   */
  #keepUpload(owned: OwnedContext, release: () => Promise<void>): void {
    const contextId = owned.record.contextId;
    if (owned.record.state !== "active" || !this.#contexts.has(contextId)) {
      void release().catch(() => undefined);
      return;
    }
    const kept = this.#stagedUploads.get(contextId) ?? [];
    kept.push(release);
    while (kept.length > MAX_STAGED_UPLOADS)
      void kept
        .shift()?.()
        .catch(() => undefined);
    this.#stagedUploads.set(contextId, kept);
  }

  #releaseUploads(contextId: BrowserContextId): void {
    const kept = this.#stagedUploads.get(contextId);
    this.#stagedUploads.delete(contextId);
    for (const release of kept ?? []) void release().catch(() => undefined);
  }

  async #actOwned(
    owned: OwnedContext,
    input: {
      readonly windowId: WindowId;
      readonly request: BrowserActionRequest;
      readonly capturedBy?: BrowserCaptureTaker;
      readonly uploadFiles?: ReadonlyArray<string>;
      readonly refuseStaleRevision?: boolean;
    },
  ): Promise<BrowserAutomationSnapshot> {
    if (owned.abort.signal.aborted || owned.record.state !== "active") {
      return this.#failure(
        owned,
        { category: "interrupted", message: "The browser context is no longer active." },
        "interrupted",
      );
    }
    const granted = this.#authority.resolve(owned.threadId, modeOf(owned.action.authority));
    if (
      !this.#authority.canAccessWindow(
        owned.windowId,
        owned.threadId,
        modeOf(owned.action.authority),
      ) ||
      granted === undefined ||
      authorizeToolAction(owned.action, granted).kind !== "allowed"
    ) {
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
      // The pane re-polls and tries again; the agent is told, so a batch
      // stops instead of carrying on as if the skipped step had run.
      if (input.refuseStaleRevision !== true) return snapshot(owned);
      return this.#failure(
        owned,
        {
          category: "stale",
          message: `The page changed since revision ${String(input.request.expectedObservationRevision)}; read it again before acting.`,
        },
        owned.status,
      );
    }
    const resolved = this.#resolveRef(owned, input.request);
    if (resolved.kind === "refused") return this.#failure(owned, resolved.failure, "failed");
    // An upload reads files off this computer, so only the agent tool, which
    // resolved them inside the thread's workspace and asked the person, can
    // hand them over. A route's request names no file a runtime would read.
    if (input.request.kind === "upload" && input.uploadFiles === undefined) {
      return this.#failure(
        owned,
        { category: "policy-denied", message: "An upload needs the agent's approved files." },
        "failed",
      );
    }
    const decision = evaluateBrowserAction(resolved.request, owned.record, granted);
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
          resolved.request.target ?? ":focus",
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
      const { files: _named, ...action } = resolved.request;
      const observed = await this.#runtime.act(
        owned.record.contextId,
        {
          ...action,
          ...(resolved.expected === undefined ? {} : { expected: resolved.expected }),
          ...(resolved.destinationExpected === undefined
            ? {}
            : { destinationExpected: resolved.destinationExpected }),
          // Only the files the agent tool resolved and the person approved.
          ...(input.request.kind === "upload" && input.uploadFiles !== undefined
            ? { files: input.uploadFiles }
            : {}),
        },
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
      const change = describeChange(
        input.request.kind,
        {
          url: owned.observation?.url,
          title: owned.observation?.title,
          contentHash: owned.contentHash,
        },
        observed,
      );
      const observation: BrowserObservation = {
        contextId: owned.record.contextId,
        actionId: owned.record.actionId,
        correlationId: owned.record.correlationId,
        authority: owned.record.authority,
        ...(observed.url === undefined ? {} : { url: observed.url }),
        ...(observed.title === undefined ? {} : { title: observed.title }),
        ...(observed.contentHash === undefined ? {} : { contentHash: observed.contentHash }),
        ...(observed.extractedText === undefined ? {} : { extractedText: observed.extractedText }),
        ...(observed.snapshot === undefined ? {} : { snapshot: observed.snapshot }),
        ...(change === undefined ? {} : { change }),
        ...(observed.screenshotDataUrl === undefined
          ? {}
          : { screenshotDataUrl: observed.screenshotDataUrl }),
        ...(observed.viewport === undefined ? {} : { viewport: observed.viewport }),
        ...(observed.tabs === undefined ? {} : { tabs: observed.tabs }),
        // Only the observe-diagnostics action collects these, and it reports
        // them as absent rather than empty when the runtime did not supply
        // them: an empty array would claim the page logged nothing, which is a
        // different statement from the runtime not being asked to look.
        ...(observed.consoleErrors === undefined ? {} : { consoleErrors: observed.consoleErrors }),
        ...(observed.failedRequests === undefined
          ? {}
          : { failedRequests: observed.failedRequests }),
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
      // After the ingestion above: the thread's taint is recorded before any
      // picture of that page is kept.
      const capture = await this.#keepCapture(owned, input, observed);
      owned.observation = capture === undefined ? observation : { ...observation, capture };
      if (observed.contentHash !== undefined) owned.contentHash = observed.contentHash;
      if (observed.snapshotRefs !== undefined) {
        owned.refs = {
          url: observed.url,
          byRef: new Map((observed.snapshotRefs ?? []).map((entry) => [entry.ref, entry])),
        };
      } else if (
        owned.refs !== undefined &&
        (input.request.kind === "navigate" ||
          input.request.kind.startsWith("tab-") ||
          observed.url !== owned.refs.url)
      ) {
        owned.refs = undefined;
      }
      owned.evidence.push(evidence);
      if (owned.evidence.length > MAX_RETAINED_BROWSER_EVIDENCE) {
        owned.evidence.splice(0, owned.evidence.length - MAX_RETAINED_BROWSER_EVIDENCE);
      }
      owned.failure = undefined;
      owned.status = "running";
      return snapshot(owned);
    } catch (error) {
      const interrupted = owned.abort.signal.aborted;
      if (!interrupted && error instanceof BrowserTargetStaleError) {
        return this.#failure(owned, staleRefFailure, "failed");
      }
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

  /**
   * Turn a ref into the selector the snapshot recorded for it, with the role
   * and name the runtime must still find there. A ref the latest snapshot did
   * not list, or one from before the page changed, is refused here, before
   * any runtime is asked.
   */
  #resolveRef(
    owned: OwnedContext,
    request: BrowserActionRequest,
  ):
    | {
        readonly kind: "resolved";
        readonly request: BrowserActionRequest;
        readonly expected?: NonNullable<BrowserRuntimeAction["expected"]>;
        readonly destinationExpected?: NonNullable<BrowserRuntimeAction["expected"]>;
      }
    | { readonly kind: "refused"; readonly failure: BrowserAutomationFailure } {
    if (request.ref === undefined && request.destinationRef === undefined) {
      return { kind: "resolved", request };
    }
    if (
      (request.ref !== undefined &&
        (request.target !== undefined || request.point !== undefined)) ||
      (request.destinationRef !== undefined && request.destination !== undefined)
    ) {
      return {
        kind: "refused",
        failure: {
          category: "invalid",
          message: "Name the element with a ref or a selector, not both.",
        },
      };
    }
    if (
      (request.ref !== undefined && !REF_ACTIONS.has(request.kind)) ||
      (request.destinationRef !== undefined && request.kind !== "drag")
    ) {
      return {
        kind: "refused",
        failure: { category: "invalid", message: `A ${request.kind} action takes no ref.` },
      };
    }
    const url = owned.refs?.url ?? "about:blank";
    const entry = request.ref === undefined ? undefined : owned.refs?.byRef.get(request.ref);
    const drop =
      request.destinationRef === undefined
        ? undefined
        : owned.refs?.byRef.get(request.destinationRef);
    if (
      (request.ref !== undefined && entry === undefined) ||
      (request.destinationRef !== undefined && drop === undefined)
    ) {
      return { kind: "refused", failure: staleRefFailure };
    }
    const { ref: _ref, destinationRef: _destinationRef, ...rest } = request;
    return {
      kind: "resolved",
      request: {
        ...rest,
        ...(entry === undefined ? {} : { target: entry.selector }),
        ...(drop === undefined ? {} : { destination: drop.selector }),
      },
      ...(entry === undefined ? {} : { expected: { role: entry.role, name: entry.name, url } }),
      ...(drop === undefined
        ? {}
        : { destinationExpected: { role: drop.role, name: drop.name, url } }),
    };
  }

  /**
   * Keep the screenshot an explicit `screenshot` action just took. The action
   * has already succeeded, so a copy that cannot be kept is reported on the
   * observation instead of failing the action.
   */
  async #keepCapture(
    owned: OwnedContext,
    input: {
      readonly request: BrowserActionRequest;
      readonly capturedBy?: BrowserCaptureTaker;
    },
    observed: {
      readonly screenshotDataUrl?: string;
      readonly url?: string;
      readonly title?: string;
    },
  ): Promise<BrowserCaptureOutcome | undefined> {
    const takenBy = browserCaptureTaker(input.request.kind, input.capturedBy);
    if (takenBy === undefined || this.#captures === undefined) return undefined;
    // Someone asked for a capture and the runtime withheld the picture. Saying
    // nothing here left the pane looking as if the capture had been kept.
    if (observed.screenshotDataUrl === undefined) {
      return { status: "not-kept", reason: "no-picture" };
    }
    try {
      return await this.#captures.keep({
        threadId: owned.threadId,
        dataUrl: observed.screenshotDataUrl,
        url: observed.url,
        title: observed.title,
        takenBy,
        ...(storedBrowserProfile(owned.record.policy.profile) === undefined
          ? {}
          : { profile: storedBrowserProfile(owned.record.policy.profile) }),
        providerInstanceId: owned.record.authority.providerInstanceId,
        correlationId: owned.action.correlationId,
      });
    } catch {
      return { status: "not-kept", reason: "unavailable" };
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
    if (
      !this.#authority.canAccessWindow(
        owned.windowId,
        owned.threadId,
        modeOf(owned.action.authority),
      ) ||
      granted === undefined ||
      authorizeToolAction(owned.action, granted).kind !== "allowed"
    ) {
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
    const threadContexts = [...this.#contexts.values()]
      .filter(
        (owned) =>
          owned.windowId === windowId &&
          owned.threadId === threadId &&
          !owned.dedicated &&
          (owned.record.state === "active" ||
            owned.record.state === "creating" ||
            owned.record.state === "stopping" ||
            owned.record.state === "failed"),
      )
      .sort(
        (left, right) =>
          contextInspectWeight(right.record.state) - contextInspectWeight(left.record.state),
      )
      .slice(0, MAX_BROWSER_THREAD_CONTEXTS);
    if (threadContexts.length === 0) return { status: "ready", threadId, evidence: [] };
    if (threadContexts.length === 1) {
      const single = threadContexts[0];
      if (single === undefined) return { status: "ready", threadId, evidence: [] };
      return this.inspect(windowId, threadId, single.record.contextId);
    }
    const inspected = threadContexts.map((owned) =>
      this.inspect(windowId, threadId, owned.record.contextId),
    );
    const active = inspected.filter(
      (snap) => snap.context !== undefined && snap.failure === undefined,
    );
    if (active.length === 0) {
      const unauthorized = inspected.find((snap) => snap.failure?.category === "unauthorized");
      return (
        unauthorized ??
        failedSnapshot(
          threadId,
          { category: "unavailable", message: "No browser context is available for this thread." },
          "failed",
        )
      );
    }
    return threadSnapshotFromSnapshots(active, threadId);
  }

  /**
   * The thread's Browser as it stands, with a fresh look at the page when the
   * runtime can take one. A page the person drives records no action, so its
   * picture was whatever the agent last saw — usually nothing. A peek records
   * no evidence and takes no authority: it reads what the context already
   * shows, and no more often than the interval however often a preview asks.
   */
  async peekThread(
    windowId: WindowId,
    threadId: BrowserThreadId,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot> {
    const owned = this.#current(windowId, threadId);
    if (owned !== undefined) await this.#refreshPicture(owned, signal);
    return this.inspectThread(windowId, threadId);
  }

  /**
   * One context as it stands, with a fresh picture when the last one is
   * stale: the Browser pane that holds a context's id polls this, and an
   * agent's action no longer leaves a picture behind for it.
   */
  async peekContext(
    windowId: WindowId,
    threadId: BrowserThreadId,
    contextId: BrowserContextId,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot> {
    const owned = this.#contexts.get(contextId);
    if (
      owned !== undefined &&
      owned.windowId === windowId &&
      String(owned.threadId) === String(threadId) &&
      // A native page is on the person's screen already; only a headless one
      // is seen as a picture.
      owned.record.presentation !== "native-live" &&
      this.#authorityIsActive(owned)
    ) {
      await this.#refreshPicture(owned, signal);
    }
    return this.inspect(windowId, threadId, contextId);
  }

  async #refreshPicture(owned: OwnedContext, signal: AbortSignal | undefined): Promise<void> {
    // Called on the runtime, never detached: a runtime's peek reaches for its
    // own state, and a bare reference to it arrived there with no `this`.
    const runtime = this.#runtime;
    if (
      runtime.peek !== undefined &&
      // A live context is "running" for as long as it exists; "waiting" is one
      // still being created, whose page is not there to look at yet.
      owned.status === "running" &&
      !this.#pictureFresh(owned)
    ) {
      owned.peekedAt = this.#now();
      try {
        const observed = await runtime.peek(
          owned.record.contextId,
          signal ?? new AbortController().signal,
        );
        // A fresh picture of the same page is not a new page: keeping the
        // revision lets an agent's next action, which names the revision its
        // last action returned, still run while a preview is open.
        const samePage =
          owned.observation !== undefined &&
          observed.url === owned.observation.url &&
          observed.title === owned.observation.title;
        owned.observation = {
          contextId: owned.record.contextId,
          actionId: owned.record.actionId,
          correlationId: owned.record.correlationId,
          authority: owned.record.authority,
          ...(observed.url === undefined ? {} : { url: observed.url }),
          ...(observed.title === undefined ? {} : { title: observed.title }),
          ...(observed.contentHash === undefined ? {} : { contentHash: observed.contentHash }),
          ...(observed.screenshotDataUrl === undefined
            ? {}
            : { screenshotDataUrl: observed.screenshotDataUrl }),
          ...(observed.viewport === undefined ? {} : { viewport: observed.viewport }),
          revision: samePage ? owned.observationRevision : ++owned.observationRevision,
          observedAt: this.#clock() as BrowserObservation["observedAt"],
          stale: false,
        };
      } catch (error) {
        // The last observation stands; a peek that fails changes nothing for
        // the thread, but the host log says why the preview has no picture.
        console.warn(
          `Octant Browser peek failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        );
      }
    }
  }

  /**
   * Whether the preview's picture is recent enough to skip a peek. An agent's
   * action no longer takes a picture unless asked, so an observation without
   * one does not count: the preview peeks right after the action instead,
   * at most once per interval.
   */
  #pictureFresh(owned: OwnedContext): boolean {
    if (owned.peekedAt !== undefined && this.#now() - owned.peekedAt < PEEK_INTERVAL_MS) {
      return true;
    }
    const observation = owned.observation;
    if (
      observation?.observedAt === undefined ||
      observation.stale ||
      observation.screenshotDataUrl === undefined
    ) {
      return false;
    }
    return Date.parse(this.#clock()) - Date.parse(observation.observedAt) < PEEK_INTERVAL_MS;
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
    for (const contextId of this.#stagedUploads.keys()) this.#releaseUploads(contextId);
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

  /**
   * A stored profile holds sign-ins, so who may open a page in one is decided
   * here, on the server, before any runtime is asked: a paired device, a
   * routine, a subagent, and a terminal grant are refused, and so is a thread
   * that is not the profile's Project's.
   */
  async #authorizeProfile(input: {
    readonly windowId: WindowId;
    readonly action: ToolActionRequest;
    readonly policy: BrowserContextPolicy;
    readonly profileCaller?: Extract<BrowserProfileCaller, "remote-device" | "terminal-grant">;
  }): Promise<BrowserAutomationFailure | undefined> {
    if (storedBrowserProfile(input.policy.profile) === undefined) return undefined;
    const caller: BrowserProfileCaller = this.#isUnattendedScope(input.windowId)
      ? "unattended"
      : (input.profileCaller ?? "person");
    const decision = evaluateBrowserProfileUse({
      profile: input.policy.profile,
      caller,
      nativeBrowserAvailable: (await this.#runtime.nativeAvailable?.()) === true,
      authority: input.action.authority,
    });
    if (decision.kind === "allowed") return undefined;
    return decision.reason === "profile-unavailable"
      ? { category: "unavailable", reason: decision.reason, message: decision.message }
      : { category: "policy-denied", reason: decision.reason, message: decision.message };
  }

  /** The profile a live context keeps its site data in, if the host knows the context. */
  profileOf(contextId: BrowserContextId): BrowserContextPolicy["profile"] {
    return this.#contexts.get(contextId)?.record.policy.profile;
  }

  /**
   * Stop every context that lives in one stored profile. Called when the person
   * signs out of it: a page must not keep a sign-in that was just removed.
   */
  async closeProfile(profile: StoredBrowserProfile): Promise<void> {
    const key = browserProfileKey(profile);
    const closing = [...this.#contexts.values()]
      .filter(
        (owned) =>
          browserProfileKey(owned.record.policy.profile) === key &&
          (owned.record.state === "active" || owned.record.state === "creating"),
      )
      .map((owned) => this.#destroy(owned, "user-requested", "stale"));
    await Promise.allSettled(closing);
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
    if (
      !this.#authority.canAccessWindow(
        owned.windowId,
        owned.threadId,
        modeOf(owned.action.authority),
      )
    ) {
      return false;
    }
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
    this.#releaseUploads(contextId);
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

/**
 * One line on what an action did to the page, from what the page was before
 * and after. Reading the page changes nothing, so a read says nothing; a page
 * whose text the host withheld (a credential form) cannot be compared.
 */
function describeChange(
  kind: BrowserActionRequest["kind"],
  before: {
    readonly url: string | undefined;
    readonly title: string | undefined;
    readonly contentHash: string | undefined;
  },
  after: {
    readonly url?: string;
    readonly title?: string;
    readonly contentHash?: string;
  },
): string | undefined {
  if (
    kind === "extract-text" ||
    kind === "snapshot" ||
    kind === "screenshot" ||
    kind === "observe-diagnostics"
  ) {
    return undefined;
  }
  const changes: string[] = [];
  if (after.url !== before.url) changes.push(`Now at ${after.url ?? "a blank page"}.`);
  if (after.title !== before.title && after.title !== undefined) {
    changes.push(`Title is now ${JSON.stringify(after.title.slice(0, 200))}.`);
  }
  if (after.contentHash === undefined) {
    changes.push("The page holds a credential field, so its content was not compared.");
  } else if (before.contentHash !== undefined && after.contentHash !== before.contentHash) {
    changes.push("The page's text changed.");
  } else if (changes.length === 0 && before.contentHash !== undefined) {
    // A field's value is not page text, so filling one changes no hash.
    changes.push(
      kind === "type" || kind === "select" || kind === "upload"
        ? "The field holds the new value; the page's text did not change."
        : "Nothing visible on the page changed.",
    );
  }
  return changes.length === 0 ? undefined : changes.join(" ").slice(0, 1024);
}

function modeOf(authority: ToolActionAuthority): ToolActionAuthority["mode"] {
  return authority.mode;
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
    return {
      category: "policy-denied",
      message: "Browser automation is unavailable in this mode.",
    };
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

function contextInspectWeight(state: BrowserContextRecord["state"]): number {
  return state === "active" ? 2 : state === "creating" ? 1 : 0;
}

function threadSnapshotFromSnapshots(
  snapshots: ReadonlyArray<BrowserAutomationSnapshot>,
  threadId: BrowserThreadId,
): BrowserAutomationSnapshot {
  const ordered = [...snapshots].sort((left, right) => {
    const leftWeight =
      left.context?.state === "active" ? 2 : left.context?.state === "creating" ? 1 : 0;
    const rightWeight =
      right.context?.state === "active" ? 2 : right.context?.state === "creating" ? 1 : 0;
    return rightWeight - leftWeight;
  });
  const primary = ordered[0];
  if (primary === undefined) {
    return failedSnapshot(
      threadId,
      { category: "unavailable", message: "No browser context is available for this thread." },
      "failed",
    );
  }
  const contexts: BrowserContextObservation[] = ordered
    .slice(0, MAX_BROWSER_THREAD_CONTEXTS)
    .map((snap) => ({
      context: snap.context as BrowserContextRecord,
      ...(snap.observation === undefined ? {} : { observation: snap.observation }),
    }));
  return {
    status: primary.status,
    threadId,
    context: primary.context,
    ...(primary.observation === undefined ? {} : { observation: primary.observation }),
    contexts,
    evidence: [...primary.evidence],
    ...(primary.failure === undefined ? {} : { failure: primary.failure }),
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
