import type { MobileInboxRow } from "@octant/client-runtime";
import { sectionForAgentRow } from "./agentsListPresentation";
import { mobileThreadShelf } from "./threadArrangement";

export type MobileInboxFilter = "all" | "urgent" | "decide" | "stuck";

/** The desktop Inbox's filters and words, over what the host says waits. */
export const MOBILE_INBOX_FILTERS: ReadonlyArray<{
  readonly id: MobileInboxFilter;
  readonly label: string;
  readonly empty: string;
}> = [
  {
    id: "all",
    label: "All",
    empty: "Threads that need an answer, an approval or a look show up here.",
  },
  { id: "urgent", label: "Urgent", empty: "Nothing urgent." },
  { id: "decide", label: "Decide", empty: "No decisions waiting." },
  { id: "stuck", label: "Stuck", empty: "Nothing stuck." },
];

function waits(row: MobileInboxRow, now: Date): boolean {
  return mobileThreadShelf(row, now) === "active" && sectionForAgentRow(row) === "attention";
}

/** Stuck is every wait that is not a decision, as on the desktop. */
function matches(row: MobileInboxRow, filter: MobileInboxFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "urgent":
      return row.waitingAsk?.urgent === true;
    case "decide":
      return row.waitingAsk?.decision === true;
    case "stuck":
      return row.waitingAsk?.decision !== true;
  }
}

export function rowsForInboxFilter(
  rows: ReadonlyArray<MobileInboxRow>,
  filter: MobileInboxFilter,
  now: Date = new Date(),
): ReadonlyArray<MobileInboxRow> {
  return rows.filter((row) => waits(row, now) && matches(row, filter));
}

export function inboxFilterCounts(
  rows: ReadonlyArray<MobileInboxRow>,
  now: Date = new Date(),
): Readonly<Record<MobileInboxFilter, number>> {
  const count = (filter: MobileInboxFilter) => rowsForInboxFilter(rows, filter, now).length;
  return {
    all: count("all"),
    urgent: count("urgent"),
    decide: count("decide"),
    stuck: count("stuck"),
  };
}
