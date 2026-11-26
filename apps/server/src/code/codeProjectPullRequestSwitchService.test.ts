import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeProjectPullRequestSwitchTarget,
  decodeCodeProjectPullRequestView,
  decodeUtcTimestamp,
  decodeWindowId,
  type CodeProjectPullRequestMergeMethod,
} from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  CodeProjectPullRequestSwitchService,
  type PullRequestAutoFixThreads,
  type PullRequestSwitchAuthority,
  type PullRequestSwitchForge,
  type PullRequestSwitchLimits,
} from "./codeProjectPullRequestSwitchService";
import type {
  GhAutoFixFailureDetail,
  GhPullRequestActivity,
  GhPullRequestSwitchObservation,
} from "./ghPullRequestSwitchPort";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const target = decodeCodeProjectPullRequestSwitchTarget({
  projectId: "10000000-0000-4000-8000-000000000001",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
});
const signal = new AbortController().signal;
const lint: GhAutoFixFailureDetail = {
  failure: { kind: "check", key: "lint" },
  detail: "error: unused variable `x`",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function openJournal() {
  const directory = mkdtempSync(join(tmpdir(), "octant-pull-request-switches-"));
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-31T10:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => "2026-10-31T10:00:00.000Z",
  });
  cleanups.push(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return journal;
}

function observed(
  overrides: Partial<Extract<GhPullRequestSwitchObservation, { status: "observed" }>> = {},
): GhPullRequestSwitchObservation {
  return {
    status: "observed",
    state: "open",
    headSha: "a1",
    headBranch: "feature/x",
    baseBranch: "main",
    autoMergeEnabled: true,
    waitingOn: [],
    failures: [],
    ...overrides,
  };
}

