import type { MobileInboxRow } from "@octant/client-runtime";

export type InboxWorkSectionId = "attention" | "working" | "review" | "recent";

function sectionFor(
  status: string,
  reviewState?: MobileInboxRow["reviewState"],
  live?: MobileInboxRow["live"],
): InboxWorkSectionId {
  // The host's runtime report is the authority on what a thread is doing now.
  // A thread's lifecycle is "active" whether or not a turn runs, so reading
  // "active" as working counted every open thread as Working.
  if (live === "needs-input") return "attention";
  if (reviewState === "changes-requested") return "attention";
  if (live === "working") return "working";
  if (reviewState === "pending" || reviewState === "approved") return "review";
  const lower = status.toLowerCase();
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
  if (lower.includes("run") || lower.includes("progress") || lower.includes("working")) {
    return "working";
  }
  return "recent";
}

export function inboxWorkStatus(
  status: string,
  reviewState?: MobileInboxRow["reviewState"],
  live?: MobileInboxRow["live"],
): string {
  const section = sectionFor(status, reviewState, live);
  if (section === "attention") return "Needs attention";
  if (section === "working") return "Working";
  if (section === "review") return "In review";
  return "Recent";
}

export interface InboxStatusCounts {
  readonly all: number;
  readonly working: number;
  readonly needsAttention: number;
  readonly inReview: number;
}

/** A Chat counts only while it waits on the person, as Home has always counted it. */
function countedSection(row: MobileInboxRow): InboxWorkSectionId | undefined {
  if (row.mode === "chat" && row.waitingAsk === undefined) return undefined;
  return sectionFor(row.status, row.reviewState, row.live);
}

/** The threads one of Home's counts counts, so its number and its list agree. */
export function inboxCountedRows(
  rows: ReadonlyArray<MobileInboxRow>,
  section: "attention" | "working" | "review",
): ReadonlyArray<MobileInboxRow> {
  return rows.filter((row) => countedSection(row) === section);
}

export function inboxStatusCounts(rows: ReadonlyArray<MobileInboxRow>): InboxStatusCounts {
  return {
    all: rows.filter((row) => countedSection(row) !== undefined).length,
    working: inboxCountedRows(rows, "working").length,
    needsAttention: inboxCountedRows(rows, "attention").length,
    inReview: inboxCountedRows(rows, "review").length,
  };
}

const SECTION_ORDER: Readonly<Record<InboxWorkSectionId, number>> = {
  attention: 0,
  working: 1,
  review: 2,
  recent: 3,
};

/**
 * The Work and Code threads the home lists under its status pills: what needs
 * the person first, then what is running, then what waits in review, then the
 * rest, each group keeping the hosts' own order, cut to `limit`.
 */
export function inboxPriorityRows(
  rows: ReadonlyArray<MobileInboxRow>,
  limit: number,
): ReadonlyArray<MobileInboxRow> {
  return rows
    .filter((row) => row.mode !== "chat" || row.waitingAsk !== undefined)
    .map((row, index) => ({
      row,
      index,
      rank: SECTION_ORDER[sectionFor(row.status, row.reviewState, row.live)],
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.row);
}
