import {
  decodeGoalLoop,
  decodeGoalLoopCommand,
  decodeGoalLoopResult,
  decodeGoalLoopRound,
  GOAL_LOOP_EVENT_NAMES,
  type AgentRunAuthority,
  type GoalLoop,
  type GoalLoopCommand,
  type GoalLoopPauseReason,
  type GoalLoopResult,
  type GoalLoopRound,
  type ThreadGoal,
  type ThreadGoalEvidenceRef,
  type ToolApprovalClass,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  decideGoalLoopRound,
  goalLoopPauseText,
  mayCompleteGoalLoop,
  narrowGoalLoopCeiling,
} from "@octant/domain";
import type { GoalLoopFrame } from "./goalLoopEventStore";

/**
 * Running a goal loop.
 *
 * The service owns no policy: every "may this round start, and under what
 * authority" answer comes from the domain, and everything here is the
 * consequence — take the checkpoint, run the turn, record the spend, journal
 * what happened. Each round is an ordinary turn in the thread that owns the
 * goal, so a loop adds no place work happens and no authority the thread did
 * not already have.
 */

export interface GoalLoopRoundOutcome {
  readonly outcome: "ran" | "failed";
  readonly tokensSpent: number;
  readonly elapsedMs: number;
  readonly detail?: string;
  /** Evidence the round produced, which is the only thing that can complete a goal. */
  readonly evidence?: ReadonlyArray<ThreadGoalEvidenceRef>;
  /** Whether the provider believes the objective is met. Never sufficient alone. */
  readonly providerReportsComplete?: boolean;
  /**
   * Whether the runner could read what the provider charged for the round.
   * A token budget is a stopping condition, so a round whose spend nobody
   * saw must stop the loop rather than read as free.
   */
  readonly usageReported?: boolean;
}

export interface GoalLoopDependencies {
  /** The goal this loop works on, and the command path that changes it. */
  readonly readGoal: (threadId: string) => ThreadGoal | null;
  /**
   * Charge one round to the goal. It must charge a round id at most once:
   * a host that stops after the charge and before the round's record settles
   * the same round again on its next start (goalLoopCharge.ts).
   */
  readonly recordUsage: (input: {
    readonly threadId: string;
    readonly roundId: string;
    readonly goal: ThreadGoal;
    readonly tokensSpent: number;
    readonly elapsedMs: number;
    readonly evidence: ReadonlyArray<ThreadGoalEvidenceRef>;
    readonly complete: boolean;
  }) => Promise<void>;
  /** What the thread may do right now. Absent means the thread is gone. */
  readonly threadAuthority: (threadId: string) => AgentRunAuthority | undefined;
  /**
   * What a turn in this thread's mode is fixed at, in the dimensions the turn
   * itself cannot be told to narrow.
   *
   * A Work turn's posture is a property of Work — project-root confined, no
   * shell, no Git — and there is no per-turn grant to hand it. A ceiling that
   * asks for less than the mode already fixes therefore cannot be enforced by
   * running the turn, only by not running it.
   */
  readonly modePosture: (threadId: string) => AgentRunAuthority | undefined;
  /** An approval the thread is already waiting on, when the host knows of one. */
  readonly pendingApproval: (threadId: string) => ToolApprovalClass | undefined;
  /**
   * Mark a checkpoint before the round. Returns its id, or undefined when the
   * thread has none to mark; policy then decides whether the round may run
   * without one, and a loop it pauses carries `checkpoint-unavailable`.
   */
  readonly markCheckpoint: (threadId: string) => Promise<string | undefined>;
  /** Run one ordinary turn against the objective, under exactly this authority. */
  readonly runRound: (input: {
    readonly threadId: string;
    readonly objective: string;
    readonly authority: AgentRunAuthority;
    /** Told what the round has charged so far, each time the runner sees it grow. */
    readonly onSpend?: (tokensSpent: number) => void;
  }) => Promise<GoalLoopRoundOutcome>;
  readonly journal: {
    readonly append: (input: {
      readonly aggregateId: string;
      readonly eventName: string;
      readonly payload: unknown;
    }) => void;
  };
  /**
   * Ask the host to come back for the next round of a continuous loop.
   *
   * The service does not drive itself: a loop that re-entered its own round
   * would decide its own pacing, and a host that wants to stop scheduling work
   * would have nowhere to say so. Absent means rounds are taken only when
   * something asks.
   */
  readonly scheduleNextRound?: (threadId: string) => void;
  /**
   * Ask the host to take the first round of a loop that just began running.
   * Same reason as scheduleNextRound: entering the running state is when a
   * continuous loop starts, and the service does not drive itself.
   */
  readonly scheduleFirstRound?: (threadId: string) => void;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
}

