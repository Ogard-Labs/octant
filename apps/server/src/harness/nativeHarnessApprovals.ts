import {
  decodeNativeHarnessApproval,
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

export type NativeHarnessApprovalOutcome = "approved" | "denied" | "expired" | "cancelled";

interface Waiter {
  readonly threadId: string;
  readonly approvalClass: string;
  readonly allowRemember: boolean;
  readonly resolve: (outcome: NativeHarnessApprovalOutcome, remembered?: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
}

export interface NativeHarnessApprovalStoreOptions {
  readonly sessions: Pick<NativeHarnessSessionStore, "ensure" | "askApproval" | "settleApproval">;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly timeoutMs?: number;
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
    this.#options.sessions.ensure({
      threadId: input.threadId,
      mode: input.mode,
      projectId: input.projectId,
      leadSlotId: "default" as never,
      lead: input.lead,
    });
    const approvalId = decodeNativeHarnessApprovalId(this.#options.uuid());
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
      status: "pending",
      askedAt: decodeUtcTimestamp(this.#options.clock()),
    });
    this.#options.sessions.askApproval(input.threadId, approval);
    try {
      this.#options.onAsked?.({ threadId: input.threadId, mode: input.mode, approval });
    } catch {
      // A surface that cannot show the approval does not stop it being asked.
    }
    return new Promise((resolve) => {
      const settle = (outcome: NativeHarnessApprovalOutcome, remembered?: boolean) => {
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
        resolve: settle,
        timer: setTimeout(
          () => settle("expired"),
          this.#options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
        ),
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

  decide(
    threadId: string,
    approvalId: string,
    decision: "approve" | "approve-always" | "deny",
  ): "decided" | "approval-not-found" | "already-settled" {
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
}
