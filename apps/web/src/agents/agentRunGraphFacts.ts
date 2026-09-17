import type { AgentRunCenterSummary } from "@octant/contracts";

export function formatAgentRunRecency(timestamp: string, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - new Date(timestamp).getTime());
  if (elapsedMs < 10_000) return "just now";
  if (elapsedMs < 60_000) return `${String(Math.floor(elapsedMs / 1000))}s ago`;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

export function formatAgentRunTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    return `${abbreviate(value / 1000)}k`;
  }
  return `${abbreviate(value / 1_000_000)}m`;
}

function abbreviate(scaled: number): string {
  if (Number.isInteger(scaled) || scaled >= 100) return String(Math.round(scaled));
  return String(Math.round(scaled * 10) / 10);
}

/**
 * Honest usage for a graph card. Unknown or estimated counts never appear as
 * zero; only provider-reported totals are labeled IN/OUT.
 */
export function agentRunGraphUsageLine(summary: AgentRunCenterSummary): string | undefined {
  if (summary.usageQuality === "provider-reported" && summary.usage !== undefined) {
    return `IN ${formatAgentRunTokenCount(summary.usage.inputTokens)} · OUT ${formatAgentRunTokenCount(summary.usage.outputTokens)}`;
  }
  if (summary.usageQuality === "estimated") return "Estimated usage";
  return undefined;
}
