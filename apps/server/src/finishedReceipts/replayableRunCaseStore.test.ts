import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_REPLAYABLE_RUN_CASES,
  decodeFinishedReceiptId,
  decodeMentionableThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeThreadRetentionThreadId,
  decodeUtcTimestamp,
  type FinishedReceiptRecorded,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { MIGRATIONS, applyMigrations } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import { PersonMemoryStore, registerPersonMemoryEvents } from "../personMemory/personMemoryStore";
import { ThreadFinishedReceiptStore, registerFinishedReceiptEvents } from "./finishedReceiptStore";
import {
  ReplayableRunCaseStore,
  readLatestFinishedReceiptFromDatabase,
  readReplayableRunCasesFromDatabase,
} from "./replayableRunCaseStore";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

const ACTOR = decodeActor({
  kind: "local-user",
  actorId: "00000000-0000-4000-8000-000000000001",
});
const WORK_PROJECT_ID = decodeProjectId("11111111-1111-4111-8111-111111111111");
const CODE_PROJECT_ID = decodeProjectId("22222222-2222-4222-8222-222222222222");
const PROVIDER_A = decodeProviderInstanceId("33333333-3333-4333-8333-333333333333");
const PROVIDER_B = decodeProviderInstanceId("44444444-4444-4444-8444-444444444444");
const MODEL_SONNET = decodeProviderModelId("claude-sonnet-4-5");
const MODEL_OPUS = decodeProviderModelId("claude-opus-4-1");
const MODEL_GPT = decodeProviderModelId("gpt-5.2");

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
  const dir = mkdtempSync(join(tmpdir(), "octant-replayable-cases-"));
  tempDirs.push(dir);
  const databasePath = join(dir, "octant.sqlite3");
  const connection = openSqlite(databasePath);
  openConnections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => "2026-11-19T12:00:00.000Z");

  let tick = 0;
  const clock = () => {
    tick += 1;
    const minutes = Math.floor(tick / 60);
    const seconds = tick % 60;
    return decodeUtcTimestamp(
      `2026-11-19T12:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`,
    );
  };

  const registry = registerPersonMemoryEvents(registerFinishedReceiptEvents(new EventRegistry()))
    .register("project.created@1", 1, Schema.Unknown)
    .register("project.renamed@1", 1, Schema.Unknown)
    .register("work.thread-created@1", 1, Schema.Unknown)
    .register("work.thread-updated@1", 1, Schema.Unknown)
    .register("work.turn-accepted@1", 1, Schema.Unknown)
    .register("work.turn-updated@1", 1, Schema.Unknown)
    .register("work.thread-rewound@1", 1, Schema.Unknown)
    .register("code.thread-created@1", 1, Schema.Unknown)
    .register("code.thread-updated@1", 1, Schema.Unknown)
    .register("code.operation-event-recorded@1", 1, Schema.Unknown);

  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock,
  });

  const receipts = new ThreadFinishedReceiptStore({
    journal,
    uuid: randomUUID,
    actor: ACTOR,
    clock,
  });

  const personMemory = new PersonMemoryStore({
    connection,
    journal,
    uuid: randomUUID,
    actor: ACTOR,
    clock,
  });

  return { databasePath, connection, journal, receipts, personMemory, clock };
}

function appendEvent(
  journal: Journal,
  input: {
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly expectedVersion: number;
    readonly eventName: string;
    readonly payload: unknown;
    readonly occurredAt?: string;
  },
) {
  journal.append({
    aggregate: {
      aggregateType: input.aggregateType,
      aggregateId: decodeAggregateId(input.aggregateId),
    },
    expectedVersion: decodeAggregateVersion(input.expectedVersion),
    events: [
      {
        eventId: decodeEventId(randomUUID()),
        eventName: input.eventName,
        eventVersion: 1,
        correlationId: decodeCorrelationId(randomUUID()),
        actor: ACTOR,
        occurredAt: input.occurredAt ?? "2026-11-19T12:00:00.000Z",
        payload: input.payload,
      },
    ],
  });
}

