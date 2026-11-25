import type { MobileInboxRow } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import { inboxFilterCounts, MOBILE_INBOX_FILTERS, rowsForInboxFilter } from "./inboxFilters";

const row = (threadId: string, fields: Partial<MobileInboxRow> = {}): MobileInboxRow => ({
  hostId: "studio",
  mode: "code",
  threadId,
  title: threadId,
  status: "active",
  freshness: "2026-11-25T08:00:00.000Z",
  ...fields,
});

const rows = [
  row("approval", { live: "needs-input", waitingAsk: { label: "Approval" } }),
  row("decision", {
    live: "needs-input",
    waitingAsk: { label: "Decision", decision: true },
  }),
  row("urgent", {
    live: "needs-input",
    waitingAsk: { label: "Decision", decision: true, urgent: true },
  }),
  row("working", { live: "working" }),
  row("failed", { status: "failed" }),
  row("in review", { reviewState: "pending" }),
  row("finished", { unread: true }),
  row("finished and put away", { unread: true, completedAt: "2026-11-25T08:30:00.000Z" }),
  row("running again", { unread: true, live: "working" }),
];
const ids = (filter: Parameters<typeof rowsForInboxFilter>[1]) =>
  rowsForInboxFilter(rows, filter).map((item) => item.threadId);

describe("Inbox", () => {
  it("lists what waits on the person, and nothing that is only working or in review", () => {
    expect(ids("all")).toEqual(["approval", "decision", "urgent", "failed"]);
  });

  it("lists a finished turn under Finished alone, until it runs again or is put away", () => {
    expect(ids("finished")).toEqual(["finished"]);
  });

  it("puts a decision under Decide, an urgent one under Urgent too, and every other wait under Stuck", () => {
    expect(ids("decide")).toEqual(["decision", "urgent"]);
    expect(ids("urgent")).toEqual(["urgent"]);
    expect(ids("stuck")).toEqual(["approval", "failed"]);
  });

  it("counts each filter from the rows that filter lists", () => {
    const counts = inboxFilterCounts(rows);
    for (const { id } of MOBILE_INBOX_FILTERS) expect(counts[id]).toBe(ids(id).length);
  });

  it("leaves out a thread the person settled or snoozed", () => {
    const shelved = [
      row("settled", { status: "failed", completedAt: "2026-11-25T07:00:00.000Z" }),
      row("snoozed", {
        status: "failed",
        snooze: { until: "2099-01-01T00:00:00.000Z", at: "2026-11-25T07:00:00.000Z" },
      }),
    ];
    expect(rowsForInboxFilter(shelved, "all")).toEqual([]);
  });
});
