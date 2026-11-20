import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH,
  REPORT_FINISHED_TOOL_NAME,
  TOOL_EFFECT_AGGREGATE_TYPE,
  TOOL_EFFECT_EVENT_NAMES,
  decodeProject,
  decodeProjectExtraFolder,
  decodeProjectId,
  decodeThreadGoalId,
  decodeThreadGoalRevisionId,
  decodeUtcTimestamp,
  decodeWindowId,
  type BoundProject,
  type ProviderExecutionPolicy,
  type ThreadGoal,
  type ThreadGoalCriterionId,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { approvedWorkingFolderChoices } from "../approvedWorkingFolders";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { MIGRATIONS, applyMigrations } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createFinishedReceiptRouteHandler } from "./finishedReceiptRoutes";
import { ThreadFinishedReceiptStore, registerFinishedReceiptEvents } from "./finishedReceiptStore";
import { createReportFinishedTool } from "./finishedReceiptTools";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

const ACTOR = decodeActor({
  kind: "local-user",
  actorId: "00000000-0000-4000-8000-000000000001",
});
const PROJECT_ID = decodeProjectId("11111111-1111-4111-8111-111111111111");
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const WORK_THREAD_ID = "33333333-3333-4333-8333-333333333333";

const tempDirs: string[] = [];
const openConnections: Array<{ close(): void }> = [];

afterEach(() => {
  while (openConnections.length > 0) openConnections.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function openTestJournal() {
  const dir = mkdtempSync(join(tmpdir(), "octant-finished-receipts-"));
  tempDirs.push(dir);
  const connection = openSqlite(join(dir, "journal.sqlite"));
  openConnections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => "2026-11-19T12:00:00.000Z");
  const registry = registerFinishedReceiptEvents(new EventRegistry())
    .register("project.created@1", 1, Schema.Unknown)
    .register("project.binding-relinked@1", 1, Schema.Unknown)
    .register("code.operation-event-recorded@1", 1, Schema.Unknown)
    .register("code.file-reference-updated@1", 1, Schema.Unknown)
    .register("work.thread-created@1", 1, Schema.Unknown)
    .register("work.thread-updated@1", 1, Schema.Unknown)
    .register("work.turn-accepted@1", 1, Schema.Unknown)
    .register("work.turn-updated@1", 1, Schema.Unknown)
    .register("work.artifact-mutation-recorded@1", 1, Schema.Unknown)
    .register(TOOL_EFFECT_EVENT_NAMES.intended, 1, Schema.Unknown)
    .register(TOOL_EFFECT_EVENT_NAMES.settled, 1, Schema.Unknown);
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => "2026-11-19T12:00:00.000Z",
  });
  return { connection, journal };
}

function makeStore(journal: Journal) {
  const store = new ThreadFinishedReceiptStore({
    journal,
    uuid: randomUUID,
    actor: ACTOR,
    clock: () => "2026-11-19T12:00:00.000Z",
  });
  const unsubscribe = journal.subscribeCommitted((append) =>
    store.onCommittedEvents(append.events),
  );
  return { store, unsubscribe };
}

function makeShell(
  responder: (command: string) => NativeHarnessShellRun | Promise<NativeHarnessShellRun>,
): { readonly shell: NativeHarnessShellPort; readonly ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    shell: {
      run: async (input) => {
        ran.push(input.command);
        return await responder(input.command);
      },
    },
  };
}

function sampleGoal(): ThreadGoal {
  return {
    id: decodeThreadGoalId("44444444-4444-4444-8444-444444444444"),
    threadId: THREAD_ID,
    revisionId: decodeThreadGoalRevisionId("55555555-5555-4555-8555-555555555555"),
    objective: "Ship the parser fix",
    status: "active",
    budget: {},
    usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
    evidence: [],
    criteria: [
      {
        id: "c1" as ThreadGoalCriterionId,
        text: "Parser tests pass",
        check: "bun run test parser",
        status: "unmet",
      },
      {
        id: "c2" as ThreadGoalCriterionId,
        text: "Error messages read clearly to a person",
        status: "unmet",
      },
    ],
    createdAt: decodeUtcTimestamp("2026-11-19T11:00:00.000Z"),
    updatedAt: decodeUtcTimestamp("2026-11-19T11:00:00.000Z"),
    version: decodeAggregateVersion(1),
  };
}

