import type { AgentRunCenterSummary, AgentRunLifecycleStatus } from "@octant/contracts";
import { isAgentRunActiveStatus } from "@octant/domain";
import { compactSpan } from "../automation/automationTable";
import { formatAgentRunTokenCount } from "./agentRunGraphFacts";

export type AgentStatusTone = "active" | "success" | "failure" | "quiet";

/**
 * The dot beside a status word. Failed and interrupted runs share the danger
 * tone because both are a run the reader may need to retry; a cancelled run
 * was the reader's own choice and stays quiet.
 */
export function agentStatusTone(status: AgentRunLifecycleStatus): AgentStatusTone {
  switch (status) {
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return "active";
    case "completed":
      return "success";
    case "failed":
    case "interrupted":
      return "failure";
    case "cancelled":
      return "quiet";
  }
}

/** "12m ago", "2d 8h ago", or "just now": when the run started. */
export function startedCell(createdAt: string, now: string): string {
  const span = compactSpan(Date.parse(now) - Date.parse(createdAt));
  return span === "now" ? "just now" : `${span} ago`;
}

/**
 * How long a live run has worked so far. A run that has not begun (queued or
 * starting) has no run time yet, and a stopped one is blank too: the summary
 * carries no end time, and its last update moves when the result is
 * acknowledged or delivered, so "last update minus start" turned a 5-minute
 * run into 4 hours once acknowledged (review finding, 2026-11-17).
 */
export function runTimeCell(
  summary: {
    readonly lifecycleStatus: AgentRunLifecycleStatus;
    readonly createdAt: string;
  },
  now: string,
): string {
  if (summary.lifecycleStatus === "queued" || summary.lifecycleStatus === "starting") return "";
  if (!isAgentRunActiveStatus(summary.lifecycleStatus)) return "";
  const span = Date.parse(now) - Date.parse(summary.createdAt);
  return Number.isFinite(span) && span >= 0 ? compactSpan(span) : "";
}

export interface UsageCell {
  /** The total tokens, or the word Estimated when only an estimate exists. */
  readonly primary: string;
  /** The split, "12k in · 3k out"; empty when there is no reported split. */
  readonly secondary: string;
}

/**
 * The Usage column. Only counts a provider reported appear as numbers; an
 * estimate says so in words, and anything else is blank, never zero.
 */
export function usageCell(
  summary: Pick<AgentRunCenterSummary, "usage" | "usageQuality">,
): UsageCell {
  if (summary.usageQuality === "provider-reported" && summary.usage !== undefined) {
    const { inputTokens, outputTokens } = summary.usage;
    return {
      primary: formatAgentRunTokenCount(inputTokens + outputTokens),
      secondary: `${formatAgentRunTokenCount(inputTokens)} in · ${formatAgentRunTokenCount(outputTokens)} out`,
    };
  }
  if (summary.usageQuality === "estimated") return { primary: "Estimated", secondary: "" };
  return { primary: "", secondary: "" };
}
