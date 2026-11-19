import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  decodeProjectId,
  decodeThreadGoalId,
  decodeThreadGoalRevisionId,
  decodeUtcTimestamp,
  decodeWindowId,
  type ProviderExecutionPolicy,
  type ThreadGoal,
  type ThreadGoalCriterionId,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
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
    .register("code.operation-event-recorded@1", 1, Schema.Unknown)
    .register("work.turn-updated@1", 1, Schema.Unknown)
    .register("work.artifact-mutation-recorded@1", 1, Schema.Unknown);
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
});
