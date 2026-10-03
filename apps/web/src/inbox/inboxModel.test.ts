import { describe, expect, it } from "vitest";
import { decodeProjectId } from "@octant/contracts/projects";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import {
  assignedWorkSeenKey,
  buildInboxAttentionItems,
  inboxAttentionMeta,
  inboxThreadProjectId,
} from "./inboxModel";

const signal = (overrides: Partial<ThreadAttentionSignal>): ThreadAttentionSignal => ({
  threadId: "thread-a",
  reason: "turn-finished",
  title: "Thread",
  source: "code",
  ...overrides,
});

describe("buildInboxAttentionItems", () => {
  it("lists blocked threads before finished ones and names their Project", () => {
    const items = buildInboxAttentionItems(
      [
        signal({ threadId: "t1", reason: "turn-finished", title: "Done turn" }),
        signal({ threadId: "t2", reason: "approval-required", title: "Blocked", projectId: "p1" }),
        signal({ threadId: "t3", reason: "question-asked", title: "Asking" }),
      ],
      new Map([["p1", "Octant"]]),
      "code",
    );
    expect(items.map((item) => item.signal.reason)).toEqual([
      "approval-required",
      "question-asked",
      "turn-finished",
    ]);
    expect(items[0]?.projectName).toBe("Octant");
    expect(items[1]?.projectName).toBeUndefined();
  });

  it("keeps one row per thread-and-reason so a re-render never doubles the list", () => {
    const items = buildInboxAttentionItems(
      [
        signal({ threadId: "t1", reason: "question-asked" }),
        signal({ threadId: "t1", reason: "question-asked" }),
      ],
      new Map(),
      "code",
    );
    expect(items).toHaveLength(1);
  });

  it("says where a thread from the other mode lives, and stays quiet for the current mode", () => {
    const signals = [
      signal({ threadId: "c1", source: "code", projectId: "code-project", title: "Code thread" }),
      signal({ threadId: "w1", source: "work", projectId: "work-project", title: "Work thread" }),
      signal({ threadId: "h1", source: "chat", projectId: "chat-project", title: "Chat thread" }),
    ];
    const projectNames = new Map([
      ["code-project", "Octant"],
      ["work-project", "Notes"],
      ["chat-project", "Ideas"],
    ]);
    const meta = (currentMode: "work" | "code") =>
      buildInboxAttentionItems(signals, projectNames, currentMode).map(
        (item) => `${item.signal.title}: ${inboxAttentionMeta(item)}`,
      );

    expect(meta("work")).toEqual([
      "Chat thread: Finished a turn · Ideas",
      "Code thread: Finished a turn · Octant · Code",
      "Work thread: Finished a turn · Notes",
    ]);
    expect(meta("code")).toEqual([
      "Chat thread: Finished a turn · Ideas · Work",
      "Code thread: Finished a turn · Octant",
      "Work thread: Finished a turn · Notes · Work",
    ]);
  });

  it("still names the mode of a thread whose Project is not known", () => {
    const [item] = buildInboxAttentionItems([signal({ source: "code" })], new Map(), "work");
    expect(item === undefined ? undefined : inboxAttentionMeta(item)).toBe(
      "Finished a turn · Code",
    );
  });
});

describe("inboxThreadProjectId", () => {
  it("decodes the signal Project for cross-Project thread opens", () => {
    const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000802");
    const waitingThread: ThreadAttentionSignal = {
      threadId: "00000000-0000-4000-8000-000000000803",
      reason: "turn-finished",
      title: "Cross-project chat",
      source: "chat",
      projectId: String(otherProjectId),
    };
    expect(inboxThreadProjectId(waitingThread)).toBe(otherProjectId);
    const withoutProject: ThreadAttentionSignal = {
      threadId: waitingThread.threadId,
      reason: waitingThread.reason,
      title: waitingThread.title,
      source: waitingThread.source,
    };
    expect(inboxThreadProjectId(withoutProject)).toBeUndefined();
  });
});

describe("assignedWorkSeenKey", () => {
  it("changes when the item is updated upstream, so it lights up again", () => {
    const item = {
      category: "issue" as const,
      owner: "octant",
      name: "octant",
      number: 7,
      title: "Issue",
      author: "octocat",
      updatedAt: "2026-08-28T10:00:00Z",
      url: "https://github.com/octant/octant/issues/7",
    };
    expect(assignedWorkSeenKey(item)).not.toBe(
      assignedWorkSeenKey({ ...item, updatedAt: "2026-08-29T10:00:00Z" }),
    );
  });
});
