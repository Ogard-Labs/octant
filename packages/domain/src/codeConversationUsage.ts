import type { CodeConversationTurnUsage, CodeConversationUsageTotals } from "@octant/contracts";

/**
 * Fold turns' usage onto what the turns before them reported.
 *
 * The thread's figure is the sum over turns, never the sum over reports: a
 * provider may report a turn's usage repeatedly as it runs, and each report is
 * that turn's total so far, so each turn contributes its last report once.
 * Window figures are the latest reporting turn's. The host folds every turn
 * older than a window into its `earlierUsage`, and the client folds its loaded
 * turns onto that seed with this same function, which is what keeps the two
 * totals equal however much of the thread is loaded.
 */
export function foldCodeTurnUsage(
  seed: CodeConversationUsageTotals | undefined,
  usages: Iterable<CodeConversationTurnUsage>,
): CodeConversationUsageTotals | undefined {
  let totals = seed;
  for (const usage of usages) totals = addCodeTurnUsage(totals, usage);
  return totals;
}

function addCodeTurnUsage(
  totals: CodeConversationUsageTotals | undefined,
  usage: CodeConversationTurnUsage,
): CodeConversationUsageTotals {
  const costUsd =
    usage.costUsd === undefined ? totals?.costUsd : (totals?.costUsd ?? 0) + usage.costUsd;
  const contextWindow = usage.contextWindow ?? totals?.contextWindow;
  const contextTokens = usage.contextTokens ?? totals?.contextTokens;
  // A turn still running has reported usage but not yet its make-up, so the
  // latest breakdown that was reported stands.
  const contextBreakdown = usage.contextBreakdown ?? totals?.contextBreakdown;
  return {
    reportedTurns: (totals?.reportedTurns ?? 0) + 1,
    inputTokens: (totals?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (totals?.outputTokens ?? 0) + usage.outputTokens,
    cacheRead: measured(totals?.cacheRead, usage.cacheReadInputTokens),
    cacheWrite: measured(totals?.cacheWrite, usage.cacheWriteInputTokens),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    // Unlike the window, a promise to compact ends when the runtime stops
    // making it, so the latest turn's report stands even when it names none.
    ...(usage.autoCompactThreshold === undefined
      ? {}
      : { autoCompactThreshold: usage.autoCompactThreshold }),
    ...(contextBreakdown === undefined ? {} : { contextBreakdown }),
  };
}

function measured(
  current: CodeConversationUsageTotals["cacheRead"] | undefined,
  tokens: number | undefined,
): CodeConversationUsageTotals["cacheRead"] {
  const base = current ?? { measuredTurns: 0, measuredTokens: 0 };
  return tokens === undefined
    ? base
    : { measuredTurns: base.measuredTurns + 1, measuredTokens: base.measuredTokens + tokens };
}
