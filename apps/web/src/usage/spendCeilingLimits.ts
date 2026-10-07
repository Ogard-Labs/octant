import type { SpendCeilingRemaining } from "@octant/contracts";
import {
  formatSpendCeilingRunTime,
  formatSpendCeilingUsd,
} from "@octant/domain/spend-ceiling-policy";

export interface SpendCeilingLimitInput {
  readonly tokens: string;
  readonly turns: string;
  readonly hours: string;
  readonly dollars: string;
}

export interface SpendCeilingLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly runTimeBudgetSeconds?: number;
  readonly costBudgetUsdCents?: number;
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

/**
 * Dollars ("25", "25.4", "$25.40") as whole cents. A money budget is whole
 * cents on the host, so a figure with finer precision sets no budget rather
 * than a rounded one the person did not type.
 */
function usdCents(text: string): number | undefined {
  const match = /^\$?\s*(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return undefined;
  const cents = Number(match[1] ?? "0") * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined;
}

/** The budgets a person filled in; blank fields set no dimension. */
export function spendCeilingLimits(input: SpendCeilingLimitInput): SpendCeilingLimits {
  const tokenBudget = positiveInteger(input.tokens);
  const turnBudget = positiveInteger(input.turns);
  const runTimeBudgetSeconds = runTimeSeconds(input.hours);
  const costBudgetUsdCents = usdCents(input.dollars);
  return {
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(turnBudget === undefined ? {} : { turnBudget }),
    ...(runTimeBudgetSeconds === undefined ? {} : { runTimeBudgetSeconds }),
    ...(costBudgetUsdCents === undefined ? {} : { costBudgetUsdCents }),
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
  const money = tighter(remainings, (remaining) => remaining.remainingUsdCents);
  if (money?.remainingUsdCents !== undefined && money.ceilingUsdCents !== undefined) {
    phrases.push(
      `${formatSpendCeilingUsd(money.remainingUsdCents)} of ${formatSpendCeilingUsd(money.ceilingUsdCents)} remaining`,
    );
  }
  return phrases;
}

/**
 * Whether either ceiling has a money budget. Money is only known once a
 * provider reports a turn, so it is checked between turns and the surfaces
 * say so wherever a money budget is in force.
 */
export function hasMoneyCeiling(
  ceilings: ReadonlyArray<
    | { readonly policy?: { readonly costBudgetUsdCents?: number | undefined } | undefined }
    | undefined
  >,
): boolean {
  return ceilings.some((ceiling) => ceiling?.policy?.costBudgetUsdCents !== undefined);
}

export const MONEY_CEILING_NOTE =
  "Money counts settled, priced usage and is checked between turns, so a running turn can finish over it. Usage with no price refuses the next turn.";
