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

/**
 * The host's search hits to list beside the in-place title filter. A title
 * match for a thread the filtered list already shows is that same row; any
 * other title match stays, since the host matches words in any order and the
 * list only the whole query.
 */
export function searchHitsBesideList<
  Hit extends {
    readonly hostId: string;
    readonly mode: string;
    readonly threadId: string;
    readonly field?: string;
  },
>(
  hits: ReadonlyArray<Hit>,
  shownRows: ReadonlyArray<Pick<MobileInboxRow, "hostId" | "mode" | "threadId">>,
): ReadonlyArray<Hit> {
  const shown = new Set(shownRows.map((row) => `${row.hostId}:${row.mode}:${row.threadId}`));
  return hits.filter(
    (hit) => hit.field !== "title" || !shown.has(`${hit.hostId}:${hit.mode}:${hit.threadId}`),
  );
}
