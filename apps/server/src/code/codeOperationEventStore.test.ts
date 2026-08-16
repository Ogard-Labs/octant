import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorId,
  CodeOperationEventFrame,
  MAX_CODE_CONVERSATION_TURN_STEPS,
  ReplayCursor,
  decodeCodeEvidenceReference,
  decodeCodeOperationEvent,
  decodeCodeOperationId,
  decodeCodeThreadId,
  type CodeOperationEvent,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  CODE_OPERATION_EVENT_RECORDED,
  CodeOperationEventStore,
  CodeOperationEventStoreError,
} from "./codeOperationEventStore";

const now = "2026-07-21T12:00:00.000Z";
const threadId = decodeCodeThreadId("89000000-0000-4000-8000-000000000001");
const otherThreadId = decodeCodeThreadId("89000000-0000-4000-8000-000000000002");
const operationId = decodeCodeOperationId("89000000-0000-4000-8000-000000000010");
const otherOperationId = decodeCodeOperationId("89000000-0000-4000-8000-000000000011");
const actor = {
  kind: "system" as const,
  actorId: Schema.decodeUnknownSync(ActorId)("89000000-0000-4000-8000-000000000020"),
};
const replayCursor = Schema.decodeUnknownSync(ReplayCursor);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodeOperationEventStore", () => {
  it("appends one strict frame with optimistic operation cursor/version", () => {
    const fixture = openJournal();
    const store = createStore(fixture.journal);
    const frame = store.append({
      threadId,
      operationId,
      expectedCursor: 0,
      event: stateEvent("running"),
    });

    expect(frame).toMatchObject({ threadId, operationId, cursor: 1, occurredAt: now });
    expect(fixture.journal.replay(replayCursor({ afterSequence: 0, limit: 10 }))).toMatchObject([
      {
        aggregateType: "code-operation",
        aggregateId: operationId,
        aggregateVersion: 1,
        eventName: CODE_OPERATION_EVENT_RECORDED,
        eventVersion: 1,
        actor,
        payload: frame,
      },
    ]);
    expect(() =>
      store.append({
        threadId,
        operationId,
        expectedCursor: 0,
        event: stateEvent("completed"),
      }),
    ).toThrow(ConcurrencyConflict);
    expect(() =>
      store.append({
        threadId,
        operationId,
        expectedCursor: 1,
        event: { ...stateEvent("completed"), secret: "do-not-store" } as never,
      }),
    ).toThrow(CodeOperationEventStoreError);
    fixture.connection.close();
  });

  it("replays journal truth after restart without in-memory cursor authority", () => {
    const path = databasePath();
    const first = openJournal(path);
    const firstStore = createStore(first.journal);
    firstStore.append({ threadId, operationId, expectedCursor: 0, event: stateEvent("running") });
    firstStore.append({ threadId, operationId, expectedCursor: 1, event: stateEvent("completed") });
    first.connection.close();

    const reopened = openJournal(path);
    const replayed = createStore(reopened.journal).replay({
      threadId,
      operationId,
      afterCursor: 0,
      limit: 10,
    });

    expect(replayed).toMatchObject({
      status: "ok",
      frames: [{ cursor: 1 }, { cursor: 2 }],
      nextCursor: 2,
    });
    reopened.connection.close();
  });

  it("collects every Code operation frame for one thread for board history", () => {
    const fixture = openJournal();
    const store = createStore(fixture.journal);
    store.append({ threadId, operationId, expectedCursor: 0, event: stateEvent("running") });
    store.append({
      threadId: otherThreadId,
      operationId: otherOperationId,
      expectedCursor: 0,
      event: stateEvent("running"),
    });
    store.append({ threadId, operationId, expectedCursor: 1, event: stateEvent("completed") });

    expect(store.historyForThread(threadId)).toMatchObject({
      status: "ok",
      frames: [
        { threadId, operationId, cursor: 1 },
        { threadId, operationId, cursor: 2 },
      ],
    });
    expect(store.historyForThread(otherThreadId)).toMatchObject({
      status: "ok",
      frames: [{ threadId: otherThreadId, operationId: otherOperationId, cursor: 1 }],
    });
    fixture.connection.close();
  });

  it("returns only exact authorized frames after the cursor with a bounded limit", () => {
    const fixture = openJournal();
    const store = createStore(fixture.journal);
    store.append({ threadId, operationId, expectedCursor: 0, event: stateEvent("running") });
    store.append({
      threadId: otherThreadId,
      operationId: otherOperationId,
      expectedCursor: 0,
      event: stateEvent("running"),
    });
    store.append({ threadId, operationId, expectedCursor: 1, event: stateEvent("waiting") });
    store.append({ threadId, operationId, expectedCursor: 2, event: stateEvent("completed") });

    expect(store.replay({ threadId, operationId, afterCursor: 1, limit: 1 })).toMatchObject({
      status: "ok",
      frames: [{ threadId, operationId, cursor: 2 }],
      nextCursor: 2,
    });
    expect(() => store.replay({ threadId, operationId, afterCursor: -1, limit: 1 })).toThrow(
      CodeOperationEventStoreError,
    );
    expect(() => store.replay({ threadId, operationId, afterCursor: 0, limit: 257 })).toThrow(
      CodeOperationEventStoreError,
    );
    fixture.connection.close();
  });

  it("projects paginated thread conversation truth across operations and restart", () => {
    const path = databasePath();
    const first = openJournal(path);
    const store = createStore(first.journal);
    const prompt = decodeCodeEvidenceReference({
      contentId: "89000000-0000-4000-8000-000000000030",
      digest: "d".repeat(64),
      byteLength: 12,
    });
    store.append({
      threadId,
      operationId,
      expectedCursor: 0,
      event: decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: "89000000-0000-4000-8000-000000000040",
        modelId: "model-one",
        sessionId: "89000000-0000-4000-8000-000000000050",
        prompt,
      }),
    });
    store.append({
      threadId,
      operationId,
      expectedCursor: 1,
      event: { kind: "provider-content", channel: "message", content: prompt },
    });
    store.append({ threadId, operationId, expectedCursor: 2, event: stateEvent("completed") });
    store.append({
      threadId,
      operationId: otherOperationId,
      expectedCursor: 0,
      event: decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: "89000000-0000-4000-8000-000000000041",
        modelId: "model-two",
        sessionId: "89000000-0000-4000-8000-000000000051",
        prompt,
      }),
    });
    store.append({
      threadId,
      operationId: otherOperationId,
      expectedCursor: 1,
      event: stateEvent("waiting"),
    });
    first.connection.close();

    const reopened = openJournal(path);
    const restarted = createStore(reopened.journal);
    const firstPage = restarted.conversation({ threadId, afterCursor: 0, limit: 1 });
    expect(firstPage).toMatchObject({
      version: 2,
      threadId,
      hasMore: true,
      turns: [
        {
          operationId,
          modelId: "model-one",
          prompt,
          assistant: [prompt],
          status: "completed",
        },
      ],
    });
    const secondPage = restarted.conversation({
      threadId,
      afterCursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(secondPage).toMatchObject({
      hasMore: false,
      turns: [{ operationId: otherOperationId, modelId: "model-two", status: "waiting" }],
    });
    expect(
      restarted.conversation({ threadId: otherThreadId, afterCursor: 0, limit: 10 }).turns,
    ).toEqual([]);
    reopened.connection.close();
  });

  it("replays a turn's tool calls and reasoning in order, folded and bounded", () => {
    const fixture = openJournal();
    const store = createStore(fixture.journal);
    const prompt = decodeCodeEvidenceReference({
      contentId: "89000000-0000-4000-8000-000000000032",
      digest: "f".repeat(64),
      byteLength: 9,
    });
    const reasoning = decodeCodeEvidenceReference({
      contentId: "89000000-0000-4000-8000-000000000033",
      digest: "a".repeat(64),
      byteLength: 5,
    });
    const toolCallId = "89000000-0000-4000-8000-000000000060";
    let cursor = 0;
    const append = (event: Parameters<typeof store.append>[0]["event"]) =>
      store.append({ threadId, operationId, expectedCursor: cursor++, event });

    append(
      decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: "89000000-0000-4000-8000-000000000040",
        modelId: "model-one",
        sessionId: "89000000-0000-4000-8000-000000000050",
        prompt,
      }),
    );
    append({ kind: "provider-content", channel: "reasoning", content: reasoning });
    append({ kind: "tool-activity", toolCallId, toolName: "Read", state: "started" });
    append({
      kind: "tool-activity",
      toolCallId,
      toolName: "Read",
      state: "completed",
      summary: "read 40 lines",
    });
    append({ kind: "provider-content", channel: "message", content: prompt });
    append(stateEvent("completed"));

    const [turn] = store.conversation({ threadId, afterCursor: 0, limit: 10 }).turns;
    // The message stays the message; the work around it is separate, in the
    // order it happened, with one row per tool call rather than one per event.
    expect(turn?.assistant).toEqual([prompt]);
    expect(turn?.steps).toEqual([
      { kind: "reasoning", content: reasoning },
      {
        kind: "tool",
        toolCallId,
        toolName: "Read",
        state: "completed",
        summary: "read 40 lines",
      },
    ]);
    expect(turn?.stepsTruncated).toBeUndefined();
    fixture.connection.close();
  });

  it("stops recording steps at the bound and says the turn had more", () => {
    const fixture = openJournal();
    const store = createStore(fixture.journal);
    const prompt = decodeCodeEvidenceReference({
      contentId: "89000000-0000-4000-8000-000000000034",
      digest: "b".repeat(64),
      byteLength: 3,
    });
    let cursor = 0;
    const append = (event: Parameters<typeof store.append>[0]["event"]) =>
      store.append({ threadId, operationId, expectedCursor: cursor++, event });
    append(
      decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: "89000000-0000-4000-8000-000000000040",
        modelId: "model-one",
        sessionId: "89000000-0000-4000-8000-000000000050",
        prompt,
      }),
    );
    for (let index = 0; index < MAX_CODE_CONVERSATION_TURN_STEPS + 5; index += 1) {
      append({
        kind: "tool-activity",
        toolCallId: `89000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        toolName: "Read",
        state: "completed",
      });
    }

    const [turn] = store.conversation({ threadId, afterCursor: 0, limit: 10 }).turns;
    expect(turn?.steps).toHaveLength(MAX_CODE_CONVERSATION_TURN_STEPS);
    expect(turn?.stepsTruncated).toBe(true);
    fixture.connection.close();
  });

  it("preserves failed and incomplete provider-turn outcomes honestly", () => {
    const fixture = openJournal();
    const store = createStore(fixture.journal);
    const failedOperation = decodeCodeOperationId("89000000-0000-4000-8000-000000000012");
    const incompleteOperation = decodeCodeOperationId("89000000-0000-4000-8000-000000000013");
    const prompt = decodeCodeEvidenceReference({
      contentId: "89000000-0000-4000-8000-000000000031",
      digest: "e".repeat(64),
      byteLength: 4,
    });
    const started = (modelId: string) =>
      decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: "89000000-0000-4000-8000-000000000040",
        modelId,
        sessionId: "89000000-0000-4000-8000-000000000050",
        prompt,
      });
    store.append({
      threadId,
      operationId: failedOperation,
      expectedCursor: 0,
      event: started("failed-model"),
    });
    store.append({
      threadId,
      operationId: failedOperation,
      expectedCursor: 1,
      event: {
        kind: "operation-result",
        result: {
          kind: "operation-failed",
          operationId: failedOperation,
          failure: { category: "failed", message: "Provider start failed." },
        },
      },
    });
    store.append({
      threadId,
      operationId: incompleteOperation,
      expectedCursor: 0,
      event: started("incomplete-model"),
    });

    expect(store.conversation({ threadId, afterCursor: 0, limit: 10 }).turns).toMatchObject([
      { operationId: failedOperation, status: "failed" },
      { operationId: incompleteOperation, status: "incomplete" },
    ]);
    fixture.connection.close();
  });

  it("requires a snapshot when operation cursors or aggregate versions contain a gap", () => {
    const fixture = openJournal();
    appendRaw(fixture.journal, operationId, 0, frame(2, threadId, operationId));

    expect(
      createStore(fixture.journal).replay({ threadId, operationId, afterCursor: 0, limit: 10 }),
    ).toEqual({ status: "snapshot-required", reason: "gap" });
    fixture.connection.close();
  });

  it("requires a snapshot without returning frames when the aggregate crosses identity", () => {
    const fixture = openJournal();
    appendRaw(fixture.journal, operationId, 0, frame(1, otherThreadId, operationId));

    expect(
      createStore(fixture.journal).replay({ threadId, operationId, afterCursor: 0, limit: 10 }),
    ).toEqual({ status: "snapshot-required", reason: "identity-mismatch" });
    fixture.connection.close();
  });
});

function createStore(journal: Journal): CodeOperationEventStore {
  let uuidCounter = 100;
  return new CodeOperationEventStore({
    journal,
    actor,
    clock: () => now,
    uuid: () => `89000000-0000-4000-8000-${(++uuidCounter).toString().padStart(12, "0")}`,
  });
}

function stateEvent(state: "running" | "waiting" | "completed"): CodeOperationEvent {
  return { kind: "operation-state", state };
}

function frame(cursor: number, authorizedThreadId = threadId, authorizedOperationId = operationId) {
  return {
    threadId: authorizedThreadId,
    operationId: authorizedOperationId,
    cursor,
    occurredAt: now,
    event: stateEvent("running"),
  };
}

function appendRaw(
  journal: Journal,
  aggregateOperationId: typeof operationId,
  expectedVersion: number,
  payload: unknown,
): void {
  journal.append({
    aggregate: { aggregateType: "code-operation", aggregateId: aggregateOperationId },
    expectedVersion,
    events: [
      {
        eventId: "89000000-0000-4000-8000-000000000030",
        eventName: CODE_OPERATION_EVENT_RECORDED,
        eventVersion: 1,
        correlationId: "89000000-0000-4000-8000-000000000031",
        actor,
        occurredAt: now,
        payload,
      },
    ],
  });
}

function openJournal(path = databasePath()): { journal: Journal; connection: SqliteConnection } {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  return {
    connection,
    journal: new Journal({
      connection,
      registry: new EventRegistry().register(
        CODE_OPERATION_EVENT_RECORDED,
        1,
        CodeOperationEventFrame,
      ),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    }),
  };
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-code-operation-events-"));
  directories.push(directory);
  return join(directory, "octant.sqlite3");
}