function fixture(
  options: {
    readonly journal?: Journal;
    readonly allowAutoMerge?: boolean;
    readonly methods?: Partial<Record<CodeProjectPullRequestMergeMethod, boolean>>;
    readonly linked?: ReadonlyArray<string>;
    readonly authorize?: PullRequestSwitchAuthority["authorizePullRequest"];
    readonly limits?: () => PullRequestSwitchLimits;
    readonly localWindows?: () => ReadonlyArray<typeof windowId>;
    readonly threadPullRequests?: ReadonlyArray<typeof target>;
  } = {},
) {
  let authority: "authorized" | "not-authorized" | "disconnected" = "authorized";
  const journal = options.journal ?? openJournal();
  let now = Date.parse("2026-10-31T10:00:00.000Z");
  let observation: GhPullRequestSwitchObservation = observed();
  let turnActive = false;
  const forge = {
    readAutoMergeSettings: vi.fn<PullRequestSwitchForge["readAutoMergeSettings"]>(async () => ({
      status: "read",
      allowAutoMerge: options.allowAutoMerge ?? true,
      methods: { merge: true, squash: true, rebase: false, ...options.methods },
    })),
    enableAutoMerge: vi.fn<PullRequestSwitchForge["enableAutoMerge"]>(async () => ({
      status: "enabled",
    })),
    disableAutoMerge: vi.fn<PullRequestSwitchForge["disableAutoMerge"]>(async () => ({
      status: "disabled",
    })),
    observe: vi.fn<PullRequestSwitchForge["observe"]>(async () => observation),
    readCiLogs: vi.fn<PullRequestSwitchForge["readCiLogs"]>(async () => ({
      status: "read",
      headSha: "a1",
      logs: [],
      running: [],
    })),
    planCiRerun: vi.fn<PullRequestSwitchForge["planCiRerun"]>(async () => ({
      status: "planned",
      headSha: "a1",
      runs: [{ runId: "7", checks: ["test"] }],
    })),
    rerunCi: vi.fn<PullRequestSwitchForge["rerunCi"]>(async () => ({
      status: "rerun",
      checks: ["test"],
    })),
  };
  const order: string[] = [];
  const threads = {
    inspect: vi.fn<PullRequestAutoFixThreads["inspect"]>(() => ({
      status: "available",
      turnActive,
    })),
    markOutsideContent: vi.fn<PullRequestAutoFixThreads["markOutsideContent"]>(() => {
      order.push("mark");
      return true;
    }),
    startTurn: vi.fn<PullRequestAutoFixThreads["startTurn"]>(async () => {
      order.push("turn");
      return true;
    }),
    readFollowUp: vi.fn<NonNullable<PullRequestAutoFixThreads["readFollowUp"]>>(),
    notifyPerson: vi.fn<PullRequestAutoFixThreads["notifyPerson"]>(async () => undefined),
  };
  const create = () =>
    new CodeProjectPullRequestSwitchService({
      ...(options.limits && { limits: options.limits }),
      ...(options.localWindows ? { localWindows: options.localWindows } : {}),
      authority: {
        authorizePullRequest:
          options.authorize ??
          (async () =>
            authority === "authorized"
              ? { status: "authorized", linkedThreadIds: options.linked ?? [String(threadId)] }
              : { status: authority }),
        linkedPullRequests: async () => options.threadPullRequests ?? [target],
      },
      forge,
      threads,
      journal,
      clock: () => new Date(now).toISOString(),
      uuid: randomUUID,
    });
  return {
    journal,
    forge,
    threads,
    order,
    service: create(),
    restart: create,
    observe: (next: GhPullRequestSwitchObservation) => {
      observation = next;
    },
    setAuthority: (value: "authorized" | "not-authorized" | "disconnected") => {
      authority = value;
    },
    setTurnActive: (value: boolean) => {
      turnActive = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    recorded: (eventName: string) =>
      journal
        .replay({ afterSequence: 0 as never, limit: 1000 })
        .filter((event) => event.eventName === eventName),
  };
}

const MERGE_WHEN_READY = "code.project-pull-request-merge-when-ready-recorded@1";
const AUTO_FIX = "code.project-pull-request-auto-fix-recorded@1";

describe("Babysit from a Code thread", () => {
  it("revalidates a paired owner's session on a headless host and stops on revocation", async () => {
    const f = fixture({ localWindows: () => [] });
    let current = true;
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId, babysit: { checks: "required" } },
      "user",
      undefined,
      () => current,
    );
    await f.service.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
    current = false;
    await f.service.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "authority-lost",
    });
  });
  it("stops a recovered babysitter when its authorizing project is archived", async () => {
    const f = fixture({ localWindows: () => [windowId] });
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId, babysit: { checks: "required" } },
      "user",
    );
    const restored = f.restart();
    await restored.tick(signal);
    f.setAuthority("not-authorized");
    await restored.tick(signal);
    f.setAuthority("authorized");
    await restored.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
    expect((await restored.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "authority-lost",
    });
  });
  it("preserves an active babysitter's rules on a plain Auto-fix enable", async () => {
    const f = fixture();
    const rules = { checks: "all", requiredLabel: "qa" } as const;
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId, babysit: rules },
      "user",
    );
    expect(
      await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user"),
    ).toEqual({ status: "refused", reason: "already-active" });
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({ babysit: rules });
    expect(f.recorded(AUTO_FIX)).toHaveLength(1);
  });
  it("resumes only an enrolled babysitter once the local project connection returns", async () => {
    let windows: ReadonlyArray<typeof windowId> = [];
    const f = fixture({ localWindows: () => windows });
    const other = { ...target, number: 13 };
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId, babysit: { checks: "required" } },
      "user",
    );
    await f.service.setAutoFix(windowId, { kind: "enable", target: other, threadId }, "user");
    const restored = f.restart();
    await restored.tick(signal);
    windows = [windowId];
    f.setAuthority("disconnected");
    await restored.tick(signal);
    expect(f.forge.observe).not.toHaveBeenCalled();
    f.setAuthority("authorized");
    f.observe(observed({ babysitReady: true }));
    await restored.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
    expect(f.threads.notifyPerson).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.stringContaining("a1"),
    );
    expect((await restored.query(windowId, other)).autoFix.status).toBe("on");
  });

  it("skips a stale window and refuses a project connection without the recorded thread link", async () => {
    const stale = decodeWindowId("00000000-0000-4000-8000-000000000902");
    let linked = true;
    const f = fixture({
      localWindows: () => [stale, windowId],
      authorize: async (id) => {
        if (String(id) === String(stale)) throw new Error("window closed");
        return { status: "authorized", linkedThreadIds: linked ? [String(threadId)] : [] };
      },
    });
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId, babysit: { checks: "all" } },
      "user",
    );
    const restored = f.restart();
    linked = false;
    await restored.tick(signal);
    expect(f.forge.observe).not.toHaveBeenCalled();
    linked = true;
    await restored.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
  });

  it("projects blockers and the ready commit onto the linked row without polling GitHub on list reads", async () => {
    const f = fixture();
    const row = {
      ...target,
      projectName: "Octant",
      title: "Change",
      state: "open",
      draft: false,
      author: "dev",
      mergeability: "mergeable",
      baseBranch: "main",
      headBranch: "feature/x",
      updatedAt: "2026-10-31T10:00:00.000Z",
      checks: "pending",
      review: "pending",
      linkedThreads: [{ threadId, title: "Build fixes" }],
    };
    const view = decodeCodeProjectPullRequestView({
      version: 1,
      query: { version: 1 },
      generatedAt: row.updatedAt,
      freshness: { status: "fresh" },
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      projects: [],
      rows: [row, { ...row, number: 13 }],
    });
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId, babysit: { checks: "required", requiredLabel: "qa" } },
      "user",
    );
    f.observe(observed({ babysitBlocker: "label" }));
    await f.service.tick(signal);
    const rows = f.service.withBabysitProgress(view).rows;
    expect(rows[0]?.babysit).toEqual({
      threadId,
      status: "label",
      requiredLabel: "qa",
      checks: "required",
      feedbackTurns: 0,
      feedbackLimit: 10,
    });
    expect(rows[1]?.babysit).toBeUndefined();
    const unlinked = { ...view, rows: view.rows.map((r) => ({ ...r, linkedThreads: [] })) };
    expect(f.service.withBabysitProgress(unlinked).rows[0]?.babysit).toBeUndefined();
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
    f.observe(observed({ babysitReady: true }));
    await f.service.tick(signal);
    expect(f.restart().withBabysitProgress(view).rows[0]?.babysit).toMatchObject({
      status: "ready",
      readyHeadSha: "a1",
    });
  });

  it("returns an idempotent result for a repeated bulk start and preserves different existing rules", async () => {
    const f = fixture();
    const command = {
      kind: "enable",
      target,
      threadId,
      babysit: { checks: "all", requiredLabel: "qa" },
    } as const;
    expect(await f.service.setAutoFix(windowId, command, "user")).not.toHaveProperty(
      "alreadyActive",
    );
    expect(await f.service.setAutoFix(windowId, command, "user")).toMatchObject({
      status: "applied",
      alreadyActive: true,
    });
    expect(
      await f.service.setAutoFix(windowId, { ...command, babysit: { checks: "required" } }, "user"),
    ).toEqual({ status: "refused", reason: "already-active" });
    expect(f.recorded(AUTO_FIX)).toHaveLength(1);
  });

  it("keeps independent watches for two PRs owned by the same thread after replay", async () => {
    const second = { ...target, number: 13 };
    const f = fixture({ threadPullRequests: [target, second] });
    const firstRules = { checks: "required" } as const;
    const secondRules = { checks: "all", requiredLabel: "QA" } as const;
    for (const [pr, rules] of [
      [target, firstRules],
      [second, secondRules],
    ] as const) {
      await f.service.setAutoFix(
        windowId,
        { kind: "enable", threadId, target: pr, babysit: rules },
        "user",
      );
    }
    const restored = f.restart();
    expect((await restored.query(windowId, target)).autoFix).toMatchObject({
      status: "on",
      babysit: firstRules,
    });
    expect((await restored.query(windowId, second)).autoFix).toMatchObject({
      status: "on",
      babysit: secondRules,
    });
    await restored.setAutoFix(windowId, { kind: "disable", threadId, target }, "user");
    expect((await restored.query(windowId, second)).autoFix).toMatchObject({
      status: "on",
      threadId,
      babysit: secondRules,
    });
  });

  it("keeps every unacknowledged ready PR in the thread, including matching numbers in different repositories", async () => {
    const f = fixture();
    let followUp: ReturnType<typeof f.threads.readFollowUp>;
    f.threads.readFollowUp.mockImplementation(() => followUp);
    f.threads.notifyPerson.mockImplementation(async (_thread, reason) => {
      followUp = { state: "open", origin: "automatic", reason };
    });
    const enable = async (repositoryName: string) =>
      f.service.setAutoFix(
        windowId,
        {
          kind: "enable",
          threadId,
          target: decodeCodeProjectPullRequestSwitchTarget({ ...target, repositoryName }),
          babysit: { checks: "all" },
        },
        "user",
      );
    await enable("first");
    await enable("second");
    f.observe(observed({ babysitReady: true, headSha: "aaaa" }));
    await f.service.tick(signal);
    expect(followUp?.reason).toContain("octant/first#12 ready to merge at aaaa");
    expect(followUp?.reason).toContain("octant/second#12 ready to merge at aaaa");
    await enable("first");
    f.observe(observed({ babysitReady: true, headSha: "bbbb" }));
    await f.service.tick(signal);
    expect(followUp?.reason).not.toContain("first#12 ready to merge at aaaa");
    expect(followUp?.reason).toContain("first#12 ready to merge at bbbb");
    followUp = { state: "completed", origin: "automatic", reason: followUp!.reason };
    await enable("third");
    await f.service.tick(signal);
    expect(followUp?.reason).toContain("third#12");
    expect(followUp?.reason).not.toContain("second#12");
  });

  it("notifies once when the thread finishes without clearing its same-head failure", async () => {
    const f = fixture();
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", threadId, target, babysit: { checks: "required" } },
      "user",
    );
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    f.setTurnActive(true);
    await f.service.tick(signal);
    expect(f.threads.notifyPerson).not.toHaveBeenCalled();
    f.setTurnActive(false);
    await f.service.tick(signal);
    expect(f.threads.notifyPerson).not.toHaveBeenCalled();
    await f.service.tick(signal);
    await f.restart().tick(signal);
    expect(f.threads.notifyPerson).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.stringContaining("unresolved failures"),
    );
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "needs-help",
    });
  });

  it("keeps watching through a stale head and resumes only the stopped enrollment the person saw", async () => {
    const f = fixture();
    const rules = { checks: "all", requiredLabel: "qa" } as const;
    const enable = { kind: "enable", threadId, target, babysit: rules } as const;
    await f.service.setAutoFix(windowId, enable, "user");
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    await f.service.tick(signal);
    expect(f.threads.notifyPerson).not.toHaveBeenCalled();
    const head = "b".repeat(40);
    f.observe(observed({ headSha: head, babysitReady: true }));
    await f.service.tick(signal);
    expect(f.threads.notifyPerson).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.stringContaining(head),
    );
    const restored = f.restart();
    const stopped = (await restored.query(windowId, target)).autoFix;
    expect(stopped).toMatchObject({
      status: "stopped",
      reason: "ready",
      readyHeadSha: head,
      babysit: rules,
    });
    if (stopped.status !== "stopped") throw new Error("Watch should be ready");
    expect(
      await restored.setAutoFix(
        windowId,
        { ...enable, expectedStoppedAt: decodeUtcTimestamp("2025-01-01T00:00:00.000Z") },
        "user",
      ),
    ).toEqual({ status: "refused", reason: "stale" });
    const command = { ...enable, expectedStoppedAt: stopped.stoppedAt };
    expect(await restored.setAutoFix(windowId, command, "user")).toMatchObject({
      status: "applied",
      view: { autoFix: { status: "on", babysit: rules } },
    });
    expect(await restored.setAutoFix(windowId, command, "user")).toEqual({
      status: "refused",
      reason: "stale",
    });
  });

  it("hands back fresh feedback after the configured budget survives restart", async () => {
    const f = fixture({ limits: () => ({ watchWakes: 1, watchDays: 3, autoFixAttempts: 3 }) });
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", threadId, target, babysit: { checks: "required" } },
      "user",
    );
    const feedback = (id: string) =>
      observed({
        activity: {
          checks: "passed",
          failedChecks: [],
          conflicting: false,
          reviews: [],
          comments: [
            {
              author: "bot",
              trustedFeedback: true,
              id,
              at: "2026-10-31T10:00:10Z",
              body: "Review this change.",
            },
          ],
        },
      });
    const outside = observed({
      activity: {
        checks: "passed",
        failedChecks: [],
        conflicting: false,
        reviews: [],
        comments: [
          { author: "passerby", id: "outside", at: "2026-10-31T10:00:10Z", body: "Try my idea." },
        ],
      },
    });
    f.observe(outside);
    await f.service.tick(signal);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    f.observe(feedback("first"));
    await f.service.tick(signal);
    const restored = f.restart();
    await restored.query(windowId, target);
    f.observe(feedback("second"));
    await restored.tick(signal);
    await restored.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);
    expect(f.threads.notifyPerson).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.stringContaining("feedback turn limit"),
    );
    expect((await restored.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "feedback-limit",
    });
  });

  it("requires fresh paired authority on reconnect and checks it again before acting on a forge read", async () => {
    const f = fixture({ localWindows: () => [] });
    let current = true;
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", threadId, target, babysit: { checks: "required" } },
      "user",
      undefined,
      () => current,
    );
    const restored = f.restart();
    await restored.query(windowId, target);
    await restored.tick(signal);
    expect(f.forge.observe).not.toHaveBeenCalled();
    await restored.query(windowId, target, () => current);
    f.forge.observe.mockImplementationOnce(async () => {
      current = false;
      return observed({ failures: [lint] });
    });
    await restored.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    expect((await restored.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "authority-lost",
    });
  });

  it("triages new bot comments once before handing back a green head", async () => {
    const f = fixture();
    await f.service.setAutoFix(
      windowId,
      { kind: "enable", threadId, target, babysit: { checks: "required" } },
      "user",
    );
    const activity: GhPullRequestActivity = {
      checks: "passed",
      failedChecks: [],
      conflicting: false,
      reviews: [],
      comments: [
        {
          author: "ci-bot",
          trustedFeedback: true,
          id: "comment-5",
          at: "2026-10-31T10:00:10Z",
          body: "Review the cache key.",
        },
      ],
    };
    f.observe(observed({ activity, babysitReady: true }));
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.stringContaining("Review the cache key."),
    );
    expect(f.threads.notifyPerson).not.toHaveBeenCalled();
    const restored = f.restart();
    await restored.query(windowId, target);
    await restored.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);
    expect((await restored.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      readyHeadSha: "a1",
    });
  });

  it("restores the chosen rules and reports the ready head once without merging", async () => {
    const f = fixture();
    const babysit = { checks: "all", requiredLabel: "qa-approved" } as const;
    await f.service.setAutoFix(windowId, { kind: "enable", threadId, target, babysit }, "user");
    const restarted = f.restart();
    expect((await restarted.query(windowId, target)).autoFix).toMatchObject({ babysit });
    await restarted.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledWith(expect.anything(), signal, {
      failures: true,
      activity: false,
      babysit,
    });
    expect(f.threads.notifyPerson).not.toHaveBeenCalled();
    f.observe(observed({ babysitReady: true }));
    await restarted.tick(signal);
    await restarted.tick(signal);
    expect((await restarted.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "ready",
      readyHeadSha: "a1",
    });
    expect(f.threads.notifyPerson).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.stringContaining("a1"),
    );
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    expect(f.forge.enableAutoMerge).not.toHaveBeenCalled();
  });
});

