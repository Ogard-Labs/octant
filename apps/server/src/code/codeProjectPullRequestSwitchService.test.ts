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
  } = {},
) {
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
        authorizePullRequest: async () => ({
          status: "authorized",
          linkedThreadIds: options.linked ?? [String(threadId)],
        }),
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
  it("refuses a caller that is not the local user before reaching the forge", async () => {
    const f = fixture();
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "agent",
      signal,
    );
    expect(outcome).toEqual({ status: "refused", reason: "not-authorized" });
    expect(f.forge.readAutoMergeSettings).not.toHaveBeenCalled();
    expect(f.forge.enableAutoMerge).not.toHaveBeenCalled();
    expect(f.recorded(MERGE_WHEN_READY)).toHaveLength(0);
  });

  it("reports a repository without auto-merge as unsupported and never turns it on", async () => {
    const f = fixture({ allowAutoMerge: false });
    const outcome = await f.service.setMergeWhenReady(
      windowId,
      { kind: "enable", target, headSha: "a1" },
      "user",
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
      "user",
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
      "user",
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
      "user",
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
      "user",
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
      "user",
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
