import type {
  SpendCeilingCommand,
  SpendCeilingCommandRefusal,
  SpendCeilingOverrun,
  SpendCeilingPolicy,
  SpendCeilingRefusal,
  SpendCeilingScope,
  SpendCeilingState,
  SpendCeilingWindow,
  UtcTimestamp,
} from "@octant/contracts";
import { authorizePrincipalAction, type PrincipalKind } from "./remoteAccessPolicy";

export const SPEND_CEILING_ACTION_NAMES = {
  read: "usage.spend-ceiling.read",
  set: "host.store.spend-ceiling",
} as const;

export type SpendTokenTotal =
  | { readonly status: "known"; readonly tokens: number }
  | { readonly status: "unavailable" }
  | { readonly status: "unknowable" };

export interface SpendCeilingScopeFacts {
  readonly scopeKind: "project" | "thread";
  readonly scopeId: string;
  readonly policy: SpendCeilingPolicy;
  readonly committed: SpendTokenTotal;
  readonly reservedTokens: number;
  readonly overrun?: SpendCeilingOverrun;
  /** Settled plus in-flight provider turns in the window; absent when unknown. */
  readonly usedTurns?: number;
  /** Settled run time plus elapsed in-flight time in the window; absent when unknown. */
  readonly usedRunTimeMs?: number;
}

export type SpendCeilingAdmission =
  | {
      readonly status: "admitted";
      readonly reservedTokens: number;
      readonly reservations: ReadonlyArray<{
        readonly scopeKind: "project" | "thread";
        readonly scopeId: string;
        readonly reservedTokens: number;
      }>;
    }
  | { readonly status: "refused"; readonly refusal: SpendCeilingRefusal };

export type SpendCeilingSettlement =
  | { readonly kind: "released" }
  | { readonly kind: "committed"; readonly observedTokens: number }
  | {
      readonly kind: "overrun";
      readonly reservedTokens: number;
      readonly observedTokens: number;
    };

export type SpendCeilingCommandDecision =
  | {
      readonly status: "accepted";
      readonly next: SpendCeilingState;
      readonly previousTokenBudget?: number;
      readonly previousTurnBudget?: number;
      readonly previousRunTimeBudgetSeconds?: number;
    }
  | { readonly status: "cleared"; readonly scope: SpendCeilingScope }
  | { readonly status: "refused"; readonly refusal: SpendCeilingCommandRefusal };

const DEFAULT_RECOVERY = ["raise-ceiling", "clear-ceiling", "open-usage", "pause-work"] as const;

