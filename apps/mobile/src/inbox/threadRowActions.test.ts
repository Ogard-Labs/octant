import { describe, expect, it } from "vitest";
import type { MobileInboxRow } from "@octant/client-runtime";
import { threadRowActions } from "./threadRowActions";

const now = new Date("2026-11-25T08:00:00.000Z");
const row = (fields: Partial<MobileInboxRow> = {}): MobileInboxRow => ({
  hostId: "host",
  mode: "chat",
  threadId: "thread",
  title: "Thread",
  status: "active",
  freshness: "2026-11-25T07:00:00.000Z",
  ...fields,
});
const said = (entry: MobileInboxRow) =>
  threadRowActions(entry, now).map((offer) =>
    offer.kind === "action"
      ? offer.action.label
      : offer.kind === "choice"
        ? `${offer.label} ▸`
        : `${offer.label}: ${offer.reason}`,
  );

describe("a thread row's actions", () => {
  it("offers Snooze and Settle on a quiet thread, and Pin on a Code thread only", () => {
    expect(said(row())).toEqual(["Snooze ▸", "Settle"]);
    expect(said(row({ mode: "code" }))).toEqual(["Snooze ▸", "Settle", "Pin"]);
    expect(said(row({ mode: "code", pinned: true }))).toEqual(["Snooze ▸", "Settle", "Unpin"]);
  });

  it("says why a thread cannot be settled instead of offering it", () => {
    expect(said(row({ live: "working" }))).toContain(
      "Settle: A turn is running. Settle it when it finishes.",
    );
    expect(said(row({ live: "needs-input" }))).toContain(
      "Settle: The agent is waiting on you. Answer it first.",
    );
  });

  it("offers the way back on a thread that is put away or asleep", () => {
    expect(said(row({ completedAt: "2026-11-25T07:30:00.000Z" }))).toContain("Un-settle");
    expect(
      said(
        row({
          snooze: { until: "2026-11-26T08:00:00.000Z", at: "2026-11-25T07:30:00.000Z" },
        }),
      ),
    ).toContain("Wake now");
  });
});
