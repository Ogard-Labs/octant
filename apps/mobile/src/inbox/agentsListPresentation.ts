import type { MobileInboxRow } from "@octant/client-runtime";

export type AgentSection = "attention" | "working" | "review" | "read";

export function sectionForAgentRow(row: MobileInboxRow): AgentSection {
  if (row.reviewState === "changes-requested") return "attention";
  if (row.reviewState === "pending" || row.reviewState === "approved") return "review";
  const lower = row.status.toLowerCase();
  if (
    lower.includes("wait") ||
    lower.includes("approval") ||
    lower.includes("fail") ||
    lower.includes("error") ||
    lower.includes("interrupt") ||
    lower.includes("block")
  ) {
    return "attention";
  }
  if (lower.includes("review") || lower.includes("merge") || lower.includes("check")) {
    return "review";
  }
  if (
    lower.includes("run") ||
    lower.includes("progress") ||
    lower.includes("active") ||
    lower.includes("working")
  ) {
    return "working";
  }
  return "read";
}