describe("Merge when ready", () => {
  it("refuses a paired device that did not confirm the head before reaching the forge", async () => {
    const f = fixture();
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "remote-device",
      signal,
    );
    expect(outcome).toEqual({ status: "refused", reason: "not-authorized" });
    expect(f.forge.readAutoMergeSettings).not.toHaveBeenCalled();
    expect(f.forge.enableAutoMerge).not.toHaveBeenCalled();
    expect(f.recorded(MERGE_WHEN_READY)).toHaveLength(0);
  });

  it("turns auto-merge on for a paired device that confirmed the head, and journals the device", async () => {
    const f = fixture();
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1", confirmed: true },
      "remote-device",
      signal,
    );
    expect(outcome.status).toBe("applied");
    expect(f.forge.enableAutoMerge).toHaveBeenCalledWith(
      expect.objectContaining({ number: 12, headSha: "a1" }),
      signal,
    );
    const [event] = f.recorded(MERGE_WHEN_READY);
    expect(event?.payload).toMatchObject({
      change: { kind: "enabled", headSha: "a1", caller: "remote-device" },
    });
  });

  it("journals both switches a device the host's own person paired sets with the device as actor, and a local window's as the local user", async () => {
    const deviceId = "71000000-0000-4000-8000-0000000000d2";
    const device = { kind: "remote-device", actorId: deviceId, deviceId } as never;
    const switchedBy = async (actor?: never) => {
      const f = fixture();
      // The route judges such a device as a local window and passes its actor.
      await f.service.setMergeWhenReady(
        windowId,
        { kind: "enable", target, headSha: "a1" },
        "local-window",
        signal,
        actor,
      );
      await f.service.setMergeWhenReady(
        windowId,
        { kind: "disable", target },
        "local-window",
        signal,
        actor,
      );
      await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user", actor);
      await f.service.setAutoFix(windowId, { kind: "disable", target }, "user", actor);
      return [...f.recorded(MERGE_WHEN_READY), ...f.recorded(AUTO_FIX)].map((event) => event.actor);
    };

    expect(await switchedBy(device)).toEqual([device, device, device, device]);
    expect((await switchedBy()).map((actor) => actor.kind)).toEqual([
      "local-user",
      "local-user",
      "local-user",
      "local-user",
    ]);
  });

  it("lets a paired device turn auto-merge off without a confirmation", async () => {
    const f = fixture();
    await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "local-window",
      signal,
    );
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "disable", target },
      "remote-device",
      signal,
    );
    expect(outcome.status).toBe("applied");
  });

  it("reports a repository without auto-merge as unsupported and never turns it on", async () => {
    const f = fixture({ allowAutoMerge: false });
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "local-window",
      signal,
    );
    expect(outcome).toEqual({ status: "unsupported", reason: "auto-merge-not-allowed" });
    expect(f.forge.enableAutoMerge).not.toHaveBeenCalled();
    expect(f.recorded(MERGE_WHEN_READY)).toHaveLength(0);
  });

  it("turns on the forge's auto-merge with an allowed method pinned to the seen head", async () => {
    const f = fixture({ methods: { squash: false } });
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "local-window",
      signal,
    );
    expect(outcome.status).toBe("applied");
    expect(f.forge.enableAutoMerge).toHaveBeenCalledWith(
      { owner: "octant", name: "octant", number: 12, method: "merge", headSha: "a1" },
      signal,
    );
    const [event] = f.recorded(MERGE_WHEN_READY);
    expect(event?.actor.kind).toBe("local-user");
    expect(event?.payload).toMatchObject({
      change: { kind: "enabled", method: "merge", headSha: "a1" },
    });
  });

  it("refuses a method the repository does not allow", async () => {
    const f = fixture({ methods: { rebase: false } });
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1", method: "rebase" },
      "local-window",
      signal,
    );
    expect(outcome).toEqual({ status: "refused", reason: "method-not-allowed" });
    expect(f.forge.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("records a merge the forge made and an auto-merge the forge dropped", async () => {
    const f = fixture();
    await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "local-window",
      signal,
    );
    f.observe(observed({ waitingOn: ["checks"] }));
    await f.service.tick(signal);
    const waiting = await f.service.query(windowId, target);
    expect(waiting.mergeWhenReady).toMatchObject({ status: "on", waitingOn: ["checks"] });

    f.observe(observed({ state: "merged" }));
    await f.service.tick(signal);
    expect((await f.service.query(windowId, target)).mergeWhenReady.status).toBe("merged");

    await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "local-window",
      signal,
    );
    f.observe(observed({ autoMergeEnabled: false }));
    await f.service.tick(signal);
    expect((await f.service.query(windowId, target)).mergeWhenReady.status).toBe(
      "turned-off-by-forge",
    );
    expect(f.recorded(MERGE_WHEN_READY).map((event) => event.actor.kind)).toEqual([
      "local-user",
      "system",
      "local-user",
      "system",
    ]);
  });
});

