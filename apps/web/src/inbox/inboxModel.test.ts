import { describe, expect, it } from "vitest";
import { decodeProjectId } from "@octant/contracts/projects";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import {
  codeDecision,
  workChildApproval,
  workDecision,
} from "../palette/pendingRequests.test-fixtures";
import { decodePendingRequest } from "@octant/contracts/pending-requests";
import {
  assignedWorkSeenKey,
  buildInboxAttentionItems,
  groupInboxByProject,
  inboxAttentionMeta,
  inboxFilterCounts,
  inboxThreadProjectId,
  inboxWaitingItems,
  matchesInboxFilter,
  type InboxWaitingItem,
} from "./inboxModel";

const signal = (overrides: Partial<ThreadAttentionSignal>): ThreadAttentionSignal => ({
  threadId: "thread-a",
  reason: "question-asked",
  title: "Thread",
  source: "code",
  ...overrides,
});

describe("buildInboxAttentionItems", () => {
  it("lists what needs the person and names the Project, with finished turns last", () => {
    const items = buildInboxAttentionItems(
      [
        signal({ threadId: "t1", reason: "turn-finished", title: "Done turn" }),
        signal({ threadId: "t4", reason: "follow-up-due", title: "Due" }),
        signal({ threadId: "t2", reason: "approval-required", title: "Blocked", projectId: "p1" }),
        signal({ threadId: "t3", reason: "question-asked", title: "Asking" }),
      ],
      new Map([["p1", "Octant"]]),
      "code",
    );
    expect(items.map((item) => item.signal.reason)).toEqual([
      "approval-required",
      "question-asked",
      "follow-up-due",
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
      "Chat thread: Asked a question · Ideas",
      "Code thread: Asked a question · Octant · Code",
      "Work thread: Asked a question · Notes",
    ]);
    expect(meta("code")).toEqual([
      "Chat thread: Asked a question · Ideas · Work",
      "Code thread: Asked a question · Octant",
      "Work thread: Asked a question · Notes · Work",
    ]);
  });

  it("still names the mode of a thread whose Project is not known", () => {
    const [item] = buildInboxAttentionItems([signal({ source: "code" })], new Map(), "work");
    expect(item === undefined ? undefined : inboxAttentionMeta(item)).toBe(
      "Asked a question · Code",
    );
  });
});

describe("inboxThreadProjectId", () => {
  it("decodes the signal Project for cross-Project thread opens", () => {
    const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000802");
    const waitingThread: ThreadAttentionSignal = {
      threadId: "00000000-0000-4000-8000-000000000803",
      reason: "question-asked",
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

const NOW = Date.parse("2026-10-06T08:10:00.000Z");

describe("inbox filters", () => {
  const urgentDecision = decodePendingRequest({ ...workDecision(), urgent: true });
  const waiting = inboxWaitingItems(
    [
      { request: codeDecision(), unlisted: false },
      { request: urgentDecision, unlisted: false },
      { request: workChildApproval(), unlisted: false },
    ],
    buildInboxAttentionItems(
      [
        signal({ threadId: "t1", reason: "approval-required" }),
        signal({ threadId: "t2", reason: "turn-finished" }),
        signal({ threadId: "t3", reason: "follow-up-due" }),
      ],
      new Map(),
      "code",
    ),
    NOW,
  );

  it("counts each chip from the same waiting items, keeping a finished turn out of All", () => {
    expect(inboxFilterCounts(waiting)).toEqual({
      all: 5,
      urgent: 1,
      decide: 2,
      stuck: 2,
      finished: 1,
    });
  });

  it("leaves a due follow-up to All only", () => {
    const followUp = waiting.find(
      (item) => item.kind === "attention" && item.item.signal.reason === "follow-up-due",
    );
    expect(followUp).toBeDefined();
    const matching = (["all", "urgent", "decide", "stuck", "finished"] as const).filter(
      (filter) => followUp !== undefined && matchesInboxFilter(followUp, filter),
    );
    expect(matching).toEqual(["all"]);
  });
});

describe("groupInboxByProject", () => {
  const item = (
    overrides: Partial<Pick<InboxWaitingItem, "projectKey" | "urgent" | "deferred" | "since">> & {
      readonly key: string;
    },
  ): InboxWaitingItem => ({
    projectKey: "p1",
    urgent: false,
    deferred: false,
    since: undefined,
    kind: "attention",
    item: { signal: signal({}) },
    ...overrides,
  });
  const names = new Map([
    ["p1", "Alpha"],
    ["p2", "Beta"],
    ["p3", "Gamma"],
  ]);

  it("leads with a Project holding an urgent wait, then the Project that has waited longest", () => {
    const groups = groupInboxByProject(
      [
        item({ key: "a", projectKey: "p1", since: 3000 }),
        item({ key: "b", projectKey: "p2", since: 2000 }),
        item({ key: "c", projectKey: "p3", since: 5000, urgent: true }),
        item({ key: "d", projectKey: undefined, since: 1000 }),
      ],
      names,
    );
    expect(groups.map((group) => group.name)).toEqual(["Gamma", "No Project", "Beta", "Alpha"]);
    expect(groups[0]?.urgentCount).toBe(1);
  });

  it("files a wait whose Project has no known name under the one No Project group", () => {
    const groups = groupInboxByProject(
      [
        item({ key: "unnamed", projectKey: "p9", since: 1000 }),
        item({ key: "none", projectKey: undefined, since: 2000 }),
      ],
      names,
    );
    expect(groups.map((group) => group.name)).toEqual(["No Project"]);
    expect(groups[0]?.items.map((entry) => entry.key)).toEqual(["unnamed", "none"]);
  });

  it("orders a group urgent first, then oldest first, then deferred", () => {
    const [group] = groupInboxByProject(
      [
        item({ key: "deferred", since: 1000, deferred: true }),
        item({ key: "newer", since: 4000 }),
        item({ key: "older", since: 2000 }),
        item({ key: "urgent", since: 9000, urgent: true }),
      ],
      names,
    );
    expect(group?.items.map((entry) => entry.key)).toEqual([
      "urgent",
      "older",
      "newer",
      "deferred",
    ]);
  });

  it("drops a deferred urgent wait below the active ones and lets it lead no group", () => {
    const groups = groupInboxByProject(
      [
        item({
          key: "deferred-urgent",
          projectKey: "p1",
          since: 5000,
          urgent: true,
          deferred: true,
        }),
        item({ key: "active", projectKey: "p1", since: 3000 }),
        item({ key: "older-project", projectKey: "p2", since: 1000 }),
      ],
      names,
    );
    expect(groups.map((group) => group.name)).toEqual(["Beta", "Alpha"]);
    expect(groups[1]?.items.map((entry) => entry.key)).toEqual(["active", "deferred-urgent"]);
  });
});
