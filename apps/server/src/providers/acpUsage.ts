import type { ProviderRuntimeEvent } from "@octant/contracts";

interface AcpUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
}

interface AcpUsageSnapshot extends AcpUsageTotals {
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

export interface AcpUsageState {
  latest?: AcpUsageSnapshot | undefined;
  baseline?: AcpUsageSnapshot | undefined;
}

type Usage = Omit<
  Extract<ProviderRuntimeEvent, { readonly kind: "usage" }>,
  "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt"
>;

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function totals(input: unknown, output: unknown, cached: unknown): AcpUsageTotals | undefined {
  if (
    !count(input) ||
    !count(output) ||
    (cached !== undefined && (!count(cached) || cached > input))
  )
    return;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
  };
}

function snapshot(update: Readonly<Record<string, unknown>>): AcpUsageSnapshot | undefined {
  const meta = record(update._meta);
  const reported = totals(meta?.promptTokens, meta?.completionTokens, meta?.cachedTokens);
  if (reported === undefined || !count(update.used) || !count(update.size) || update.size === 0)
    return;
  return { ...reported, contextTokens: update.used, contextWindow: update.size };
}

function regresses(current: AcpUsageTotals, previous: AcpUsageTotals): boolean {
  return (
    current.inputTokens < previous.inputTokens ||
    current.outputTokens < previous.outputTokens ||
    (current.cacheReadInputTokens !== undefined &&
      previous.cacheReadInputTokens !== undefined &&
      (current.cacheReadInputTokens < previous.cacheReadInputTokens ||
        current.cacheReadInputTokens - previous.cacheReadInputTokens >
          current.inputTokens - previous.inputTokens))
  );
}

export function beginAcpUsageTurn(state: AcpUsageState): void {
  state.baseline = state.latest;
}

/** Vibe 3.0.3 reports session totals, including after loading an earlier session. */
export function observeAcpUsage(
  state: AcpUsageState,
  update: Readonly<Record<string, unknown>>,
): void {
  const previous = state.latest;
  const current = snapshot(update);
  if (current === undefined || (previous !== undefined && regresses(current, previous))) {
    state.latest = undefined;
    state.baseline = undefined;
    return;
  }
  state.latest = current;
}

export function finishAcpUsageTurn(state: AcpUsageState, receipt: unknown): Usage | undefined {
  const baseline = state.baseline;
  state.baseline = undefined;
  const final = record(receipt);
  const current = totals(
    final?.inputTokens,
    final?.outputTokens,
    final?.cachedReadTokens ?? undefined,
  );
  const latest = state.latest;
  const valid =
    current !== undefined &&
    count(final?.totalTokens) &&
    final.totalTokens === current.inputTokens + current.outputTokens;
  const context =
    valid &&
    latest !== undefined &&
    latest.inputTokens === current.inputTokens &&
    latest.outputTokens === current.outputTokens
      ? latest
      : undefined;
  // Final counters also seed the next turn when the notification is delayed.
  // Its earlier context stays separate from the authoritative final totals.
  state.latest = valid
    ? {
        ...current,
        ...(context === undefined
          ? {}
          : {
              ...(context.contextTokens === undefined
                ? {}
                : { contextTokens: context.contextTokens }),
              ...(context.contextWindow === undefined
                ? {}
                : { contextWindow: context.contextWindow }),
            }),
      }
    : undefined;
  if (
    baseline === undefined ||
    !valid ||
    regresses(current, baseline) ||
    (latest !== undefined && regresses(current, latest))
  )
    return;
  // Its cost reprices cumulative tokens at the current model's rates. Without
  // a verified turn-cost boundary that figure cannot be charged to this turn.
  return {
    kind: "usage",
    inputTokens: current.inputTokens - baseline.inputTokens,
    outputTokens: current.outputTokens - baseline.outputTokens,
    ...(current.cacheReadInputTokens === undefined || baseline.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: current.cacheReadInputTokens - baseline.cacheReadInputTokens }),
    ...(context?.contextTokens === undefined || context.contextWindow === undefined
      ? {}
      : { contextTokens: context.contextTokens, contextWindow: context.contextWindow }),
  };
}

