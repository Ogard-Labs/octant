import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventActor } from "@octant/contracts/events";
import type { UtcTimestamp } from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AUTOMATION_BLOCKED,
  AUTOMATION_DEFINITION_AGGREGATE_TYPE,
  AUTOMATION_DEFINITION_CREATED,
  AUTOMATION_DEFINITION_EXHAUSTED,
  AUTOMATION_DEFINITION_LIFECYCLE_CHANGED,
  AUTOMATION_DEFINITION_UPDATED,
  AUTOMATION_DISPATCH_INTENT_RECORDED,
  AUTOMATION_FIRST_TURN_ACCEPTED,
  AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED,
  AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED,
  AUTOMATION_OCCURRENCE_CLAIMED,
  AUTOMATION_OCCURRENCE_SKIPPED,
  AUTOMATION_RUN_AGGREGATE_TYPE,
  AUTOMATION_RUN_CREATED,
  AUTOMATION_RUN_STATUS_CHANGED,
  AutomationEventStore,
  AutomationEventStoreError,
  registerAutomationEvents,
} from "./automationEventStore";
import {
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
  automationDefinitionFixture,
  automationRunFixture,
} from "./automationTestFixtures";

const directories: Array<string> = [];
const now = AUTOMATION_TEST_NOW as UtcTimestamp;
const later = "2026-08-10T12:05:00.000Z" as UtcTimestamp;

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-automation-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `bb000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function createStore(connection: SqliteConnection = openConnection()): AutomationEventStore {
  const registry = registerAutomationEvents(new EventRegistry());
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  return new AutomationEventStore({ journal, uuid: nextUuid, actor });
}

describe("automation event store", () => {
  it("appends definition lifecycle events with optimistic concurrency", () => {
    const store = createStore();
    const created = automationDefinitionFixture();
    const createdEnvelope = store.appendDefinitionCreated({ automation: created });
    expect(createdEnvelope.aggregateType).toBe(AUTOMATION_DEFINITION_AGGREGATE_TYPE);
    expect(createdEnvelope.eventName).toBe(AUTOMATION_DEFINITION_CREATED);
    expect(createdEnvelope.aggregateVersion).toBe(1);

    const updated = automationDefinitionFixture({
      displayName: "Weekly summary v2" as never,
      definitionRevision: 2 as never,
      version: 2 as never,
      updatedAt: later,
    });
    const updatedEnvelope = store.appendDefinitionUpdated({
      automation: updated,
      previousDefinitionRevision: created.definitionRevision,
      expectedVersion: 1,
    });
    expect(updatedEnvelope.eventName).toBe(AUTOMATION_DEFINITION_UPDATED);
    expect(updatedEnvelope.aggregateVersion).toBe(2);

    const paused = automationDefinitionFixture({
      lifecycle: "paused",
      definitionRevision: 2 as never,
      nextDueAt: null,
      version: 3 as never,
      updatedAt: later,
    });
    const pausedEnvelope = store.appendDefinitionLifecycleChanged({
      automation: paused,
      previousLifecycle: "enabled",
      expectedVersion: 2,
    });
    expect(pausedEnvelope.eventName).toBe(AUTOMATION_DEFINITION_LIFECYCLE_CHANGED);
    expect(pausedEnvelope.aggregateVersion).toBe(3);

    expect(() =>
      store.appendDefinitionLifecycleChanged({
        automation: paused,
        previousLifecycle: "enabled",
        expectedVersion: 2,
      }),
    ).toThrowError(AutomationEventStoreError);
  });

  it("rejects definition payloads whose version does not extend the expected head", () => {
    const store = createStore();
    const created = automationDefinitionFixture({ version: 2 as never });
    expect(() => store.appendDefinitionCreated({ automation: created })).toThrowError(
      AutomationEventStoreError,
    );
  });

  it("claims a run exactly once and reports a duplicate claim as a conflict", () => {
    const store = createStore();
    const run = automationRunFixture();
    const envelope = store.appendRunCreated({ run });
    expect(envelope.aggregateType).toBe(AUTOMATION_RUN_AGGREGATE_TYPE);
    expect(envelope.eventName).toBe(AUTOMATION_RUN_CREATED);
    expect(envelope.aggregateVersion).toBe(1);

    let conflict: unknown;
    try {
      store.appendRunCreated({ run });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(AutomationEventStoreError);
    expect((conflict as AutomationEventStoreError).category).toBe("conflict");
  });

  it("appends run status changes and an atomic cancellation receipt", () => {
    const store = createStore();
    const run = automationRunFixture();
    store.appendRunCreated({ run });

    const statusEnvelope = store.appendRunStatusChanged({
      automationId: run.automationId,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: later,
    });
    expect(statusEnvelope.eventName).toBe(AUTOMATION_RUN_STATUS_CHANGED);
    expect(statusEnvelope.aggregateVersion).toBe(2);

    const cancellation = store.appendRunCancellation({
      automationId: run.automationId,
      runId: run.id,
      previousLifecycle: "dispatching",
      tombstone: { requestId: AUTOMATION_TEST_IDS.cancelRequest as never, cancelledAt: later },
      expectedVersion: 2,
      updatedAt: later,
    });
    expect(cancellation.map((event) => event.eventName)).toEqual([
      AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED,
      AUTOMATION_RUN_STATUS_CHANGED,
    ]);
    expect(cancellation.map((event) => event.aggregateVersion)).toEqual([3, 4]);

    expect(() =>
      store.appendRunCancellation({
        automationId: run.automationId,
        runId: run.id,
        previousLifecycle: "dispatching",
        tombstone: { requestId: AUTOMATION_TEST_IDS.cancelRequest as never, cancelledAt: later },
        expectedVersion: 2,
        updatedAt: later,
      }),
    ).toThrowError(AutomationEventStoreError);
  });

  it("appends dispatch intent, runtime claim, and first-turn acceptance receipts", () => {
    const store = createStore();
    const run = automationRunFixture();
    store.appendRunCreated({ run });
    store.appendRunStatusChanged({
      automationId: run.automationId,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: later,
    });

    const intentEnvelope = store.appendDispatchIntentRecorded({
      automationId: run.automationId,
      runId: run.id,
      intent: {
        firstTurnRequestId: run.firstTurnRequestId,
        threadId: "dd000000-0000-4000-8000-000000000001" as never,
        authoritySnapshot: run.authoritySnapshot,
        promptDigest: "a".repeat(64) as never,
        recordedAt: later,
      },
      expectedVersion: 2,
    });
    expect(intentEnvelope.eventName).toBe(AUTOMATION_DISPATCH_INTENT_RECORDED);
    expect(intentEnvelope.aggregateVersion).toBe(3);

    const claimEnvelope = store.appendFirstTurnRuntimeClaimed({
      automationId: run.automationId,
      runId: run.id,
      claim: {
        firstTurnRequestId: run.firstTurnRequestId,
        generation: 1 as never,
        claimedAt: later,
        leaseExpiresAt: "2026-08-10T12:10:00.000Z" as never,
      },
      expectedVersion: 3,
    });
    expect(claimEnvelope.eventName).toBe(AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED);

    const acceptedEnvelope = store.appendFirstTurnAccepted({
      automationId: run.automationId,
      runId: run.id,
      receipt: {
        firstTurnRequestId: run.firstTurnRequestId,
        runtimeReceipt: "code-operation:test" as never,
        acceptedAt: later,
      },
      expectedVersion: 4,
    });
    expect(acceptedEnvelope.eventName).toBe(AUTOMATION_FIRST_TURN_ACCEPTED);
    expect(acceptedEnvelope.aggregateVersion).toBe(5);
  });

  it("appends an atomic occurrence ledger batch with sequential versions", () => {
    const store = createStore();
    const definition = automationDefinitionFixture({
      trigger: {
        kind: "interval",
        anchorAt: "2026-08-10T13:00:00.000Z",
        intervalMinutes: 60,
      } as never,
      nextDueAt: "2026-08-10T13:00:00.000Z" as never,
    });
    store.appendDefinitionCreated({ automation: definition });

    const occurrenceAt = (scheduledAt: string) =>
      ({
        kind: "scheduled",
        automationId: definition.id,
        definitionRevision: definition.definitionRevision,
        triggerKind: "interval",
        scheduledAt,
      }) as never;
    const committed = store.appendOccurrenceLedger({
      automationId: definition.id,
      expectedVersion: 1,
      events: [
        {
          kind: "occurrence-skipped",
          occurrence: occurrenceAt("2026-08-10T13:00:00.000Z"),
          reason: "missed-run-policy",
          at: later,
        },
        {
          kind: "occurrence-claimed",
          occurrence: occurrenceAt("2026-08-10T14:00:00.000Z"),
          runId: AUTOMATION_TEST_IDS.run as never,
          at: later,
        },
      ],
    });
    expect(committed.map((event) => event.eventName)).toEqual([
      AUTOMATION_OCCURRENCE_SKIPPED,
      AUTOMATION_OCCURRENCE_CLAIMED,
    ]);
    expect(committed.map((event) => event.aggregateVersion)).toEqual([2, 3]);
    expect(committed.every((event) => event.aggregateId === String(definition.id))).toBe(true);

    // A stale expected version is a typed conflict.
    let conflict: unknown;
    try {
      store.appendOccurrenceLedger({
        automationId: definition.id,
        expectedVersion: 1,
        events: [
          {
            kind: "occurrence-skipped",
            occurrence: occurrenceAt("2026-08-10T15:00:00.000Z"),
            reason: "missed-run-policy",
            at: later,
          },
        ],
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(AutomationEventStoreError);
    expect((conflict as AutomationEventStoreError).category).toBe("conflict");
  });

  it("appends blocked and exhausted ledger receipts and rejects malformed input", () => {
    const store = createStore();
    const definition = automationDefinitionFixture();
    store.appendDefinitionCreated({ automation: definition });

    const blocked = store.appendOccurrenceLedger({
      automationId: definition.id,
      expectedVersion: 1,
      events: [
        {
          kind: "blocked",
          reason: "missed-run-cap-exceeded",
          examinedFrom: "2026-08-10T13:00:00.000Z" as never,
          examinedThrough: "2026-08-10T20:00:00.000Z" as never,
          nextFutureOccurrence: "2026-08-10T21:00:00.000Z" as never,
          at: later,
        },
      ],
    });
    expect(blocked.map((event) => event.eventName)).toEqual([AUTOMATION_BLOCKED]);
    expect(blocked[0]?.aggregateVersion).toBe(2);

    const exhausted = store.appendOccurrenceLedger({
      automationId: definition.id,
      expectedVersion: 2,
      events: [
        {
          kind: "exhausted",
          definitionRevision: definition.definitionRevision,
          consumedScheduledAt:
            definition.trigger.kind === "once" ? definition.trigger.scheduledAt : (now as never),
          at: later,
        },
      ],
    });
    expect(exhausted.map((event) => event.eventName)).toEqual([AUTOMATION_DEFINITION_EXHAUSTED]);
    expect(exhausted[0]?.aggregateVersion).toBe(3);

    // Empty batches and malformed occurrences fail closed without a commit.
    expect(() =>
      store.appendOccurrenceLedger({
        automationId: definition.id,
        expectedVersion: 3,
        events: [],
      }),
    ).toThrowError(AutomationEventStoreError);
    expect(() =>
      store.appendOccurrenceLedger({
        automationId: definition.id,
        expectedVersion: 3,
        events: [
          {
            kind: "occurrence-claimed",
            occurrence: { kind: "scheduled", automationId: definition.id } as never,
            runId: AUTOMATION_TEST_IDS.run as never,
            at: later,
          },
        ],
      }),
    ).toThrowError(AutomationEventStoreError);
  });

  it("replays every automation event in order and fails closed on identity drift", () => {
    const store = createStore();
    const definition = automationDefinitionFixture();
    store.appendDefinitionCreated({ automation: definition });
    const run = automationRunFixture();
    store.appendRunCreated({ run });
    store.appendRunStatusChanged({
      automationId: run.automationId,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: later,
    });

    const replay = store.replayAll();
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.events.map((event) => event.eventName)).toEqual([
      AUTOMATION_DEFINITION_CREATED,
      AUTOMATION_RUN_CREATED,
      AUTOMATION_RUN_STATUS_CHANGED,
    ]);
  });

  it("fails closed when an automation frame is journaled under the wrong aggregate", () => {
    const connection = openConnection();
    const registry = registerAutomationEvents(new EventRegistry());
    const journal = new Journal({
      connection,
      registry,
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    });
    const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
    // A hostile writer journals a run-created frame whose payload identity does
    // not match its aggregate id.
    journal.append({
      aggregate: {
        aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE,
        aggregateId: AUTOMATION_TEST_IDS.otherAutomation,
      },
      expectedVersion: 0,
      events: [
        {
          eventId: nextUuid(),
          eventName: AUTOMATION_RUN_CREATED,
          eventVersion: 1,
          correlationId: AUTOMATION_TEST_IDS.correlation,
          actor,
          occurredAt: now,
          payload: { run: automationRunFixture() },
        },
      ],
    });

    const replay = store.replayAll();
    expect(replay).toEqual({ status: "snapshot-required", reason: "identity-mismatch" });
  });
});
