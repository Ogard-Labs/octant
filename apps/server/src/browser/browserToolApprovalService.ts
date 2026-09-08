import {
  decodeBrowserToolApproval,
  type BrowserToolApproval,
  type BrowserToolApprovalDecision,
} from "@octant/contracts/browser-automation-rpc";
import { decodeToolApprovalId, type ToolActionAuthority, type WindowId } from "@octant/contracts";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_PENDING_APPROVALS = 32;

interface PendingApproval {
  readonly view: BrowserToolApproval;
  readonly windowId: WindowId;
  readonly threadId: string;
  readonly authority: ToolActionAuthority;
  readonly resolve: (decision: "approved" | "denied" | "cancelled" | "expired") => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * Host-owned, provider-neutral origin approval for managed Browser calls.
 * Pending entries are scoped to the requesting window and exact thread
 * authority. A decision is one-shot; abort, expiry, and window revocation all
 * settle as denial so a late answer cannot resume a browser effect.
 */
export class BrowserToolApprovalService {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #ttlMs: number;

  constructor(
    private readonly options: {
      readonly uuid: () => string;
      readonly now: () => number;
      readonly ttlMs?: number;
      readonly authorityIsCurrent: (threadId: string, authority: ToolActionAuthority) => boolean;
    },
  ) {
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, 10 * 60_000));
  }

  request(input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly origin: string;
    readonly signal?: AbortSignal;
  }): Promise<"approved" | "denied" | "cancelled" | "expired"> {
    if (input.signal?.aborted) return Promise.resolve("cancelled");
    if (this.#pending.size >= MAX_PENDING_APPROVALS) return Promise.resolve("denied");
    const approvalId = decodeToolApprovalId(this.options.uuid());
    const view = decodeBrowserToolApproval({
      approvalId,
      threadId: input.threadId,
      mode: input.authority.mode,
      origin: input.origin,
      requestedAt: new Date(this.options.now()).toISOString(),
    });
    return new Promise((resolve) => {
      const settle = (decision: "approved" | "denied" | "cancelled" | "expired") => {
        const current = this.#pending.get(String(approvalId));
        if (current === undefined) return;
        this.#pending.delete(String(approvalId));
        clearTimeout(current.timer);
        if (current.signal !== undefined && current.onAbort !== undefined) {
          current.signal.removeEventListener("abort", current.onAbort);
        }
        resolve(decision);
      };
      const timer = setTimeout(() => settle("expired"), this.#ttlMs);
      timer.unref?.();
      const onAbort = input.signal === undefined ? undefined : () => settle("cancelled");
      const pending: PendingApproval = {
        view,
        windowId: input.windowId,
        threadId: input.threadId,
        authority: input.authority,
        resolve: settle,
        timer,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      };
      this.#pending.set(String(approvalId), pending);
      if (input.signal !== undefined && onAbort !== undefined) {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (input.signal?.aborted) settle("cancelled");
    });
  }

  list(windowId: WindowId): ReadonlyArray<BrowserToolApproval> {
    this.#expire();
    return [...this.#pending.values()]
      .filter((pending) => pending.windowId === windowId)
      .map((pending) => pending.view);
  }

  decide(windowId: WindowId, decision: BrowserToolApprovalDecision): boolean {
    this.#expire();
    const pending = this.#pending.get(String(decision.approvalId));
    if (pending === undefined || pending.windowId !== windowId) return false;
    if (!this.options.authorityIsCurrent(pending.threadId, pending.authority)) {
      pending.resolve("denied");
      return false;
    }
    pending.resolve(decision.decision);
    return true;
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
    const now = this.options.now();
    for (const pending of this.#pending.values()) {
      if (Date.parse(String(pending.view.requestedAt)) + this.#ttlMs <= now) {
        pending.resolve("expired");
      }
    }
  }
}
