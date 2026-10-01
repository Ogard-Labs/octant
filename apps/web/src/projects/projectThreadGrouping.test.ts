import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import {
  groupThreadsByCheckout,
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
  it("files a thread whose Project this mode cannot see with the unfiled threads", () => {
    const grouping = groupThreadsByProject(threads, [{ id: "project-a" }]);

    expect(grouping.byProjectId.get("project-a")).toEqual([threads[0]]);
    expect(grouping.unfiled).toEqual([threads[1], threads[2]]);
  });

  it("answers for one Project exactly as it groups for many", () => {
    expect(threadsInProject(threads, "project-a")).toEqual([threads[0]]);
    expect(threadsInProject(threads, "project-gone")).toEqual([threads[1]]);
  });
});

describe("groupThreadsByCheckout", () => {
  const onMain = { checkoutKind: "existing-worktree", label: "main" } as const;
  const onFeature = { checkoutKind: "managed-worktree", label: "feature/lexer" } as const;

  it("splits nothing while every thread runs in one checkout", () => {
    expect(
      groupThreadsByCheckout([
        { threadId: "a", title: "A", checkoutChip: onMain },
        { threadId: "b", title: "B", checkoutChip: onMain },
      ]),
    ).toBeUndefined();
    expect(groupThreadsByCheckout([{ threadId: "a", title: "A" }])).toBeUndefined();
  });

  it("groups threads by checkout once there are two, with primary checkouts first", () => {
    const groups = groupThreadsByCheckout([
      { threadId: "a", title: "A", checkoutChip: onFeature },
      { threadId: "b", title: "B", checkoutChip: onMain },
      { threadId: "c", title: "C", checkoutChip: onFeature },
    ]);

    expect(
      groups?.map((group) => [group.kind, group.branch, group.threads.map((t) => t.threadId)]),
    ).toEqual([
      ["primary", "main", ["b"]],
      ["worktree", "feature/lexer", ["a", "c"]],
    ]);
  });

  it("names no branch for a thread the host reported no checkout for", () => {
    const groups = groupThreadsByCheckout([
      { threadId: "a", title: "A" },
      { threadId: "b", title: "B", checkoutChip: onFeature },
    ]);

    expect(groups?.[0]).toMatchObject({ kind: "primary", threads: [{ threadId: "a" }] });
    expect(groups?.[0]?.branch).toBeUndefined();
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
