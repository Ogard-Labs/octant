import {
  decodeNativeHarnessQuestion,
  decodeNativeHarnessQuestionId,
  decodeUtcTimestamp,
  type NativeHarnessQuestion,
  type NativeHarnessQuestionId,
  type OctantMode,
  type ProjectId,
  type NativeHarnessSlotCandidate,
} from "@octant/contracts";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000;

export type NativeHarnessQuestionOutcome =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "expired" }
  | { readonly status: "cancelled" };

interface Waiter {
  readonly threadId: string;
  readonly resolve: (outcome: NativeHarnessQuestionOutcome) => void;
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
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<NativeHarnessQuestionOutcome & { readonly questionId: NativeHarnessQuestionId }> {
    this.#options.sessions.ensure({
      threadId: input.threadId,
      mode: input.mode,
      projectId: input.projectId,
      leadSlotId: "default" as never,
      lead: input.lead,
    });
    const questionId = decodeNativeHarnessQuestionId(this.#options.uuid());
    const question = decodeNativeHarnessQuestion({
      id: questionId,
      prompt: input.prompt,
      options: input.options,
      status: "pending",
      askedAt: decodeUtcTimestamp(this.#options.clock()),
    });
    this.#options.sessions.askQuestion(input.threadId, question);
    try {
      this.#options.onAsked?.({ threadId: input.threadId, mode: input.mode, question });
    } catch {
      // A surface that cannot show the question does not stop it being asked.
    }
    return new Promise((resolve) => {
      const settle = (outcome: NativeHarnessQuestionOutcome) => {
        const waiter = this.#waiters.get(String(questionId));
        if (waiter === undefined) return;
        this.#waiters.delete(String(questionId));
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        this.#options.sessions.settleQuestion(input.threadId, questionId, outcome);
        resolve({ ...outcome, questionId });
      };
      const waiter: Waiter = {
        threadId: input.threadId,
        resolve: settle,
        timer: setTimeout(
          () => settle({ status: "expired" }),
          this.#options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
        ),
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

  /** Whether a pending question with this id belongs to the thread. */
  owns(threadId: string, questionId: string): boolean {
    return this.#waiters.get(questionId)?.threadId === threadId;
  }

  answer(
    threadId: string,
    questionId: string,
    answer: string,
  ): "answered" | "question-not-found" | "already-settled" {
    const waiter = this.#waiters.get(questionId);
    if (waiter === undefined || waiter.threadId !== threadId) {
      return this.#options.sessions.settleQuestion(threadId, questionId as never, {
        status: "answered",
        answer,
      }) === "question-not-found"
        ? "question-not-found"
        : "already-settled";
    }
    waiter.resolve({ status: "answered", answer });
    return "answered";
  }
}