describe("Auto-fix", () => {
  it("refuses a caller that is not the local user", async () => {
    const f = fixture();
    const outcome = await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId },
      "agent",
    );
    expect(outcome).toEqual({ status: "refused", reason: "not-authorized" });
    expect(f.recorded(AUTO_FIX)).toHaveLength(0);
  });

  it("refuses a thread that is not linked to the pull request", async () => {
    const f = fixture({ linked: [] });
    const outcome = await f.service.setAutoFix(
      windowId,
      { kind: "enable", target, threadId },
      "user",
    );
    expect(outcome).toEqual({ status: "refused", reason: "thread-not-linked" });
  });

  it("wakes the thread once per new failure, marking the forge text as outside content first", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    await f.service.tick(signal);

    expect(f.order).toEqual(["mark", "turn"]);
    const text = f.threads.startTurn.mock.calls[0]?.[1] ?? "";
    expect(text).toContain("Never force-push");
    expect(text).toContain("merge it into the branch; do not rebase");
    expect(text).toContain("--- outside content begins ---\nFailed required check: lint");
    expect(text).toContain("error: unused variable `x`");
    const wakes = f
      .recorded(AUTO_FIX)
      .filter((event) => (event.payload as { change: { kind: string } }).change.kind === "woke");
    expect(wakes).toHaveLength(1);
    expect(JSON.stringify(wakes[0]?.payload)).not.toContain("unused variable");
  });

  it("sends nothing when the outside-content mark is refused", async () => {
    const f = fixture();
    f.threads.markOutsideContent.mockReturnValue(false);
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      status: "on",
      lastWake: { result: "unmarked" },
    });
  });

  it("stops without waking when the Project no longer connects the pull request's repository", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    f.setAuthority("not-authorized");
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    expect(f.forge.observe).not.toHaveBeenCalled();
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    expect(f.recorded(AUTO_FIX).at(-1)?.payload).toMatchObject({
      change: { kind: "stopped", reason: "authority-lost" },
    });
    f.setAuthority("authorized");
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "authority-lost",
    });
  });

  it("holds Auto-fix quiet while GitHub access is revoked, then resumes", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    f.setAuthority("disconnected");
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    f.setAuthority("authorized");
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);
  });

  it("does not wake after a restart until a window shows the pull request again", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    const restarted = f.restart();
    f.observe(observed({ failures: [lint] }));
    await restarted.tick(signal);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    await restarted.query(windowId, target);
    await restarted.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);
  });

  it("tries a refused wake again on the next pass without journaling the same refusal twice", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    f.threads.startTurn.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(2);
    const wakes = () =>
      f
        .recorded(AUTO_FIX)
        .filter((event) => (event.payload as { change: { kind: string } }).change.kind === "woke");
    expect(wakes()).toHaveLength(1);
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(3);
    expect(wakes()).toHaveLength(2);
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      lastWake: { result: "started", attempt: 1 },
    });
  });

  it("stops and tells the person after three attempts on the same failure", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    for (const head of ["a1", "a2", "a3", "a4"]) {
      f.observe(observed({ headSha: head, failures: [lint] }));
      await f.service.tick(signal);
    }
    expect(f.threads.startTurn).toHaveBeenCalledTimes(3);
    expect(f.threads.notifyPerson).toHaveBeenCalledTimes(1);
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "attempt-limit",
    });
    f.observe(observed({ headSha: "a5", failures: [lint] }));
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(3);
  });

  it("holds the wake while the person types or a turn runs, then wakes", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    f.observe(observed({ failures: [lint] }));

    f.service.noteComposerActivity(threadId);
    await f.service.tick(signal);
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      pausedFor: "person-typing",
    });

    f.advance(61_000);
    f.setTurnActive(true);
    await f.service.tick(signal);
    expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
      pausedFor: "turn-active",
    });
    expect(f.threads.startTurn).not.toHaveBeenCalled();

    f.setTurnActive(false);
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);
  });

  it("stops when the pull request is merged or closed", async () => {
    for (const state of ["merged", "closed"] as const) {
      const f = fixture();
      await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
      f.observe(observed({ state, failures: [] }));
      await f.service.tick(signal);
      expect((await f.service.query(windowId, target)).autoFix).toMatchObject({
        status: "stopped",
        reason: state,
      });
      expect(f.threads.startTurn).not.toHaveBeenCalled();
    }
  });

  it("does not wake after the person turns it off", async () => {
    const f = fixture();
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    await f.service.setAutoFix(windowId, { kind: "disable", target }, "user");
    f.observe(observed({ failures: [lint] }));
    await f.service.tick(signal);
    expect(f.forge.observe).not.toHaveBeenCalled();
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    expect(f.service.watching).toBe(false);
  });

  it("rebuilds both switches and the attempt count from the journal after a restart", async () => {
    const f = fixture();
    await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "local-window",
      signal,
    );
    await f.service.setAutoFix(windowId, { kind: "enable", target, threadId }, "user");
    for (const head of ["a1", "a2"]) {
      f.observe(observed({ headSha: head, failures: [lint] }));
      await f.service.tick(signal);
    }
    const restarted = f.restart();
    const view = await restarted.query(windowId, target);
    expect(view.mergeWhenReady.status).toBe("on");
    expect(view.autoFix).toMatchObject({ status: "on", lastWake: { attempt: 2 } });

    f.observe(observed({ headSha: "a3", failures: [lint] }));
    await restarted.tick(signal);
    f.observe(observed({ headSha: "a4", failures: [lint] }));
    await restarted.tick(signal);
    expect((await restarted.query(windowId, target)).autoFix).toMatchObject({
      status: "stopped",
      reason: "attempt-limit",
    });
  });
});

