import type { BrowserDownloadSource } from "@octant/contracts";
import {
  decodeBrowserToolApproval,
  type BrowserToolApproval,
  type BrowserToolApprovalDecision,
} from "@octant/contracts/browser-automation-rpc";
import {
  ANY_BROWSER_ORIGIN,
  decodeToolApprovalId,
  type RememberedBrowserTransfer,
  type StoredBrowserProfile,
  type ToolActionAuthority,
  type WindowId,
} from "@octant/contracts";

/**
 * An approval waits until it is answered or withdrawn, never for a fixed
 * time, so this host-wide cap is the only bound on how many are held.
 */
const MAX_PENDING_APPROVALS = 32;

interface BrowserToolApprovalServiceOptions {
  readonly uuid: () => string;
  readonly now: () => number;
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
   * Persist an "Always allow" answer to an upload or a download save, journaled
   * like a remembered origin. Absent, such an answer approves once.
   */
  readonly rememberTransfer?: (transfer: RememberedBrowserTransfer, windowId: WindowId) => void;
  /** Whether an upload or a download save already holds such an answer; read live. */
  readonly isTransferRemembered?: (transfer: RememberedBrowserTransfer) => boolean;
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
  readonly profileLabel?: (profile: StoredBrowserProfile) => Promise<string | undefined>;
  /**
   * The waiting set changed: a prompt became listable or left the list for
   * a decision, a cancel, a close, or a revocation. Wired only at
   * composition so the service stays free of the change feed.
   */
  readonly onChanged?: () => void;
  /**
   * An ask began to wait. Wired at composition to the paired phones'
   * notifications; it names the thread and the ask and nothing of its content.
   */
  readonly onAsked?: (ask: { readonly threadId: string; readonly askId: string }) => void;
}

/**
 * How an ask ends. None of them is a lapse: an approval that timed out would
 * tell the agent the person refused something they never saw.
 */
export type BrowserToolApprovalOutcome = "approved" | "denied" | "cancelled";

interface PendingApproval {
  readonly view: BrowserToolApproval;
  readonly windowId: WindowId;
  readonly threadId: string;
  readonly authority: ToolActionAuthority;
  /** The thread workspace an upload reads from or a download lands in. */
  readonly workspaceRoot?: string;
  readonly resolve: (decision: BrowserToolApprovalOutcome) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * Host-owned, provider-neutral origin approval for managed Browser calls.
 * Pending entries are scoped to the requesting window and exact thread
 * authority; a routine's entries go to the windows that can see its thread. A
 * decision is one-shot; abort, thread archive, and window revocation all
 * settle as cancelled so a late answer cannot resume a browser effect. No ask
 * has an expiry (a site, an upload, a download, a script, a sign-in): each
 * ends with the person's answer, its turn, its thread's archive, its window,
 * or the host. An upload's staged copies and a download's held file are
 * released by the caller on any outcome but approval, so a withdrawn ask
 * leaves nothing behind.
 */
export class BrowserToolApprovalService {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #options: BrowserToolApprovalServiceOptions;

  constructor(options: BrowserToolApprovalServiceOptions) {
    this.#options = options;
  }

