import type { AgentRunCenterSummary, CodeBoardCard } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { boardFactsByThread, buildWorkingNowRows, remoteHostLabel } from "./workingNow";

function thread(overrides: Partial<ChatThreadNavigationItem>): ChatThreadNavigationItem {
  return { threadId: "thread", title: "Thread", activity: "working", ...overrides };
}

function run(overrides: Record<string, unknown>): AgentRunCenterSummary {
  return {
    runId: "run-1",
    parentThreadId: "thread-1",
    parentThreadTitle: "Wire the board",
    mode: "code",
    role: "reviewer",
    task: "Check the failing test\nthen report",
    lifecycleStatus: "running",
    route: { executionProviderInstanceId: "provider-1" },
    createdAt: "2026-10-06T09:00:00.000Z",
    updatedAt: "2026-10-06T09:05:00.000Z",
    ...overrides,
  } as unknown as AgentRunCenterSummary;
}

const base = {
  modes: ["code"] as const,
  projectNames: new Map([["project-1", "octant"]]),
  providers: new Map([["provider-1", { displayName: "Codex", driverKind: "codex" }]]),
  boardFacts: new Map(),
};

describe("the work in progress a start screen lists", () => {
  it("lists only threads the host projects as executing, newest first, with their Project and provider", () => {
    const rows = buildWorkingNowRows({
      ...base,
      runs: undefined,
      threads: [
        {
          mode: "code",
          thread: thread({
            threadId: "old",
            title: "Older",
            projectId: "project-1",
            providerInstanceId: "provider-1",
            updatedAt: "2026-10-06T08:00:00.000Z",
          }),
        },
        {
          mode: "code",
          thread: thread({
            threadId: "new",
            title: "Newer",
            updatedAt: "2026-10-06T09:30:00.000Z",
          }),
        },
        { mode: "code", thread: thread({ threadId: "idle", activity: "idle" }) },
        { mode: "code", thread: thread({ threadId: "snoozed", shelf: "snoozed" }) },
      ],
    });

    expect(rows.map((row) => row.title)).toEqual(["Newer", "Older"]);
    expect(rows[1]).toMatchObject({
      projectName: "octant",
      provider: { displayName: "Codex", driverKind: "codex" },
      activeAt: "2026-10-06T08:00:00.000Z",
    });
    expect(rows[1]?.step).toBeUndefined();
    expect(rows[1]?.startedAt).toBeUndefined();
  });

  it("states the host's own activity line from the board and leaves a missing one out", () => {
    const facts = boardFactsByThread([
      {
        threadId: "a",
        executing: true,
        childAgents: { latestSummary: "Reading App.tsx" },
        planProgress: { kind: "none" },
        lastMeaningfulActivityAt: "2026-10-06T09:40:00.000Z",
      },
      {
        threadId: "idle",
        executing: false,
        childAgents: {},
        planProgress: { kind: "none" },
        lastMeaningfulActivityAt: null,
      },
      {
        threadId: "b",
        executing: true,
        childAgents: {},
        planProgress: { kind: "none" },
        lastMeaningfulActivityAt: null,
      },
    ] as unknown as ReadonlyArray<CodeBoardCard>);

    const rows = buildWorkingNowRows({
      ...base,
      boardFacts: facts,
      runs: undefined,
      threads: [
        { mode: "code", thread: thread({ threadId: "a", updatedAt: "2026-10-06T07:00:00.000Z" }) },
        { mode: "code", thread: thread({ threadId: "b" }) },
      ],
    });

    expect(rows.find((row) => row.threadId === "a")).toMatchObject({
      step: "Reading App.tsx",
      activeAt: "2026-10-06T09:40:00.000Z",
    });
    expect(rows.find((row) => row.threadId === "b")?.step).toBeUndefined();
    expect(facts.has("idle")).toBe(false);
  });

  it("falls back to how far the plan has come when nothing livelier is known", () => {
    const facts = boardFactsByThread([
      {
        threadId: "a",
        executing: true,
        childAgents: {},
        planProgress: { kind: "present", done: 2, total: 5 },
        lastMeaningfulActivityAt: null,
      },
    ] as unknown as ReadonlyArray<CodeBoardCard>);
    const input = {
      ...base,
      boardFacts: facts,
      threads: [{ mode: "code" as const, thread: thread({ threadId: "a" }) }],
    };
    expect(buildWorkingNowRows({ ...input, runs: undefined })[0]?.step).toBe(
      "Plan: 2 of 5 steps done",
    );
    expect(buildWorkingNowRows({ ...input, runs: [run({ parentThreadId: "a" })] })[0]?.step).toBe(
      "reviewer: Check the failing test",
    );
  });

  it("folds an active agent run into its running thread's step instead of listing it twice", () => {
    const rows = buildWorkingNowRows({
      ...base,
      threads: [
        { mode: "code", thread: thread({ threadId: "thread-1", title: "Wire the board" }) },
      ],
      runs: [run({})],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.step).toBe("reviewer: Check the failing test");
  });

  it("counts several runs on one thread in its step", () => {
    const rows = buildWorkingNowRows({
      ...base,
      threads: [{ mode: "code", thread: thread({ threadId: "thread-1" }) }],
      runs: [
        run({}),
        run({ runId: "run-2", updatedAt: "2026-10-06T09:09:00.000Z", role: "tester" }),
      ],
    });
    expect(rows[0]?.step).toBe("2 agents: tester: Check the failing test");
  });

  it("lists a run whose own thread is resting as a row with how long it has run, opening its child thread", () => {
    const rows = buildWorkingNowRows({
      ...base,
      threads: [{ mode: "code", thread: thread({ threadId: "thread-1", activity: "idle" }) }],
      runs: [run({ childThreadId: "child-1", projectId: "project-1" })],
    });
    expect(rows).toEqual([
      {
        key: "run:run-1",
        mode: "code",
        threadId: "child-1",
        title: "Wire the board",
        projectName: "octant",
        step: "reviewer: Check the failing test",
        startedAt: "2026-10-06T09:00:00.000Z",
        activeAt: "2026-10-06T09:05:00.000Z",
        provider: { displayName: "Codex", driverKind: "codex" },
      },
    ]);
  });

  it("leaves out finished runs and runs from a mode this screen does not speak for", () => {
    const rows = buildWorkingNowRows({
      ...base,
      threads: [],
      runs: [
        run({ runId: "done", lifecycleStatus: "completed" }),
        run({ runId: "chat", mode: "chat" }),
      ],
    });
    expect(rows).toEqual([]);
  });

  it("names the host on every row only when one was given", () => {
    const input = {
      ...base,
      runs: undefined,
      threads: [{ mode: "code" as const, thread: thread({ threadId: "a" }) }],
    };
    expect(buildWorkingNowRows(input)[0]?.host).toBeUndefined();
    expect(buildWorkingNowRows({ ...input, host: "Studio Mac" })[0]?.host).toBe("Studio Mac");
  });
});

describe("naming the host a window reads", () => {
  it("names a host that is not this computer and says nothing on loopback", () => {
    expect(remoteHostLabel("http://127.0.0.1:4100", "Studio")).toBeUndefined();
    expect(remoteHostLabel("http://localhost:4100", "Studio")).toBeUndefined();
    expect(remoteHostLabel("https://studio.example.net", "Studio")).toBe("Studio");
    expect(remoteHostLabel("https://studio.example.net", undefined)).toBeUndefined();
    expect(remoteHostLabel("not a url", "Studio")).toBeUndefined();
  });
});
