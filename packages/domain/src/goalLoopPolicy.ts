import type {
  AgentRunAuthority,
  GoalLoopPauseReason,
  GoalLoopStatus,
  ThreadGoalBudget,
  ThreadGoalEvidenceRef,
  ThreadGoalStatus,
  ThreadGoalUsage,
  ToolApprovalClass,
} from "@octant/contracts";

/**
 * What a goal loop is allowed to do while nobody is watching.
 *
 * The loop itself is not interesting; this is. Every decision here answers one
 * question — may the next round start, and under what authority — and every
 * answer that is not "run" is a state a person resumes rather than one the loop
 * clears for itself.
 *
 * Nothing here grants anything. The authority a round runs under is the
 * intersection of what the person declared when they started the loop and what
 * the thread has right now, so a loop can only ever do less than the thread
 * could, never more.
 */

export interface GoalLoopRoundFacts {
  readonly loopStatus: GoalLoopStatus;
  readonly goalStatus: ThreadGoalStatus;
  readonly budget: ThreadGoalBudget;
  readonly usage: ThreadGoalUsage;
  /** The ceiling the person declared at the moment they started the loop. */
  readonly declaredCeiling: AgentRunAuthority;
  /** What the thread may do right now, which can change under a running loop. */
  readonly liveThreadAuthority: AgentRunAuthority;
  /**
   * The authority the previous round actually ran under. Present from the
   * second round on; its absence is a first round, not a widening.
   */
  readonly previousEffectiveCeiling?: AgentRunAuthority;
  /** An approval the next effect would need, when the host already knows of one. */
  readonly pendingApprovalClass?: ToolApprovalClass;
  /** Whether this round can be checkpointed before it starts. */
  readonly checkpointAvailable: boolean;
}

export type GoalLoopRoundDecision =
  | { readonly decision: "run"; readonly authority: AgentRunAuthority }
  | { readonly decision: "pause"; readonly reason: GoalLoopPauseReason }
  | { readonly decision: "stop"; readonly reason: GoalLoopPauseReason };

const CAPABILITIES = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;

const EXECUTION_RANK: Record<AgentRunAuthority["executionPolicy"], number> = {
  plan: 0,
  "approval-gated": 1,
  "auto-accept-edits": 2,
  "full-access": 3,
};

/**
 * Whether the next round may start, and under what authority.
 *
 * The order of these checks is the policy, not an implementation detail. A
 * user's own pause outranks everything because it is the one signal that is
 * unambiguously a person's; budget comes before approvals because a loop that
 * has run out of budget should not be asking for permission to spend more.
 */
export function decideGoalLoopRound(facts: GoalLoopRoundFacts): GoalLoopRoundDecision {
  if (facts.loopStatus === "stopped") return { decision: "stop", reason: "stopped-by-user" };
  if (facts.loopStatus === "complete") return { decision: "stop", reason: "goal-complete" };
  if (facts.loopStatus === "paused" || facts.loopStatus === "awaiting-approval") {
    return { decision: "pause", reason: "paused-by-user" };
  }

  if (facts.goalStatus === "complete") return { decision: "stop", reason: "goal-complete" };
  if (facts.goalStatus === "paused") return { decision: "pause", reason: "goal-paused" };
  if (facts.goalStatus === "budget-limited") {
    return { decision: "pause", reason: "budget-exhausted" };
  }

  // Budgets are mandatory for unattended work. A hand-driven goal without one
  // is a person choosing to watch; a loop without one is nothing stopping it.
  if (!hasAnyCeiling(facts.budget)) return { decision: "pause", reason: "budget-required" };
  if (budgetExhausted(facts.budget, facts.usage)) {
    return { decision: "pause", reason: "budget-exhausted" };
  }

  if (facts.pendingApprovalClass !== undefined) {
    // Deliberately no allowlist of classes a loop may self-approve. Such a list
    // would be the loop granting authority the thread's own approvals withheld,
    // which is the one thing this policy exists to prevent.
    return { decision: "pause", reason: "approval-required" };
  }

  if (!facts.checkpointAvailable) {
    return { decision: "pause", reason: "checkpoint-unavailable" };
  }

  const authority = intersectAuthority(facts.declaredCeiling, facts.liveThreadAuthority);

  // Narrowing under a running loop is fine and needs no gesture — the loop
  // simply does less. Widening is a person changing the terms mid-flight, and
  // the loop stops rather than quietly taking the larger grant.
  if (
    facts.previousEffectiveCeiling !== undefined &&
    widens(facts.previousEffectiveCeiling, authority)
  ) {
    return { decision: "pause", reason: "authority-widened" };
  }

  return { decision: "run", authority };
}

/**
 * Whether a loop may move its goal to complete.
 *
 * A provider announcing that it finished is a claim about its own output. The
 * host completes a goal only against something it can point at afterwards.
 */
export function mayCompleteGoalLoop(input: {
  readonly evidence: ReadonlyArray<ThreadGoalEvidenceRef>;
  readonly providerReportsComplete: boolean;
}): boolean {
  return input.evidence.length > 0;
}

export type GoalLoopCeilingChange =
  | { readonly outcome: "narrowed"; readonly ceiling: AgentRunAuthority }
  | { readonly outcome: "refused"; readonly reason: "would-widen" };

/**
 * Adjust a running loop's ceiling.
 *
 * Refused rather than silently clamped: someone lowering a ceiling and someone
 * trying to raise one mean different things, and quietly turning the second
 * into the first would tell them they succeeded.
 */
