import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import {
  groupThreadsByProject,
  orderThreadsByRecency,
  threadsInProject,
} from "./projectThreadGrouping";

const threads: ReadonlyArray<ChatThreadNavigationItem> = [
  { projectId: "project-a", threadId: "thread-a", title: "Planning" },
  { projectId: "project-gone", threadId: "thread-gone", title: "Orphaned" },
  { threadId: "thread-rootless", title: "Loose chat" },
];

describe("groupThreadsByProject", () => {
  it("files a thread whose Project this mode cannot see with the rootless threads", () => {
    const grouping = groupThreadsByProject(threads, [{ id: "project-a" }]);

    expect(grouping.byProjectId.get("project-a")).toEqual([threads[0]]);
    expect(grouping.unfiled).toEqual([threads[1], threads[2]]);
  });

  it("answers for one Project exactly as it groups for many", () => {
    expect(threadsInProject(threads, "project-a")).toEqual([threads[0]]);
    expect(threadsInProject(threads, "project-gone")).toEqual([threads[1]]);
  });
});

describe("orderThreadsByRecency", () => {
  it("puts the newest host-reported update first and keeps untimed threads stable", () => {
    const ordered = orderThreadsByRecency([
      { threadId: "older", title: "Older", updatedAt: "2026-08-10T09:00:00.000Z" },
      { threadId: "untimed-b", title: "Beta" },
      { threadId: "newer", title: "Newer", updatedAt: "2026-08-14T09:00:00.000Z" },
      { threadId: "untimed-a", title: "Alpha" },
    ]);

    expect(ordered.map((thread) => thread.threadId)).toEqual([
      "newer",
      "older",
      "untimed-a",
      "untimed-b",
    ]);
  });
});
