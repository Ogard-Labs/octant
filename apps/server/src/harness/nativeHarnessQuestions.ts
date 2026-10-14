import {
  decodeNativeHarnessQuestion,
  decodeNativeHarnessQuestionId,
  decodeUtcTimestamp,
  type NativeHarnessQuestion,
  type NativeHarnessQuestionId,
  type OctantMode,
  type ProjectId,
  type NativeHarnessSlotCandidate,
  type NativeHarnessInteractionSource,
} from "@octant/contracts";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000;

/**
 * At most this many harness questions wait for a person at once across the
 * whole host, the same cap harness, MCP, and browser tool approvals use. A
 * lead or child that keeps asking would otherwise stack questions without
 * bound; past the cap a question is refused at once and nothing is journaled.
 */
export const MAX_WAITING_NATIVE_HARNESS_QUESTIONS = 32;

/** How an asked, journaled question settles. */
type SettledQuestionOutcome =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "expired" }
  | { readonly status: "cancelled" };

/** A question refused before it was asked; nothing was journaled for it. */
type RefusedQuestionOutcome = { readonly status: "too-many-waiting" };

export type NativeHarnessQuestionOutcome = SettledQuestionOutcome | RefusedQuestionOutcome;

interface Waiter {
  readonly threadId: string;
  readonly expiresAt: number;
  readonly resolve: (outcome: SettledQuestionOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
}

export interface NativeHarnessQuestionStoreOptions {
  readonly sessions: Pick<NativeHarnessSessionStore, "ensure" | "askQuestion" | "settleQuestion">;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly timeoutMs?: number;
  /**
   * Told when a question is asked on a thread, so a mode with its own inline
   * question surface (Code) can show it there as well.
   */
  readonly onAsked?: (input: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly question: NativeHarnessQuestion;
  }) => void;
  /**
   * Told when an asked question settles however it settled, so a surface
   * that showed it (Code's inline question) stops listing it.
   */
  readonly onSettled?: (input: { readonly threadId: string; readonly questionId: string }) => void;
}

/**
 * The questions a lead has asked and not yet had answered. Asking journals
 * the question on the session and blocks the tool call; an answer from any
 * surface settles it and unblocks the model. A question that outlives its
 * timeout or its turn is settled as expired or cancelled, never left hanging.
 */
export class NativeHarnessQuestionStore {
  readonly #options: NativeHarnessQuestionStoreOptions;
  readonly #waiters = new Map<string, Waiter>();

  constructor(options: NativeHarnessQuestionStoreOptions) {
    this.#options = options;
  }

  ask(input: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
    readonly source?: NativeHarnessInteractionSource;
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<
    | (SettledQuestionOutcome & { readonly questionId: NativeHarnessQuestionId })
    | RefusedQuestionOutcome
  > {
    this.#expire();
    if (this.#waiters.size >= MAX_WAITING_NATIVE_HARNESS_QUESTIONS) {
      return Promise.resolve({ status: "too-many-waiting" });
    }
    this.#options.sessions.ensure({
      threadId: input.threadId,
      mode: input.mode,
      projectId: input.projectId,
      leadSlotId: "default" as never,
      lead: input.lead,
    });
    const questionId = decodeNativeHarnessQuestionId(this.#options.uuid());
    const askedAt = decodeUtcTimestamp(this.#options.clock());
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
    const question = decodeNativeHarnessQuestion({
      id: questionId,
      ...(input.source === undefined ? {} : { source: input.source }),
      prompt: input.prompt,
      options: input.options,
      status: "pending",
      askedAt,
    });
    this.#options.sessions.askQuestion(input.threadId, question);
    try {
      this.#options.onAsked?.({ threadId: input.threadId, mode: input.mode, question });
    } catch {
      // A surface that cannot show the question does not stop it being asked.
    }
    return new Promise((resolve) => {
      const settle = (outcome: SettledQuestionOutcome) => {
        const waiter = this.#waiters.get(String(questionId));
        if (waiter === undefined) return;
        this.#waiters.delete(String(questionId));
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        this.#options.sessions.settleQuestion(input.threadId, questionId, outcome);
        try {
          this.#options.onSettled?.({ threadId: input.threadId, questionId: String(questionId) });
        } catch {
          // A surface that cannot withdraw its copy does not stop the settlement.
        }
        resolve({ ...outcome, questionId });
      };
      const waiter: Waiter = {
        threadId: input.threadId,
        expiresAt: Date.parse(askedAt) + timeoutMs,
        resolve: settle,
        timer: setTimeout(() => settle({ status: "expired" }), timeoutMs),
        onAbort: () => settle({ status: "cancelled" }),
        signal: input.signal,
      };
      this.#waiters.set(String(questionId), waiter);
      if (input.signal?.aborted) {
        waiter.onAbort();
        return;
      }
      input.signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  /**
   * The questions a tool call is blocked on right now. An expired or cancelled
   * question, or one lost to a restart, has no waiter and is not here.
   */
  waiting(): ReadonlyArray<{ readonly threadId: string; readonly questionId: string }> {
    this.#expire();
    return [...this.#waiters].map(([questionId, waiter]) => ({
      threadId: waiter.threadId,
      questionId,
    }));
  }

  /** Whether a pending question with this id belongs to the thread. */
  owns(threadId: string, questionId: string): boolean {
    this.#expire();
    return this.#waiters.get(questionId)?.threadId === threadId;
  }

  answer(
    threadId: string,
    questionId: string,
    answer: string,
  ): "answered" | "question-not-found" | "already-settled" {
    this.#expire();
    const waiter = this.#waiters.get(questionId);
    if (waiter === undefined || waiter.threadId !== threadId) {
      // No turn is waiting (a restart, say); the journaled question can still
      // take the answer, and that is an answer, not a refusal.
      const settled = this.#options.sessions.settleQuestion(threadId, questionId as never, {
        status: "answered",
        answer,
      });
      return typeof settled === "string" ? settled : "answered";
    }
    waiter.resolve({ status: "answered", answer });
    return "answered";
  }

  /**
   * Settles every question whose time is up by the clock as expired, journaled
   * exactly as a timer expiry is. A reader of the session view calls this
   * first so the person is never shown an overdue question as pending.
   */
  expireOverdue(): void {
    this.#expire();
  }

  /**
   * The timer alone is not enough: it fires late behind a busy event loop or
   * across a machine's sleep, and until it fires an overdue question would
   * still be listed, could still be answered, and would hold a waiting slot.
   * So asking, listing, and answering all check the clock first, as the
   * harness approvals do.
   */
  #expire(): void {
    const now = Date.parse(this.#options.clock());
    for (const waiter of [...this.#waiters.values()]) {
      if (waiter.expiresAt <= now) waiter.resolve({ status: "expired" });
    }
  }
}
