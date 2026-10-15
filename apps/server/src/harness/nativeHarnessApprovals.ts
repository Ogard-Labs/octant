import {
  decodeNativeHarnessApproval,
  type ApprovalOutsideContent,
  decodeNativeHarnessApprovalId,
  decodeUtcTimestamp,
  type NativeHarnessApproval,
  type NativeHarnessApprovalId,
  type NativeHarnessSlotCandidate,
  type NativeHarnessInteractionSource,
  type OctantMode,
  type ProjectId,
} from "@octant/contracts";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * At most this many harness approvals wait for a person at once across the
 * whole host, the same cap the MCP and browser tool approvals use. A lead or
 * child that keeps asking would otherwise stack prompts without bound; past
 * the cap a call is refused at once and nothing is journaled.
 */
export const MAX_WAITING_NATIVE_HARNESS_APPROVALS = 32;

export type NativeHarnessApprovalOutcome =
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "too-many-waiting";

/** How an asked, journaled approval settles; a refused ask is never journaled. */
type SettledApprovalOutcome = Exclude<NativeHarnessApprovalOutcome, "too-many-waiting">;

interface Waiter {
  readonly threadId: string;
  readonly approvalClass: string;
  readonly allowRemember: boolean;
  readonly expiresAt: number;
  readonly resolve: (outcome: SettledApprovalOutcome, remembered?: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
}

export interface NativeHarnessApprovalStoreOptions {
  readonly sessions: Pick<NativeHarnessSessionStore, "ensure" | "askApproval" | "settleApproval">;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly timeoutMs?: number;
  /**
   * The sources that marked a thread, read when its own single-use approval
   * is asked so the prompt can say why it asks and what the thread read.
   */
  readonly outsideContent?: (threadId: string) => ApprovalOutsideContent | undefined;
  readonly onAsked?: (input: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly approval: NativeHarnessApproval;
  }) => void;
}

/**
 * Tool calls waiting on a person. Asking journals the approval on the
 * session and blocks the call; a decision from any surface settles it. An
 * "always" approval remembers the class for this thread's session only —
 * the thread's posture is untouched, so a restart asks again.
 *
 * A single-use ask (the thread has taken in outside content) is never
 * answered by a remembered class and never remembers one. Taint lasts for the
 * thread's lifetime, so an "always" given then could only ever be a lie.
 */
export class NativeHarnessApprovalStore {
  readonly #options: NativeHarnessApprovalStoreOptions;
  readonly #waiters = new Map<string, Waiter>();
  readonly #remembered = new Map<string, Set<string>>();

  constructor(options: NativeHarnessApprovalStoreOptions) {
    this.#options = options;
  }