export function narrowGoalLoopCeiling(
  current: AgentRunAuthority,
  requested: AgentRunAuthority,
): GoalLoopCeilingChange {
  return widens(current, requested)
    ? { outcome: "refused", reason: "would-widen" }
    : { outcome: "narrowed", ceiling: requested };
}

export type GoalLoopLimit = "tokens" | "time" | "turns" | "none";

export interface GoalLoopBurnDown {
  /** 0 to 1 against the tightest ceiling; 1 when there is no ceiling to spend against. */
  readonly fractionSpent: number;
  readonly limiting: GoalLoopLimit;
  readonly remaining: {
    readonly tokens?: number;
    readonly timeMs?: number;
    readonly turns?: number;
  };
}

/**
 * How much of the budget is gone, and which ceiling will stop the loop.
 *
 * The tightest one is the answer a person needs: a loop with 90% of its tokens
 * spent and 20% of its turns will stop on tokens, and showing the turns would
 * say it has room it does not have.
 */
export function goalLoopBurnDown(
  budget: ThreadGoalBudget,
  usage: ThreadGoalUsage,
): GoalLoopBurnDown {
  const present: ReadonlyArray<readonly [GoalLoopLimit, number]> = [
    ["tokens", ratio(usage.tokensUsed, budget.tokenBudget)],
    ["time", ratio(usage.elapsedMs, budget.timeBudgetMs)],
    ["turns", ratio(usage.turnsUsed, budget.turnBudget)],
  ].flatMap(([limit, fraction]) =>
    typeof fraction === "number" ? [[limit as GoalLoopLimit, fraction] as const] : [],
  );
  if (present.length === 0) {
    return { fractionSpent: 1, limiting: "none", remaining: {} };
  }
  const tightest = present.reduce((left, right) => (right[1] > left[1] ? right : left));
  return {
    fractionSpent: Math.min(1, tightest[1]),
    limiting: tightest[0],
    remaining: {
      ...(budget.tokenBudget === undefined
        ? {}
        : { tokens: Math.max(0, budget.tokenBudget - usage.tokensUsed) }),
      ...(budget.timeBudgetMs === undefined
        ? {}
        : { timeMs: Math.max(0, budget.timeBudgetMs - usage.elapsedMs) }),
      ...(budget.turnBudget === undefined
        ? {}
        : { turns: Math.max(0, budget.turnBudget - usage.turnsUsed) }),
    },
  };
}

export function goalLoopPauseText(reason: GoalLoopPauseReason): string {
  switch (reason) {
    case "budget-exhausted":
      return "The goal's budget is spent. Raise it or resume to keep going.";
    case "budget-required":
      return "An unattended loop needs a budget. Set one on the goal to start it.";
    case "goal-paused":
      return "The goal is paused, so the loop is too.";
    case "goal-complete":
      return "The goal is complete.";
    case "authority-widened":
      return "This thread's access widened while the loop was running. It stopped rather than take the wider grant.";
    case "approval-required":
      return "The next step needs an approval. The loop stopped and recorded the request.";
    case "checkpoint-unavailable":
      return "The next round could not be checkpointed, so it was not started.";
    case "paused-by-user":
      return "Paused.";
    case "stopped-by-user":
      return "Stopped.";
  }
}

function hasAnyCeiling(budget: ThreadGoalBudget): boolean {
  return (
    budget.tokenBudget !== undefined ||
    budget.timeBudgetMs !== undefined ||
    budget.turnBudget !== undefined
  );
}

function budgetExhausted(budget: ThreadGoalBudget, usage: ThreadGoalUsage): boolean {
  if (budget.tokenBudget !== undefined && usage.tokensUsed >= budget.tokenBudget) return true;
  if (budget.timeBudgetMs !== undefined && usage.elapsedMs >= budget.timeBudgetMs) return true;
  if (budget.turnBudget !== undefined && usage.turnsUsed >= budget.turnBudget) return true;
  return false;
}

/**
 * The authority a round actually runs under.
 *
 * Not `clampAgentRunAuthority`, deliberately. That function exists for a child
 * that *asks* for authority, where asking beyond a ceiling is an error worth
 * refusing. A loop asks for nothing: the person declared a ceiling once, the
 * thread's grant moves underneath it, and a grant that dropped below the
 * declared ceiling must simply lower the loop with no gesture from anyone. The
 * same shape with the opposite answer to the same situation is a second
 * function, not a flag on the first.
 */
function intersectAuthority(
  declared: AgentRunAuthority,
  live: AgentRunAuthority,
): AgentRunAuthority {
  return {
    filesystem: declared.filesystem && live.filesystem,
    shell: declared.shell && live.shell,
    git: declared.git && live.git,
    network: declared.network && live.network,
    tools: declared.tools && live.tools,
    subagents: declared.subagents && live.subagents,
    executionPolicy:
      EXECUTION_RANK[live.executionPolicy] < EXECUTION_RANK[declared.executionPolicy]
        ? live.executionPolicy
        : declared.executionPolicy,
    // An unattended round never persists a permission beyond itself: a grant
    // the loop banked while nobody watched would outlive the loop.
    permissionPersistence: "current-session",
  };
}

function widens(from: AgentRunAuthority, to: AgentRunAuthority): boolean {
  if (CAPABILITIES.some((capability) => to[capability] && !from[capability])) return true;
  if (EXECUTION_RANK[to.executionPolicy] > EXECUTION_RANK[from.executionPolicy]) return true;
  return (
    to.permissionPersistence === "project-default" &&
    from.permissionPersistence !== "project-default"
  );
}

function ratio(used: number, ceiling: number | undefined): number | undefined {
  return ceiling === undefined ? undefined : used / ceiling;
}
