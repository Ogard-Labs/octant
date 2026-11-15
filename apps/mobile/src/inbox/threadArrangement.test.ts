import type { MobileInboxRow } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import { arrangeMobileThreads } from "./threadArrangement";

const row = (threadId: string, fields: Partial<MobileInboxRow> = {}): MobileInboxRow => ({
  hostId: "host-1",
  mode: "work",
  threadId,
  title: threadId,
  status: "active",
  freshness: "2026-11-14T09:00:00.000Z",
  ...fields,
});

const now = new Date("2026-11-14T12:00:00");
const names = (groups: ReturnType<typeof arrangeMobileThreads>) =>
  groups.map((group) => [group.label, group.rows.map((entry) => entry.threadId)]);

describe("arranging a mode's threads on the phone", () => {
  it("orders Status by what the person does next, each thread once", () => {
    const groups = arrangeMobileThreads({
      arrangement: "status",
      projectName: () => undefined,
      rows: [
        row("idle"),
        row("running", { live: "working" }),
        row("asks", { live: "needs-input" }),
        row("pinned-and-asks", { pinned: true, live: "needs-input" }),
        row("review", { mode: "code", reviewState: "pending" }),
      ],
    });
    expect(names(groups)).toEqual([
      ["Pinned", ["pinned-and-asks"]],
      ["Needs input", ["asks"]],
      ["Ready for review", ["review"]],
      ["Working", ["running"]],
      ["Idle", ["idle"]],
    ]);
  });

  it("groups by Project with chats that have no folder last, newest Project first", () => {
    const groups = arrangeMobileThreads({
      arrangement: "projects",
      projectName: (entry) => (entry.projectId === "p-1" ? "Octant" : "Site"),
      rows: [
        row("chat", { mode: "chat", freshness: "2026-11-14T11:00:00.000Z" }),
        row("old-site", { projectId: "p-2", freshness: "2026-11-10T09:00:00.000Z" }),
        row("octant", { projectId: "p-1", freshness: "2026-11-14T10:00:00.000Z" }),
      ],
    });
    expect(names(groups)).toEqual([
      ["Octant", ["octant"]],
      ["Site", ["old-site"]],
      ["No Project", ["chat"]],
    ]);
  });

  it("groups Activity by day, newest first, with pins on top", () => {
    const groups = arrangeMobileThreads({
      arrangement: "activity",
      projectName: () => undefined,
      now,
      rows: [
        row("today", { freshness: "2026-11-14T08:00:00" }),
        row("yesterday", { freshness: "2026-11-13T08:00:00" }),
        row("wednesday", { freshness: "2026-11-11T08:00:00" }),
        row("old", { freshness: "2026-10-01T08:00:00" }),
        row("pinned", { pinned: true, freshness: "2026-10-01T08:00:00" }),
      ],
    });
    expect(names(groups)).toEqual([
      ["Pinned", ["pinned"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Wednesday", ["wednesday"]],
      ["Earlier", ["old"]],
    ]);
  });

  it("shelves snoozed and put-away threads below the list, and wakes a snooze when the agent needs the person", () => {
    const groups = arrangeMobileThreads({
      arrangement: "status",
      projectName: () => undefined,
      now,
      rows: [
        row("open"),
        row("asleep", { snooze: { until: "2026-11-15T09:00:00", at: "2026-11-14T08:00:00" } }),
        row("asleep-but-asks", {
          live: "needs-input",
          snooze: { until: "2026-11-15T09:00:00", at: "2026-11-14T08:00:00" },
        }),
        row("done", { completedAt: "2026-11-13T08:00:00" }),
      ],
    });
    expect(names(groups)).toEqual([
      ["Needs input", ["asleep-but-asks"]],
      ["Idle", ["open"]],
      ["Snoozed", ["asleep"]],
      ["Put away", ["done"]],
    ]);
  });
});