function scopeLabel(kind: "project" | "thread"): string {
  return kind === "project" ? "Project" : "thread";
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** "2h", "1h 30m", "45m", or "30s": run-time budgets are set in hours or minutes. */
export function formatSpendCeilingRunTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function recoveryFor(kind: SpendCeilingRefusal["kind"]): SpendCeilingRefusal["recovery"] {
  if (kind === "missing-turn-bound") {
    return ["raise-ceiling", "pause-work"];
  }
  return [...DEFAULT_RECOVERY];
}

interface RefusalInput {
  readonly kind: SpendCeilingRefusal["kind"];
  readonly dimension: SpendCeilingRefusal["dimension"];
  readonly scopeKind: "project" | "thread";
  readonly scopeId: string;
  readonly remainingTokens?: number;
  readonly overrunTokens?: number;
  readonly ceilingTokens?: number;
  readonly neededTokens?: number;
  readonly remainingTurns?: number;
  readonly ceilingTurns?: number;
  readonly remainingRunTimeSeconds?: number;
  readonly ceilingRunTimeSeconds?: number;
}

function refusalMessage(input: RefusalInput): string {
  const who = scopeLabel(input.scopeKind);
  const recovery = `Raise or clear the ceiling, open Usage for this ${who}, or pause work.`;
  if (input.dimension === "turns") {
    if (input.kind === "unknown-spend") {
      return `This ${who}'s turn ceiling cannot be measured because its turn ledger is unavailable. ${recovery}`;
    }
    return `This ${who}'s turn ceiling of ${formatCount(input.ceilingTurns ?? 0)} turns is used up for this window. ${recovery}`;
  }
  if (input.dimension === "run-time") {
    if (input.kind === "unknown-spend") {
      return `This ${who}'s agent run time ceiling cannot be measured because its turn ledger is unavailable. ${recovery}`;
    }
    return `This ${who}'s agent run time ceiling of ${formatSpendCeilingRunTime(input.ceilingRunTimeSeconds ?? 0)} is used up for this window. ${recovery}`;
  }
  if (input.kind === "unknown-spend") {
    return `This ${who}'s token spend ceiling cannot be measured because recent usage is unavailable. ${recovery}`;
  }
  if (input.kind === "missing-turn-bound") {
    return `This ${who}'s token spend ceiling cannot admit a turn without a per-turn token bound. Raise the ceiling to set a per-turn maximum, or pause work.`;
  }
  if (input.kind === "overrun") {
    const overrun =
      input.overrunTokens === undefined ? "" : ` (${formatCount(input.overrunTokens)} tokens over)`;
    return `This ${who}'s token spend ceiling was overrun${overrun}. Further turns stay refused until a person raises or clears the ceiling. Open Usage for this ${who}, or pause work.`;
  }
  if (input.remainingTokens !== undefined && input.ceilingTokens !== undefined) {
    const needed =
      input.neededTokens === undefined
        ? ""
        : ` This turn needs ${formatCount(input.neededTokens)}.`;
    return `This ${who}'s token spend ceiling has ${formatCount(input.remainingTokens)} tokens remaining of ${formatCount(input.ceilingTokens)}.${needed} ${recovery}`;
  }
  return `This ${who}'s token spend ceiling is exhausted. ${recovery}`;
}

function makeRefusal(input: RefusalInput): SpendCeilingRefusal {
  return {
    kind: input.kind,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    dimension: input.dimension,
    ...(input.remainingTokens === undefined ? {} : { remainingTokens: input.remainingTokens }),
    ...(input.overrunTokens === undefined ? {} : { overrunTokens: input.overrunTokens }),
    ...(input.ceilingTokens === undefined ? {} : { ceilingTokens: input.ceilingTokens }),
    ...(input.remainingTurns === undefined ? {} : { remainingTurns: input.remainingTurns }),
    ...(input.ceilingTurns === undefined ? {} : { ceilingTurns: input.ceilingTurns }),
    ...(input.remainingRunTimeSeconds === undefined
      ? {}
      : { remainingRunTimeSeconds: input.remainingRunTimeSeconds }),
    ...(input.ceilingRunTimeSeconds === undefined
      ? {}
      : { ceilingRunTimeSeconds: input.ceilingRunTimeSeconds }),
    recovery: recoveryFor(input.kind),
    message: refusalMessage(input),
  };
}

function remainingTokens(facts: SpendCeilingScopeFacts, tokenBudget: number): number | undefined {
  if (facts.committed.status !== "known") return undefined;
  return Math.max(0, tokenBudget - facts.committed.tokens - facts.reservedTokens);
}

function configuredTurnBound(scopes: ReadonlyArray<SpendCeilingScopeFacts>): number | undefined {
  const bounds = scopes
    .map((facts) => facts.policy.maxTokensPerTurn)
    .filter((value): value is number => value !== undefined);
  if (bounds.length === 0) return undefined;
  return Math.min(...bounds);
}

function refuseTurnsOrRunTime(facts: SpendCeilingScopeFacts): SpendCeilingRefusal | undefined {
  const { turnBudget, runTimeBudgetSeconds } = facts.policy;
  const where = { scopeKind: facts.scopeKind, scopeId: facts.scopeId } as const;
  if (turnBudget !== undefined) {
    if (facts.usedTurns === undefined) {
      return makeRefusal({
        ...where,
        kind: "unknown-spend",
        dimension: "turns",
        ceilingTurns: turnBudget,
      });
    }
    if (facts.usedTurns >= turnBudget) {
      return makeRefusal({
        ...where,
        kind: "exhausted",
        dimension: "turns",
        remainingTurns: 0,
        ceilingTurns: turnBudget,
      });
    }
  }
  if (runTimeBudgetSeconds !== undefined) {
    if (facts.usedRunTimeMs === undefined) {
      return makeRefusal({
        ...where,
        kind: "unknown-spend",
        dimension: "run-time",
        ceilingRunTimeSeconds: runTimeBudgetSeconds,
      });
    }
    if (facts.usedRunTimeMs >= runTimeBudgetSeconds * 1_000) {
      return makeRefusal({
        ...where,
        kind: "exhausted",
        dimension: "run-time",
        remainingRunTimeSeconds: 0,
        ceilingRunTimeSeconds: runTimeBudgetSeconds,
      });
    }
  }
  return undefined;
}

/**
 * Admit a provider-consuming turn against the intersection of Project and
 * thread ceilings. Token reservations are counted in `reservedTokens` so two
 * concurrent admits cannot both take the same remaining capacity. Turn and
 * run-time budgets count in-flight turns, so a turn is admitted while any turn
 * and any run time remains; a turn already running is never cut off when the
 * run-time budget runs out, the next admission refuses instead.
 */
export function evaluateSpendCeilingAdmission(input: {
  readonly project?: SpendCeilingScopeFacts;
  readonly thread?: SpendCeilingScopeFacts;
  readonly turnUpperBoundTokens?: number;
}): SpendCeilingAdmission {
  const scopes = [input.project, input.thread].filter(
    (facts): facts is SpendCeilingScopeFacts => facts !== undefined,
  );
  if (scopes.length === 0) {
    return { status: "admitted", reservedTokens: 0, reservations: [] };
  }

  for (const facts of scopes) {
    if (facts.overrun !== undefined) {
      const overrunTokens = Math.max(
        1,
        facts.overrun.observedTokens - facts.overrun.reservedTokens,
      );
      return {
        status: "refused",
        refusal: makeRefusal({
          kind: "overrun",
          dimension: "tokens",
          scopeKind: facts.scopeKind,
          scopeId: facts.scopeId,
          overrunTokens,
          ...(facts.policy.tokenBudget === undefined
            ? {}
            : { ceilingTokens: facts.policy.tokenBudget }),
        }),
      };
    }
  }

  for (const facts of scopes) {
    const refusal = refuseTurnsOrRunTime(facts);
    if (refusal !== undefined) return { status: "refused", refusal };
  }

  const tokenScopes = scopes.filter((facts) => facts.policy.tokenBudget !== undefined);
  if (tokenScopes.length === 0) {
    return { status: "admitted", reservedTokens: 0, reservations: [] };
  }

  const bound =
    input.turnUpperBoundTokens !== undefined &&
    Number.isSafeInteger(input.turnUpperBoundTokens) &&
    input.turnUpperBoundTokens > 0
      ? input.turnUpperBoundTokens
      : configuredTurnBound(tokenScopes);

  if (bound === undefined || !Number.isSafeInteger(bound) || bound <= 0) {
    const facts = tokenScopes[0];
    return {
      status: "refused",
      refusal: makeRefusal({
        kind: "missing-turn-bound",
        dimension: "tokens",
        scopeKind: facts?.scopeKind ?? "thread",
        scopeId: facts?.scopeId ?? "",
        ...(facts?.policy.tokenBudget === undefined
          ? {}
          : { ceilingTokens: facts.policy.tokenBudget }),
      }),
    };
  }

  for (const facts of tokenScopes) {
    const tokenBudget = facts.policy.tokenBudget ?? 0;
    if (facts.committed.status !== "known") {
      return {
        status: "refused",
        refusal: makeRefusal({
          kind: "unknown-spend",
          dimension: "tokens",
          scopeKind: facts.scopeKind,
          scopeId: facts.scopeId,
          ceilingTokens: tokenBudget,
        }),
      };
    }
    const remaining = remainingTokens(facts, tokenBudget);
    if (remaining === undefined || remaining < bound) {
      return {
        status: "refused",
        refusal: makeRefusal({
          kind: "exhausted",
          dimension: "tokens",
          scopeKind: facts.scopeKind,
          scopeId: facts.scopeId,
          remainingTokens: remaining ?? 0,
          ceilingTokens: tokenBudget,
          neededTokens: bound,
        }),
      };
    }
  }

  return {
    status: "admitted",
    reservedTokens: bound,
    reservations: tokenScopes.map((facts) => ({
      scopeKind: facts.scopeKind,
      scopeId: facts.scopeId,
      reservedTokens: bound,
    })),
  };
}

/**
 * Finish an in-flight reservation. Observed spend above the reserved bound is
 * an overrun: the ceiling is not silently widened.
 */
export function settleSpendCeilingReservation(input: {
  readonly reservedTokens: number;
  readonly observedTokens?: number;
}): SpendCeilingSettlement {
  if (input.observedTokens === undefined) return { kind: "released" };
  if (!Number.isSafeInteger(input.observedTokens) || input.observedTokens < 0) {
    return { kind: "released" };
  }
  if (input.observedTokens > input.reservedTokens) {
    return {
      kind: "overrun",
      reservedTokens: input.reservedTokens,
      observedTokens: input.observedTokens,
    };
  }
  return { kind: "committed", observedTokens: input.observedTokens };
}

export function remainingSpendCeilingTokens(input: {
  readonly tokenBudget: number;
  readonly committedTokens: number;
  readonly reservedTokens: number;
}): number {
  return Math.max(0, input.tokenBudget - input.committedTokens - input.reservedTokens);
}

/**
 * Calendar windows count from the start of the period in the ceiling's time
 * zone. Lifetime windows have no lower bound.
 */
export function spendCeilingWindowStart(
  window: SpendCeilingWindow,
  now: UtcTimestamp | string,
): string | undefined {
  if (window.kind === "lifetime") return undefined;
  const parts = dateParts(now, window.timeZone);
  if (window.period === "day") {
    return zonedMidnight(parts, window.timeZone);
  }
  if (window.period === "month") {
    return zonedMidnight({ ...parts, day: "01" }, window.timeZone);
  }
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return zonedMidnight(
    {
      year: String(date.getUTCFullYear()).padStart(4, "0"),
      month: String(date.getUTCMonth() + 1).padStart(2, "0"),
      day: String(date.getUTCDate()).padStart(2, "0"),
    },
    window.timeZone,
  );
}

function dateParts(
  timestamp: string,
  timeZone: string,
): { readonly year: string; readonly month: string; readonly day: string } {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(formatted.map((part) => [part.type, part.value]));
  return {
    year: values.year ?? "1970",
    month: values.month ?? "01",
    day: values.day ?? "01",
  };
}

/**
 * Instant at local midnight in `timeZone` for the civil date. Uses the same
 * Intl offset-probe as automation scheduling so DST folds and gaps do not
 * treat the local calendar date as UTC.
 */
function zonedMidnight(
  parts: { readonly year: string; readonly month: string; readonly day: string },
  timeZone: string,
): string {
  const utcGuess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const offsetMs = (instant: number): number => {
    const local = zonedDateTimeParts(instant, timeZone);
    return (
      Date.UTC(
        Number(local.year),
        Number(local.month) - 1,
        Number(local.day),
        Number(local.hour),
        Number(local.minute),
        Number(local.second),
      ) - instant
    );
  };
  const first = utcGuess - offsetMs(utcGuess);
  const secondOffset = offsetMs(first);
  const resolved = secondOffset === offsetMs(utcGuess) ? first : utcGuess - secondOffset;
  return new Date(resolved).toISOString();
}

function zonedDateTimeParts(
  instant: number,
  timeZone: string,
): {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
} {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(formatted.map((part) => [part.type, part.value]));
  return {
    year: values.year ?? "1970",
    month: values.month ?? "01",
    day: values.day ?? "01",
    hour: values.hour ?? "00",
    minute: values.minute ?? "00",
    second: values.second ?? "00",
  };
}

function commandRefusal(
  kind: SpendCeilingCommandRefusal["kind"],
  message: string,
): SpendCeilingCommandDecision {
  return { status: "refused", refusal: { kind, message } };
}

function authorizeSet(principalKind: PrincipalKind): SpendCeilingCommandDecision | undefined {
  const decision = authorizePrincipalAction({
    principalKind,
    action: SPEND_CEILING_ACTION_NAMES.set,
  });
  if (decision.kind === "deny") {
    return commandRefusal(
      "unauthorized",
      "Setting a spend ceiling is a host owner command. Open this host locally to raise or clear it.",
    );
  }
  return undefined;
}

function validateWindow(
  scope: SpendCeilingScope,
  window: SpendCeilingWindow,
): SpendCeilingCommandDecision | undefined {
  if (scope.kind === "project" && window.kind !== "calendar") {
    return commandRefusal(
      "invalid-window",
      "A Project ceiling uses a calendar day, week, or month in the host time zone.",
    );
  }
  return undefined;
}

export function decideSpendCeilingCommand(input: {
  readonly principalKind: PrincipalKind;
  readonly command: SpendCeilingCommand;
  readonly current?: SpendCeilingState;
  readonly scopeExists: boolean;
  readonly now: UtcTimestamp;
  readonly actor: SpendCeilingState["setBy"];
}): SpendCeilingCommandDecision {
  const unauthorized = authorizeSet(input.principalKind);
  if (unauthorized !== undefined) return unauthorized;
  if (!input.scopeExists) {
    return commandRefusal("unknown-scope", "That Project or thread is not on this host.");
  }
  const expected = input.command.expectedVersion;
  const actual = input.current?.version ?? 0;
  if (actual !== expected) {
    return commandRefusal("version-conflict", "Spend ceiling changed; reload and retry.");
  }

  if (input.command.kind === "set-spend-ceiling") {
    const invalid = validateWindow(input.command.scope, input.command.window);
    if (invalid !== undefined) return invalid;
    return {
      status: "accepted",
      next: {
        scope: input.command.scope,
        window: input.command.window,
        policy: input.command.policy,
        version: (actual + 1) as SpendCeilingState["version"],
        setAt: input.now,
        setBy: input.actor,
      },
    };
  }

  if (input.command.kind === "raise-spend-ceiling") {
    if (input.current === undefined) {
      return commandRefusal("ceiling-not-set", "There is no spend ceiling to raise.");
    }
    const current = input.current.policy;
    const raises = [
      ["token", input.command.tokenBudget, current.tokenBudget],
      ["turn", input.command.turnBudget, current.turnBudget],
      ["run-time", input.command.runTimeBudgetSeconds, current.runTimeBudgetSeconds],
    ] as const;
    for (const [dimension, next, previous] of raises) {
      if (next === undefined) continue;
      if (previous === undefined) {
        return commandRefusal(
          "not-a-raise",
          `This ceiling has no ${dimension} budget to raise. Clear it and set a new ceiling to add one.`,
        );
      }
      if (next <= previous) {
        return commandRefusal(
          "not-a-raise",
          `Raising a ${dimension} ceiling requires a budget strictly above the current one.`,
        );
      }
    }
    // An overrun is a token fact; only a wider token budget resolves it.
    const { overrun, ...withoutOverrun } = input.current;
    const base =
      input.command.tokenBudget === undefined || overrun === undefined
        ? input.current
        : withoutOverrun;
    return {
      status: "accepted",
      ...(input.command.tokenBudget === undefined || current.tokenBudget === undefined
        ? {}
        : { previousTokenBudget: current.tokenBudget }),
      ...(input.command.turnBudget === undefined || current.turnBudget === undefined
        ? {}
        : { previousTurnBudget: current.turnBudget }),
      ...(input.command.runTimeBudgetSeconds === undefined ||
      current.runTimeBudgetSeconds === undefined
        ? {}
        : { previousRunTimeBudgetSeconds: current.runTimeBudgetSeconds }),
      next: {
        ...base,
        policy: {
          ...current,
          ...(input.command.tokenBudget === undefined
            ? {}
            : { tokenBudget: input.command.tokenBudget }),
          ...(input.command.turnBudget === undefined
            ? {}
            : { turnBudget: input.command.turnBudget }),
          ...(input.command.runTimeBudgetSeconds === undefined
            ? {}
            : { runTimeBudgetSeconds: input.command.runTimeBudgetSeconds }),
        },
        version: (actual + 1) as SpendCeilingState["version"],
        setAt: input.now,
        setBy: input.actor,
      },
    };
  }

  if (input.current === undefined) {
    return commandRefusal("ceiling-not-set", "There is no spend ceiling to clear.");
  }
  return { status: "cleared", scope: input.command.scope };
}

export function authorizeSpendCeilingRead(principalKind: PrincipalKind): boolean {
  return (
    authorizePrincipalAction({
      principalKind,
      action: SPEND_CEILING_ACTION_NAMES.read,
    }).kind === "allow"
  );
}
