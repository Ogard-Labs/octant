/**
 * What a host restart left of a thread's session, read from its journal.
 *
 * `turn-cut-off`: a turn had started and never settled. Tool calls are
 * journaled with their turn when it ends, so the journal cannot say whether
 * the turn's last tool call took effect.
 *
 * `answer-dropped`: no turn was open; the session only held an approval or a
 * question nobody can answer any more. An approval-gated effect runs after
 * its answer, so nothing was in flight.
 */
export type RestartRecoveryStanding = "turn-cut-off" | "answer-dropped";

export type UnattendedResumeDecision =
  | { readonly kind: "resume" }
  | {
      readonly kind: "wait";
      readonly reason: "setting-off" | "effect-uncertain" | "resumed-once";
    };

/**
 * Whether a session a restart left needing recovery resumes with nobody
 * there. The setting is off by default and then nothing changes. A cut-off
 * turn always waits: resuming is a new prompt, never a replay, and a person
 * must look when an effect may have landed unrecorded. One unattended resume
 * is allowed until a turn completes or a person resumes, so a restart during
 * the work it started waits instead of resuming again.
 */
export function resumesRecoveryUnattended(input: {
  readonly settingOn: boolean;
  readonly standing: RestartRecoveryStanding;
  readonly resumedUnattendedBefore: boolean;
}): UnattendedResumeDecision {
  if (!input.settingOn) return { kind: "wait", reason: "setting-off" };
  if (input.standing === "turn-cut-off") return { kind: "wait", reason: "effect-uncertain" };
  if (input.resumedUnattendedBefore) return { kind: "wait", reason: "resumed-once" };
  return { kind: "resume" };
}
