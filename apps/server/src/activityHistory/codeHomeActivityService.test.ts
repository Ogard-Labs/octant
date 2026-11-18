import { describe, expect, it } from "vitest";
import { decodeUtcTimestamp, type WindowId } from "@octant/contracts";
import type { ActivityQuery } from "@octant/contracts/code-home-activity";
import type { ActivityFact } from "../persistence/activityHistoryProjection";
import {
  CodeHomeActivityService,
  type CodeHomeActivityForgeRecord,
  type CodeHomeActivityForgeResult,
} from "./codeHomeActivityService";

const windowId = "83000000-0000-4000-8000-0000000000aa" as WindowId;
const otherWindow = "83000000-0000-4000-8000-0000000000bb" as WindowId;
const project = "83000000-0000-4000-8000-000000000004";
const codeThread = "83000000-0000-4000-8000-000000000020";
const otherThread = "83000000-0000-4000-8000-000000000022";
const now = decodeUtcTimestamp("2026-08-20T10:00:00.000Z");
const until = decodeUtcTimestamp("2026-08-21T00:00:00.000Z");
let uuidCounter = 0;

const runFact = (
  source: string,
  runId: string,
  finish: string,
  overrides: Record<string, unknown> = {},
): ActivityFact => ({
  identity: `${source}:${runId}`,
  occurredAt: now,
  threadId: codeThread,
  projectId: project,
  metadataJson: JSON.stringify({
    source,
    runId,
    finish,
    mode: source === "agent-run" ? "chat" : source,
  }),
  ...overrides,
});

const mergeFact = (overrides: Record<string, unknown> = {}): ActivityFact => ({
  identity: "octant-dev/octant#42",
  occurredAt: now,
  threadId: codeThread,
  projectId: project,
  metadataJson: JSON.stringify({
    repositoryOwner: "octant-dev",
    repositoryName: "octant",
    number: 42,
    title: "Ship it",
    mergedBy: "henrik",
  }),
  ...overrides,
});