describe("a thread watching its own pull request", () => {
  const WATCH = "code.project-pull-request-watch-recorded@1";
  const providerInstanceId = "60000000-0000-4000-8000-000000000001";

  function activity(
    overrides: Partial<GhPullRequestActivity> = {},
    observation: Partial<Extract<GhPullRequestSwitchObservation, { status: "observed" }>> = {},
  ): GhPullRequestSwitchObservation {
    return observed({
      autoMergeEnabled: false,
      ...observation,
      activity: {
        checks: "pending",
        failedChecks: [],
        conflicting: false,
        reviews: [],
        comments: [],
        ...overrides,
      },
    });
  }

  async function watching(f: ReturnType<typeof fixture>) {
    const outcome = await f.service.watch({ windowId, threadId, providerInstanceId, signal });
    return { outcome };
  }

  it("watches without asking anyone, journaled as the thread's agent with what was already true", async () => {
    const f = fixture();
    f.observe(activity({ checks: "passed", reviewDecision: "review-required" }));
    const { outcome } = await watching(f);
    expect(outcome).toMatchObject({ status: "watching", target, alreadyWatching: false });
    const [event] = f.recorded(WATCH);
    expect(event?.actor).toMatchObject({ kind: "agent", providerInstanceId, threadId });
    expect(event?.payload).toEqual({
      target,
      threadId,
      change: {
        kind: "enabled",
        baseline: [
          { kind: "checks-passed", key: "a1" },
          { kind: "review-decision", key: "review-required" },
        ],
      },
    });
    await f.service.tick(signal);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
  });

  it("journals nothing and reads no forge without a linked pull request", async () => {
    const unlinked = fixture({ threadPullRequests: [] });
    const { outcome } = await watching(unlinked);
    expect(outcome).toEqual({ status: "refused", reason: "no-pull-request" });
    expect(unlinked.recorded(WATCH)).toHaveLength(0);
    expect(unlinked.forge.observe).not.toHaveBeenCalled();
  });

  it("wakes the thread once when checks settle, with the forge's text as outside content", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    f.observe(activity({ checks: "failed", failedChecks: ["lint"] }));
    await f.service.tick(signal);
    await f.service.tick(signal);
    expect(f.order).toEqual(["mark", "turn"]);
    expect(f.threads.markOutsideContent).toHaveBeenCalledWith(
      threadId,
      expect.stringMatching(/^pull-request-watch:/),
      "pull-request-watch",
    );
    const text = f.threads.startTurn.mock.calls[0]?.[1] ?? "";
    expect(text).toContain("pull request #12");
    expect(text).toContain("--- outside content begins ---");
    expect(text.indexOf("lint")).toBeGreaterThan(text.indexOf("--- outside content begins ---"));
    expect(text).not.toMatch(/fix it/i);
    expect(f.recorded(WATCH).at(-1)?.payload).toMatchObject({
      change: {
        kind: "woke",
        headSha: "a1",
        signals: [{ kind: "checks-failed", key: "a1" }],
        wake: 1,
        result: "started",
      },
    });
    expect(f.forge.observe).toHaveBeenLastCalledWith(expect.anything(), signal, {
      failures: false,
      activity: true,
    });
  });

  it("puts a new review and a new comment from one pass into a single turn", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    f.advance(60_000);
    f.observe(
      activity({
        reviewDecision: "changes-requested",
        reviews: [
          {
            id: "PRR_1",
            author: "rev",
            state: "changes requested",
            at: "2026-10-31T10:00:30.000Z",
            body: "Rename this.",
          },
        ],
        comments: [
          { id: "IC_1", author: "teammate", at: "2026-10-31T10:00:40.000Z", body: "Ping." },
        ],
      }),
    );
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);
    const text = f.threads.startTurn.mock.calls[0]?.[1] ?? "";
    expect(text).toContain("Rename this.");
    expect(text).toContain("Ping.");
    expect(f.recorded(WATCH).at(-1)?.payload).toMatchObject({
      change: {
        kind: "woke",
        signals: [
          { kind: "review-decision", key: "changes-requested" },
          { kind: "review", key: "PRR_1" },
          { kind: "comment", key: "IC_1" },
        ],
      },
    });
  });

  it("holds the wake while a turn runs in the thread, then wakes", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    f.observe(activity({ checks: "passed" }));
    f.setTurnActive(true);
    await f.service.tick(signal);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    f.setTurnActive(false);
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);
  });

  it("ends without waking when the pull request merges", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    f.observe(activity({ checks: "passed" }, { state: "merged" }));
    await f.service.tick(signal);
    expect(f.threads.startTurn).not.toHaveBeenCalled();
    expect(f.recorded(WATCH).at(-1)?.payload).toMatchObject({
      change: { kind: "stopped", reason: "merged" },
    });
    expect(f.service.watching).toBe(false);
  });

  it("ends after ten wakes and tells the person", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    for (let index = 0; index < 11; index += 1) {
      f.observe(activity({ checks: "failed" }, { headSha: `h${index}` }));
      await f.service.tick(signal);
    }
    expect(f.threads.startTurn).toHaveBeenCalledTimes(10);
    expect(f.recorded(WATCH).at(-1)?.payload).toMatchObject({
      change: { kind: "stopped", reason: "wake-limit" },
    });
    expect(f.threads.notifyPerson).toHaveBeenCalledWith(threadId, expect.stringContaining("10"));
  });

  it("ends three days after it began, even while no window vouches for it after a restart", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    const restarted = f.restart();
    f.advance(3 * 24 * 60 * 60 * 1000);
    await restarted.tick(signal);
    expect(f.forge.observe).toHaveBeenCalledTimes(1);
    expect(f.recorded(WATCH).at(-1)?.payload).toMatchObject({
      change: { kind: "stopped", reason: "expired" },
    });
  });

  it("stays quiet after a restart until a window shows the pull request, and never repeats a wake", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    f.observe(activity({ checks: "failed" }));
    await f.service.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);

    const restarted = f.restart();
    f.observe(activity({ checks: "failed", conflicting: true }));
    await restarted.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(1);

    await restarted.query(windowId, target);
    await restarted.tick(signal);
    expect(f.threads.startTurn).toHaveBeenCalledTimes(2);
    expect(f.recorded(WATCH).at(-1)?.payload).toMatchObject({
      change: { kind: "woke", signals: [{ kind: "conflict", key: "a1" }], wake: 2 },
    });
  });

  it("stops when the thread's agent unwatches, without asking, and says so when nothing was watched", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    expect(await f.service.unwatch({ threadId, providerInstanceId })).toEqual({
      status: "unwatched",
      target,
    });
    expect(f.recorded(WATCH).at(-1)?.payload).toMatchObject({ change: { kind: "disabled" } });
    expect(f.service.watching).toBe(false);
    expect(await f.service.unwatch({ threadId, providerInstanceId })).toEqual({
      status: "not-watching",
    });
  });

  it("answers a second watch of the same pull request without journaling it again", async () => {
    const f = fixture();
    f.observe(activity());
    await watching(f);
    const { outcome } = await watching(f);
    expect(outcome).toMatchObject({ status: "watching", alreadyWatching: true });
    expect(f.recorded(WATCH)).toHaveLength(1);
  });

  it("keeps the first of two linked threads asking at once as the watcher, and refuses the second", async () => {
    const otherThreadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000002");
    const f = fixture({ linked: [String(threadId), String(otherThreadId)] });
    const reads: Array<(observation: GhPullRequestSwitchObservation) => void> = [];
    f.forge.observe.mockImplementation(
      () => new Promise<GhPullRequestSwitchObservation>((resolve) => reads.push(resolve)),
    );
    const first = f.service.watch({ windowId, threadId, providerInstanceId, signal });
    const second = f.service.watch({
      windowId,
      threadId: otherThreadId,
      providerInstanceId,
      signal,
    });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[0]?.(activity());
    expect(await first).toMatchObject({ status: "watching", alreadyWatching: false });
    reads[1]?.(activity());
    expect(await second).toEqual({ status: "refused", reason: "watched-by-another-thread" });
    expect(f.recorded(WATCH)).toHaveLength(1);
    expect(await f.service.unwatch({ threadId, providerInstanceId })).toEqual({
      status: "unwatched",
      target,
    });
  });
});

