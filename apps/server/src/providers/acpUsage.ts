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