function insertCodeEvidence(
  connection: SqliteConnection,
  contentId: string,
  bodyText: string,
): { readonly contentId: string; readonly digest: string; readonly byteLength: number } {
  const digest = createHash("sha256").update(bodyText, "utf8").digest("hex");
  const byteLength = Buffer.byteLength(bodyText, "utf8");
  connection
    .prepare(
      `INSERT INTO code_evidence_content_store (content_id, body_text, digest, byte_length, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(contentId, bodyText, digest, byteLength, "2026-11-19T12:00:00.000Z");
  return { contentId, digest, byteLength };
}

function makeReceipt(input: {
  readonly receiptId?: string;
  readonly threadId: string;
  readonly mode: "work" | "code";
  readonly projectId: typeof WORK_PROJECT_ID;
  readonly turnId?: string;
  readonly summary: string;
  readonly items?: FinishedReceiptRecorded["items"];
  readonly diff?: FinishedReceiptRecorded["diff"];
  readonly recordedAt?: string;
}): FinishedReceiptRecorded {
  return {
    receiptId: decodeFinishedReceiptId(input.receiptId ?? randomUUID()),
    threadId: input.threadId,
    mode: input.mode,
    projectId: input.projectId,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    summary: input.summary,
    items: input.items ?? [
      {
        kind: "check",
        label: "bun run test",
        command: "bun run test",
        status: "proven",
        exitCode: 0,
      },
    ],
    diff: input.diff ?? {
      status: "observed",
      changedFiles: 3,
      insertions: 25,
      deletions: 4,
    },
    recordedAt: decodeUtcTimestamp(input.recordedAt ?? "2026-11-19T12:10:00.000Z"),
  };
}

describe("replayable run case journal projection", () => {
  it("rebuilds cases across Work and Code threads with request, Project, mode, model, receipt, and changed-file count", () => {
    const { databasePath, connection, journal, receipts, personMemory } = openTestJournal();
    try {
      // Seed Projects (including a rename to verify latest Project name is used).
      appendEvent(journal, {
        aggregateType: "project",
        aggregateId: String(WORK_PROJECT_ID),
        expectedVersion: 0,
        eventName: "project.created@1",
        payload: { project: { id: String(WORK_PROJECT_ID), name: "Draft Ops" } },
      });
      appendEvent(journal, {
        aggregateType: "project",
        aggregateId: String(WORK_PROJECT_ID),
        expectedVersion: 1,
        eventName: "project.renamed@1",
        payload: { project: { id: String(WORK_PROJECT_ID), name: "Operations" } },
      });
      appendEvent(journal, {
        aggregateType: "project",
        aggregateId: String(CODE_PROJECT_ID),
        expectedVersion: 0,
        eventName: "project.created@1",
        payload: { project: { id: String(CODE_PROJECT_ID), name: "Octant Repo" } },
      });

      // Work thread with initial prompt + follow-up turn on a different model.
      const workThreadId = randomUUID();
      const workTurn1 = randomUUID();
      const workTurn2 = randomUUID();
      appendEvent(journal, {
        aggregateType: "work-thread",
        aggregateId: workThreadId,
        expectedVersion: 0,
        eventName: "work.thread-created@1",
        payload: {
          thread: {
            id: workThreadId,
            projectId: String(WORK_PROJECT_ID),
            title: "Quarterly report",
            providerInstanceId: String(PROVIDER_A),
            modelId: String(MODEL_SONNET),
          },
        },
      });
      appendEvent(journal, {
        aggregateType: "work-turn",
        aggregateId: randomUUID(),
        expectedVersion: 0,
        eventName: "work.turn-accepted@1",
        payload: {
          kind: "turn-accepted",
          requestId: randomUUID(),
          threadId: workThreadId,
          turnId: workTurn1,
          projectId: String(WORK_PROJECT_ID),
          prompt: "Draft the Q4 status summary from the metrics folder.",
          authority: {
            providerInstanceId: String(PROVIDER_A),
            modelId: String(MODEL_SONNET),
          },
        },
      });
      appendEvent(journal, {
        aggregateType: "work-turn",
        aggregateId: randomUUID(),
        expectedVersion: 0,
        eventName: "work.turn-accepted@1",
        payload: {
          kind: "turn-accepted",
          requestId: randomUUID(),
          threadId: workThreadId,
          turnId: workTurn2,
          projectId: String(WORK_PROJECT_ID),
          prompt: "Tighten the executive summary.",
          authority: {
            providerInstanceId: String(PROVIDER_B),
            modelId: String(MODEL_OPUS),
          },
        },
      });
      const workReceipt = makeReceipt({
        threadId: workThreadId,
        mode: "work",
        projectId: WORK_PROJECT_ID,
        turnId: workTurn2,
        summary: "Drafted and tightened the Q4 status summary.",
        diff: { status: "unavailable", reason: "No Git diff is available for this folder." },
        recordedAt: "2026-11-19T12:05:00.000Z",
      });
      receipts.record(workReceipt);

      // Code thread whose initial prompt lives in code_evidence_content_store.
      const codeThreadId = randomUUID();
      const codeOp1 = randomUUID();
      const codeOp2 = randomUUID();
      appendEvent(journal, {
        aggregateType: "code-thread",
        aggregateId: codeThreadId,
        expectedVersion: 0,
        eventName: "code.thread-created@1",
        payload: {
          thread: {
            id: codeThreadId,
            projectId: String(CODE_PROJECT_ID),
            title: "Parser fix",
            providerInstanceId: String(PROVIDER_A),
            modelId: String(MODEL_SONNET),
          },
        },
      });
      const promptRef1 = insertCodeEvidence(
        connection,
        randomUUID(),
        "Fix the parser crash on empty brackets and add a regression test.",
      );
      const promptRef2 = insertCodeEvidence(connection, randomUUID(), "Run the full test suite.");
      appendEvent(journal, {
        aggregateType: "code-operation",
        aggregateId: codeOp1,
        expectedVersion: 0,
        eventName: "code.operation-event-recorded@1",
        payload: {
          operationId: codeOp1,
          threadId: codeThreadId,
          event: {
            kind: "conversation-turn-started",
            providerInstanceId: String(PROVIDER_A),
            modelId: String(MODEL_SONNET),
            prompt: promptRef1,
          },
        },
      });
      appendEvent(journal, {
        aggregateType: "code-operation",
        aggregateId: codeOp2,
        expectedVersion: 0,
        eventName: "code.operation-event-recorded@1",
        payload: {
          operationId: codeOp2,
          threadId: codeThreadId,
          event: {
            kind: "conversation-turn-started",
            providerInstanceId: String(PROVIDER_B),
            modelId: String(MODEL_GPT),
            prompt: promptRef2,
          },
        },
      });
      const codeReceipt = makeReceipt({
        threadId: codeThreadId,
        mode: "code",
        projectId: CODE_PROJECT_ID,
        turnId: codeOp2,
        summary: "Fixed the parser crash and verified unit tests.",
        diff: { status: "observed", changedFiles: 2, insertions: 19, deletions: 3 },
        recordedAt: "2026-11-19T12:08:00.000Z",
      });
      receipts.record(codeReceipt);

      const store = new ReplayableRunCaseStore({ journal, connection });
      const projected = store.list();
      expect(projected).toHaveLength(2);

      // Newest first: Code case then Work case.
      expect(projected[0]).toEqual({
        receiptId: codeReceipt.receiptId,
        threadId: codeThreadId,
        mode: "code",
        request: "Fix the parser crash on empty brackets and add a regression test.",
        project: { id: CODE_PROJECT_ID, name: "Octant Repo" },
        model: { providerInstanceId: PROVIDER_B, modelId: MODEL_GPT },
        receipt: codeReceipt,
        changedFileCount: 2,
        recordedAt: codeReceipt.recordedAt,
      });

      expect(projected[1]).toEqual({
        receiptId: workReceipt.receiptId,
        threadId: workThreadId,
        mode: "work",
        request: "Draft the Q4 status summary from the metrics folder.",
        project: { id: WORK_PROJECT_ID, name: "Operations" },
        model: { providerInstanceId: PROVIDER_B, modelId: MODEL_OPUS },
        receipt: workReceipt,
        recordedAt: workReceipt.recordedAt,
      });
      expect("changedFileCount" in (projected[1] ?? {})).toBe(false);

      // Read-only database helper produces the exact same projection and receipt lookup.
      expect(readReplayableRunCasesFromDatabase(databasePath)).toEqual(projected);
      expect(readLatestFinishedReceiptFromDatabase(databasePath, codeThreadId)).toEqual({
        receipt: codeReceipt,
        stale: false,
      });
    } finally {
      personMemory.close();
    }
  });

  it("never produces a case for a Leave no trace thread and omits a thread marked Leave no trace on rebuild", () => {
    const { databasePath, connection, journal, receipts, personMemory } = openTestJournal();
    try {
      const untracedBeforeId = randomUUID();
      const markedAfterId = randomUUID();
      const normalId = randomUUID();

      // Mark first thread Leave no trace BEFORE it finishes.
      personMemory.change({
        kind: "set-thread-leaves-no-trace",
        mode: "work",
        threadId: decodeMentionableThreadId(untracedBeforeId),
        leavesNoTrace: true,
      });

      for (const [threadId, prompt] of [
        [untracedBeforeId, "Confidential HR review"],
        [markedAfterId, "Sensitive customer contract"],
        [normalId, "Prepare weekly engineering digest"],
      ] as const) {
        const turnId = randomUUID();
        appendEvent(journal, {
          aggregateType: "work-turn",
          aggregateId: randomUUID(),
          expectedVersion: 0,
          eventName: "work.turn-accepted@1",
          payload: {
            kind: "turn-accepted",
            requestId: randomUUID(),
            threadId,
            turnId,
            projectId: String(WORK_PROJECT_ID),
            prompt,
            authority: {
              providerInstanceId: String(PROVIDER_A),
              modelId: String(MODEL_SONNET),
            },
          },
        });
        receipts.record(
          makeReceipt({
            threadId,
            mode: "work",
            projectId: WORK_PROJECT_ID,
            turnId,
            summary: `Done: ${prompt}`,
          }),
        );
      }

      // Even if the first thread is later unmarked, the receipt recorded while
      // Leave no trace was active never becomes a case.
      personMemory.change({
        kind: "set-thread-leaves-no-trace",
        mode: "work",
        threadId: decodeMentionableThreadId(untracedBeforeId),
        leavesNoTrace: false,
      });

      // Before marking the second thread Leave no trace, only normal + markedAfter appear.
      const store = new ReplayableRunCaseStore({ journal, connection });
      expect(store.list().map((entry) => entry.threadId)).toEqual([normalId, markedAfterId]);

      // Mark the second thread Leave no trace AFTER its receipt was recorded.
      personMemory.change({
        kind: "set-thread-leaves-no-trace",
        mode: "work",
        threadId: decodeMentionableThreadId(markedAfterId),
        leavesNoTrace: true,
      });

      // Rebuilding from the journal omits it cleanly.
      const rebuilt = new ReplayableRunCaseStore({ journal, connection });
      expect(rebuilt.list().map((entry) => entry.threadId)).toEqual([normalId]);
      expect(
        readReplayableRunCasesFromDatabase(databasePath).map((entry) => entry.threadId),
      ).toEqual([normalId]);
    } finally {
      personMemory.close();
    }
  });

  it("removes a purged thread's case automatically on rebuild while preserving surviving threads", () => {
    const { databasePath, connection, journal, receipts, personMemory } = openTestJournal();
    try {
      const purgedThreadId = randomUUID();
      const survivingThreadId = randomUUID();

      for (const [threadId, prompt] of [
        [purgedThreadId, "Temporary scratch investigation"],
        [survivingThreadId, "Keep this reproducible fix"],
      ] as const) {
        const turnId = randomUUID();
        appendEvent(journal, {
          aggregateType: "work-thread",
          aggregateId: threadId,
          expectedVersion: 0,
          eventName: "work.thread-created@1",
          payload: {
            thread: {
              id: threadId,
              projectId: String(WORK_PROJECT_ID),
              title: prompt,
              providerInstanceId: String(PROVIDER_A),
              modelId: String(MODEL_SONNET),
            },
          },
        });
        appendEvent(journal, {
          aggregateType: "work-turn",
          aggregateId: randomUUID(),
          expectedVersion: 0,
          eventName: "work.turn-accepted@1",
          payload: {
            kind: "turn-accepted",
            requestId: randomUUID(),
            threadId,
            turnId,
            projectId: String(WORK_PROJECT_ID),
            prompt,
            authority: {
              providerInstanceId: String(PROVIDER_A),
              modelId: String(MODEL_SONNET),
            },
          },
        });
        receipts.record(
          makeReceipt({
            threadId,
            mode: "work",
            projectId: WORK_PROJECT_ID,
            turnId,
            summary: `Done: ${prompt}`,
          }),
        );
      }

      expect(new ReplayableRunCaseStore({ journal, connection }).list()).toHaveLength(2);

      erasePurgedThread({
        connection,
        mode: "work",
        threadId: decodeThreadRetentionThreadId(purgedThreadId),
      });

      const afterPurge = new ReplayableRunCaseStore({ journal, connection }).list();
      expect(afterPurge.map((entry) => entry.threadId)).toEqual([survivingThreadId]);
      expect(
        readReplayableRunCasesFromDatabase(databasePath).map((entry) => entry.threadId),
      ).toEqual([survivingThreadId]);
    } finally {
      personMemory.close();
    }
  });

  it("retains only the newest 200 cases across journal replay", () => {
    const { databasePath, connection, journal, receipts, personMemory } = openTestJournal();
    try {
      const total = MAX_REPLAYABLE_RUN_CASES + 10;
      const recordedReceiptIds: string[] = [];

      for (let i = 1; i <= total; i += 1) {
        const threadId = randomUUID();
        const turnId = randomUUID();
        appendEvent(journal, {
          aggregateType: "work-turn",
          aggregateId: randomUUID(),
          expectedVersion: 0,
          eventName: "work.turn-accepted@1",
          payload: {
            kind: "turn-accepted",
            requestId: randomUUID(),
            threadId,
            turnId,
            projectId: String(WORK_PROJECT_ID),
            prompt: `Run task ${String(i)}`,
            authority: {
              providerInstanceId: String(PROVIDER_A),
              modelId: String(MODEL_SONNET),
            },
          },
        });
        const receipt = makeReceipt({
          threadId,
          mode: "work",
          projectId: WORK_PROJECT_ID,
          turnId,
          summary: `Completed task ${String(i)}`,
        });
        receipts.record(receipt);
        recordedReceiptIds.push(String(receipt.receiptId));
      }

      const rebuilt = new ReplayableRunCaseStore({ journal, connection }).list();
      expect(rebuilt).toHaveLength(MAX_REPLAYABLE_RUN_CASES);
      expect(String(rebuilt[0]?.receiptId)).toBe(recordedReceiptIds.at(-1));
      expect(String(rebuilt.at(-1)?.receiptId)).toBe(recordedReceiptIds[10]);
      // Oldest 10 receipts were evicted.
      const kept = new Set(rebuilt.map((entry) => String(entry.receiptId)));
      for (let i = 0; i < 10; i += 1) {
        expect(kept.has(recordedReceiptIds[i] ?? "")).toBe(false);
      }

      expect(readReplayableRunCasesFromDatabase(databasePath)).toEqual(rebuilt);
    } finally {
      personMemory.close();
    }
  });
});
