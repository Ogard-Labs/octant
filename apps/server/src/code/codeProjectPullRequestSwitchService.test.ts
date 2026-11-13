import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeProjectPullRequestSwitchTarget,
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
  type PullRequestSwitchForge,
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
    notifyPerson: vi.fn<PullRequestAutoFixThreads["notifyPerson"]>(async () => undefined),
  };
  const create = () =>
    new CodeProjectPullRequestSwitchService({
      authority: {
        authorizePullRequest: async () =>
          authority === "authorized"
            ? { status: "authorized", linkedThreadIds: options.linked ?? [String(threadId)] }
            : { status: authority },
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
