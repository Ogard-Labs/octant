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

/**
 * What the form says once it is read. A field that is filled but cannot be
 * read refuses the whole form: setting the other budgets and dropping that one
 * would set a different ceiling than the person typed.
 */
export type SpendCeilingLimitsReading =
  | { readonly status: "ready"; readonly limits: SpendCeilingLimits }
  | { readonly status: "refused"; readonly message: string };

type FieldReading =
  | { readonly status: "blank" }
  | { readonly status: "read"; readonly value: number }
  | { readonly status: "refused"; readonly message: string };

function wholeNumber(text: string, refusal: string): FieldReading {
  const trimmed = text.trim();
  if (trimmed === "") return { status: "blank" };
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isSafeInteger(value) && value > 0
    ? { status: "read", value }
    : { status: "refused", message: refusal };
}

/** Hours may be fractional ("1.5"); the budget is whole seconds. */
function runTimeSeconds(text: string): FieldReading {
  const trimmed = text.trim();
  if (trimmed === "") return { status: "blank" };
  const refused = {
    status: "refused",
    message: "Hours of agent run time must be a number, for example 1.5.",
  } as const;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return refused;
  const seconds = Math.round(Number(trimmed) * 3_600);
  return Number.isSafeInteger(seconds) && seconds > 0
    ? { status: "read", value: seconds }
    : refused;
}

/**
 * Dollars ("25", "25.4", "$25.40") as whole cents. A money budget is whole
 * cents on the host, so finer precision is refused rather than rounded, and a
 * comma is refused rather than guessed at: nothing else in Octant reads a
 * locale's decimal separator, and "25,40" could mean either.
 */
function usdCents(text: string): FieldReading {
  const trimmed = text.trim();
  if (trimmed === "") return { status: "blank" };
  if (trimmed.includes(",")) {
    return { status: "refused", message: "Use a dot for cents in US dollars, for example 25.40." };
  }
  if (/^\$?\s*\d+\.\d{3,}$/.test(trimmed)) {
    return {
      status: "refused",
      message: "A money budget is whole cents: use at most two decimals, for example 25.40.",
    };
  }
  const match = /^\$?\s*(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  const cents =
    match === null
      ? Number.NaN
      : Number(match[1] ?? "0") * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0
    ? { status: "read", value: cents }
    : { status: "refused", message: "US dollars must be an amount, for example 25 or 25.40." };
}

/** The budgets a person filled in; blank fields set no dimension. */
export function spendCeilingLimits(input: SpendCeilingLimitInput): SpendCeilingLimitsReading {
  const tokens = wholeNumber(input.tokens, "Tokens must be a whole number, for example 200000.");
  const turns = wholeNumber(input.turns, "Turns must be a whole number, for example 40.");
  const hours = runTimeSeconds(input.hours);
  const dollars = usdCents(input.dollars);
  for (const field of [tokens, turns, hours, dollars]) {
    if (field.status === "refused") return field;
  }
  const limits: SpendCeilingLimits = {
    ...(tokens.status === "read" ? { tokenBudget: tokens.value } : {}),
    ...(turns.status === "read" ? { turnBudget: turns.value } : {}),
    ...(hours.status === "read" ? { runTimeBudgetSeconds: hours.value } : {}),
    ...(dollars.status === "read" ? { costBudgetUsdCents: dollars.value } : {}),
  };
  if (Object.keys(limits).length === 0) {
    return { status: "refused", message: "Enter at least one budget." };
  }
  return { status: "ready", limits };
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
