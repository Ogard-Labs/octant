import {
  decodeBrowserToolApproval,
  type BrowserToolApproval,
  type BrowserToolApprovalDecision,
} from "@octant/contracts/browser-automation-rpc";
import {
  decodeToolApprovalId,
  type StoredBrowserProfile,
  type ToolActionAuthority,
  type WindowId,
} from "@octant/contracts";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 10 * 60_000;
const MAX_PENDING_APPROVALS = 32;

interface BrowserToolApprovalServiceOptions {
  readonly uuid: () => string;
  readonly now: () => number;
  readonly ttlMs?: number;
  readonly authorityIsCurrent: (
    threadId: string,
    authority: ToolActionAuthority,
    windowId: WindowId,
  ) => boolean;
  /**
   * Persist a granted origin so later requests for it never prompt. Wired to
   * the journaled shell settings at composition; absent, "always allow"
   * decisions approve once and remember nothing.
   */
  readonly rememberOrigin?: (
    origin: string,
    windowId: WindowId,
    profile: StoredBrowserProfile | undefined,
  ) => void;
  /**
   * Whether the origin already holds a remembered grant. Read live: a grant
   * forgotten in Settings stops satisfying this at once.
   */
  readonly isOriginRemembered?: (
    origin: string,
    profile: StoredBrowserProfile | undefined,
  ) => boolean;
  /**
   * Whether a requesting scope is the host acting for a routine. Nobody sits at
   * that scope, so its approvals go to the windows that can see the thread.
   */
  readonly isHostScope?: (windowId: WindowId) => boolean;
  /**
   * Whether a scope is a window of this computer. A scope that is neither a local
   * window nor the host acting alone is a paired device. Absent, no scope is
   * treated as a paired device.
   */
  readonly isLocalWindow?: (windowId: WindowId) => boolean;
  /** How many extensions are enabled in a profile, to name in its prompt. */
  readonly extensionsEnabledIn?: (profile: StoredBrowserProfile) => number;
  /**
   * The waiting set changed: a prompt became listable or left the list for
   * a decision, a cancel, an expiry, a close, or a revocation. Wired only at
   * composition so the service stays free of the change feed.
   */
  readonly onChanged?: () => void;
}

interface PendingApproval {
  readonly view: BrowserToolApproval;
  readonly windowId: WindowId;
  readonly threadId: string;
  readonly authority: ToolActionAuthority;
  readonly resolve: (decision: "approved" | "denied" | "cancelled" | "expired") => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly ttlMs: number;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * Host-owned, provider-neutral origin approval for managed Browser calls.
 * Pending entries are scoped to the requesting window and exact thread
 * authority; a routine's entries go to the windows that can see its thread. A decision is one-shot; abort, expiry, and window revocation all
 * settle as denial so a late answer cannot resume a browser effect.
 */
export class BrowserToolApprovalService {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #ttlMs: number;
  readonly #options: BrowserToolApprovalServiceOptions;