describe("CI logs and reruns for the thread's own pull request", () => {
  it("reads and reruns only the thread's own linked pull request", async () => {
    const notLinked = fixture({ linked: ["10000000-0000-4000-8000-0000000000ff"] });
    expect(await notLinked.service.ciLogs({ windowId, threadId, tailLines: 200, signal })).toEqual({
      status: "refused",
      reason: "no-pull-request",
    });
    expect(await notLinked.service.ciRerun({ windowId, threadId, signal })).toEqual({
      status: "refused",
      reason: "no-pull-request",
    });
    expect(notLinked.forge.readCiLogs).not.toHaveBeenCalled();
    expect(notLinked.forge.planCiRerun).not.toHaveBeenCalled();

    const two = fixture({ threadPullRequests: [target, { ...target, number: target.number + 1 }] });
    expect(await two.service.ciRerun({ windowId, threadId, signal })).toEqual({
      status: "refused",
      reason: "ambiguous-pull-request",
    });
  });

  it("asks about exactly the planned checks and reruns nothing when the person declines", async () => {
    const f = fixture();
    const confirm = vi.fn(async () => "denied" as const);
    expect(await f.service.ciRerun({ windowId, threadId, confirm, signal })).toEqual({
      status: "not-confirmed",
      answer: "denied",
    });
    expect(confirm).toHaveBeenCalledWith({
      number: target.number,
      headSha: "a1",
      checks: ["test"],
    });
    expect(f.forge.planCiRerun).toHaveBeenCalledWith(expect.anything(), { maxReruns: 3 }, signal);
    expect(f.forge.rerunCi).not.toHaveBeenCalled();

    expect(await f.service.ciRerun({ windowId, threadId, signal })).toMatchObject({
      status: "rerun",
      headSha: "a1",
      checks: ["test"],
    });
  });
});
