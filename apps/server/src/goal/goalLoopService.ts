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
}

export interface GoalLoopDependencies {
  /** The goal this loop works on, and the command path that changes it. */
  readonly readGoal: (threadId: string) => ThreadGoal | null;
  readonly recordUsage: (input: {
    readonly threadId: string;
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
  /** Mark a checkpoint before the round. Returns its id, or undefined if it could not. */
  readonly markCheckpoint: (threadId: string) => Promise<string | undefined>;
  /** Run one ordinary turn against the objective, under exactly this authority. */
  readonly runRound: (input: {
    readonly threadId: string;
    readonly objective: string;
    readonly authority: AgentRunAuthority;
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
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
}

interface LoopRecord {
  readonly loop: GoalLoop;
  readonly rounds: ReadonlyArray<GoalLoopRound>;
  /** What the last round actually ran under, for the widening check. */
  readonly lastAuthority?: AgentRunAuthority;
}

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
        return this.#result(
          this.#write({
            ...record,
            loop: this.#loopWith(record.loop, { ceiling: change.ceiling }),
          }),
        );
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
    // deciding rather than after: a round that cannot be checkpointed is a
    // round that must not start, and asking afterwards would have started it.
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
    });

    if (decision.decision !== "run") {
      return this.#pause(record, decision.reason, decision.decision === "stop");
    }

    this.#inFlight.add(threadId);
    const startedAt = this.#dependencies.clock();
    try {
      const outcome = await this.#dependencies.runRound({
        threadId,
        objective: goal.objective,
        authority: decision.authority,
      });
      const complete =
        outcome.outcome === "ran" &&
        mayCompleteGoalLoop({
          evidence: outcome.evidence ?? [],
          providerReportsComplete: outcome.providerReportsComplete === true,
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
        roundId: this.#dependencies.uuid(),
        loopId: record.loop.id,
        sequence: record.loop.roundsRun + 1,
        checkpointId: checkpointId as string,
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
      });
      this.#dependencies.journal.append({
        aggregateId: String(record.loop.id),
        eventName: GOAL_LOOP_EVENT_NAMES.roundRecorded,
        payload: { round },
      });
      if (usageRecorded && !complete && record.loop.trigger.kind === "continuous") {
        this.#dependencies.scheduleNextRound?.(threadId);
      }
      return round;
    } finally {
      this.#inFlight.delete(threadId);
    }
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
    const status = stopped
      ? reason === "goal-complete"
        ? ("complete" as const)
        : ("stopped" as const)
      : reason === "approval-required"
        ? ("awaiting-approval" as const)
        : reason === "budget-exhausted" || reason === "budget-required"
          ? ("budget-limited" as const)
          : ("paused" as const);
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

  #loopWith(
    loop: GoalLoop,
    changes: Partial<
      Pick<GoalLoop, "status" | "pauseReason" | "ceiling" | "roundsRun" | "lastRoundAt">
    >,
  ): GoalLoop {
    const status = changes.status ?? loop.status;
    const pauseReason = changes.pauseReason ?? loop.pauseReason;
    return decodeGoalLoop({
      ...loop,
      ...changes,
      status,
      // The contract refuses a running loop that still carries a reason it
      // stopped, so resuming clears it rather than leaving a stale explanation.
      ...(status === "running" ? {} : { pauseReason: pauseReason ?? "paused-by-user" }),
      ...(status === "running" && loop.pauseReason !== undefined ? {} : {}),
      updatedAt: this.#dependencies.clock(),
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
