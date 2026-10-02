import type { SpendCeilingRemaining } from "@octant/contracts";
import { formatSpendCeilingRunTime } from "@octant/domain/spend-ceiling-policy";

export interface SpendCeilingLimitInput {
  readonly tokens: string;
  readonly turns: string;
  readonly hours: string;
}

export interface SpendCeilingLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly runTimeBudgetSeconds?: number;
}

function positiveInteger(text: string): number | undefined {
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Hours may be fractional ("1.5"); the budget is whole seconds. */
function runTimeSeconds(text: string): number | undefined {
  const hours = Number.parseFloat(text);
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  const seconds = Math.round(hours * 3_600);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** The budgets a person filled in; blank fields set no dimension. */
export function spendCeilingLimits(input: SpendCeilingLimitInput): SpendCeilingLimits {
  const tokenBudget = positiveInteger(input.tokens);
  const turnBudget = positiveInteger(input.turns);
  const runTimeBudgetSeconds = runTimeSeconds(input.hours);
  return {
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(turnBudget === undefined ? {} : { turnBudget }),
    ...(runTimeBudgetSeconds === undefined ? {} : { runTimeBudgetSeconds }),
  };
}

function tighter(
  remainings: ReadonlyArray<SpendCeilingRemaining>,
  pick: (remaining: SpendCeilingRemaining) => number | undefined,
): SpendCeilingRemaining | undefined {
  let best: SpendCeilingRemaining | undefined;
  for (const remaining of remainings) {
    const value = pick(remaining);
    if (value === undefined) continue;
    const bestValue = best === undefined ? undefined : pick(best);
    if (bestValue === undefined || value < bestValue) best = remaining;
  }
  return best;
}

/**
 * One phrase per configured dimension, each from whichever ceiling leaves less,
 * because a turn must fit both the thread and the Project ceiling.
 */
export function spendCeilingRemainingPhrases(
  remainings: ReadonlyArray<SpendCeilingRemaining>,
): ReadonlyArray<string> {
  const phrases: Array<string> = [];
  const tokens = tighter(remainings, (remaining) => remaining.remainingTokens);
  if (tokens?.remainingTokens !== undefined && tokens.ceilingTokens !== undefined) {
    phrases.push(
      `${tokens.remainingTokens.toLocaleString()} of ${tokens.ceilingTokens.toLocaleString()} tokens remaining`,
    );
  }
  const turns = tighter(remainings, (remaining) => remaining.remainingTurns);
  if (turns?.remainingTurns !== undefined && turns.ceilingTurns !== undefined) {
    phrases.push(
      `${turns.remainingTurns.toLocaleString()} of ${turns.ceilingTurns.toLocaleString()} turns remaining`,
    );
  }
  const runTime = tighter(remainings, (remaining) => remaining.remainingRunTimeSeconds);
  if (
    runTime?.remainingRunTimeSeconds !== undefined &&
    runTime.ceilingRunTimeSeconds !== undefined
  ) {
    phrases.push(
      `${formatSpendCeilingRunTime(runTime.remainingRunTimeSeconds)} of ${formatSpendCeilingRunTime(runTime.ceilingRunTimeSeconds)} agent run time remaining`,
    );
  }
  return phrases;
}
