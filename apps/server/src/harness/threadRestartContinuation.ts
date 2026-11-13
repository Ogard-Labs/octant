/**
 * The host's own continuation of the Chat answers and Work turns a restart
 * cut off. It follows the Code continuation (code/codeRestartContinuation.ts):
 * each cut-off turn is continued once, as the host, with the message a
 * person's Resume sends, through the mode's ordinary turn admission, which
 * rechecks authority, posture and the spend ceiling as it admits it. A thread
 * is held for its person instead when the setting or the thread's own switch
 * is off, when a person quit Octant while it ran, when its own continuations
 * keep being cut off, or when its provider cannot take up the session the
 * cut-off turn ran in.
 *
 * Chat and Work keep no journaled push or pull request steps of their own,
 * so the Code hold for an uncertain external action has nothing to read here;
 * the continuation message tells the agent to inspect before repeating.
 */
import type { HostRestartRecovery, HostRestartRecoveryHold } from "@octant/contracts";
import {
  boundedRestartDetail,
  MAX_REPORTED_RESTART_THREADS,
  MAX_RESTART_CONTINUATIONS_CUT_OFF,
  QUIT_HOLD_DETAIL,
  type CodeRestartContinuationAttempts,
} from "../code/codeRestartContinuation";
import { RESTART_CONTINUATION_PROMPT, restartContinuationId } from "./restartContinuation";

/** A Chat attempt or Work turn this start found the previous host still running. */
export interface ThreadTurnCutOffByRestart {
  readonly threadId: string;
  /** The cut-off attempt (Chat) or turn request (Work). */
  readonly turnId: string;
}

/**
 * What the mode reads of a cut-off turn now. `settled` means nothing is owed:
 * the thread is gone or put away, or a newer turn already followed this one.
 */
export type RestartContinuationReadiness =
  | { readonly kind: "settled" }
  | {
      readonly kind: "owed";
      /** The identity the host's own continuation of this turn would carry, if this turn is one. */
      readonly continuationOf: string | undefined;
      readonly optedOut: boolean;
      /** Why the provider cannot take up the session the turn ran in, when it cannot. */
      readonly cannotResume?: string;
    };

export interface ThreadRestartContinuationPorts {
  readonly mode: "chat" | "work";
  /**
   * The previous host stopped because a person quit it, not because it
   * crashed or the system restarted (personQuit.ts).
   */
  readonly quitByPerson: boolean;
  readonly cutOff: ReadonlyArray<ThreadTurnCutOffByRestart>;
  readonly readiness: (turn: ThreadTurnCutOffByRestart) => RestartContinuationReadiness;
  /** The mode's Continue after restart setting. */
  readonly enabled: () => boolean;
  readonly attempts: CodeRestartContinuationAttempts;
  /**
   * Starts the continuation as the host under its one identity. Resolves once
   * the mode admitted the turn, or with the reason it refused.
   */
  readonly dispatch: (
    turn: ThreadTurnCutOffByRestart,
    continuation: string,
    prompt: string,
  ) => Promise<
    { readonly kind: "dispatched" } | { readonly kind: "refused"; readonly detail: string }
  >;
  /**
   * Lifts the thread's native harness session out of the recovery the restart
   * put it in, through the blockers a person's Resume checks. Without it the
   * turn admission refuses a session that still reads recovery-required.
   */
  readonly liftHarnessRecovery: (
    threadId: string,
  ) => Promise<
    { readonly kind: "none" | "lifted" } | { readonly kind: "held"; readonly detail: string }
  >;
  /** Lets the thread's queued messages follow the continuation. */
  readonly releaseQueue: (threadId: string) => Promise<void>;
}

type Entries = Pick<HostRestartRecovery, "continued" | "held">;

export const HOLD_DETAIL: Record<"turned-off" | "opted-out" | "crash-loop", string> = {
  "turned-off": "Continue after restart is off in Settings, so this thread waits for you.",
  "opted-out": "Continue after restart is off for this thread, so it waits for you.",
  "crash-loop":
    "Octant stopped twice while continuing this thread by itself. Check it before continuing.",
};

