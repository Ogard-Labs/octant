import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LinearIssueWorkflow, LinearWorkflowState, LinkedIssueRef } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ThreadLinkedIssueStore } from "./threadLinkedIssueStore";
import { TrackerIssueWrites, type TrackerIssuePort } from "./trackerIssueWrites";

const directories: string[] = [];
const now = "2026-11-26T12:00:00.000Z";
const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actor = { kind: "system" as const, actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-linked-issues-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  return new ThreadLinkedIssueStore({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
    actor: actor as never,
  });
}

const state = (id: string, name: string, type: string, position: number): LinearWorkflowState => ({
  id,
  name,
  type,
  position,
});
const teamStates = [
  state("s-todo", "Todo", "unstarted", 1),
  state("s-progress", "In Progress", "started", 2),
  state("s-review", "In Review", "started", 3),
  state("s-done", "Done", "completed", 4),
];

/** A Linear and GitHub fake that remembers the issue's state; nothing leaves the test. */
function fakePort(initial: { linearState?: string; githubOpen?: boolean } = {}) {
  let linearState = initial.linearState ?? "s-todo";
  let githubOpen = initial.githubOpen ?? true;
  const workflow = (): LinearIssueWorkflow => ({
    id: "lin-1",
    identifier: "ENG-7",
    url: "https://linear.app/acme/issue/ENG-7/x",
    state: teamStates.find((entry) => entry.id === linearState) ?? teamStates[0]!,
    teamStates,
  });
  const port = {
    linearWorkflow: vi.fn(async () => ({ status: "read" as const, value: workflow() })),
    linearSetState: vi.fn(async (_id: string, stateId: string) => {
      linearState = stateId;
      return { status: "applied" as const };
    }),
    linearComment: vi.fn(async () => ({ status: "applied" as const })),
    githubOpen: vi.fn(async () => ({ status: "read" as const, value: githubOpen })),
    githubComment: vi.fn(async () => ({ status: "applied" as const })),
    githubClose: vi.fn(async () => {
      githubOpen = false;
      return { status: "applied" as const };
    }),
  } satisfies TrackerIssuePort;
  return { port, linearState: () => linearState };
}

const linear: LinkedIssueRef = { forge: "linear", identifier: "ENG-7", issueId: "lin-1" };
const github: LinkedIssueRef = { forge: "github", owner: "acme", repository: "app", number: 12 };
const prUrl = "https://github.com/acme/app/pull/9";

describe("TrackerIssueWrites", () => {
  it("with the switch on, a linked Linear issue moves to In Progress, In Review and Done with a comment", async () => {
    const store = openStore();
    store.link(threadId, linear, "created-from");
    const fake = fakePort();
    const writes = new TrackerIssueWrites({ store, port: fake.port });

    await writes.advance(threadId, "in-progress");
    expect(fake.linearState()).toBe("s-progress");
    await writes.advance(threadId, "in-review");
    expect(fake.linearState()).toBe("s-review");
    await writes.advance(threadId, "done", prUrl);
    expect(fake.linearState()).toBe("s-done");
    expect(fake.port.linearComment).toHaveBeenCalledWith("lin-1", `Merged in ${prUrl}.`, undefined);

    // Each moment is written once, and the comment is journaled as a digest only.
    await writes.advance(threadId, "done", prUrl);
    expect(fake.port.linearSetState).toHaveBeenCalledTimes(3);
    expect(fake.port.linearComment).toHaveBeenCalledTimes(1);
    const records = store.writes(threadId);
    expect(records.map((record) => [record.action, record.target, record.outcome])).toEqual([
      ["set-state", "in-progress", "applied"],
      ["set-state", "in-review", "applied"],
      ["set-state", "done", "applied"],
      ["comment", "done", "applied"],
    ]);
    expect(JSON.stringify(records)).not.toContain("Merged in");
    expect(records[3]?.commentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never moves an issue backwards", async () => {
    const store = openStore();
    store.link(threadId, linear, "created-from");
    const fake = fakePort({ linearState: "s-review" });
    const writes = new TrackerIssueWrites({ store, port: fake.port });
    await writes.advance(threadId, "in-progress");
    expect(fake.port.linearSetState).not.toHaveBeenCalled();
    expect(store.writes(threadId)).toMatchObject([
      { action: "set-state", target: "in-progress", outcome: "skipped", reason: "already-there" },
    ]);
  });

  it("a GitHub issue is closed as completed with a comment when the merge is observed, and in-progress and in-review are skipped", async () => {
    const store = openStore();
    store.link(threadId, github, "created-from");
    const fake = fakePort();
    const writes = new TrackerIssueWrites({ store, port: fake.port });
    await writes.advance(threadId, "in-progress");
    await writes.advance(threadId, "in-review");
    expect(fake.port.githubClose).not.toHaveBeenCalled();
    await writes.advance(threadId, "done", prUrl);
    expect(fake.port.githubClose).toHaveBeenCalledOnce();
    expect(fake.port.githubComment).toHaveBeenCalledWith(github, `Merged in ${prUrl}.`, undefined);
    expect(store.writes(threadId).map((record) => [record.action, record.outcome])).toEqual([
      ["close", "skipped"],
      ["close", "skipped"],
      ["close", "applied"],
      ["comment", "applied"],
    ]);
  });

  it("a refused write is recorded once, told to the person once, and retried at the next trigger", async () => {
    const store = openStore();
    store.link(threadId, linear, "created-from");
    const fake = fakePort();
    fake.port.linearSetState.mockResolvedValue({
      status: "refused",
      reason: "missing-scope",
    } as never);
    const writes = new TrackerIssueWrites({ store, port: fake.port });
    const first = await writes.advance(threadId, "in-progress");
    expect(first).toEqual([
      {
        issue: linear,
        message: expect.stringContaining("Reconnect Linear in Settings › Integrations"),
      },
    ]);
    expect(await writes.advance(threadId, "in-progress")).toEqual([]);
    expect(fake.port.linearSetState).toHaveBeenCalledTimes(2);
    expect(store.writes(threadId)).toHaveLength(1);
  });

  it("writes nothing for a thread with no linked issue", async () => {
    const store = openStore();
    const fake = fakePort();
    await new TrackerIssueWrites({ store, port: fake.port }).advance(threadId, "done", prUrl);
    expect(Object.values(fake.port).every((call) => call.mock.calls.length === 0)).toBe(true);
  });
});

describe("ThreadLinkedIssueStore", () => {
  it("links at most ten issues, once each, and unlinks", () => {
    const store = openStore();
    expect(store.link(threadId, linear, "person")).toMatchObject({ status: "linked" });
    expect(store.link(threadId, linear, "person")).toMatchObject({ status: "unchanged" });
    for (let number = 1; number <= 9; number += 1) {
      store.link(threadId, { ...github, number } as LinkedIssueRef, "person");
    }
    expect(store.link(threadId, github, "person")).toEqual({
      status: "refused",
      reason: "too-many",
    });
    expect(store.unlink(threadId, linear)).toMatchObject({ status: "unlinked" });
    expect(store.list(threadId)).toHaveLength(9);
    expect(store.unlink(threadId, linear)).toEqual({ status: "refused", reason: "not-linked" });
  });
});