/**
 * Usage observed so far in a turn that fails before its reply settles: the
 * counters added since the turn's baseline, from the latest valid snapshot.
 * A failed turn has no final receipt, and the turn's consumer stops reading
 * at its failure, so this is the whole usage it can still record.
 */
export function observedAcpUsageTurn(state: AcpUsageState): Usage | undefined {
  const baseline = state.baseline;
  const latest = state.latest;
  state.baseline = undefined;
  if (baseline === undefined || latest === undefined || regresses(latest, baseline)) return;
  return {
    kind: "usage",
    inputTokens: latest.inputTokens - baseline.inputTokens,
    outputTokens: latest.outputTokens - baseline.outputTokens,
    ...(latest.cacheReadInputTokens === undefined || baseline.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: latest.cacheReadInputTokens - baseline.cacheReadInputTokens }),
    ...(latest.contextTokens === undefined || latest.contextWindow === undefined
      ? {}
      : { contextTokens: latest.contextTokens, contextWindow: latest.contextWindow }),
  };
}

/**
 * How a profile reviewed a reply that leaves out ACP's required
 * `totalTokens`: Google Antigravity's `inputTokens` leaves out cached reads
 * (other ACP clients of it add them back) and its `outputTokens` already
 * counts thinking. Without a reviewed rule such a reply is not read.
 */
export type AcpTurnUsageWithoutTotal = "input-excludes-cache-reads";

function optionalCount(value: unknown): number | undefined | false {
  if (value === undefined || value === null) return undefined;
  return count(value) ? value : false;
}

/**
 * Token usage in a `session/prompt` reply, read by ACP's `Usage` schema:
 * the reply's `usage` is "token usage for this turn", and `totalTokens` is
 * the "sum of all token types". Agents differ on whether `inputTokens`
 * already counts the cached reads and writes and whether `outputTokens`
 * already counts `thoughtTokens`, so the total decides: the first reading
 * whose parts add up to it is taken, starting with every type disjoint (as
 * the schema's sum describes) and then each part counted inside its parent.
 * Octant's input is all input, cached or not, and its output counts thinking,
 * with `thoughtTokens` kept as the reasoning part of it.
 * A reply whose parts fit no reading, or with no total and no reviewed rule
 * for that, reports nothing rather than a guess.
 */
export function acpTurnUsage(
  receipt: unknown,
  withoutTotal?: AcpTurnUsageWithoutTotal,
): Usage | undefined {
  const reported = record(receipt);
  const input = reported?.inputTokens;
  const output = reported?.outputTokens;
  const total = optionalCount(reported?.totalTokens);
  const thought = optionalCount(reported?.thoughtTokens);
  const cacheRead = optionalCount(reported?.cachedReadTokens);
  const cacheWrite = optionalCount(reported?.cachedWriteTokens);
  if (
    !count(input) ||
    !count(output) ||
    total === false ||
    thought === false ||
    cacheRead === false ||
    cacheWrite === false
  )
    return;
  const cache = {
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
  };
  if (total === undefined) {
    if (withoutTotal !== "input-excludes-cache-reads") return;
    return {
      kind: "usage",
      inputTokens: input + (cacheRead ?? 0),
      outputTokens: output,
      ...(thought === undefined || thought > output ? {} : { reasoningTokens: thought }),
      ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    };
  }
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
  const thinking = thought ?? 0;
  // Whichever way an agent nests the parts, Octant's input plus output is
  // every token the turn spent, which is what `totalTokens` sums.
  const readings = [
    { inputTokens: input + cached, outputTokens: output + thinking },
    ...(cached <= input && thinking <= output
      ? [{ inputTokens: input, outputTokens: output }]
      : []),
    ...(thinking <= output ? [{ inputTokens: input + cached, outputTokens: output }] : []),
    ...(cached <= input ? [{ inputTokens: input, outputTokens: output + thinking }] : []),
  ];
  const reading = readings.find(
    (candidate) => candidate.inputTokens + candidate.outputTokens === total,
  );
  if (reading === undefined) return;
  // Every reading's output counts thinking, so the thought figure is the
  // part of it spent reasoning.
  return {
    kind: "usage",
    ...reading,
    ...(thought === undefined ? {} : { reasoningTokens: thought }),
    ...cache,
  };
}

