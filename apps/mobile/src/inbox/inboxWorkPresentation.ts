import type { MobileInboxRow } from "@octant/client-runtime";

export type InboxWorkSectionId = "attention" | "working" | "review" | "recent";

function sectionFor(
  status: string,
  reviewState?: MobileInboxRow["reviewState"],
): InboxWorkSectionId {
  if (reviewState === "changes-requested") return "attention";
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
  if (
    lower.includes("active") ||
    lower.includes("run") ||
    lower.includes("progress") ||
    lower.includes("working")
  ) {
    return "working";
  }
  return "recent";
}

export function inboxWorkStatus(
  status: string,
  reviewState?: MobileInboxRow["reviewState"],
): string {
  const section = sectionFor(status, reviewState);
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

export function inboxStatusCounts(rows: ReadonlyArray<MobileInboxRow>): InboxStatusCounts {
  let all = 0;
  let working = 0;
  let needsAttention = 0;
  let inReview = 0;

  for (const row of rows) {
    if (row.mode === "chat") continue;
    all += 1;
    const section = sectionFor(row.status, row.reviewState);
    if (section === "working") working += 1;
    else if (section === "attention") needsAttention += 1;
    else if (section === "review") inReview += 1;
  }

  return { all, working, needsAttention, inReview };
}