  ask(input: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
    readonly toolName: NativeHarnessApproval["toolName"];
    readonly source?: NativeHarnessInteractionSource;
    readonly summary: string;
    readonly approvalClass: string;
    readonly singleUse?: boolean;
    readonly signal?: AbortSignal | undefined;
  }): Promise<NativeHarnessApprovalOutcome> {
    const singleUse = input.singleUse === true;
    if (input.signal?.aborted) return Promise.resolve("cancelled");
    if (input.source !== undefined && input.summary.length > 8_192)
      return Promise.resolve("denied");
    if (
      input.source === undefined &&
      !singleUse &&
      this.#remembered.get(input.threadId)?.has(input.approvalClass) === true
    ) {
      return Promise.resolve("approved");
    }
    this.#expire();
    if (this.#waiters.size >= MAX_WAITING_NATIVE_HARNESS_APPROVALS) {
      return Promise.resolve("too-many-waiting");
    }
    this.#options.sessions.ensure({
      threadId: input.threadId,
      mode: input.mode,
      projectId: input.projectId,
      leadSlotId: "default" as never,
      lead: input.lead,
    });
    const approvalId = decodeNativeHarnessApprovalId(this.#options.uuid());
    const askedAt = decodeUtcTimestamp(this.#options.clock());
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const approval = decodeNativeHarnessApproval({
      id: approvalId,
      toolName: input.toolName,
      ...(input.source === undefined ? {} : { source: input.source }),
      summary: input.summary.length > 240 ? input.summary.slice(0, 240) : input.summary,
      ...(input.source !== undefined && input.summary.length > 240
        ? { detail: input.summary }
        : {}),
      approvalClass: input.approvalClass,
      ...(singleUse ? { singleUse: true } : {}),
      ...this.#outsideContentFor(input.threadId, singleUse && input.source === undefined),
      status: "pending",
      askedAt,
    });
    this.#options.sessions.askApproval(input.threadId, approval);
    try {
      this.#options.onAsked?.({ threadId: input.threadId, mode: input.mode, approval });
    } catch {
      // A surface that cannot show the approval does not stop it being asked.
    }
    return new Promise((resolve) => {
      const settle = (outcome: SettledApprovalOutcome, remembered?: boolean) => {
        const waiter = this.#waiters.get(String(approvalId));
        if (waiter === undefined) return;
        this.#waiters.delete(String(approvalId));
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        this.#options.sessions.settleApproval(input.threadId, approvalId, {
          status: outcome,
          ...(remembered === true ? { remembered: true } : {}),
        });
        resolve(outcome);
      };
      const waiter: Waiter = {
        threadId: input.threadId,
        approvalClass: input.approvalClass,
        allowRemember: input.source === undefined && !singleUse,
        expiresAt: Date.parse(askedAt) + timeoutMs,
        resolve: settle,
        timer: setTimeout(() => settle("expired"), timeoutMs),
        onAbort: () => settle("cancelled"),
        signal: input.signal,
      };
      this.#waiters.set(String(approvalId), waiter);
      if (input.signal?.aborted) {
        waiter.onAbort();
        return;
      }
      input.signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  #outsideContentFor(
    threadId: string,
    named: boolean,
  ): { readonly outsideContent?: ApprovalOutsideContent } {
    if (!named) return {};
    const outsideContent = this.#options.outsideContent?.(threadId);
    return outsideContent === undefined ? {} : { outsideContent };
  }

  /**
   * The approvals a tool call is blocked on right now. A request that expired,
   * was cancelled, or was lost to a restart has no waiter and is not here, so
   * a reader listing what a person can still answer never lists a dead one.
   */
  waiting(): ReadonlyArray<{ readonly threadId: string; readonly approvalId: string }> {
    this.#expire();
    return [...this.#waiters].map(([approvalId, waiter]) => ({
      threadId: waiter.threadId,
      approvalId,
    }));
  }

  decide(
    threadId: string,
    approvalId: string,
    decision: "approve" | "approve-always" | "deny",
  ): "decided" | "approval-not-found" | "already-settled" {
    this.#expire();
    const waiter = this.#waiters.get(approvalId);
    if (waiter === undefined || waiter.threadId !== threadId) {
      return this.#options.sessions.settleApproval(
        threadId,
        approvalId as NativeHarnessApprovalId,
        {
          status: decision === "deny" ? "denied" : "approved",
        },
      ) === "approval-not-found"
        ? "approval-not-found"
        : "already-settled";
    }
    const remember = decision === "approve-always" && waiter.allowRemember;
    if (remember) {
      const classes = this.#remembered.get(threadId) ?? new Set<string>();
      classes.add(waiter.approvalClass);
      this.#remembered.set(threadId, classes);
    }
    waiter.resolve(decision === "deny" ? "denied" : "approved", remember);
    return "decided";
  }

  /**
   * Settles every approval whose time is up by the clock as expired, journaled
   * exactly as a timer expiry is. A reader of the session view calls this
   * first so the person is never shown an overdue approval as pending.
   */
  expireOverdue(): void {
    this.#expire();
  }

  /**
   * The timer alone is not enough: it fires late behind a busy event loop or
   * across a machine's sleep, and until it fires an overdue approval would
   * still be listed, could still be approved, and would hold a waiting slot.
   * So asking, listing, and deciding all check the clock first, as the MCP
   * and browser tool approvals do.
   */
  #expire(): void {
    const now = Date.parse(this.#options.clock());
    for (const waiter of [...this.#waiters.values()]) {
      if (waiter.expiresAt <= now) waiter.resolve("expired");
    }
  }
}
