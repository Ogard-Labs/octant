import { describe, expect, it } from "vitest";
import {
  compareSidebarProjectStatus,
  describeSidebarProjectStatus,
  resolveSidebarThreadStatus,
  rollUpSidebarProjectStatus,
  sidebarThreadStatuses,
  SIDEBAR_THREAD_STATUS_LABEL,
  type SidebarThreadStatusInput,
} from "./sidebarThreadStatusPolicy";

function thread(overrides: Partial<SidebarThreadStatusInput> = {}): SidebarThreadStatusInput {
  return {
    working: overrides.working ?? false,
    attention: overrides.attention ?? false,
    woke: overrides.woke ?? false,
    unread: overrides.unread ?? false,
  };
}

describe("resolveSidebarThreadStatus", () => {
  it("reports nothing for a thread with no facts to report", () => {
    expect(resolveSidebarThreadStatus(thread())).toBeUndefined();
  });

  it("shows a running thread as working even when it is also unread and woken", () => {
    expect(resolveSidebarThreadStatus(thread({ working: true, unread: true, woke: true }))).toBe(
      "working",
    );
  });

  it("shows an obligation ahead of an ended snooze and unread activity", () => {
    expect(resolveSidebarThreadStatus(thread({ attention: true, woke: true, unread: true }))).toBe(
      "attention",
    );
  });

  it("shows an ended snooze ahead of unread activity", () => {
    expect(resolveSidebarThreadStatus(thread({ woke: true, unread: true }))).toBe("woke");
  });
});

describe("sidebarThreadStatuses", () => {
  it("keeps every supported status so a row can name the ones it cannot draw", () => {
    expect(sidebarThreadStatuses(thread({ working: true, unread: true }))).toEqual([
      "working",
      "unread",
    ]);
  });

  it("names nothing for a thread with no facts to report", () => {
    expect(sidebarThreadStatuses(thread())).toEqual([]);
  });
});

describe("rollUpSidebarProjectStatus", () => {
  it("reports nothing for a Project with no threads", () => {
    expect(rollUpSidebarProjectStatus([])).toBeUndefined();
  });

  it("reports nothing for a Project whose threads are all quiet", () => {
    expect(rollUpSidebarProjectStatus([thread(), thread()])).toBeUndefined();
  });

  it("reports the strongest status its threads reach", () => {
    expect(
      rollUpSidebarProjectStatus([thread({ unread: true }), thread({ attention: true })]),
    ).toEqual({ status: "attention", count: 1 });
  });

  it("counts every thread that reached the reported status", () => {
    expect(
      rollUpSidebarProjectStatus([
        thread({ working: true }),
        thread({ working: true }),
        thread({ unread: true }),
      ]),
    ).toEqual({ status: "working", count: 2 });
  });

  it("counts a thread once, at its own strongest status", () => {
    expect(
      rollUpSidebarProjectStatus([
        thread({ working: true, unread: true }),
        thread({ unread: true }),
      ]),
    ).toEqual({ status: "working", count: 1 });
  });
});

describe("describeSidebarProjectStatus", () => {
  it("names the Project and its status without a count for a single thread", () => {
    expect(describeSidebarProjectStatus("Packaging", { status: "attention", count: 1 })).toBe(
      "Packaging: Needs attention",
    );
  });

  it("counts the threads when more than one reached the reported status", () => {
    expect(describeSidebarProjectStatus("Packaging", { status: "working", count: 3 })).toBe(
      "Packaging: Working (3 threads)",
    );
  });

  it("reads a Project with the same words a row uses", () => {
    expect(describeSidebarProjectStatus("Docs", { status: "unread", count: 1 })).toContain(
      SIDEBAR_THREAD_STATUS_LABEL.unread,
    );
  });
});

describe("compareSidebarProjectStatus", () => {
  it("puts the Project with the stronger status first", () => {
    expect(
      compareSidebarProjectStatus({ status: "unread", count: 9 }, { status: "working", count: 1 }),
    ).toBeGreaterThan(0);
  });

  it("puts the busier Project first when both report the same status", () => {
    expect(
      compareSidebarProjectStatus({ status: "working", count: 1 }, { status: "working", count: 4 }),
    ).toBeGreaterThan(0);
  });

  it("leaves two Projects reporting the same status and count to the caller's own order", () => {
    expect(
      compareSidebarProjectStatus({ status: "woke", count: 2 }, { status: "woke", count: 2 }),
    ).toBe(0);
  });

  it("sorts a Project with nothing to report after every Project that has something", () => {
    expect(compareSidebarProjectStatus(undefined, { status: "unread", count: 1 })).toBeGreaterThan(
      0,
    );
    expect(compareSidebarProjectStatus({ status: "unread", count: 1 }, undefined)).toBeLessThan(0);
  });

  it("leaves two Projects with nothing to report in the order they came", () => {
    expect(compareSidebarProjectStatus(undefined, undefined)).toBe(0);
  });
});