type LoopChanges = Partial<
  Pick<GoalLoop, "status" | "pauseReason" | "ceiling" | "roundsRun" | "lastRoundAt">
>;

function trailingInterrupted(rounds: ReadonlyArray<GoalLoopRound>): number {
  let count = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (rounds[index]?.outcome !== "interrupted") break;
    count += 1;
  }
  return count;
}

/** The status a pause or stop frame leaves a loop in. */
function pausedStatus(
  reason: GoalLoopPauseReason,
  stopped: boolean,
): { readonly status: GoalLoop["status"]; readonly pauseReason: GoalLoopPauseReason } {
  const status = stopped
    ? reason === "goal-complete"
      ? ("complete" as const)
      : ("stopped" as const)
    : reason === "approval-required"
      ? ("awaiting-approval" as const)
      : reason === "budget-exhausted" || reason === "budget-required"
        ? ("budget-limited" as const)
        : ("paused" as const);
  return { status, pauseReason: reason };
}

interface LoopRecord {
  readonly loop: GoalLoop;
  readonly rounds: ReadonlyArray<GoalLoopRound>;
  /** What the last round actually ran under, for the widening check. */
  readonly lastAuthority?: AgentRunAuthority;
  /** Whether the last round's spend was visible, for the token-budget rule. */
  readonly lastSpendObserved?: boolean;
  /** A round the journal shows started and never recorded: the one a restart cut off. */
  readonly openRound?: OpenRound;
}

interface OpenRound {
  readonly roundId: string;
  readonly sequence: number;
  readonly authority: AgentRunAuthority;
  readonly checkpointId?: string;
  readonly startedAt: UtcTimestamp;
  readonly tokensSpent?: number;
  readonly lastSpendAt?: UtcTimestamp;
}

/**
 * How often a running round journals what it has charged. A restart loses at
 * most this much of a round's spend; journaling every usage report would add
 * a frame per model step.
 */
const ROUND_SPEND_JOURNAL_INTERVAL_MS = 5_000;

/**
 * A loop's rounds cut off by restarts in a row before it waits for its person.
 * The first is the restart's own; the rest are the host's continuations, held
 * after two as a cut-off turn's continuations are (MAX_RESTART_CONTINUATIONS_CUT_OFF).
 */
const MAX_ROUNDS_CUT_OFF_IN_A_ROW = 3;

export class GoalLoopService {
  readonly #dependencies: GoalLoopDependencies;
  readonly #byThread = new Map<string, LoopRecord>();
  /** One round at a time per thread: a loop that overlapped itself would spend twice. */
  readonly #inFlight = new Set<string>();

  constructor(dependencies: GoalLoopDependencies) {
    this.#dependencies = dependencies;
  }

  read(threadId: string): {
    readonly loop: GoalLoop | null;
    readonly rounds: ReadonlyArray<GoalLoopRound>;
  } {
    const record = this.#byThread.get(threadId);
    return { loop: record?.loop ?? null, rounds: record?.rounds ?? [] };
  }

