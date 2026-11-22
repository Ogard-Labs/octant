import { validateQuestionnaireAnswer } from "@octant/domain";
import {
  type EventActor,
  decodeNativeHarnessQuestion,
  decodeNativeHarnessQuestionId,
  decodeUtcTimestamp,
  type NativeHarnessQuestion,
  type Questionnaire,
  type NativeHarnessQuestionId,
  type OctantMode,
  type ProjectId,
  type NativeHarnessSlotCandidate,
  type NativeHarnessInteractionSource,
} from "@octant/contracts";
import { whileAwaitingToolApproval } from "../toolEffects/toolEffectLedger";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

/**
 * At most this many harness questions wait for a person at once across the
 * whole host, the same cap harness, MCP, and browser tool approvals use. A
 * question waits until it is answered or its turn stops, never for a fixed
 * time, so the cap is the only bound on a lead or child that keeps asking;
 * past it a question is refused at once and nothing is journaled.
 */
export const MAX_WAITING_NATIVE_HARNESS_QUESTIONS = 32;

/** How an asked, journaled question settles. */
type SettledQuestionOutcome =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "cancelled" };

/** A question refused before it was asked; nothing was journaled for it. */
type RefusedQuestionOutcome = { readonly status: "too-many-waiting" };

export type NativeHarnessQuestionOutcome = SettledQuestionOutcome | RefusedQuestionOutcome;

interface Waiter {
  readonly threadId: string;
  readonly questionnaire?: Questionnaire;
  /** The question asks for a secret; only a secret answer settles it. */
  readonly secret?: true;
  readonly resolve: (outcome: SettledQuestionOutcome, actor?: EventActor) => void;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
}

export interface NativeHarnessQuestionStoreOptions {
  readonly sessions: Pick<
    NativeHarnessSessionStore,
    "ensure" | "askQuestion" | "settleQuestion" | "read"
  >;
  readonly uuid: () => string;
  readonly clock: () => string;
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
 * surface settles it and unblocks the model. An unanswered question waits:
 * a lapse would hand the model a refusal the person never gave. One that
 * outlives its turn (the ask's abort signal) is settled as cancelled.
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
    readonly questionnaire?: Questionnaire;
    readonly options: ReadonlyArray<string>;
    /**
     * A subagent's provider asks for a secret: the answer comes back to the
     * asker in memory and the journal records only that it was given.
     */
    readonly secret?: true;
    readonly signal?: AbortSignal | undefined;
  }): Promise<
    | (SettledQuestionOutcome & { readonly questionId: NativeHarnessQuestionId })
    | RefusedQuestionOutcome
  > {
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
    const question = decodeNativeHarnessQuestion({
      id: questionId,
      ...(input.source === undefined ? {} : { source: input.source }),
      prompt: input.prompt,
      ...(input.questionnaire === undefined ? {} : { questionnaire: input.questionnaire }),
      options: input.options,
      ...(input.secret === true ? { secret: true } : {}),
      status: "pending",
      askedAt,
    });
    this.#options.sessions.askQuestion(input.threadId, question);
    try {
      this.#options.onAsked?.({ threadId: input.threadId, mode: input.mode, question });
    } catch {
      // A surface that cannot show the question does not stop it being asked.
    }
    // A question is the call's own ask and changes nothing, so while it waits
    // the call's record says nothing ran and a restart asks it again.
    return whileAwaitingToolApproval(() => this.#wait(input, questionId));
  }

  #wait(
    input: {
      readonly threadId: string;
      readonly questionnaire?: Questionnaire;
      readonly secret?: true;
      readonly signal?: AbortSignal | undefined;
    },
    questionId: NativeHarnessQuestionId,
  ): Promise<SettledQuestionOutcome & { readonly questionId: NativeHarnessQuestionId }> {
    return new Promise((resolve) => {
      const settle = (outcome: SettledQuestionOutcome, actor?: EventActor) => {
        const waiter = this.#waiters.get(String(questionId));
        if (waiter === undefined) return;
        this.#waiters.delete(String(questionId));
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        // A secret answer goes back to the asker alone; the journal keeps
        // only that the question was answered.
        this.#options.sessions.settleQuestion(
          input.threadId,
          questionId,
          input.secret === true && outcome.status === "answered" ? { status: "answered" } : outcome,
          actor,
        );
        try {
          this.#options.onSettled?.({ threadId: input.threadId, questionId: String(questionId) });
        } catch {
          // A surface that cannot withdraw its copy does not stop the settlement.
        }
        resolve({ ...outcome, questionId });
      };
      const waiter: Waiter = {
        threadId: input.threadId,
        ...(input.questionnaire === undefined ? {} : { questionnaire: input.questionnaire }),
        ...(input.secret === true ? { secret: true } : {}),
        resolve: settle,
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
   * The questions a tool call is blocked on right now. A cancelled question,
   * or one lost to a restart, has no waiter and is not here.
   */
  waiting(): ReadonlyArray<{ readonly threadId: string; readonly questionId: string }> {
    return [...this.#waiters].map(([questionId, waiter]) => ({
      threadId: waiter.threadId,
      questionId,
    }));
  }

  /** Whether a pending question with this id belongs to the thread. */
  owns(threadId: string, questionId: string): boolean {
    return this.#waiters.get(questionId)?.threadId === threadId;
  }

  answer(
    threadId: string,
    questionId: string,
    answer: string,
    /** Who answered, as the route resolved it; absent means the person at this host. */
    actor?: EventActor,
    /**
     * The answer is a secret question's, held in memory only. A secret answer
     * settles only a question that asked for one, and such a question takes
     * no other answer (`invalid-answer` either way).
     */
    secret?: true,
  ): "answered" | "question-not-found" | "already-settled" | "invalid-answer" {
    const waiter = this.#waiters.get(questionId);
    if (waiter === undefined || waiter.threadId !== threadId) {
      const stored = this.#options.sessions
        .read(threadId)
        ?.questions.find((question) => String(question.id) === questionId);
      if (
        stored !== undefined &&
        stored.status === "pending" &&
        (stored.secret === true) !== (secret === true)
      )
        return "invalid-answer";
      // No asker waits to take a secret in memory, and the journal would
      // never hold it, so there is nothing to answer.
      if (
        stored?.status === "pending" &&
        (stored.questionnaire !== undefined || stored.secret === true)
      )
        return "question-not-found";
      // No turn is waiting (a restart, say); the journaled question can still
      // take the answer, and that is an answer, not a refusal.
      const settled = this.#options.sessions.settleQuestion(
        threadId,
        questionId as never,
        { status: "answered", answer },
        actor,
      );
      return typeof settled === "string" ? settled : "answered";
    }
    if ((waiter.secret === true) !== (secret === true)) return "invalid-answer";
    if (
      waiter.questionnaire !== undefined &&
      validateQuestionnaireAnswer(waiter.questionnaire, answer).status === "invalid"
    )
      return "invalid-answer";
    waiter.resolve({ status: "answered", answer }, actor);
    return "answered";
  }

  /**
   * Settles as cancelled what a thread still waits on, when it is archived or
   * deleted. Its turn may still be running, parked on this very wait, and
   * nothing else would ever release the slot.
   */
  withdrawThread(threadId: string): void {
    for (const waiter of Array.from(this.#waiters.values())) {
      if (waiter.threadId === threadId) waiter.resolve({ status: "cancelled" });
    }
  }
}