function fixture(
  facts: ReadonlyArray<ActivityFact>,
  options: {
    readonly projects?: ReadonlyArray<string>;
    readonly deniedThreads?: ReadonlySet<string>;
    readonly held?: boolean;
    readonly forgeScope?: ReadonlyArray<string>;
    readonly forge?: () => Promise<CodeHomeActivityForgeResult>;
    readonly forgeAccount?: () => Promise<string | undefined>;
  } = {},
) {
  const projects = options.projects ?? [project];
  const denied = options.deniedThreads ?? new Set<string>();
  const service = new CodeHomeActivityService({
    listProjects: async () => projects,
    canReadThread: async ({ threadId }) => !denied.has(threadId),
    readFacts: (input) =>
      facts.filter(
        (fact) =>
          (input.from === null || fact.occurredAt >= input.from) && fact.occurredAt < input.until,
      ),
    projectionHeld: () => options.held === true,
    listForgeScope: async () => options.forgeScope ?? [`${project}|octant-dev/octant`],
    ...(options.forge === undefined ? {} : { forgeRead: options.forge }),
    ...(options.forgeAccount === undefined ? {} : { forgeAccount: options.forgeAccount }),
    uuid: () => `83000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    now: () => Date.now(),
    clock: () => now,
  });
  const read = (query: ActivityQuery, id: WindowId = windowId) =>
    service.read(id, query, () => true);
  return { service, read };
}

const readQuery = (
  card: "prs-merged" | "issues-closed" | "releases-published" | "runs",
): ActivityQuery => ({
  kind: "read",
  card,
  source: "octant",
  current: { from: null, until },
});

describe("CodeHomeActivityService", () => {
  it("deduplicates repeated closure witnesses into one record", async () => {
    const { read } = fixture([mergeFact(), mergeFact({ threadId: otherThread })]);
    const view = await read(readQuery("prs-merged"));
    expect(view.status).toBe("ready");
    expect(view.count).toBe(1);
    expect(view.records).toHaveLength(1);
  });

  it("counts runs and pages the successful subset while allFinished keeps every finish", async () => {
    const { read } = fixture([
      runFact("chat", "83000000-0000-4000-8000-000000000101", "successful"),
      runFact("code", "83000000-0000-4000-8000-000000000102", "failed"),
      runFact("agent-run", "83000000-0000-4000-8000-000000000103", "canceled"),
      runFact("agent-run", "83000000-0000-4000-8000-000000000104", "failed"),
    ]);
    const view = await read(readQuery("runs"));
    expect(view.status).toBe("ready");
    expect(view.finished).toEqual({ successful: 1, failed: 2, canceled: 1 });
    expect(view.count).toBe(1);
    expect(view.records).toHaveLength(1);
    const all = await read({
      kind: "page",
      snapshotId: view.snapshotId!,
      offset: 0,
      allFinished: true,
    });
    expect(all.records).toHaveLength(4);
    expect(all.count).toBe(1);
    expect(all.finished).toEqual({ successful: 1, failed: 2, canceled: 1 });
  });

  it("answers releases as unavailable rather than a fabricated empty list", async () => {
    const { read } = fixture([]);
    const view = await read(readQuery("releases-published"));
    expect(view).toMatchObject({ status: "unavailable", source: "octant", reason: "not-recorded" });
  });

  it("excludes a fact witnessed only by a thread the window cannot read", async () => {
    const { read } = fixture([mergeFact()], { deniedThreads: new Set([codeThread]) });
    const view = await read(readQuery("prs-merged"));
    expect(view.count).toBe(0);
    expect(view.records).toHaveLength(0);
  });

  it("keeps the authorized witness when an inaccessible one shares the identity", async () => {
    const { read } = fixture([mergeFact({ threadId: otherThread }), mergeFact()], {
      deniedThreads: new Set([otherThread]),
    });
    const view = await read(readQuery("prs-merged"));
    expect(view.records).toHaveLength(1);
    expect(view.records[0]).toMatchObject({ threadId: codeThread });
  });

  it("pages twenty-six records exactly and ignores facts journaled after the snapshot", async () => {
    const facts: ActivityFact[] = [];
    for (let i = 1; i <= 26; i += 1) {
      facts.push(
        mergeFact({
          identity: `octant-dev/octant#${i}`,
          occurredAt: `2026-08-20T10:${String(60 - i).padStart(2, "0")}:00.000Z`,
        }),
      );
    }
    const { read } = fixture(facts);
    const first = await read(readQuery("prs-merged"));
    expect(first.count).toBe(26);
    expect(first.records).toHaveLength(25);
    expect(first.nextOffset).toBe(25);
    // A newer fact arriving after the first read must not move the drilldown.
    facts.push(
      mergeFact({ identity: "octant-dev/octant#99", occurredAt: "2026-08-20T11:00:00.000Z" }),
    );
    const second = await read({ kind: "page", snapshotId: first.snapshotId!, offset: 25 });
    expect(second.records).toHaveLength(1);
    expect(second.nextOffset).toBeUndefined();
    expect(second.count).toBe(26);
  });

  it("refuses a snapshot to another window and after the Project set changed", async () => {
    let projects = [project];
    const { read } = fixture([mergeFact()], { projects });
    const service = new CodeHomeActivityService({
      listProjects: async () => projects,
      canReadThread: async () => true,
      readFacts: () => [mergeFact()],
      projectionHeld: () => false,
      uuid: () => `83000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
      now: () => Date.now(),
      clock: () => now,
    });
    const first = await service.read(windowId, readQuery("prs-merged"), () => true);
    const foreign = await service.read(
      otherWindow,
      { kind: "page", snapshotId: first.snapshotId!, offset: 0 },
      () => true,
    );
    expect(foreign.status).toBe("unavailable");
    expect(foreign.records).toHaveLength(0);
    // A scope loss expires the snapshot: no prior total survives.
    projects = [];
    const revoked = await service.read(
      windowId,
      { kind: "page", snapshotId: first.snapshotId!, offset: 0 },
      () => true,
    );
    expect(revoked.status).toBe("unavailable");
    expect(revoked.count).toBeUndefined();
    await read(readQuery("prs-merged"));
  });

  it("expires a snapshot whose comparison-only witness loses access", async () => {
    const denied = new Set<string>();
    // The comparison fact leads so coverage reaches its window; its witness
    // counts only toward the comparison, never toward the current records.
    const facts = [
      mergeFact({
        identity: "octant-dev/octant#7",
        threadId: otherThread,
        occurredAt: "2026-08-14T10:00:00.000Z",
      }),
      mergeFact({ occurredAt: "2026-08-19T10:00:00.000Z" }),
    ];
    const service = new CodeHomeActivityService({
      listProjects: async () => [project],
      canReadThread: async ({ threadId }) => !denied.has(threadId),
      readFacts: (input) =>
        facts.filter(
          (fact) =>
            (input.from === null || fact.occurredAt >= input.from) && fact.occurredAt < input.until,
        ),
      projectionHeld: () => false,
      uuid: () => `83000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
      now: () => Date.now(),
      clock: () => now,
    });
    const view = await service.read(
      windowId,
      {
        kind: "read",
        card: "prs-merged",
        source: "octant",
        current: {
          from: decodeUtcTimestamp("2026-08-18T00:00:00.000Z"),
          until: decodeUtcTimestamp("2026-08-25T00:00:00.000Z"),
        },
        comparison: {
          from: decodeUtcTimestamp("2026-08-11T00:00:00.000Z"),
          until: decodeUtcTimestamp("2026-08-18T00:00:00.000Z"),
        },
      },
      () => true,
    );
    expect(view.count).toBe(1);
    expect(view.comparisonCount).toBe(1);

    denied.add(otherThread);
    const page = await service.read(
      windowId,
      { kind: "page", snapshotId: view.snapshotId!, offset: 0 },
      () => true,
    );
    expect(page).toMatchObject({ status: "unavailable", reason: "authorization-changed" });
    expect(page.count).toBeUndefined();
    expect(page.comparisonCount).toBeUndefined();
    expect(page.records).toHaveLength(0);
  });

  it("expires a snapshot when either witness of a shared identity loses access", async () => {
    const denied = new Set<string>();
    // The same delivery is witnessed by different threads in the two
    // windows: both threads proved the answer, so losing either must expire
    // the snapshot rather than the comparison witness overwriting the
    // current one.
    const facts = [
      mergeFact({
        threadId: otherThread,
        occurredAt: "2026-08-14T10:00:00.000Z",
      }),
      mergeFact({ occurredAt: "2026-08-19T10:00:00.000Z" }),
    ];
    const service = new CodeHomeActivityService({
      listProjects: async () => [project],
      canReadThread: async ({ threadId }) => !denied.has(threadId),
      readFacts: (input) =>
        facts.filter(
          (fact) =>
            (input.from === null || fact.occurredAt >= input.from) && fact.occurredAt < input.until,
        ),
      projectionHeld: () => false,
      uuid: () => `83000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
      now: () => Date.now(),
      clock: () => now,
    });
    const view = await service.read(
      windowId,
      {
        kind: "read",
        card: "prs-merged",
        source: "octant",
        current: {
          from: decodeUtcTimestamp("2026-08-18T00:00:00.000Z"),
          until: decodeUtcTimestamp("2026-08-25T00:00:00.000Z"),
        },
        comparison: {
          from: decodeUtcTimestamp("2026-08-11T00:00:00.000Z"),
          until: decodeUtcTimestamp("2026-08-18T00:00:00.000Z"),
        },
      },
      () => true,
    );
    expect(view.count).toBe(1);
    expect(view.comparisonCount).toBe(1);

    denied.add(codeThread);
    const page = await service.read(
      windowId,
      { kind: "page", snapshotId: view.snapshotId!, offset: 0 },
      () => true,
    );
    expect(page).toMatchObject({ status: "unavailable", reason: "authorization-changed" });
    expect(page.records).toHaveLength(0);
  });

  it("answers no comparison when the comparison window itself read partial", async () => {
    // The comparison window's facts overflow the selection cap; its
    // truncated count must not surface and its witnesses must not join the
    // snapshot's authority set.
    const facts = [
      mergeFact({ occurredAt: "2026-08-19T10:00:00.000Z" }),
      ...Array.from({ length: 10_001 }, (_, index) =>
        mergeFact({
          identity: `octant-dev/octant#${index + 1000}`,
          occurredAt: "2026-08-14T10:00:00.000Z",
        }),
      ),
    ];
    const service = new CodeHomeActivityService({
      listProjects: async () => [project],
      canReadThread: async () => true,
      readFacts: (input) =>
        facts.filter(
          (fact) =>
            (input.from === null || fact.occurredAt >= input.from) && fact.occurredAt < input.until,
        ),
      projectionHeld: () => false,
      uuid: () => `83000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
      now: () => Date.now(),
      clock: () => now,
    });
    const view = await service.read(
      windowId,
      {
        kind: "read",
        card: "prs-merged",
        source: "octant",
        current: {
          from: decodeUtcTimestamp("2026-08-18T00:00:00.000Z"),
          until: decodeUtcTimestamp("2026-08-25T00:00:00.000Z"),
        },
        comparison: {
          from: decodeUtcTimestamp("2026-08-11T00:00:00.000Z"),
          until: decodeUtcTimestamp("2026-08-18T00:00:00.000Z"),
        },
      },
      () => true,
    );
    expect(view.status).toBe("ready");
    expect(view.count).toBe(1);
    expect(view.comparisonCount).toBeUndefined();
  });

  it("reports a held projection as unavailable instead of an empty history", async () => {
    const { read } = fixture([mergeFact()], { held: true });
    const view = await read(readQuery("prs-merged"));
    expect(view).toMatchObject({ status: "unavailable", reason: "read-failed" });
  });

  it("answers a valid empty window with a real zero, not a refusal", async () => {
    const { read } = fixture([]);
    const view = await read(readQuery("prs-merged"));
    expect(view.status).toBe("ready");
    expect(view.count).toBe(0);
    expect(view.records).toHaveLength(0);
  });

  it("withholds a comparison count when no authorized fact reaches the window", async () => {
    const { read } = fixture([mergeFact()]);
    const view = await read({
      kind: "read",
      card: "prs-merged",
      source: "octant",
      current: { from: null, until },
      comparison: { from: null, until: decodeUtcTimestamp("2026-01-01T00:00:00.000Z") },
    });
    expect(view.comparisonCount).toBeUndefined();
  });

  it("counts a comparison window only when an authorized fact covers it", async () => {
    const { read } = fixture([
      mergeFact({ identity: "octant-dev/octant#1", occurredAt: "2025-12-15T00:00:00.000Z" }),
      mergeFact(),
    ]);
    const view = await read({
      kind: "read",
      card: "prs-merged",
      source: "octant",
      current: { from: decodeUtcTimestamp("2026-08-01T00:00:00.000Z"), until },
      comparison: { from: null, until: decodeUtcTimestamp("2026-01-01T00:00:00.000Z") },
    });
    expect(view.comparisonCount).toBe(1);
  });

  it("reads an honest zero for a covered but empty comparison window", async () => {
    const { read } = fixture([
      mergeFact({ identity: "octant-dev/octant#1", occurredAt: "2025-11-01T00:00:00.000Z" }),
      mergeFact(),
    ]);
    const view = await read({
      kind: "read",
      card: "prs-merged",
      source: "octant",
      current: { from: null, until },
      comparison: {
        from: decodeUtcTimestamp("2025-12-01T00:00:00.000Z"),
        until: decodeUtcTimestamp("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(view.comparisonCount).toBe(0);
  });

  it("never proves comparison coverage from a fact the window cannot read", async () => {
    const { read } = fixture(
      [
        mergeFact({
          identity: "octant-dev/octant#1",
          occurredAt: "2025-12-15T00:00:00.000Z",
          threadId: otherThread,
        }),
      ],
      { deniedThreads: new Set([otherThread]) },
    );
    const view = await read({
      kind: "read",
      card: "prs-merged",
      source: "octant",
      current: { from: null, until },
      comparison: { from: null, until: decodeUtcTimestamp("2026-01-01T00:00:00.000Z") },
    });
    expect(view.comparisonCount).toBeUndefined();
    expect(view.coverageFrom).toBeUndefined();
  });

  const forgeRecord = (
    recordOverrides: Record<string, unknown> = {},
    projectOverride: string = project,
    repositoryKey = "octant-dev/octant",
  ): CodeHomeActivityForgeRecord => ({
    projectId: projectOverride,
    repositoryKey,
    record: {
      kind: "prs-merged",
      occurredAt: now,
      id: "octant-dev/octant#42",
      label: "Ship it",
      repositoryOwner: "octant-dev",
      repositoryName: "octant",
      number: 42,
      mergedBy: "henrik",
      ...recordOverrides,
    } as CodeHomeActivityForgeRecord["record"],
  });

  it("answers github history from authorized forge records only", async () => {
    const { read } = fixture([mergeFact()], {
      forge: async () => ({
        status: "ready",
        account: "henrik",
        checkedAt: now,
        records: [
          forgeRecord(),
          forgeRecord(
            { id: "octant-dev/octant#77", number: 77 },
            "83000000-0000-4000-8000-000000000009",
          ),
          // An admitted Project name is not enough: the record's own
          // repository must still be connected for this window.
          forgeRecord({ id: "octant-dev/other#3", number: 3 }, project, "octant-dev/other"),
        ],
      }),
      forgeAccount: async () => "henrik",
    });
    const view = await read({
      kind: "read",
      card: "prs-merged",
      source: "github",
      current: { from: null, until },
    });
    expect(view.status).toBe("ready");
    expect(view.source).toBe("github");
    expect(view.count).toBe(1);
    expect(view.records).toHaveLength(1);
  });

  it("labels an insecure forge account as a fallback on the Octant view", async () => {
    const { read } = fixture([], {
      forge: async () => ({ status: "fallback", fallback: "insecure-github-storage" }),
    });
    const view = await read({
      kind: "read",
      card: "prs-merged",
      source: "github",
      current: { from: null, until },
    });
    expect(view.status).toBe("ready");
    expect(view.fallback).toBe("insecure-github-storage");
  });

  it("answers a forge refusal as unavailable rather than an empty history", async () => {
    const { read } = fixture([], {
      forge: async () => ({ status: "unavailable", reason: "rate-limited" }),
    });
    const view = await read({
      kind: "read",
      card: "prs-merged",
      source: "github",
      current: { from: null, until },
    });
    expect(view).toMatchObject({ status: "unavailable", reason: "rate-limited" });
  });

  it("expires a github snapshot when the account behind it changes", async () => {
    let account: string | undefined = "henrik";
    const { read } = fixture([], {
      forge: async () => ({
        status: "ready",
        account: "henrik",
        checkedAt: now,
        records: [forgeRecord()],
      }),
      forgeAccount: async () => account,
    });
    const first = await read({
      kind: "read",
      card: "prs-merged",
      source: "github",
      current: { from: null, until },
    });
    expect(first.status).toBe("ready");
    account = "other-login";
    const next = await read({
      kind: "page",
      snapshotId: first.snapshotId!,
      offset: 0,
    });
    expect(next.status).toBe("unavailable");
    expect(next.records).toHaveLength(0);
    expect(next.count).toBeUndefined();
  });

  it("expires a page when a thread loses read access with the same Project roster", async () => {
    const denied = new Set<string>();
    const service = new CodeHomeActivityService({
      listProjects: async () => [project],
      canReadThread: async ({ threadId }) => !denied.has(threadId),
      readFacts: () => [mergeFact()],
      projectionHeld: () => false,
      uuid: () => `83000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
      now: () => Date.now(),
      clock: () => now,
    });
    const first = await service.read(windowId, readQuery("prs-merged"), () => true);
    expect(first.count).toBe(1);
    denied.add(codeThread);
    const next = await service.read(
      windowId,
      { kind: "page", snapshotId: first.snapshotId!, offset: 0 },
      () => true,
    );
    expect(next.status).toBe("unavailable");
    expect(next.count).toBeUndefined();
    expect(next.records).toHaveLength(0);
  });

  it("expires a github snapshot when a connected repository leaves the admitted scope", async () => {
    let scope: ReadonlyArray<string> = [`${project}|octant-dev/octant`];
    const service = new CodeHomeActivityService({
      listProjects: async () => [project],
      canReadThread: async () => true,
      readFacts: () => [],
      projectionHeld: () => false,
      listForgeScope: async () => scope,
      forgeRead: async () => ({
        status: "ready",
        account: "henrik",
        checkedAt: now,
        records: [forgeRecord()],
      }),
      forgeAccount: async () => "henrik",
      uuid: () => `83000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
      now: () => Date.now(),
      clock: () => now,
    });
    const first = await service.read(
      windowId,
      { kind: "read", card: "prs-merged", source: "github", current: { from: null, until } },
      () => true,
    );
    expect(first.status).toBe("ready");
    scope = [];
    const next = await service.read(
      windowId,
      { kind: "page", snapshotId: first.snapshotId!, offset: 0 },
      () => true,
    );
    expect(next.status).toBe("unavailable");
    expect(next.count).toBeUndefined();
  });

  it("never asks the forge for runs and reads the local journal instead", async () => {
    let forgeCalled = false;
    const { read } = fixture(
      [runFact("chat", "83000000-0000-4000-8000-000000000101", "successful")],
      {
        forge: async () => {
          forgeCalled = true;
          return { status: "unavailable", reason: "read-failed" };
        },
      },
    );
    const view = await read({
      kind: "read",
      card: "runs",
      source: "github",
      current: { from: null, until },
    });
    expect(forgeCalled).toBe(false);
    expect(view.status).toBe("ready");
    expect(view.count).toBe(1);
  });
});
