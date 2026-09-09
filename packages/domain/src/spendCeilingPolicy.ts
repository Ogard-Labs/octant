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

function recoveryFor(kind: SpendCeilingRefusal["kind"]): SpendCeilingRefusal["recovery"] {
  if (kind === "missing-turn-bound") {
    return ["raise-ceiling", "pause-work"];
  }
  return [...DEFAULT_RECOVERY];
}

function refusalMessage(input: {
  readonly kind: SpendCeilingRefusal["kind"];
  readonly scopeKind: "project" | "thread";
  readonly remainingTokens?: number;
  readonly overrunTokens?: number;
  readonly ceilingTokens?: number;
  readonly neededTokens?: number;
}): string {
  const who = scopeLabel(input.scopeKind);
  if (input.kind === "unknown-spend") {
    return `This ${who}'s token spend ceiling cannot be measured because recent usage is unavailable. Raise or clear the ceiling, open Usage for this ${who}, or pause work.`;
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
    return `This ${who}'s token spend ceiling has ${formatCount(input.remainingTokens)} tokens remaining of ${formatCount(input.ceilingTokens)}.${needed} Raise or clear the ceiling, open Usage for this ${who}, or pause work.`;
  }
  return `This ${who}'s token spend ceiling is exhausted. Raise or clear the ceiling, open Usage for this ${who}, or pause work.`;
}

function makeRefusal(input: {
  readonly kind: SpendCeilingRefusal["kind"];
  readonly scopeKind: "project" | "thread";
  readonly scopeId: string;
  readonly remainingTokens?: number;
  readonly overrunTokens?: number;
  readonly ceilingTokens?: number;
  readonly neededTokens?: number;
}): SpendCeilingRefusal {
  return {
    kind: input.kind,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    dimension: "tokens",
    ...(input.remainingTokens === undefined ? {} : { remainingTokens: input.remainingTokens }),
    ...(input.overrunTokens === undefined ? {} : { overrunTokens: input.overrunTokens }),
    ...(input.ceilingTokens === undefined ? {} : { ceilingTokens: input.ceilingTokens }),
    recovery: recoveryFor(input.kind),
    message: refusalMessage(input),
  };
}

function remainingTokens(facts: SpendCeilingScopeFacts): number | undefined {
  if (facts.committed.status !== "known") return undefined;
  return Math.max(0, facts.policy.tokenBudget - facts.committed.tokens - facts.reservedTokens);
}

function configuredTurnBound(
  project: SpendCeilingScopeFacts | undefined,
  thread: SpendCeilingScopeFacts | undefined,
): number | undefined {
  const bounds = [project?.policy.maxTokensPerTurn, thread?.policy.maxTokensPerTurn].filter(
    (value): value is number => value !== undefined,
  );
  if (bounds.length === 0) return undefined;
  return Math.min(...bounds);
}

/**
 * Admit a provider-consuming turn against the intersection of Project and
 * thread token ceilings. Reservations are counted in `reservedTokens` so two
 * concurrent admits cannot both take the same remaining capacity.
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
          scopeKind: facts.scopeKind,
          scopeId: facts.scopeId,
          overrunTokens,
          ceilingTokens: facts.policy.tokenBudget,
        }),
      };
    }
  }

  const bound =
    input.turnUpperBoundTokens !== undefined &&
    Number.isSafeInteger(input.turnUpperBoundTokens) &&
    input.turnUpperBoundTokens > 0
      ? input.turnUpperBoundTokens
      : configuredTurnBound(input.project, input.thread);

  if (bound === undefined || !Number.isSafeInteger(bound) || bound <= 0) {
    const facts = scopes[0]!;
    return {
      status: "refused",
      refusal: makeRefusal({
        kind: "missing-turn-bound",
        scopeKind: facts.scopeKind,
        scopeId: facts.scopeId,
        ceilingTokens: facts.policy.tokenBudget,
      }),
    };
  }

  for (const facts of scopes) {
    if (facts.committed.status !== "known") {
      return {
        status: "refused",
        refusal: makeRefusal({
          kind: "unknown-spend",
          scopeKind: facts.scopeKind,
          scopeId: facts.scopeId,
          ceilingTokens: facts.policy.tokenBudget,
        }),
      };
    }
    const remaining = remainingTokens(facts);
    if (remaining === undefined || remaining < bound) {
      return {
        status: "refused",
        refusal: makeRefusal({
          kind: "exhausted",
          scopeKind: facts.scopeKind,
          scopeId: facts.scopeId,
          remainingTokens: remaining ?? 0,
          ceilingTokens: facts.policy.tokenBudget,
          neededTokens: bound,
        }),
      };
    }
  }

  return {
    status: "admitted",
    reservedTokens: bound,
    reservations: scopes.map((facts) => ({
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
    return `${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`;
  }
  if (window.period === "month") {
    return `${parts.year}-${parts.month}-01T00:00:00.000Z`;
  }
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString();
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
      "A Project token ceiling uses a calendar day, week, or month in the host time zone.",
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
    if (input.command.tokenBudget <= input.current.policy.tokenBudget) {
      return commandRefusal(
        "not-a-raise",
        "Raising a token ceiling requires a budget strictly above the current one.",
      );
    }
    const { overrun: _cleared, ...withoutOverrun } = input.current;
    return {
      status: "accepted",
      previousTokenBudget: input.current.policy.tokenBudget,
      next: {
        ...withoutOverrun,
        policy: {
          ...input.current.policy,
          tokenBudget: input.command.tokenBudget,
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