  constructor(options: BrowserToolApprovalServiceOptions) {
    this.#options = options;
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS));
  }

  request(input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly origin: string;
    /** The Project or Personal profile the page lives in, when it is in one. */
    readonly profile?: StoredBrowserProfile;
    /** Files the agent asks to upload to this origin; see the contract. */
    readonly upload?: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
    /** The agent asks the person to sign in here; see the contract. */
    readonly signIn?: { readonly reason?: string };
    readonly signal?: AbortSignal;
  }): Promise<"approved" | "denied" | "cancelled" | "expired"> {
    if (input.signal?.aborted) return Promise.resolve("cancelled");
    if (this.#pending.size >= MAX_PENDING_APPROVALS) return Promise.resolve("denied");
    const approvalId = decodeToolApprovalId(this.#options.uuid());
    const extensionCount =
      input.profile === undefined
        ? 0
        : Math.min(64, this.#options.extensionsEnabledIn?.(input.profile) ?? 0);
    const view = decodeBrowserToolApproval({
      approvalId,
      threadId: input.threadId,
      mode: input.authority.mode,
      origin: input.origin,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(extensionCount > 0 ? { extensionCount } : {}),
      ...(input.upload === undefined
        ? {}
        : {
            upload: {
              files: input.upload.map((file) => ({
                name: file.name.slice(0, 256),
                sizeBytes: file.sizeBytes,
              })),
            },
          }),
      ...(input.signIn === undefined
        ? {}
        : {
            signIn:
              input.signIn.reason === undefined || input.signIn.reason.trim() === ""
                ? {}
                : { reason: input.signIn.reason.trim().slice(0, 300) },
          }),
      requestedAt: new Date(this.#options.now()).toISOString(),
    });
    return new Promise((resolve) => {
      const settle = (decision: "approved" | "denied" | "cancelled" | "expired") => {
        const current = this.#pending.get(String(approvalId));
        if (current === undefined) return;
        this.#pending.delete(String(approvalId));
        this.#options.onChanged?.();
        clearTimeout(current.timer);
        if (current.signal !== undefined && current.onAbort !== undefined) {
          current.signal.removeEventListener("abort", current.onAbort);
        }
        resolve(decision);
      };
      // Signing in can take a second factor and a password manager; it gets
      // the longest wait the service allows.
      const ttlMs = input.signIn === undefined ? this.#ttlMs : MAX_TTL_MS;
      const timer = setTimeout(() => settle("expired"), ttlMs);
      timer.unref?.();
      const onAbort = input.signal === undefined ? undefined : () => settle("cancelled");
      const pending: PendingApproval = {
        view,
        windowId: input.windowId,
        threadId: input.threadId,
        authority: input.authority,
        resolve: settle,
        timer,
        ttlMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      };
      this.#pending.set(String(approvalId), pending);
      this.#options.onChanged?.();
      if (input.signal !== undefined && onAbort !== undefined) {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (input.signal?.aborted) settle("cancelled");
    });
  }

  list(windowId: WindowId): ReadonlyArray<BrowserToolApproval> {
    this.#expire();
    return [...this.#pending.values()]
      .filter((pending) => this.#answerableBy(pending, windowId))
      .map((pending) => pending.view);
  }

  decide(windowId: WindowId, decision: BrowserToolApprovalDecision): boolean {
    this.#expire();
    const pending = this.#pending.get(String(decision.approvalId));
    if (pending === undefined || !this.#answerableBy(pending, windowId)) return false;
    if (!this.#options.authorityIsCurrent(pending.threadId, pending.authority, pending.windowId)) {
      pending.resolve("denied");
      return false;
    }
    pending.resolve(decision.decision);
    // An upload's answer covers those files once; it never becomes a
    // remembered grant for the origin.
    if (
      decision.decision === "approved" &&
      decision.remember === true &&
      pending.view.upload === undefined &&
      pending.view.signIn === undefined
    ) {
      // The answering window journals the grant: for a routine it is the
      // person who saw the prompt, not the host scope that raised it.
      this.#options.rememberOrigin?.(pending.view.origin, windowId, pending.view.profile);
    }
    return true;
  }

  /**
   * A window answers its own prompts. A routine's prompt has no window of its
   * own, so any window that may drive that thread's browser answers it; the
   * answer settles only this prompt and lends the window nothing else of the
   * host scope.
   */
  #answerableBy(pending: PendingApproval, windowId: WindowId): boolean {
    // A signed-in page acts as the person's account, so a paired device neither
    // sees nor answers its approval, and an approval a paired device's turn raised
    // waits for a window of this computer, like a routine's.
    const signedIn = pending.view.profile !== undefined;
    if (signedIn && this.#isPairedDevice(windowId)) return false;
    if (pending.windowId === windowId) return true;
    const isHostScope = this.#options.isHostScope;
    const waitsForPerson =
      (isHostScope?.(pending.windowId) ?? false) ||
      (signedIn && this.#isPairedDevice(pending.windowId));
    if (!waitsForPerson || isHostScope?.(windowId) === true || this.#isPairedDevice(windowId)) {
      return false;
    }
    return this.#options.authorityIsCurrent(pending.threadId, pending.authority, windowId);
  }

  #isPairedDevice(windowId: WindowId): boolean {
    const { isLocalWindow, isHostScope } = this.#options;
    return (
      isLocalWindow !== undefined && !isLocalWindow(windowId) && isHostScope?.(windowId) !== true
    );
  }

  /**
   * Whether a request for this origin settles approved without a prompt — a
   * grant remembered from an earlier "always allow" decision.
   */
  isRemembered(origin: string, profile?: StoredBrowserProfile): boolean {
    return this.#options.isOriginRemembered?.(origin, profile) === true;
  }

  /** Whether a scope is a paired device rather than a window of this computer. */
  isPairedDevice(windowId: WindowId): boolean {
    return this.#isPairedDevice(windowId);
  }

  /** Whether a scope is the host acting alone, with no person to answer a prompt. */
  isUnattendedScope(windowId: WindowId): boolean {
    return this.#options.isHostScope?.(windowId) === true;
  }

  revokeWindow(windowId: WindowId): void {
    for (const pending of this.#pending.values()) {
      if (pending.windowId === windowId) pending.resolve("cancelled");
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.resolve("cancelled");
  }

  #expire(): void {
    const now = this.#options.now();
    for (const pending of this.#pending.values()) {
      if (Date.parse(String(pending.view.requestedAt)) + pending.ttlMs <= now) {
        pending.resolve("expired");
      }
    }
  }
}