  async execute(input: unknown): Promise<GoalLoopResult> {
    let command: GoalLoopCommand;
    try {
      command = decodeGoalLoopCommand(input);
    } catch {
      return this.#refused("loop-not-found", "That goal loop command is not one this host serves.");
    }

    const record = this.#byThread.get(command.threadId);
    if (command.kind === "start-goal-loop") return this.#start(command, record);
    if (record === undefined) {
      return this.#refused("loop-not-found", "There is no loop on this thread.");
    }
    if (record.loop.version !== command.expectedVersion) {
      return this.#refused("stale-version", "The loop changed since you read it.");
    }

    switch (command.kind) {
      case "pause-goal-loop":
        return this.#settle(record, "paused", "paused-by-user", GOAL_LOOP_EVENT_NAMES.paused);
      case "resume-goal-loop": {
        const next = this.#write({
          ...record,
          loop: this.#loopWith(record.loop, { status: "running" }),
        });
        this.#dependencies.journal.append({
          aggregateId: String(record.loop.id),
          eventName: GOAL_LOOP_EVENT_NAMES.resumed,
          payload: { loopId: String(record.loop.id) },
        });
        this.#dependencies.scheduleFirstRound?.(command.threadId);
        return this.#result(next);
      }
      case "stop-goal-loop":
        return this.#settle(record, "stopped", "stopped-by-user", GOAL_LOOP_EVENT_NAMES.stopped);
      case "narrow-goal-loop-ceiling": {
        const change = narrowGoalLoopCeiling(record.loop.ceiling, command.ceiling);
        if (change.outcome === "refused") {
          return this.#refused(
            "would-widen",
            "A running loop's ceiling can only narrow. Stop it and start a new one to widen it.",
          );
        }
        const next = this.#write({
          ...record,
          loop: this.#loopWith(record.loop, { ceiling: change.ceiling }),
        });
        this.#dependencies.journal.append({
          aggregateId: String(record.loop.id),
          eventName: GOAL_LOOP_EVENT_NAMES.ceilingNarrowed,
          payload: { loopId: String(record.loop.id), ceiling: change.ceiling },
        });
        return this.#result(next);
      }
    }
  }

  /**
   * Take one round if policy allows one.
   *
   * The single entry point for both triggers: a continuous loop calls it when
   * the previous round ends, a schedule calls it when the schedule says so.
   * Neither decides anything the other does not — a trigger says when, and
   * every rule below applies to the round it started unchanged.
   */
  async advance(
    threadId: string,
  ): Promise<GoalLoopRound | { readonly paused: GoalLoopPauseReason }> {
    const record = this.#byThread.get(threadId);
    if (record === undefined) return { paused: "stopped-by-user" };
    if (this.#inFlight.has(threadId)) return { paused: "paused-by-user" };

    const goal = this.#dependencies.readGoal(threadId);
    if (goal === null) return this.#pause(record, "goal-complete");
    const live = this.#dependencies.threadAuthority(threadId);
    if (live === undefined) return this.#pause(record, "stopped-by-user");

    // The checkpoint is a fact the decision turns on, so it is taken before
    // deciding rather than after: whether a round without one may start is
    // policy's call, and asking afterwards would have started it. A marker
    // that fails reads as no checkpoint, never as one taken.
    const checkpointId = await this.#dependencies.markCheckpoint(threadId).catch(() => undefined);

    const pendingApproval = this.#dependencies.pendingApproval(threadId);
    const decision = decideGoalLoopRound({
      loopStatus: record.loop.status,
      goalStatus: goal.status,
      budget: goal.budget,
      usage: goal.usage,
      declaredCeiling: record.loop.ceiling,
      liveThreadAuthority: live,
      ...(record.lastAuthority === undefined
        ? {}
        : { previousEffectiveCeiling: record.lastAuthority }),
      ...(pendingApproval === undefined ? {} : { pendingApprovalClass: pendingApproval }),
      checkpointAvailable: checkpointId !== undefined,
      roundSpendObserved: record.lastSpendObserved !== false,
    });

    if (decision.decision !== "run") {
      return this.#pause(record, decision.reason, decision.decision === "stop");
    }

    this.#inFlight.add(threadId);
    const startedAt = this.#dependencies.clock();
    const roundId = this.#dependencies.uuid();
    const loopId = String(record.loop.id);
    try {
      // Journaled before the turn starts, so a restart mid-round finds the
      // round open and can charge what it spent (settleAfterRestart).
      this.#dependencies.journal.append({
        aggregateId: loopId,
        eventName: GOAL_LOOP_EVENT_NAMES.roundStarted,
        payload: {
          loopId,
          roundId,
          sequence: record.loop.roundsRun + 1,
          authority: decision.authority,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          startedAt,
        },
      });
      let spendJournaledAt = Date.parse(startedAt);
      const outcome = await this.#dependencies.runRound({
        threadId,
        objective: goal.objective,
        authority: decision.authority,
        onSpend: (tokensSpent) => {
          const now = Date.parse(this.#dependencies.clock());
          if (now - spendJournaledAt < ROUND_SPEND_JOURNAL_INTERVAL_MS) return;
          spendJournaledAt = now;
          try {
            this.#dependencies.journal.append({
              aggregateId: loopId,
              eventName: GOAL_LOOP_EVENT_NAMES.roundSpend,
              payload: { loopId, roundId, tokensSpent: Math.max(0, Math.floor(tokensSpent)) },
            });
          } catch {
            // A spend frame is a restart's estimate; the round records its own total.
          }
        },
      });
      const complete =
        outcome.outcome === "ran" &&
        mayCompleteGoalLoop({
          evidence: outcome.evidence ?? [],
          providerReportsComplete: outcome.providerReportsComplete === true,
          criteria: this.#dependencies.readGoal(threadId)?.criteria,
        }) &&
        outcome.providerReportsComplete === true;
      // A round that already ran must not be lost because the spend could not
      // be recorded — a person revising the goal mid-round is an ordinary
      // conflict, not a reason to throw out of a background loop. The round is
      // recorded as failed so the spend that did happen is visible even when
      // the goal did not take it.
      let usageRecorded = true;
      try {
        await this.#dependencies.recordUsage({
          threadId,
          roundId,
          goal,
          tokensSpent: outcome.tokensSpent,
          elapsedMs: outcome.elapsedMs,
          evidence: outcome.evidence ?? [],
          complete,
        });
      } catch {
        usageRecorded = false;
      }

      const round = decodeGoalLoopRound({
        roundId,
        loopId: record.loop.id,
        sequence: record.loop.roundsRun + 1,
        ...(checkpointId === undefined ? {} : { checkpointId }),
        authority: decision.authority,
        outcome: usageRecorded ? outcome.outcome : "failed",
        ...(usageRecorded
          ? outcome.detail === undefined
            ? {}
            : { detail: outcome.detail }
          : { detail: "The round ran but its spend could not be recorded against the goal." }),
        tokensSpent: outcome.tokensSpent,
        startedAt,
        endedAt: this.#dependencies.clock(),
      });
      this.#write({
        loop: this.#loopWith(record.loop, {
          roundsRun: record.loop.roundsRun + 1,
          lastRoundAt: round.endedAt,
          ...(complete
            ? { status: "complete" as const, pauseReason: "goal-complete" as const }
            : {}),
        }),
        rounds: [...record.rounds, round],
        lastAuthority: decision.authority,
        lastSpendObserved: outcome.usageReported !== false,
      });
      this.#dependencies.journal.append({
        aggregateId: String(record.loop.id),
        eventName: GOAL_LOOP_EVENT_NAMES.roundRecorded,
        payload: { round, spendObserved: outcome.usageReported !== false },
      });
      if (usageRecorded && !complete && record.loop.trigger.kind === "continuous") {
        this.#dependencies.scheduleNextRound?.(threadId);
      }
      return round;
    } finally {
      this.#inFlight.delete(threadId);
    }
  }

  /**
   * Rebuilds every loop from its journaled frames, as the previous host left
   * them. Each frame advances the loop's version exactly as the change that
   * wrote it did, so a window's expected version still matches after a
   * restart. A loop found running was running when the host stopped; it
   * stays that way until continueAfterRestart or holdAfterRestart decides it,
   * and nothing schedules it here.
   */
  replay(frames: ReadonlyArray<GoalLoopFrame>): void {
    const byLoop = new Map<string, LoopRecord>();
    for (const frame of frames) {
      if (frame.kind === "started") {
        const previous = this.#byThread.get(String(frame.payload.loop.threadId));
        const record = { loop: frame.payload.loop, rounds: previous?.rounds ?? [] };
        byLoop.set(String(frame.payload.loop.id), record);
        this.#write(record);
        continue;
      }
      const loopId =
        frame.kind === "round-recorded" ? frame.payload.round.loopId : frame.payload.loopId;
      if (frame.kind === "round-started" || frame.kind === "round-spend") {
        const open = byLoop.get(String(loopId));
        if (open === undefined) continue;
        const openRound: OpenRound | undefined =
          frame.kind === "round-started"
            ? {
                roundId: frame.payload.roundId,
                sequence: frame.payload.sequence,
                authority: frame.payload.authority,
                ...(frame.payload.checkpointId === undefined
                  ? {}
                  : { checkpointId: frame.payload.checkpointId }),
                startedAt: frame.payload.startedAt,
              }
            : open.openRound !== undefined && open.openRound.roundId === frame.payload.roundId
              ? {
                  ...open.openRound,
                  tokensSpent: frame.payload.tokensSpent,
                  lastSpendAt: frame.occurredAt,
                }
              : open.openRound;
        const next = openRound === undefined ? open : { ...open, openRound };
        byLoop.set(String(loopId), next);
        const current = this.#byThread.get(String(next.loop.threadId));
        if (current === undefined || String(current.loop.id) === String(loopId)) this.#write(next);
        continue;
      }
      const record = byLoop.get(String(loopId));
      if (record === undefined) continue;
      const replayed = (changes: LoopChanges) =>
        this.#loopWithAt(record.loop, changes, frame.occurredAt);
      let next: LoopRecord;
      switch (frame.kind) {
        case "round-recorded":
          // Built without openRound: recording a round closes the one open.
          next = {
            loop: replayed({
              roundsRun: record.loop.roundsRun + 1,
              lastRoundAt: frame.payload.round.endedAt,
            }),
            rounds: [...record.rounds, frame.payload.round],
            lastAuthority: frame.payload.round.authority,
            lastSpendObserved: frame.payload.spendObserved !== false,
          };
          break;
        case "paused":
          next = { ...record, loop: replayed(pausedStatus(frame.payload.reason, false)) };
          break;
        case "stopped":
          next = { ...record, loop: replayed(pausedStatus(frame.payload.reason, true)) };
          break;
        case "resumed":
          next = { ...record, loop: replayed({ status: "running" }) };
          break;
        case "ceiling-narrowed":
          next = { ...record, loop: replayed({ ceiling: frame.payload.ceiling }) };
          break;
      }
      byLoop.set(String(loopId), next);
      // Only the thread's newest loop is the one it shows and commands.
      const current = this.#byThread.get(String(next.loop.threadId));
      if (current === undefined || String(current.loop.id) === String(loopId)) this.#write(next);
    }
  }

  /**
   * Records the round a restart cut off as interrupted and charges the goal
   * what the round had journaled before the restart, so a restart neither
   * loses that spend nor counts the round as run. Answers how many of the
   * loop's rounds in a row a restart has now cut off.
   */
  async settleAfterRestart(threadId: string): Promise<{ readonly roundsCutOffInARow: number }> {
    const record = this.#byThread.get(threadId);
    const open = record?.openRound;
    if (record === undefined || open === undefined) {
      return { roundsCutOffInARow: trailingInterrupted(record?.rounds ?? []) };
    }
    const tokensSpent = open.tokensSpent ?? 0;
    const endedAt = open.lastSpendAt ?? open.startedAt;
    const elapsedMs = Math.max(0, Date.parse(endedAt) - Date.parse(open.startedAt));
    const goal = this.#dependencies.readGoal(threadId);
    let charged = goal !== null && goal.status !== "complete";
    if (charged && goal !== null) {
      try {
        await this.#dependencies.recordUsage({
          threadId,
          roundId: open.roundId,
          goal,
          tokensSpent,
          elapsedMs,
          evidence: [],
          complete: false,
        });
      } catch {
        charged = false;
      }
    }
    const round = decodeGoalLoopRound({
      roundId: open.roundId,
      loopId: record.loop.id,
      sequence: open.sequence,
      ...(open.checkpointId === undefined ? {} : { checkpointId: open.checkpointId }),
      authority: open.authority,
      outcome: "interrupted",
      detail: charged
        ? "Octant restarted while this round ran. The spend journaled before then is charged to the goal."
        : "Octant restarted while this round ran, and its spend could not be charged to the goal.",
      tokensSpent,
      startedAt: open.startedAt,
      endedAt,
    });
    // The current record, not the one read before the charge: a person's
    // command may have moved the loop while the goal was written.
    const current = this.#byThread.get(threadId) ?? record;
    const { openRound: _closed, ...rest } = current;
    const next = this.#write({
      ...rest,
      loop: this.#loopWith(current.loop, {
        roundsRun: current.loop.roundsRun + 1,
        lastRoundAt: endedAt,
      }),
      rounds: [...current.rounds, round],
      lastAuthority: open.authority,
      // Spend after the last journaled figure is unseen; a round with none
      // journaled reads as unreported so a token budget is not trusted on it.
      lastSpendObserved: open.tokensSpent !== undefined,
    });
    this.#dependencies.journal.append({
      aggregateId: String(record.loop.id),
      eventName: GOAL_LOOP_EVENT_NAMES.roundRecorded,
      payload: { round, spendObserved: open.tokensSpent !== undefined },
    });
    return { roundsCutOffInARow: trailingInterrupted(next.rounds) };
  }

  /** Whether restarts have cut off so many of this loop's rounds in a row that it should wait. */
  crashLooping(roundsCutOffInARow: number): boolean {
    return roundsCutOffInARow >= MAX_ROUNDS_CUT_OFF_IN_A_ROW;
  }

  /**
   * The threads whose loop has a round the restart cut off, whatever the
   * loop's status: a person may pause a loop while its round runs, and that
   * round still spent and must still be recorded before a Resume.
   */
  openRoundThreads(): ReadonlyArray<string> {
    return [...this.#byThread.values()]
      .filter((record) => record.openRound !== undefined)
      .map((record) => String(record.loop.threadId));
  }

  /** The threads whose loop was running when the previous host stopped. */
  runningLoopThreads(): ReadonlyArray<string> {
    return [...this.#byThread.values()]
      .filter((record) => record.loop.status === "running")
      .map((record) => String(record.loop.threadId));
  }

  /**
   * Takes up a loop the restart cut off: its next round starts through the
   * ordinary round path, where every rule a round answers to applies again.
   * The round in flight at the restart is not recorded; its Work turn settled
   * as cut off and its spend is not charged to the goal.
   */
  continueAfterRestart(threadId: string): boolean {
    if (this.#byThread.get(threadId)?.loop.status !== "running") return false;
    this.#dependencies.scheduleFirstRound?.(threadId);
    return true;
  }

  /** Leaves a loop the restart cut off paused for its person, with the reason journaled. */
  holdAfterRestart(threadId: string): boolean {
    const record = this.#byThread.get(threadId);
    if (record?.loop.status !== "running") return false;
    this.#pause(record, "held-after-restart");
    return true;
  }

  #start(
    command: Extract<GoalLoopCommand, { readonly kind: "start-goal-loop" }>,
    existing: LoopRecord | undefined,
  ): GoalLoopResult {
    if (existing !== undefined && existing.loop.status === "running") {
      return this.#refused("loop-already-running", "This thread already has a loop running.");
    }
    if (existing !== undefined && existing.loop.version !== command.expectedVersion) {
      return this.#refused("stale-version", "The loop changed since you read it.");
    }
    const goal = this.#dependencies.readGoal(command.threadId);
    if (goal === null || String(goal.id) !== String(command.goalId)) {
      return this.#refused("goal-not-found", "That goal is not the one on this thread.");
    }
    // Refused at the door rather than started and immediately paused: a loop
    // with nothing to stop it is the thing this whole design exists to prevent,
    // and it should read as a refusal, not as a loop that mysteriously idles.
    if (
      goal.budget.tokenBudget === undefined &&
      goal.budget.timeBudgetMs === undefined &&
      goal.budget.turnBudget === undefined
    ) {
      return this.#refused("budget-required", goalLoopPauseText("budget-required"));
    }

    // A trigger that nothing dispatches is a loop that would sit at zero rounds
    // forever while reading as running. Refused until the scheduler can hand a
    // due occurrence to `advance`, rather than accepted and silently inert.
    if (command.trigger.kind === "scheduled") {
      return this.#refused(
        "not-authorized",
        "Starting a loop on a schedule is not available on this host yet.",
      );
    }

    // A ceiling the host cannot actually impose is worse than no ceiling: the
    // person believes the loop is narrower than it is. Refused at the door,
    // where it can be explained, rather than silently ignored per round.
    const posture = this.#dependencies.modePosture(command.threadId);
    const unenforceable =
      posture === undefined
        ? undefined
        : (["filesystem", "shell", "git", "network", "tools", "subagents"] as const).find(
            (capability) => posture[capability] && !command.ceiling[capability],
          );
    if (unenforceable !== undefined) {
      return this.#refused(
        "ceiling-unenforceable",
        `A turn in this thread always has ${unenforceable}, so a loop cannot run with it withheld.`,
      );
    }

    const now = this.#dependencies.clock();
    const loop = decodeGoalLoop({
      id: command.loopId,
      threadId: command.threadId,
      goalId: command.goalId,
      ceiling: command.ceiling,
      trigger: command.trigger,
      status: "running",
      roundsRun: 0,
      startedAt: now,
      updatedAt: now,
      version: command.expectedVersion + 1,
    });
    const record = this.#write({ loop, rounds: existing?.rounds ?? [] });
    this.#dependencies.journal.append({
      aggregateId: String(loop.id),
      eventName: GOAL_LOOP_EVENT_NAMES.started,
      payload: { loop },
    });
    this.#dependencies.scheduleFirstRound?.(command.threadId);
    return this.#result(record);
  }

  #settle(
    record: LoopRecord,
    status: "paused" | "stopped",
    reason: GoalLoopPauseReason,
    eventName: string,
  ): GoalLoopResult {
    const next = this.#write({
      ...record,
      loop: this.#loopWith(record.loop, { status, pauseReason: reason }),
    });
    this.#dependencies.journal.append({
      aggregateId: String(record.loop.id),
      eventName,
      payload:
        status === "stopped"
          ? { loopId: String(record.loop.id), reason, roundsRun: record.loop.roundsRun }
          : { loopId: String(record.loop.id), reason },
    });
    return this.#result(next);
  }

  #pause(
    record: LoopRecord,
    reason: GoalLoopPauseReason,
    stopped = false,
  ): { readonly paused: GoalLoopPauseReason } {
    const { status } = pausedStatus(reason, stopped);
    // Journaled every time, including when the loop was already in this state:
    // a loop that goes quiet for six hours should leave six hours of evidence
    // that it kept deciding not to run, not silence indistinguishable from a
    // loop that was never started.
    this.#write({ ...record, loop: this.#loopWith(record.loop, { status, pauseReason: reason }) });
    this.#dependencies.journal.append({
      aggregateId: String(record.loop.id),
      eventName: stopped ? GOAL_LOOP_EVENT_NAMES.stopped : GOAL_LOOP_EVENT_NAMES.paused,
      payload: stopped
        ? { loopId: String(record.loop.id), reason, roundsRun: record.loop.roundsRun }
        : { loopId: String(record.loop.id), reason },
    });
    return { paused: reason };
  }

  #loopWith(loop: GoalLoop, changes: LoopChanges): GoalLoop {
    return this.#loopWithAt(loop, changes, this.#dependencies.clock());
  }

  #loopWithAt(loop: GoalLoop, changes: LoopChanges, updatedAt: UtcTimestamp): GoalLoop {
    const status = changes.status ?? loop.status;
    const pauseReason = changes.pauseReason ?? loop.pauseReason;
    return decodeGoalLoop({
      ...loop,
      ...changes,
      status,
      // The contract refuses a running loop that still carries a reason it
      // stopped, so entering running clears it rather than keeping a stale
      // explanation beside a status that no longer explains it.
      ...(status === "running"
        ? { pauseReason: undefined }
        : { pauseReason: pauseReason ?? "paused-by-user" }),
      updatedAt,
      version: loop.version + 1,
    });
  }

  #write(record: LoopRecord): LoopRecord {
    this.#byThread.set(String(record.loop.threadId), record);
    return record;
  }

  #result(record: LoopRecord): GoalLoopResult {
    return decodeGoalLoopResult({
      kind: "goal-loop",
      loop: record.loop,
      rounds: record.rounds,
    });
  }

  #refused(
    reason: Extract<GoalLoopResult, { readonly kind: "goal-loop-refused" }>["reason"],
    message: string,
  ): GoalLoopResult {
    return decodeGoalLoopResult({ kind: "goal-loop-refused", reason, message });
  }
}
