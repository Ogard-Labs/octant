/**
 * How the next Chat or Work turn gets the conversation so far.
 *
 * A provider either keeps a thread's conversation in a session of its own
 * (`runtime`), which a follow-up must resume, or leaves it to the host
 * (`host`), which sends the history again every turn. A thread that moves to a
 * provider of the first kind cannot resume the previous provider's session, so
 * it starts a new one and the host hands the earlier conversation over as
 * text. A thread that moves to a provider of the second kind needs nothing
 * handed over: the host already holds the history.
 */
export type ConversationOwner = "runtime" | "host";

export interface ConversationSessionInput {
  readonly recipient: {
    readonly providerInstanceId: string;
    readonly owner: ConversationOwner;
  };
  /** The thread's latest attempt; absent before its first turn. */
  readonly previous?: {
    readonly providerInstanceId: string;
    /**
     * Whether that attempt's own session can be taken up again as it stands:
     * it recorded a resume cursor, and the model and folder allow the resume.
     * Read only when the recipient is the same provider instance.
     */
    readonly continuable: boolean;
    /**
     * That attempt started a new session with a handoff and never completed.
     * Its session may have started without the provider ever receiving the
     * handoff, and the person was shown none, so the session is not taken up
     * again: the conversation is handed over again in a fresh one.
     */
    readonly undeliveredHandoff?: "provider-switch" | "branch";
  };
  /**
   * The thread is a branch that carries a copy of its source's messages and
   * has run no turn of its own yet, so it has no session to resume. It may
   * have no `previous` attempt at all when it was branched from a turn that
   * kept none.
   */
  readonly branchWithoutSession?: boolean;
  /**
   * Whether this kind of turn may start a new session with a handoff. A retry,
   * a resume and an edit continue or rewrite an existing conversation, so they
   * never start a handed-over one.
   */
  readonly handoff: "allowed" | "refused";
}

export type ConversationSessionDecision =
  | { readonly kind: "host-rebuild" }
  | { readonly kind: "new-session" }
  | { readonly kind: "continue-session" }
  | {
      readonly kind: "new-session-with-handoff";
      readonly reason: "provider-switch" | "branch";
    }
  | {
      readonly kind: "refuse";
      /**
       * `session-unrecoverable`: the same provider cannot take its session up
       * again, and a handoff would replace a conversation it still holds.
       * `handoff-unavailable`: a new session is needed but this kind of turn
       * may not hand the conversation over.
       */
      readonly reason: "session-unrecoverable" | "handoff-unavailable";
    };

export function decideConversationSession(
  input: ConversationSessionInput,
): ConversationSessionDecision {
  if (input.recipient.owner === "host") return { kind: "host-rebuild" };
  // A branch carries messages even when its tail turn kept no attempt (it was
  // branched from a turn that failed or was interrupted), so it is checked
  // before "nothing ran yet".
  if (input.branchWithoutSession === true) {
    return input.handoff === "allowed"
      ? { kind: "new-session-with-handoff", reason: "branch" }
      : { kind: "refuse", reason: "handoff-unavailable" };
  }
  const { previous } = input;
  if (previous === undefined) return { kind: "new-session" };
  if (previous.providerInstanceId === input.recipient.providerInstanceId) {
    if (previous.undeliveredHandoff !== undefined) {
      return input.handoff === "allowed"
        ? { kind: "new-session-with-handoff", reason: previous.undeliveredHandoff }
        : { kind: "refuse", reason: "handoff-unavailable" };
    }
    return previous.continuable
      ? { kind: "continue-session" }
      : { kind: "refuse", reason: "session-unrecoverable" };
  }
  return input.handoff === "allowed"
    ? { kind: "new-session-with-handoff", reason: "provider-switch" }
    : { kind: "refuse", reason: "handoff-unavailable" };
}