  async request(input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly origin: string;
    /** The Project or Personal profile the page lives in, when it is in one. */
    readonly profile?: StoredBrowserProfile;
    /** Files the agent asks to upload to this origin; see the contract. */
    readonly upload?: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
    /** A download the agent asks to save into the workspace; see the contract. */
    readonly download?: {
      readonly name: string;
      readonly sizeBytes: number;
      readonly mediaType: string;
      readonly source?: BrowserDownloadSource;
    };
    /**
     * The thread workspace an upload or a download save is for. With it, the
     * person's "Always allow" is remembered for this site, this workspace and
     * the page's profile.
     */
    readonly workspaceRoot?: string;
    /** The agent asks the person to sign in here; see the contract. */
    readonly signIn?: { readonly reason?: string };
    readonly script?: { readonly source: string };
    readonly signal?: AbortSignal;
  }): Promise<BrowserToolApprovalOutcome> {
    if (input.signal?.aborted) return Promise.resolve("cancelled");
    if (this.#pending.size >= MAX_PENDING_APPROVALS) return Promise.resolve("denied");
    let profileLabel: string | undefined;
    if (input.profile?.kind === "account") {
      profileLabel = await this.#options.profileLabel?.(input.profile).catch(() => undefined);
      if (input.signal?.aborted) return "cancelled";
      if (
        profileLabel === undefined ||
        profileLabel.trim().length === 0 ||
        profileLabel.length > 256 ||
        this.#pending.size >= MAX_PENDING_APPROVALS ||
        !this.#options.authorityIsCurrent(input.threadId, input.authority, input.windowId)
      )
        return "denied";
    }
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
      ...(profileLabel === undefined ? {} : { profileLabel }),
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
      ...(input.download === undefined
        ? {}
        : {
            download: {
              name: input.download.name.slice(0, 256),
              sizeBytes: input.download.sizeBytes,
              mediaType: input.download.mediaType.slice(0, 128),
              ...(input.download.source === undefined ? {} : { source: input.download.source }),
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
      ...(input.script === undefined ? {} : { script: input.script }),
      requestedAt: new Date(this.#options.now()).toISOString(),
    });
    return new Promise((resolve) => {
      const settle = (decision: BrowserToolApprovalOutcome) => {
        const current = this.#pending.get(String(approvalId));
        if (current === undefined) return;
        this.#pending.delete(String(approvalId));
        this.#options.onChanged?.();
        if (current.signal !== undefined && current.onAbort !== undefined) {
          current.signal.removeEventListener("abort", current.onAbort);
        }
        resolve(decision);
      };
      const onAbort = input.signal === undefined ? undefined : () => settle("cancelled");
      const pending: PendingApproval = {
        view,
        windowId: input.windowId,
        threadId: input.threadId,
        authority: input.authority,
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        resolve: settle,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      };
      this.#pending.set(String(approvalId), pending);
      this.#options.onChanged?.();
      this.#options.onAsked?.({ threadId: input.threadId, askId: String(approvalId) });
      if (input.signal !== undefined && onAbort !== undefined) {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (input.signal?.aborted) settle("cancelled");
    });
  }

  list(windowId: WindowId): ReadonlyArray<BrowserToolApproval> {
    return [...this.#pending.values()]
      .filter((pending) => this.#answerableBy(pending, windowId))
      .map((pending) => pending.view);
  }

  decide(windowId: WindowId, decision: BrowserToolApprovalDecision): boolean {
    const pending = this.#pending.get(String(decision.approvalId));
    if (pending === undefined || !this.#answerableBy(pending, windowId)) return false;
    if (!this.#options.authorityIsCurrent(pending.threadId, pending.authority, pending.windowId)) {
      pending.resolve("denied");
      return false;
    }
    pending.resolve(decision.decision);
    // An upload's or a download's "Always allow" covers later transfers in that
    // direction between this site and this workspace on a page in the same
    // profile; it never becomes a
    // remembered grant to open the origin. A paired device is not at this
    // computer's files, so its answer covers this one transfer only.
    const direction =
      pending.view.upload !== undefined
        ? "upload"
        : pending.view.download !== undefined
          ? "download"
          : undefined;
    if (
      decision.decision === "approved" &&
      decision.remember === true &&
      direction !== undefined &&
      pending.workspaceRoot !== undefined &&
      !this.#isPairedDevice(windowId)
    ) {
      this.#options.rememberTransfer?.(
        {
          direction,
          origin: pending.view.origin,
          workspaceRoot: pending.workspaceRoot,
          ...(pending.view.profile === undefined
            ? { privatePage: true as const }
            : { profile: pending.view.profile }),
        },
        windowId,
      );
    }
    if (
      decision.decision === "approved" &&
      pending.view.upload === undefined &&
      pending.view.download === undefined &&
      pending.view.signIn === undefined &&
      pending.view.script === undefined
    ) {
      // "Allow all sites in this profile" remembers the profile under the
      // any-site entry; a Private page has no profile, so there it remembers
      // nothing wider than the origin the prompt showed.
      const origin =
        decision.rememberProfile === true && pending.view.profile !== undefined
          ? ANY_BROWSER_ORIGIN
          : decision.remember === true && pending.view.origin !== ANY_BROWSER_ORIGIN
            ? pending.view.origin
            : undefined;
      // The answering window journals the grant: for a routine it is the
      // person who saw the prompt, not the host scope that raised it.
      if (origin !== undefined) {
        this.#options.rememberOrigin?.(origin, windowId, pending.view.profile);
      }
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
    const signedIn = pending.view.profile !== undefined || pending.view.script !== undefined;
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

  /** Whether an upload or a download save settles approved without a prompt. */
  isTransferRemembered(transfer: RememberedBrowserTransfer): boolean {
    return this.#options.isTransferRemembered?.(transfer) === true;
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

  /** Gives up what a thread still waits on, when it is archived or deleted. */
  withdrawThread(threadId: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.threadId === threadId) pending.resolve("cancelled");
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.resolve("cancelled");
  }
}