interface AcpSessionCost {
  readonly amount: number;
  /** Absent only for the zero a session Octant opened new starts from. */
  readonly currency?: string;
}

/**
 * What an agent without a reviewed reading reports through ACP's standard
 * `usage_update`: the context it holds now (`used` of `size`) and the
 * session's cumulative `cost`.
 */
export interface AcpReportedUsageState {
  /** The session cost charged to earlier turns; absent until one is known. */
  charged?: AcpSessionCost | undefined;
  latestCost?: AcpSessionCost | undefined;
  /**
   * Whether a cost arrived since the last settled turn. Without one,
   * `latestCost` is the figure already charged, and their difference would
   * read as a provider-priced zero for a turn whose cost is unknown.
   */
  costUnsettled?: boolean;
  /** Context reported during the running turn; an earlier turn's is stale. */
  context?: { readonly used: number; readonly size: number } | undefined;
}

/**
 * A session Octant opens with `session/new` has cost nothing yet; one it
 * loads or resumes carries an earlier cost Octant has not seen, so its first
 * turn's share is known only once a cost was reported before that turn.
 */
export function acpReportedUsageState(opened: "new" | "existing"): AcpReportedUsageState {
  return opened === "new" ? { charged: { amount: 0 } } : {};
}

export function observeAcpUsageUpdate(
  state: AcpReportedUsageState,
  update: Readonly<Record<string, unknown>>,
): void {
  if (count(update.used) && count(update.size) && update.size > 0)
    state.context = { used: update.used, size: update.size };
  const cost = record(update.cost);
  const amount = cost?.amount;
  const currency = cost?.currency;
  if (
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    typeof currency === "string"
  ) {
    state.latestCost = { amount, currency };
    state.costUnsettled = true;
  }
}

export function beginAcpReportedTurn(state: AcpReportedUsageState): void {
  if (state.charged === undefined && state.latestCost !== undefined) {
    // An existing session's cost reported before its first turn is the
    // baseline that turn grows from, not spend of that turn.
    state.charged = state.latestCost;
    state.costUnsettled = false;
  }
  state.context = undefined;
}

/**
 * Settles a turn of an agent read by ACP's standard usage. Its cost is what
 * the session's cumulative cost grew by since the last settled turn, so a
 * cost update that arrives after a reply is charged to the next turn rather
 * than lost. A turn with no cost update since the last settlement is left
 * unpriced rather than charged zero. Only US dollars become `costUsd`; another currency or unit
 * ("credits") leaves the turn unpriced by the provider, as does a cost that
 * fell or changed unit. A reply without whole token counts reports nothing,
 * so the turn records an unavailable row.
 */
export function finishAcpReportedTurn(
  state: AcpReportedUsageState,
  receipt: unknown,
  withoutTotal?: AcpTurnUsageWithoutTotal,
): Usage | undefined {
  const charged = state.charged;
  const latest = state.latestCost;
  const context = state.context;
  const unsettled = state.costUnsettled === true;
  state.charged = latest ?? charged;
  state.costUnsettled = false;
  state.context = undefined;
  const tokens = acpTurnUsage(receipt, withoutTotal);
  if (tokens === undefined) return;
  const costUsd =
    unsettled &&
    charged !== undefined &&
    latest !== undefined &&
    latest.currency === "USD" &&
    (charged.currency === undefined || charged.currency === "USD") &&
    latest.amount >= charged.amount
      ? // Subtracting decimal dollars leaves binary noise in the last digits.
        Math.round((latest.amount - charged.amount) * 1e9) / 1e9
      : undefined;
  return {
    ...tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(context === undefined ? {} : { contextTokens: context.used, contextWindow: context.size }),
  };
}