/**
 * The continuation identity of a cut-off turn, the same on every start, so a
 * repeated recovery lands on the turn the first one admitted.
 */
export function threadRestartContinuationId(
  mode: "chat" | "work",
  turn: ThreadTurnCutOffByRestart,
): string {
  return restartContinuationId(`${mode}:${turn.turnId}`);
}

/** Continues or holds every cut-off turn of one mode, and says which. */
export async function continueThreadTurnsCutOffByRestart(
  ports: ThreadRestartContinuationPorts,
): Promise<Entries> {
  const continued: Array<Entries["continued"][number]> = [];
  const held: Array<Entries["held"][number]> = [];
  const hold = (threadId: string, reason: HostRestartRecoveryHold, detail: string) =>
    held.push({ mode: ports.mode, threadId, reason, detail });
  const seen = new Set<string>();
  for (const turn of ports.cutOff) {
    const readiness = ports.readiness(turn);
    if (readiness.kind === "settled" || seen.has(turn.threadId)) continue;
    seen.add(turn.threadId);
    if (!ports.enabled()) {
      hold(turn.threadId, "turned-off", HOLD_DETAIL["turned-off"]);
      continue;
    }
    if (readiness.optedOut) {
      hold(turn.threadId, "opted-out", HOLD_DETAIL["opted-out"]);
      continue;
    }
    if (ports.quitByPerson) {
      hold(turn.threadId, "quit", QUIT_HOLD_DETAIL);
      continue;
    }
    // The chain goes on only while the cut-off turn is the continuation the
    // host itself started last on this thread; any other turn starts anew.
    const last = ports.attempts.read(turn.threadId);
    const prior =
      last !== undefined &&
      readiness.continuationOf !== undefined &&
      last.operationId === readiness.continuationOf
        ? last.attempts
        : 0;
    if (prior >= MAX_RESTART_CONTINUATIONS_CUT_OFF) {
      hold(turn.threadId, "crash-loop", HOLD_DETAIL["crash-loop"]);
      continue;
    }
    if (readiness.cannotResume !== undefined) {
      hold(turn.threadId, "cannot-resume", readiness.cannotResume);
      continue;
    }
    const lifted = await ports.liftHarnessRecovery(turn.threadId).catch(() => ({
      kind: "held" as const,
      detail: "The thread's harness session could not be resumed.",
    }));
    if (lifted.kind === "held") {
      hold(turn.threadId, "refused", lifted.detail);
      continue;
    }
    const continuation = threadRestartContinuationId(ports.mode, turn);
    // Counted before anything starts, so a continuation that takes the host
    // down with it is counted even though it never reports back.
    ports.attempts.record(turn.threadId, { operationId: continuation, attempts: prior + 1 });
    const dispatched = await ports
      .dispatch(turn, continuation, RESTART_CONTINUATION_PROMPT)
      .catch(() => ({ kind: "refused" as const, detail: "The continuation could not start." }));
    if (dispatched.kind === "refused") {
      hold(turn.threadId, "refused", dispatched.detail);
      continue;
    }
    continued.push({ mode: ports.mode, threadId: turn.threadId });
    // A queue that cannot be released keeps its restart hold for the person.
    await ports.releaseQueue(turn.threadId).catch(() => undefined);
  }
  return { continued, held };
}

/**
 * One summary of everything this start continued or held, across modes, for
 * the host control status. Undefined when the restart cut nothing off.
 */
export function mergeRestartRecoveries(
  at: HostRestartRecovery["at"],
  parts: ReadonlyArray<Entries | undefined>,
): HostRestartRecovery | undefined {
  const continued = parts.flatMap((part) => part?.continued ?? []);
  const held = parts.flatMap((part) => part?.held ?? []);
  return continued.length + held.length === 0
    ? undefined
    : {
        at,
        continued: continued.slice(0, MAX_REPORTED_RESTART_THREADS),
        held: held
          .slice(0, MAX_REPORTED_RESTART_THREADS)
          .map((entry) => ({ ...entry, detail: boundedRestartDetail(entry.detail) })),
      };
}