describe("octant_report_finished tool and receipt store", () => {
  it("offers the tool only to Work and Code leads outside Plan, never in Chat, Plan, or child runs", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const common = {
        threadId: THREAD_ID,
        projectId: String(PROJECT_ID),
        folder: "/tmp/repo",
        observeDiff: async () => ({ status: "unavailable" as const, reason: "None" }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:00:00.000Z",
      };

      const codeLead = createReportFinishedTool({
        ...common,
        mode: "code",
        readPosture: () => "full-access",
      });
      expect(codeLead.definitions.map((d) => d.name)).toEqual([REPORT_FINISHED_TOOL_NAME]);

      const workLead = createReportFinishedTool({
        ...common,
        mode: "work",
        readPosture: () => "approval-gated",
      });
      expect(workLead.definitions.map((d) => d.name)).toEqual([REPORT_FINISHED_TOOL_NAME]);

      const chat = createReportFinishedTool({
        ...common,
        mode: "chat",
        readPosture: () => "full-access",
      });
      expect(chat.definitions).toEqual([]);
      expect(
        (await chat.execute({ name: REPORT_FINISHED_TOOL_NAME, inputJson: '{"summary":"hi"}' }))
          .isError,
      ).toBe(true);

      const plan = createReportFinishedTool({
        ...common,
        mode: "code",
        readPosture: () => "plan",
      });
      expect(plan.definitions).toEqual([]);
      expect(
        (await plan.execute({ name: REPORT_FINISHED_TOOL_NAME, inputJson: '{"summary":"hi"}' }))
          .isError,
      ).toBe(true);

      const child = createReportFinishedTool({
        ...common,
        mode: "code",
        isChildRun: true,
        readPosture: () => "full-access",
      });
      expect(child.definitions).toEqual([]);
      expect(
        (await child.execute({ name: REPORT_FINISHED_TOOL_NAME, inputJson: '{"summary":"hi"}' }))
          .isError,
      ).toBe(true);

      // Even if a session keeps the definition from an earlier non-Plan turn,
      // switching to Plan refuses execution live.
      let posture: ProviderExecutionPolicy = "full-access";
      const dynamic = createReportFinishedTool({
        ...common,
        mode: "code",
        readPosture: () => posture,
      });
      expect(dynamic.definitions).toHaveLength(1);
      posture = "plan";
      const planResult = await dynamic.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Done" }),
      });
      expect(planResult.isError).toBe(true);
      expect(store.read(THREAD_ID)).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("runs named checks and goal criteria under the thread guardrail level, journals the receipt, and projects the board mark", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const asked: string[] = [];
      const { shell, ran } = makeShell((command) => ({
        status: "ran",
        exitCode: 0,
        output: `passed: ${command}`,
        truncated: false,
      }));

      // Full access runs checks with no approval prompt.
      const fullAccessTool = createReportFinishedTool({
        mode: "code",
        threadId: THREAD_ID,
        projectId: String(PROJECT_ID),
        turnId: "turn-1",
        readPosture: () => "full-access",
        folder: "/tmp/repo",
        shell,
        askPerson: async (summary) => {
          asked.push(summary);
          return "approved";
        },
        readGoal: sampleGoal,
        observeDiff: async () => ({
          status: "observed",
          changedFiles: 3,
          insertions: 25,
          deletions: 4,
        }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:00:00.000Z",
      });

      const outcome = await fullAccessTool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({
          summary: "Fixed parser edge case and verified tests.",
          checks: ["bun run lint", "bun run test parser"],
        }),
      });
      expect(outcome.isError).toBeUndefined();
      expect(asked).toEqual([]);
      // Goal criterion c1 shares `bun run test parser`, so each distinct command runs once.
      expect(ran).toEqual(["bun run lint", "bun run test parser"]);

      const receipts = store.read(THREAD_ID);
      expect(receipts).toHaveLength(1);
      const latest = receipts[0];
      expect(latest?.status).toBe("proven");
      expect(latest?.stale).toBe(false);
      expect(latest?.provenCount).toBe(3); // 2 named checks + 1 checked goal criterion
      expect(latest?.claimedCount).toBe(1); // c2 without a check command
      expect(latest?.receipt.diff).toEqual({
        status: "observed",
        changedFiles: 3,
        insertions: 25,
        deletions: 4,
      });
      expect(store.boardMark(THREAD_ID)).toMatchObject({
        provenCount: 3,
        claimedCount: 1,
      });

      // Below Full access, each check asks the person under the thread's rules.
      const guardedTool = createReportFinishedTool({
        mode: "work",
        threadId: WORK_THREAD_ID,
        projectId: String(PROJECT_ID),
        turnId: "work-turn-1",
        readPosture: () => "approval-gated",
        folder: "/tmp/work",
        shell,
        askPerson: async (summary) => {
          asked.push(summary);
          return "approved";
        },
        observeDiff: async () => ({ status: "unavailable", reason: "Not a Git repo." }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:05:00.000Z",
      });
      const guardedOutcome = await guardedTool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Drafted report", checks: ["check-doc"] }),
      });
      expect(guardedOutcome.isError).toBeUndefined();
      expect(asked).toEqual(["Run check: check-doc"]);
      expect(store.boardMark(WORK_THREAD_ID)?.provenCount).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("records nothing when any check fails, returns the last 2,000 characters of output, and lets the agent report again", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      let shouldFail = true;
      const hugeOutput = `${"x".repeat(3_000)}FAILURE_TAIL_MARKER`;
      const { shell } = makeShell((command) => {
        if (command === "bun run test" && shouldFail) {
          return { status: "ran", exitCode: 1, output: hugeOutput, truncated: false };
        }
        return { status: "ran", exitCode: 0, output: "all green", truncated: false };
      });

      const tool = createReportFinishedTool({
        mode: "code",
        threadId: THREAD_ID,
        projectId: String(PROJECT_ID),
        turnId: "turn-1",
        readPosture: () => "full-access",
        folder: "/tmp/repo",
        shell,
        observeDiff: async () => ({
          status: "observed",
          changedFiles: 1,
          insertions: 5,
          deletions: 1,
        }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:00:00.000Z",
      });

      const first = await tool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Done", checks: ["bun run lint", "bun run test"] }),
      });
      expect(first.isError).toBe(true);
      const failedBody = first.result as {
        readonly status: string;
        readonly recorded: boolean;
        readonly failedChecks: ReadonlyArray<{
          readonly command?: string;
          readonly exitCode?: number;
          readonly outputTail: string;
        }>;
      };
      expect(failedBody.status).toBe("failed");
      expect(failedBody.recorded).toBe(false);
      expect(failedBody.failedChecks).toHaveLength(1);
      expect(failedBody.failedChecks[0]?.command).toBe("bun run test");
      expect(failedBody.failedChecks[0]?.exitCode).toBe(1);
      expect(failedBody.failedChecks[0]?.outputTail).toHaveLength(
        MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH,
      );
      expect(failedBody.failedChecks[0]?.outputTail.endsWith("FAILURE_TAIL_MARKER")).toBe(true);
      // Nothing recorded on the thread or board.
      expect(store.read(THREAD_ID)).toEqual([]);
      expect(store.boardMark(THREAD_ID)).toBeUndefined();

      // After fixing, the agent reports again in the same turn and succeeds.
      shouldFail = false;
      const second = await tool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Done after fix", checks: ["bun run test"] }),
      });
      expect(second.isError).toBeUndefined();
      expect(store.read(THREAD_ID)).toHaveLength(1);
      expect(store.boardMark(THREAD_ID)?.provenCount).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("marks a receipt stale on a later file-change journal event, clears the board mark, and rebuilds identically on replay", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const { shell } = makeShell(() => ({
        status: "ran",
        exitCode: 0,
        output: "ok",
        truncated: false,
      }));
      const tool = createReportFinishedTool({
        mode: "code",
        threadId: THREAD_ID,
        projectId: String(PROJECT_ID),
        turnId: "op-1",
        readPosture: () => "full-access",
        folder: "/tmp/repo",
        shell,
        observeDiff: async () => ({
          status: "observed",
          changedFiles: 1,
          insertions: 10,
          deletions: 2,
        }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:00:00.000Z",
      });
      await tool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Ready", checks: ["bun run test"] }),
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(false);
      expect(store.boardMark(THREAD_ID)?.provenCount).toBe(1);

      // End-of-turn summary for the SAME operation (op-1) does NOT stale the receipt.
      journal.append({
        aggregate: {
          aggregateType: "code-operation",
          aggregateId: decodeAggregateId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "code.operation-event-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:00:01.000Z",
            payload: {
              threadId: THREAD_ID,
              operationId: "op-1",
              event: {
                kind: "conversation-turn-changed-files",
                changedFiles: { files: [], total: 1, truncated: false },
              },
            },
          },
        ],
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(false);
      expect(store.boardMark(THREAD_ID)?.provenCount).toBe(1);

      // A later file-change journal event marks the receipt stale and clears the board mark.
      journal.append({
        aggregate: {
          aggregateType: "code-operation",
          aggregateId: decodeAggregateId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "code.operation-event-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:01:00.000Z",
            payload: {
              threadId: THREAD_ID,
              operationId: "op-2",
              event: {
                kind: "file-change",
                path: "src/app.ts",
                change: "modified",
                reconciled: true,
              },
            },
          },
        ],
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(true);
      expect(store.latest(THREAD_ID)?.status).toBe("stale");
      expect(store.boardMark(THREAD_ID)).toBeUndefined();

      // Replaying a fresh store from the same journal reproduces identical state.
      const replayed = new ThreadFinishedReceiptStore({
        journal,
        uuid: randomUUID,
        actor: ACTOR,
        clock: () => "2026-11-19T12:02:00.000Z",
      });
      expect(replayed.read(THREAD_ID)).toEqual(store.read(THREAD_ID));
      expect(replayed.boardMark(THREAD_ID)).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("enforces authentication and thread authorization on GET /api/finished-receipts/:threadId", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const windowAuthorityStore = new WindowAuthorityStore();
      const windowId = decodeWindowId("99999999-9999-4999-8999-999999999999");
      const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      windowAuthorityStore.register({
        windowId,
        capability,
        now: 1_000,
      });

      const route = createFinishedReceiptRouteHandler({
        store,
        windowAuthorityStore,
        authorizeThread: ({ threadId }) => threadId === THREAD_ID,
        now: () => 2_000,
      });

      const unauthenticated = await route(
        new Request(`http://127.0.0.1:4123/api/finished-receipts/${THREAD_ID}`),
      );
      expect(unauthenticated?.status).toBe(401);

      const forbidden = await route(
        new Request(`http://127.0.0.1:4123/api/finished-receipts/${WORK_THREAD_ID}`, {
          headers: { "x-octant-window-capability": capability },
        }),
      );
      expect(forbidden?.status).toBe(403);

      const ok = await route(
        new Request(`http://127.0.0.1:4123/api/finished-receipts/${THREAD_ID}`, {
          headers: { "x-octant-window-capability": capability },
        }),
      );
      expect(ok?.status).toBe(200);
      expect(await ok?.json()).toEqual({ receipts: [] });
    } finally {
      unsubscribe();
    }
  });

  it("marks a Code receipt stale on production-shaped operation-result Git mutations and file-restoring rewinds, live and on replay", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const { shell } = makeShell(() => ({
        status: "ran",
        exitCode: 0,
        output: "ok",
        truncated: false,
      }));
      const tool = createReportFinishedTool({
        mode: "code",
        threadId: THREAD_ID,
        projectId: String(PROJECT_ID),
        turnId: "op-1",
        readPosture: () => "full-access",
        folder: "/tmp/repo",
        shell,
        observeDiff: async () => ({
          status: "observed",
          changedFiles: 1,
          insertions: 4,
          deletions: 1,
        }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:00:00.000Z",
      });
      await tool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Ready", checks: ["bun run test"] }),
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(false);

      // Non-mutating Git action (staging) does not stale proof.
      journal.append({
        aggregate: {
          aggregateType: "code-operation",
          aggregateId: decodeAggregateId("cccccccc-cccc-4ccc-8ccc-ccccccccccc1"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "code.operation-event-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:00:10.000Z",
            payload: {
              threadId: THREAD_ID,
              operationId: "op-stage",
              event: {
                kind: "operation-result",
                result: {
                  kind: "git-mutation-state",
                  mutation: "stage",
                  state: "completed",
                },
              },
            },
          },
        ],
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(false);

      // Mutating Git operation (`discard`) with production `operation-result` discriminator marks stale.
      journal.append({
        aggregate: {
          aggregateType: "code-operation",
          aggregateId: decodeAggregateId("cccccccc-cccc-4ccc-8ccc-ccccccccccc2"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "code.operation-event-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:00:20.000Z",
            payload: {
              threadId: THREAD_ID,
              operationId: "op-discard",
              event: {
                kind: "operation-result",
                result: {
                  kind: "git-mutation-state",
                  mutation: "discard",
                  state: "completed",
                },
              },
            },
          },
        ],
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(true);
      expect(store.boardMark(THREAD_ID)).toBeUndefined();

      // Record a fresh receipt, then restore files via `thread-rewound`.
      await tool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Ready again", checks: ["bun run test"] }),
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(false);

      journal.append({
        aggregate: {
          aggregateType: "code-operation",
          aggregateId: decodeAggregateId("cccccccc-cccc-4ccc-8ccc-ccccccccccc3"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "code.operation-event-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:00:30.000Z",
            payload: {
              threadId: THREAD_ID,
              operationId: "op-rewind",
              event: {
                kind: "operation-result",
                result: {
                  kind: "thread-rewound",
                  files: "restored",
                },
              },
            },
          },
        ],
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(true);

      const replayed = new ThreadFinishedReceiptStore({
        journal,
        uuid: randomUUID,
        actor: ACTOR,
        clock: () => "2026-11-19T12:01:00.000Z",
      });
      expect(replayed.read(THREAD_ID)).toEqual(store.read(THREAD_ID));
      expect(replayed.boardMark(THREAD_ID)).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("marks a Code receipt stale when an editor save completes, while ignoring in-progress, read, and failed file updates", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const { shell } = makeShell(() => ({
        status: "ran",
        exitCode: 0,
        output: "ok",
        truncated: false,
      }));
      const tool = createReportFinishedTool({
        mode: "code",
        threadId: THREAD_ID,
        projectId: String(PROJECT_ID),
        turnId: "op-1",
        readPosture: () => "full-access",
        folder: "/tmp/repo",
        shell,
        observeDiff: async () => ({
          status: "observed",
          changedFiles: 1,
          insertions: 2,
          deletions: 0,
        }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:00:00.000Z",
      });
      await tool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Verified", checks: ["bun run test"] }),
      });
      expect(store.latest(THREAD_ID)?.stale).toBe(false);

      const fileId = decodeAggregateId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      let version = 0;
      const appendFileState = (state: string) => {
        journal.append({
          aggregate: { aggregateType: "code-file", aggregateId: fileId },
          expectedVersion: decodeAggregateVersion(version),
          events: [
            {
              eventId: decodeEventId(randomUUID()),
              eventName: "code.file-reference-updated@1",
              eventVersion: 1,
              correlationId: decodeCorrelationId(randomUUID()),
              actor: ACTOR,
              occurredAt: "2026-11-19T12:00:05.000Z",
              payload: {
                kind: "file-reference-updated",
                file: {
                  id: String(fileId),
                  threadId: THREAD_ID,
                  checkoutId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                  relativePath: "src/index.ts",
                  digest: "a".repeat(64),
                  byteLength: 42,
                  state,
                  version: version + 1,
                  updatedAt: "2026-11-19T12:00:05.000Z",
                },
              },
            },
          ],
        });
        version += 1;
      };

      // Non-completed states (reads, in-progress saves, conflicts, failures) do not stale proof.
      for (const state of [
        "available",
        "read-only",
        "saving",
        "conflict",
        "failed",
        "interrupted",
      ]) {
        appendFileState(state);
        expect(store.latest(THREAD_ID)?.stale).toBe(false);
        expect(store.boardMark(THREAD_ID)?.provenCount).toBe(1);
      }

      // A completed editor save marks the receipt stale immediately and on replay.
      appendFileState("completed");
      expect(store.latest(THREAD_ID)?.stale).toBe(true);
      expect(store.boardMark(THREAD_ID)).toBeUndefined();

      const replayed = new ThreadFinishedReceiptStore({
        journal,
        uuid: randomUUID,
        actor: ACTOR,
        clock: () => "2026-11-19T12:01:00.000Z",
      });
      expect(replayed.read(THREAD_ID)).toEqual(store.read(THREAD_ID));
      expect(replayed.boardMark(THREAD_ID)).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("marks a Work receipt stale when a sibling Work thread edits files in the same Project folder, while keeping distinct folders isolated", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const workSameFolderA = "33333333-3333-4333-8333-333333333301";
      const workSameFolderB = "33333333-3333-4333-8333-333333333302";
      const workExtraFolder = "33333333-3333-4333-8333-333333333303";
      const workDisjointSubdir = "33333333-3333-4333-8333-333333333304";
      const workOtherProject = "33333333-3333-4333-8333-333333333305";
      const otherProjectId = decodeProjectId("11111111-1111-4111-8111-111111111199");
      const extraFolderId = `folder_${"b".repeat(64)}`;

      const registerWorkThread = (input: {
        readonly id: string;
        readonly projectId: string;
        readonly workingFolderId?: string;
        readonly workingDirectory?: string;
      }) => {
        journal.append({
          aggregate: { aggregateType: "work-thread", aggregateId: decodeAggregateId(input.id) },
          expectedVersion: decodeAggregateVersion(0),
          events: [
            {
              eventId: decodeEventId(randomUUID()),
              eventName: "work.thread-created@1",
              eventVersion: 1,
              correlationId: decodeCorrelationId(randomUUID()),
              actor: ACTOR,
              occurredAt: "2026-11-19T11:55:00.000Z",
              payload: {
                kind: "thread-created",
                thread: {
                  id: input.id,
                  projectId: input.projectId,
                  ...(input.workingFolderId === undefined
                    ? {}
                    : { workingFolderId: input.workingFolderId }),
                  ...(input.workingDirectory === undefined
                    ? {}
                    : { workingDirectory: input.workingDirectory }),
                },
              },
            },
          ],
        });
      };

      registerWorkThread({
        id: workSameFolderA,
        projectId: String(PROJECT_ID),
        workingDirectory: "docs",
      });
      registerWorkThread({
        id: workSameFolderB,
        projectId: String(PROJECT_ID),
        workingDirectory: "docs",
      });
      registerWorkThread({
        id: workExtraFolder,
        projectId: String(PROJECT_ID),
        workingFolderId: extraFolderId,
        workingDirectory: "docs",
      });
      registerWorkThread({
        id: workDisjointSubdir,
        projectId: String(PROJECT_ID),
        workingDirectory: "notes",
      });
      registerWorkThread({
        id: workOtherProject,
        projectId: String(otherProjectId),
        workingDirectory: "docs",
      });

      const { shell } = makeShell(() => ({
        status: "ran",
        exitCode: 0,
        output: "ok",
        truncated: false,
      }));
      const recordReceiptFor = async (threadId: string, projectId: string) => {
        const tool = createReportFinishedTool({
          mode: "work",
          threadId,
          projectId,
          turnId: `turn-${threadId}`,
          readPosture: () => "full-access",
          folder: "/tmp/work",
          shell,
          observeDiff: async () => ({ status: "unavailable", reason: "Not a Git repo." }),
          store,
          uuid: randomUUID,
          clock: () => "2026-11-19T12:00:00.000Z",
        });
        const res = await tool.execute({
          name: REPORT_FINISHED_TOOL_NAME,
          inputJson: JSON.stringify({ summary: "Finished draft", checks: ["check-doc"] }),
        });
        expect(res.isError).toBeUndefined();
      };

      await recordReceiptFor(workSameFolderA, String(PROJECT_ID));
      await recordReceiptFor(workExtraFolder, String(PROJECT_ID));
      await recordReceiptFor(workDisjointSubdir, String(PROJECT_ID));
      await recordReceiptFor(workOtherProject, String(otherProjectId));

      // Sibling Work thread B writes a file in the shared Project folder (`docs`).
      journal.append({
        aggregate: {
          aggregateType: "work-turn",
          aggregateId: decodeAggregateId("ffffffff-ffff-4fff-8fff-fffffffffff1"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "work.turn-updated@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:01:00.000Z",
            payload: {
              kind: "turn-updated",
              threadId: workSameFolderB,
              turnId: "sibling-turn-1",
              status: "completed",
              wroteFiles: { paths: ["docs/summary.md"], truncated: false },
            },
          },
        ],
      });

      // Thread A in the same folder is marked stale; distinct folders and projects stay fresh.
      expect(store.latest(workSameFolderA)?.stale).toBe(true);
      expect(store.boardMark(workSameFolderA)).toBeUndefined();
      expect(store.latest(workExtraFolder)?.stale).toBe(false);
      expect(store.boardMark(workExtraFolder)?.provenCount).toBe(1);
      expect(store.latest(workDisjointSubdir)?.stale).toBe(false);
      expect(store.boardMark(workDisjointSubdir)?.provenCount).toBe(1);
      expect(store.latest(workOtherProject)?.stale).toBe(false);
      expect(store.boardMark(workOtherProject)?.provenCount).toBe(1);

      // Re-record Thread A, then verify a settled file-write tool effect on sibling B also invalidates A.
      await recordReceiptFor(workSameFolderA, String(PROJECT_ID));
      expect(store.latest(workSameFolderA)?.stale).toBe(false);
      const effectAgg = decodeAggregateId("ffffffff-ffff-4fff-8fff-fffffffffff2");
      journal.append({
        aggregate: { aggregateType: TOOL_EFFECT_AGGREGATE_TYPE, aggregateId: effectAgg },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: TOOL_EFFECT_EVENT_NAMES.intended,
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:02:00.000Z",
            payload: {
              threadId: workSameFolderB,
              toolCallId: "call-1",
              toolName: "write",
            },
          },
          {
            eventId: decodeEventId(randomUUID()),
            eventName: TOOL_EFFECT_EVENT_NAMES.settled,
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:02:01.000Z",
            payload: {
              threadId: workSameFolderB,
              toolCallId: "call-1",
              outcome: "succeeded",
            },
          },
        ],
      });
      expect(store.latest(workSameFolderA)?.stale).toBe(true);
      expect(store.latest(workExtraFolder)?.stale).toBe(false);
      expect(store.latest(workDisjointSubdir)?.stale).toBe(false);
      expect(store.latest(workOtherProject)?.stale).toBe(false);

      // Replay reproduces identical staleness and isolation.
      const replayed = new ThreadFinishedReceiptStore({
        journal,
        uuid: randomUUID,
        actor: ACTOR,
        clock: () => "2026-11-19T12:03:00.000Z",
      });
      expect(replayed.read(workSameFolderA)).toEqual(store.read(workSameFolderA));
      expect(replayed.read(workExtraFolder)).toEqual(store.read(workExtraFolder));
      expect(replayed.read(workDisjointSubdir)).toEqual(store.read(workDisjointSubdir));
      expect(replayed.read(workOtherProject)).toEqual(store.read(workOtherProject));
    } finally {
      unsubscribe();
    }
  });

  it("keeps the final failure diagnostics when a check produces more output than the process capture limit", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const fake = createFakeSandboxConfinement();
      tempDirs.push(fake.root);
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-finished-tail-")));
      tempDirs.push(root);
      const checkout = join(root, "checkout");
      const scripts = join(root, "scripts");
      mkdirSync(checkout, { recursive: true });
      mkdirSync(scripts, { recursive: true });

      const processPort = new RepositoryTestProcessPort({
        confinement: fake.confinement,
        receiptDirectory: join(root, "receipts"),
        temporaryDirectory: fake.temporaryDirectory,
        networkEgress: "none",
        harnessShellScriptDirectory: scripts,
        maxOutputBytes: 4_096,
      });
      const baseShell = createNativeHarnessShell({
        process: processPort,
        scriptDirectory: scripts,
      });
      let observedTruncated: boolean | undefined;
      const observingShell: NativeHarnessShellPort = {
        run: async (input) => {
          const run = await baseShell.run(input);
          observedTruncated = run.truncated;
          return run;
        },
      };

      const tool = createReportFinishedTool({
        mode: "code",
        threadId: THREAD_ID,
        projectId: String(PROJECT_ID),
        turnId: "turn-tail",
        readPosture: () => "full-access",
        folder: checkout,
        shell: observingShell,
        observeDiff: async () => ({ status: "unavailable", reason: "Not a Git repo." }),
        store,
        uuid: randomUUID,
        clock: () => "2026-11-19T12:00:00.000Z",
      });

      // Emit > 12 KiB of noise (well above the 4 KiB process capture cap) before the final error.
      const command = `i=0; while [ "$i" -lt 200 ]; do echo "noise-line-$i-0123456789abcdefghijklmnopqrstuvwxyz0123456789"; i=$((i+1)); done; echo "FINAL_ASSERTION_FAILURE_999"; exit 1`;
      const outcome = await tool.execute({
        name: REPORT_FINISHED_TOOL_NAME,
        inputJson: JSON.stringify({ summary: "Attempt", checks: [command] }),
      });

      expect(outcome.isError).toBe(true);
      expect(observedTruncated).toBe(true);
      const failedBody = outcome.result as {
        readonly status: string;
        readonly recorded: boolean;
        readonly failedChecks: ReadonlyArray<{
          readonly exitCode?: number;
          readonly outputTail: string;
        }>;
      };
      expect(failedBody.status).toBe("failed");
      expect(failedBody.recorded).toBe(false);
      expect(failedBody.failedChecks[0]?.exitCode).toBe(1);
      expect(failedBody.failedChecks[0]?.outputTail).toContain("FINAL_ASSERTION_FAILURE_999");
      expect(failedBody.failedChecks[0]?.outputTail.length).toBeLessThanOrEqual(
        MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH,
      );
      expect(store.read(THREAD_ID)).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("marks extra-folder Work receipts stale on production-shaped artifact deletions and exports, live and on replay", async () => {
    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      const mainThread = "33333333-3333-4333-8333-333333333401";
      const extraThread = "33333333-3333-4333-8333-333333333402";
      const extraFolderId = `folder_${"c".repeat(64)}`;

      const registerWorkThread = (id: string, workingFolderId?: string) => {
        journal.append({
          aggregate: { aggregateType: "work-thread", aggregateId: decodeAggregateId(id) },
          expectedVersion: decodeAggregateVersion(0),
          events: [
            {
              eventId: decodeEventId(randomUUID()),
              eventName: "work.thread-created@1",
              eventVersion: 1,
              correlationId: decodeCorrelationId(randomUUID()),
              actor: ACTOR,
              occurredAt: "2026-11-19T11:55:00.000Z",
              payload: {
                kind: "thread-created",
                thread: {
                  id,
                  projectId: String(PROJECT_ID),
                  ...(workingFolderId === undefined ? {} : { workingFolderId }),
                  workingDirectory: ".",
                },
              },
            },
          ],
        });
      };

      registerWorkThread(mainThread);
      registerWorkThread(extraThread, extraFolderId);

      const { shell } = makeShell(() => ({
        status: "ran",
        exitCode: 0,
        output: "ok",
        truncated: false,
      }));
      const recordReceiptFor = async (threadId: string) => {
        const tool = createReportFinishedTool({
          mode: "work",
          threadId,
          projectId: String(PROJECT_ID),
          turnId: `turn-${randomUUID()}`,
          readPosture: () => "full-access",
          folder: "/tmp/work",
          shell,
          observeDiff: async () => ({ status: "unavailable", reason: "Not a Git repo." }),
          store,
          uuid: randomUUID,
          clock: () => "2026-11-19T12:00:00.000Z",
        });
        expect(
          (
            await tool.execute({
              name: REPORT_FINISHED_TOOL_NAME,
              inputJson: JSON.stringify({ summary: "Verified", checks: ["check"] }),
            })
          ).isError,
        ).toBeUndefined();
      };

      // Create an artifact in the extra folder BEFORE recording the receipts so
      // its folder scope is retained in the store from `created`.
      const artifactA = decodeAggregateId("77777777-7777-4777-8777-777777777701");
      const producedArtifactB = decodeAggregateId("77777777-7777-4777-8777-777777777702");
      journal.append({
        aggregate: { aggregateType: "work-artifact", aggregateId: artifactA },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "work.artifact-mutation-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T11:58:00.000Z",
            payload: {
              projectId: String(PROJECT_ID),
              sequence: 1,
              occurredAt: "2026-11-19T11:58:00.000Z",
              outcome: {
                kind: "created",
                artifact: {
                  artifactId: String(artifactA),
                  projectId: String(PROJECT_ID),
                  workingFolderId: extraFolderId,
                  directory: "reports",
                },
              },
            },
          },
        ],
      });

      await recordReceiptFor(mainThread);
      await recordReceiptFor(extraThread);
      expect(store.latest(mainThread)?.stale).toBe(false);
      expect(store.latest(extraThread)?.stale).toBe(false);

      // Exporting the extra-folder artifact (no `outcome.artifact`) marks the extra-folder
      // receipt stale, keeps the main-folder receipt fresh, and propagates folder ownership
      // to `producedVersion.artifactId`.
      journal.append({
        aggregate: { aggregateType: "work-artifact", aggregateId: artifactA },
        expectedVersion: decodeAggregateVersion(1),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "work.artifact-mutation-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:01:00.000Z",
            payload: {
              projectId: String(PROJECT_ID),
              sequence: 2,
              occurredAt: "2026-11-19T12:01:00.000Z",
              outcome: {
                kind: "exported",
                handoff: {
                  handoffKind: "in-app-version",
                  artifactId: String(artifactA),
                  producedVersion: {
                    artifactId: String(producedArtifactB),
                    projectId: String(PROJECT_ID),
                    sequence: 2,
                  },
                },
              },
            },
          },
        ],
      });
      expect(store.latest(extraThread)?.stale).toBe(true);
      expect(store.boardMark(extraThread)).toBeUndefined();
      expect(store.latest(mainThread)?.stale).toBe(false);

      // Re-record the extra-folder receipt, then delete the produced artifact (no `outcome.artifact`).
      await recordReceiptFor(extraThread);
      expect(store.latest(extraThread)?.stale).toBe(false);

      journal.append({
        aggregate: { aggregateType: "work-artifact", aggregateId: producedArtifactB },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "work.artifact-mutation-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:02:00.000Z",
            payload: {
              projectId: String(PROJECT_ID),
              sequence: 3,
              occurredAt: "2026-11-19T12:02:00.000Z",
              outcome: {
                kind: "deleted",
                artifactId: String(producedArtifactB),
                projectId: String(PROJECT_ID),
              },
            },
          },
        ],
      });
      expect(store.latest(extraThread)?.stale).toBe(true);
      expect(store.latest(mainThread)?.stale).toBe(false);

      // A standalone deletion whose artifact was never seen before conservatively invalidates
      // every Work receipt in the Project (including extra-folder receipts).
      await recordReceiptFor(extraThread);
      expect(store.latest(extraThread)?.stale).toBe(false);
      const unknownArtifact = decodeAggregateId("77777777-7777-4777-8777-777777777799");
      journal.append({
        aggregate: { aggregateType: "work-artifact", aggregateId: unknownArtifact },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "work.artifact-mutation-recorded@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:03:00.000Z",
            payload: {
              projectId: String(PROJECT_ID),
              sequence: 1,
              occurredAt: "2026-11-19T12:03:00.000Z",
              outcome: {
                kind: "deleted",
                artifactId: String(unknownArtifact),
                projectId: String(PROJECT_ID),
              },
            },
          },
        ],
      });
      expect(store.latest(extraThread)?.stale).toBe(true);
      expect(store.latest(mainThread)?.stale).toBe(true);

      const replayed = new ThreadFinishedReceiptStore({
        journal,
        uuid: randomUUID,
        actor: ACTOR,
        clock: () => "2026-11-19T12:04:00.000Z",
      });
      expect(replayed.read(extraThread)).toEqual(store.read(extraThread));
      expect(replayed.read(mainThread)).toEqual(store.read(mainThread));
    } finally {
      unsubscribe();
    }
  });

  it("invalidates Work receipts across implicit and explicit main-folder aliases and preserves staleness on replay after Project relinking", async () => {
    const extraFolder = decodeProjectExtraFolder({
      canonicalRoot: "/workspace/project-extra",
      addedBy: ACTOR,
      addedAt: "2026-11-19T10:00:00.000Z",
    });
    const projectV1 = decodeProject({
      id: PROJECT_ID,
      type: "work",
      name: "Work",
      lifecycle: "active",
      pinned: false,
      rank: "0/1",
      version: 1,
      createdAt: "2026-11-19T10:00:00.000Z",
      updatedAt: "2026-11-19T10:00:00.000Z",
      binding: { canonicalRoot: "/workspace/project-main" },
      bindingHistory: [
        {
          revisionId: "88888888-8888-4888-8888-888888888881",
          revision: 1,
          currentBinding: { canonicalRoot: "/workspace/project-main" },
          actor: ACTOR,
          changedAt: "2026-11-19T10:00:00.000Z",
        },
      ],
      extraFolders: [extraFolder],
    }) as BoundProject;
    const choicesV1 = approvedWorkingFolderChoices(projectV1);
    const mainChoiceV1 = choicesV1.find((choice) => choice.kind === "main");
    const extraChoiceV1 = choicesV1.find((choice) => choice.kind === "extra");
    expect(mainChoiceV1).toBeDefined();
    expect(extraChoiceV1).toBeDefined();
    if (mainChoiceV1 === undefined || extraChoiceV1 === undefined) return;

    const { journal } = openTestJournal();
    const { store, unsubscribe } = makeStore(journal);
    try {
      journal.append({
        aggregate: { aggregateType: "project", aggregateId: decodeAggregateId(String(PROJECT_ID)) },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "project.created@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T10:00:00.000Z",
            payload: { kind: "project-created", project: projectV1 },
          },
        ],
      });

      const implicitMainThread = "33333333-3333-4333-8333-333333333501";
      const explicitMainThread = "33333333-3333-4333-8333-333333333502";
      const extraFolderThread = "33333333-3333-4333-8333-333333333503";

      const registerWorkThread = (id: string, workingFolderId?: string) => {
        journal.append({
          aggregate: { aggregateType: "work-thread", aggregateId: decodeAggregateId(id) },
          expectedVersion: decodeAggregateVersion(0),
          events: [
            {
              eventId: decodeEventId(randomUUID()),
              eventName: "work.thread-created@1",
              eventVersion: 1,
              correlationId: decodeCorrelationId(randomUUID()),
              actor: ACTOR,
              occurredAt: "2026-11-19T11:55:00.000Z",
              payload: {
                kind: "thread-created",
                thread: {
                  id,
                  projectId: String(PROJECT_ID),
                  ...(workingFolderId === undefined ? {} : { workingFolderId }),
                  workingDirectory: "docs",
                },
              },
            },
          ],
        });
      };

      registerWorkThread(implicitMainThread);
      registerWorkThread(explicitMainThread, String(mainChoiceV1.id));
      registerWorkThread(extraFolderThread, String(extraChoiceV1.id));

      const { shell } = makeShell(() => ({
        status: "ran",
        exitCode: 0,
        output: "ok",
        truncated: false,
      }));
      const recordReceiptFor = async (threadId: string) => {
        const tool = createReportFinishedTool({
          mode: "work",
          threadId,
          projectId: String(PROJECT_ID),
          turnId: `turn-${randomUUID()}`,
          readPosture: () => "full-access",
          folder: "/workspace/project-main",
          shell,
          observeDiff: async () => ({ status: "unavailable", reason: "Not a Git repo." }),
          store,
          uuid: randomUUID,
          clock: () => "2026-11-19T12:00:00.000Z",
        });
        expect(
          (
            await tool.execute({
              name: REPORT_FINISHED_TOOL_NAME,
              inputJson: JSON.stringify({ summary: "Verified", checks: ["check"] }),
            })
          ).isError,
        ).toBeUndefined();
      };

      await recordReceiptFor(implicitMainThread);
      await recordReceiptFor(extraFolderThread);

      // A write from the explicit main-folder thread invalidates the implicit main-folder
      // thread's receipt, while leaving the extra-folder thread fresh.
      journal.append({
        aggregate: {
          aggregateType: "work-turn",
          aggregateId: decodeAggregateId("99999999-9999-4999-8999-999999999901"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "work.turn-updated@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:01:00.000Z",
            payload: {
              kind: "turn-updated",
              threadId: explicitMainThread,
              turnId: "explicit-turn-1",
              status: "completed",
              wroteFiles: { paths: ["docs/readme.md"], truncated: false },
            },
          },
        ],
      });
      expect(store.latest(implicitMainThread)?.stale).toBe(true);
      expect(store.boardMark(implicitMainThread)).toBeUndefined();
      expect(store.latest(extraFolderThread)?.stale).toBe(false);
      expect(store.boardMark(extraFolderThread)?.provenCount).toBe(1);

      // Symmetrically, a write from the implicit main-folder thread invalidates the
      // explicit main-folder thread's receipt while keeping the extra folder fresh.
      await recordReceiptFor(explicitMainThread);
      expect(store.latest(explicitMainThread)?.stale).toBe(false);

      journal.append({
        aggregate: {
          aggregateType: "work-turn",
          aggregateId: decodeAggregateId("99999999-9999-4999-8999-999999999902"),
        },
        expectedVersion: decodeAggregateVersion(0),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "work.turn-updated@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:02:00.000Z",
            payload: {
              kind: "turn-updated",
              threadId: implicitMainThread,
              turnId: "implicit-turn-1",
              status: "completed",
              wroteFiles: { paths: ["docs/readme.md"], truncated: false },
            },
          },
        ],
      });
      expect(store.latest(explicitMainThread)?.stale).toBe(true);
      expect(store.latest(extraFolderThread)?.stale).toBe(false);

      // Relink the Project to a new binding revision (changing the current approved
      // folder IDs). Replaying the journal must still recognize the historical
      // rev-1 main-folder ID so stale receipts are never revived after restart.
      const projectV2 = decodeProject({
        id: PROJECT_ID,
        type: "work",
        name: "Work",
        lifecycle: "active",
        pinned: false,
        rank: "0/1",
        version: 2,
        createdAt: "2026-11-19T10:00:00.000Z",
        updatedAt: "2026-11-19T12:02:30.000Z",
        binding: { canonicalRoot: "/workspace/project-relinked" },
        bindingHistory: [
          {
            revisionId: "88888888-8888-4888-8888-888888888881",
            revision: 1,
            currentBinding: { canonicalRoot: "/workspace/project-main" },
            actor: ACTOR,
            changedAt: "2026-11-19T10:00:00.000Z",
          },
          {
            revisionId: "88888888-8888-4888-8888-888888888882",
            revision: 2,
            previousBinding: { canonicalRoot: "/workspace/project-main" },
            currentBinding: { canonicalRoot: "/workspace/project-relinked" },
            actor: ACTOR,
            changedAt: "2026-11-19T12:02:30.000Z",
          },
        ],
        extraFolders: [extraFolder],
      }) as BoundProject;
      const choicesV2 = approvedWorkingFolderChoices(projectV2);
      const mainChoiceV2 = choicesV2.find((choice) => choice.kind === "main");
      expect(mainChoiceV2?.id).not.toBe(mainChoiceV1.id);

      journal.append({
        aggregate: { aggregateType: "project", aggregateId: decodeAggregateId(String(PROJECT_ID)) },
        expectedVersion: decodeAggregateVersion(1),
        events: [
          {
            eventId: decodeEventId(randomUUID()),
            eventName: "project.binding-relinked@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(randomUUID()),
            actor: ACTOR,
            occurredAt: "2026-11-19T12:02:30.000Z",
            payload: { kind: "project-binding-relinked", project: projectV2 },
          },
        ],
      });

      const replayed = new ThreadFinishedReceiptStore({
        journal,
        uuid: randomUUID,
        actor: ACTOR,
        clock: () => "2026-11-19T12:03:00.000Z",
      });
      expect(replayed.latest(implicitMainThread)?.stale).toBe(true);
      expect(replayed.boardMark(implicitMainThread)).toBeUndefined();
      expect(replayed.latest(explicitMainThread)?.stale).toBe(true);
      expect(replayed.boardMark(explicitMainThread)).toBeUndefined();
      expect(replayed.latest(extraFolderThread)?.stale).toBe(false);
      expect(replayed.boardMark(extraFolderThread)?.provenCount).toBe(1);
      expect(replayed.read(implicitMainThread)).toEqual(store.read(implicitMainThread));
      expect(replayed.read(explicitMainThread)).toEqual(store.read(explicitMainThread));
      expect(replayed.read(extraFolderThread)).toEqual(store.read(extraFolderThread));
    } finally {
      unsubscribe();
    }
  });
});
