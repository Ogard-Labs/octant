import { describe, expect, it } from "vitest";
import {
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
    expect(resolveSidebarThreadStatus(thread())).toBe("idle");
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
    expect(rollUpSidebarProjectStatus([])).toEqual({ status: "idle", count: 0 });
  });

  it("reports nothing for a Project whose threads are all quiet", () => {
    expect(rollUpSidebarProjectStatus([thread(), thread()])).toEqual({ status: "idle", count: 0 });
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
  it("says nothing about a quiet Project", () => {
    expect(describeSidebarProjectStatus("Packaging", { status: "idle", count: 0 })).toBeUndefined();
  });

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
