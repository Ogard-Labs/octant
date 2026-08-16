import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutomationSummary,
  decodeAutomationRun,
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type AutomationId,
  type AutomationOccurrence,
  type AutomationRunId,
  type UtcTimestamp,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AUTOMATION_BLOCKED,
  AUTOMATION_DEFINITION_AGGREGATE_TYPE,
  AUTOMATION_DEFINITION_EXHAUSTED,
  AUTOMATION_DISPATCH_INTENT_RECORDED,
  AUTOMATION_FIRST_TURN_ACCEPTED,
  AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED,
  AUTOMATION_OCCURRENCE_CLAIMED,
  AUTOMATION_OCCURRENCE_SKIPPED,
  AUTOMATION_RUN_AGGREGATE_TYPE,
  AutomationEventStore,
  registerAutomationEvents,
} from "./automationEventStore";
import { AutomationProjection } from "./automationProjection";
import { automationRunIdForOccurrence } from "./automationRunIdentity";
import {
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
  automationDefinitionFixture,
  automationRunForDefinition,
} from "./automationTestFixtures";

const directories: Array<string> = [];
const now = AUTOMATION_TEST_NOW as UtcTimestamp;
const later = "2026-08-10T12:10:00.000Z" as UtcTimestamp;

const decodeSummary = Schema.decodeUnknownSync(AutomationSummary, {
  onExcessProperty: "error",
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-automation-projection-"));
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

let uuidCounter = 1_000;
function nextUuid(): string {
  uuidCounter += 1;
  return `cc000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

interface Harness {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly store: AutomationEventStore;
  readonly projection: AutomationProjection;
}

function createHarness(): Harness {
  const connection = openConnection();
  const registry = registerAutomationEvents(new EventRegistry());
  const projection = new AutomationProjection();
  const journal = new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(projection),
    clock: () => now,
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  return { connection, journal, store, projection };
}

function automationId(suffix: string): AutomationId {
  return `aa000000-0000-4000-8000-00000000${suffix}` as AutomationId;
}

function runId(suffix: string): AutomationRunId {
  return `ab000000-0000-4000-8000-00000000${suffix}` as AutomationRunId;
}

describe("automation projection", () => {
  it("projects bounded sanitized summaries with next due and latest run state", () => {
    const { store, projection } = createHarness();
    const work = automationDefinitionFixture({ id: automationId("1001") as never });
    store.appendDefinitionCreated({ automation: work });

    const run = automationRunForDefinition(work, { id: runId("2001") });
    store.appendRunCreated({ run });

    const list = projection.listSummaries({
      hostId: work.hostId,
      mode: "all",
      limit: 10,
    });
    expect(list.items).toHaveLength(1);
    const summary = decodeSummary(list.items[0]);
    expect(summary).toMatchObject({
      id: work.id,
      displayName: work.displayName,
      lifecycle: "enabled",
      nextDueAt: work.nextDueAt,
      latestRunLifecycle: "queued",
      version: 1,
    });
    // Sanitized: the summary never leaks prompts, bindings, receipts, or
    // authority facts.
    const keys = Object.keys(list.items[0] as Record<string, unknown>);
    for (const forbidden of [
      "taskPrompt",
      "binding",
      "executionProfile",
      "authorityProfile",
      "deliveryTarget",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("filters by mode and project, searches names, and paginates with a cursor", () => {
    const { store, projection } = createHarness();
    const first = automationDefinitionFixture({
      id: automationId("1011") as never,
      displayName: "Nightly notes" as never,
    });
    const second = automationDefinitionFixture({
      id: automationId("1012") as never,
      displayName: "Weekly digest" as never,
      updatedAt: later,
      createdAt: later,
    });
    store.appendDefinitionCreated({ automation: first });
    store.appendDefinitionCreated({ automation: second });

    const firstPage = projection.listSummaries({ hostId: first.hostId, mode: "work", limit: 1 });
    expect(firstPage.items.map((item) => item.id)).toEqual([second.id]);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = projection.listSummaries({
      hostId: first.hostId,
      mode: "work",
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map((item) => item.id)).toEqual([first.id]);
    expect(secondPage.nextCursor).toBeUndefined();

    expect(
      projection
        .listSummaries({ hostId: first.hostId, mode: "code", limit: 10 })
        .items.map((item) => item.id),
    ).toEqual([]);
    expect(
      projection
        .listSummaries({ hostId: first.hostId, mode: "all", limit: 10, search: "digest" })
        .items.map((item) => item.id),
    ).toEqual([second.id]);
    expect(
      projection
        .listSummaries({
          hostId: first.hostId,
          mode: "all",
          limit: 10,
          projectId: AUTOMATION_TEST_IDS.otherProject as never,
        })
        .items.map((item) => item.id),
    ).toEqual([]);
  });

  it("keeps bounded newest-first run history with cursor replay", () => {
    const { store, projection } = createHarness();
    const definition = automationDefinitionFixture({ id: automationId("1021") as never });
    store.appendDefinitionCreated({ automation: definition });

    const runIds = ["2011", "2012", "2013"].map((suffix, index) => {
      const run = automationRunForDefinition(definition, {
        id: runId(suffix),
        runNowRequestId: `ad000000-0000-4000-8000-00000000${suffix}`,
        at: `2026-08-10T12:0${index + 1}:00.000Z`,
      });
      store.appendRunCreated({ run });
      return run.id;
    });

    store.appendRunStatusChanged({
      automationId: definition.id,
      runId: runIds[0]!,
      previousLifecycle: "queued",
      lifecycle: "cancelled",
      version: 2,
      expectedVersion: 1,
      updatedAt: later,
    });

    const firstPage = projection.listRuns({ automationId: definition.id, limit: 2 });
    expect(firstPage.runs.map((run) => run.id)).toEqual([runIds[2], runIds[1]]);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = projection.listRuns({
      automationId: definition.id,
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.runs.map((run) => run.id)).toEqual([runIds[0]]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(secondPage.runs[0]?.lifecycle).toBe("cancelled");

    expect(projection.latestRun(definition.id)?.id).toBe(runIds[2]);
    expect(projection.activeRun(definition.id)?.id).toBe(runIds[2]);
    for (const run of firstPage.runs) {
      expect(() => decodeAutomationRun(run)).not.toThrow();
    }
  });

  it("applies run receipts and archive lifecycle while preserving history", () => {
    const { store, projection } = createHarness();
    const definition = automationDefinitionFixture({ id: automationId("1031") as never });
    store.appendDefinitionCreated({ automation: definition });
    const run = automationRunForDefinition(definition, { id: runId("2031") });
    store.appendRunCreated({ run });
    store.appendRunCancellation({
      automationId: definition.id,
      runId: run.id,
      previousLifecycle: "queued",
      tombstone: { requestId: AUTOMATION_TEST_IDS.cancelRequest as never, cancelledAt: later },
      expectedVersion: 1,
      updatedAt: later,
    });

    const cancelled = projection.getRun(run.id);
    expect(cancelled?.lifecycle).toBe("cancelled");
    expect(cancelled?.cancellationTombstone?.requestId).toBe(AUTOMATION_TEST_IDS.cancelRequest);
    expect(cancelled?.version).toBe(3);
    expect(() => decodeAutomationRun(cancelled)).not.toThrow();

    const archived = automationDefinitionFixture({
      id: definition.id as never,
      lifecycle: "archived",
      nextDueAt: null,
      version: 2 as never,
      updatedAt: later,
    });
    store.appendDefinitionLifecycleChanged({
      automation: archived,
      previousLifecycle: "enabled",
      expectedVersion: 1,
    });
    expect(projection.getDefinition(definition.id)?.lifecycle).toBe("archived");
    // Archive preserves run history.
    expect(projection.listRuns({ automationId: definition.id, limit: 10 }).runs).toHaveLength(1);
  });

  it("rebuilds identically from replay and ignores stale duplicate frames", () => {
    const { store, projection } = createHarness();
    const definition = automationDefinitionFixture({ id: automationId("1041") as never });
    store.appendDefinitionCreated({ automation: definition });
    const updated = automationDefinitionFixture({
      id: definition.id as never,
      displayName: "Renamed" as never,
      definitionRevision: 2 as never,
      version: 2 as never,
      updatedAt: later,
    });
    store.appendDefinitionUpdated({
      automation: updated,
      previousDefinitionRevision: 1,
      expectedVersion: 1,
    });

    const replay = store.replayAll();
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;

    const rebuilt = new AutomationProjection();
    for (const envelope of replay.events) rebuilt.apply(undefined as never, envelope);
    // Applying the same frames a second time must not change state.
    for (const envelope of replay.events) rebuilt.apply(undefined as never, envelope);

    expect(rebuilt.getDefinition(definition.id)).toEqual(projection.getDefinition(definition.id));
    expect(rebuilt.listSummaries({ hostId: definition.hostId, mode: "all", limit: 10 })).toEqual(
      projection.listSummaries({ hostId: definition.hostId, mode: "all", limit: 10 }),
    );
  });
});

const INTERVAL_ANCHOR = "2026-08-10T13:00:00.000Z" as UtcTimestamp;
const INTERVAL_NEXT = "2026-08-10T14:00:00.000Z" as UtcTimestamp;

function intervalDefinitionFixture(id: AutomationId): AutomationDefinition {
  return automationDefinitionFixture({
    id: id as never,
    trigger: { kind: "interval", anchorAt: INTERVAL_ANCHOR, intervalMinutes: 60 } as never,
    nextDueAt: INTERVAL_ANCHOR,
  });
}

function scheduledIntervalOccurrence(
  definition: AutomationDefinition,
  scheduledAt: UtcTimestamp,
  definitionRevision = definition.definitionRevision,
): AutomationOccurrence {
  return {
    kind: "scheduled",
    automationId: definition.id,
    definitionRevision,
    triggerKind: "interval",
    scheduledAt,
  } as AutomationOccurrence;
}

function appendDefinitionEvent(
  harness: Harness,
  definition: AutomationDefinition,
  expectedVersion: number,
  eventName: string,
  payload: unknown,
): void {
  harness.journal.append({
    aggregate: {
      aggregateType: AUTOMATION_DEFINITION_AGGREGATE_TYPE,
      aggregateId: String(definition.id),
    },
    expectedVersion,
    events: [
      {
        eventId: nextUuid(),
        eventName,
        eventVersion: 1,
        correlationId: nextUuid(),
        actor,
        occurredAt: later,
        payload,
      },
    ],
  });
}

function appendRunEvent(
  harness: Harness,
  runId: AutomationRunId,
  expectedVersion: number,
  eventName: string,
  payload: unknown,
): void {
  harness.journal.append({
    aggregate: { aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE, aggregateId: String(runId) },
    expectedVersion,
    events: [
      {
        eventId: nextUuid(),
        eventName,
        eventVersion: 1,
        correlationId: nextUuid(),
        actor,
        occurredAt: later,
        payload,
      },
    ],
  });
}

describe("automation projection occurrence ledger", () => {
  it("advances the recurring due ledger when a scheduled occurrence is claimed", () => {
    const harness = createHarness();
    const definition = intervalDefinitionFixture(automationId("1101"));
    harness.store.appendDefinitionCreated({ automation: definition });

    const occurrence = scheduledIntervalOccurrence(definition, INTERVAL_ANCHOR);
    const occurrenceKey = deriveAutomationOccurrenceKey(occurrence);
    appendDefinitionEvent(harness, definition, 1, AUTOMATION_OCCURRENCE_CLAIMED, {
      automationId: definition.id,
      runId: automationRunIdForOccurrence(occurrenceKey),
      occurrence,
      occurrenceKey,
      claimedAt: later,
    });

    const projected = harness.projection.getDefinition(definition.id);
    expect(projected?.nextDueAt).toBe(INTERVAL_NEXT);
    expect(projected?.lifecycle).toBe("enabled");
    expect(projected?.version).toBe(2);
    expect(harness.projection.isOccurrenceConsumed(definition.id, occurrenceKey)).toBe(true);
    expect(
      harness.projection.isOccurrenceConsumed(
        definition.id,
        deriveAutomationOccurrenceKey(scheduledIntervalOccurrence(definition, INTERVAL_NEXT)),
      ),
    ).toBe(false);
  });

  it("advances the ledger for skipped occurrences and records consumed receipts", () => {
    const harness = createHarness();
    const definition = intervalDefinitionFixture(automationId("1102"));
    harness.store.appendDefinitionCreated({ automation: definition });

    const first = scheduledIntervalOccurrence(definition, INTERVAL_ANCHOR);
    const second = scheduledIntervalOccurrence(definition, INTERVAL_NEXT);
    for (const [index, occurrence] of [first, second].entries()) {
      const occurrenceKey = deriveAutomationOccurrenceKey(occurrence);
      appendDefinitionEvent(harness, definition, 1 + index, AUTOMATION_OCCURRENCE_SKIPPED, {
        automationId: definition.id,
        occurrence,
        occurrenceKey,
        skippedAt: later,
        reason: "missed-run-policy",
      });
    }

    const projected = harness.projection.getDefinition(definition.id);
    expect(projected?.nextDueAt).toBe("2026-08-10T15:00:00.000Z");
    expect(projected?.version).toBe(3);
    expect(
      harness.projection.isOccurrenceConsumed(definition.id, deriveAutomationOccurrenceKey(first)),
    ).toBe(true);
    expect(
      harness.projection.isOccurrenceConsumed(definition.id, deriveAutomationOccurrenceKey(second)),
    ).toBe(true);
  });

  it("pauses the definition with a typed reason when a blocked receipt is journaled", () => {
    const harness = createHarness();
    const definition = intervalDefinitionFixture(automationId("1103"));
    harness.store.appendDefinitionCreated({ automation: definition });

    appendDefinitionEvent(harness, definition, 1, AUTOMATION_BLOCKED, {
      automationId: definition.id,
      reason: "missed-run-cap-exceeded",
      examinedFrom: INTERVAL_ANCHOR,
      examinedThrough: INTERVAL_NEXT,
      nextFutureOccurrence: "2026-08-10T15:00:00.000Z",
      recordedAt: later,
    });

    const projected = harness.projection.getDefinition(definition.id);
    expect(projected?.lifecycle).toBe("paused");
    expect(projected?.blockedReason).toBe("missed-run-cap-exceeded");
    expect(projected?.nextDueAt).toBeNull();
    expect(projected?.version).toBe(2);
  });

  it("keeps the once due instant after a claim and clears it only on exhaustion", () => {
    const harness = createHarness();
    const definition = automationDefinitionFixture({ id: automationId("1104") as never });
    if (definition.trigger.kind !== "once") throw new Error("fixture must be once");
    harness.store.appendDefinitionCreated({ automation: definition });

    const occurrence: AutomationOccurrence = {
      kind: "scheduled",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      triggerKind: "once",
      scheduledAt: definition.trigger.scheduledAt,
    } as AutomationOccurrence;
    const occurrenceKey = deriveAutomationOccurrenceKey(occurrence);
    appendDefinitionEvent(harness, definition, 1, AUTOMATION_OCCURRENCE_CLAIMED, {
      automationId: definition.id,
      runId: automationRunIdForOccurrence(occurrenceKey),
      occurrence,
      occurrenceKey,
      claimedAt: later,
    });

    const claimed = harness.projection.getDefinition(definition.id);
    expect(claimed?.nextDueAt).toBe(definition.trigger.scheduledAt);
    expect(claimed?.version).toBe(2);
    expect(harness.projection.isOccurrenceConsumed(definition.id, occurrenceKey)).toBe(true);

    appendDefinitionEvent(harness, definition, 2, AUTOMATION_DEFINITION_EXHAUSTED, {
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      consumedScheduledAt: definition.trigger.scheduledAt,
      version: 3,
    });
    const exhausted = harness.projection.getDefinition(definition.id);
    expect(exhausted?.lifecycle).toBe("exhausted");
    expect(exhausted?.nextDueAt).toBeNull();
    expect(exhausted?.version).toBe(3);
  });

  it("does not mutate a newer revision's schedule from an old revision's occurrence", () => {
    const harness = createHarness();
    const definition = intervalDefinitionFixture(automationId("1105"));
    harness.store.appendDefinitionCreated({ automation: definition });
    const updated = automationDefinitionFixture({
      id: definition.id as never,
      trigger: { kind: "interval", anchorAt: INTERVAL_ANCHOR, intervalMinutes: 120 } as never,
      nextDueAt: INTERVAL_ANCHOR,
      definitionRevision: 2 as never,
      version: 2 as never,
      updatedAt: later,
    });
    harness.store.appendDefinitionUpdated({
      automation: updated,
      previousDefinitionRevision: 1,
      expectedVersion: 1,
    });

    // A claim for the superseded revision arrives late; the aggregate head
    // advances but the newer schedule remains untouched.
    const stale = scheduledIntervalOccurrence(
      definition,
      INTERVAL_ANCHOR,
      definition.definitionRevision,
    );
    const staleKey = deriveAutomationOccurrenceKey(stale);
    appendDefinitionEvent(harness, definition, 2, AUTOMATION_OCCURRENCE_CLAIMED, {
      automationId: definition.id,
      runId: automationRunIdForOccurrence(staleKey),
      occurrence: stale,
      occurrenceKey: staleKey,
      claimedAt: later,
    });

    const projected = harness.projection.getDefinition(definition.id);
    expect(projected?.nextDueAt).toBe(INTERVAL_ANCHOR);
    expect(projected?.version).toBe(3);
  });

  it("attaches dispatch intent, launch claim, and acceptance receipts to the run", () => {
    const harness = createHarness();
    const definition = automationDefinitionFixture({ id: automationId("1106") as never });
    harness.store.appendDefinitionCreated({ automation: definition });
    const run = automationRunForDefinition(definition, { id: runId("2106") });
    harness.store.appendRunCreated({ run });
    harness.store.appendRunStatusChanged({
      automationId: definition.id,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: later,
    });

    const threadId = "ae000000-0000-4000-8000-000000002106";
    appendRunEvent(harness, run.id, 2, AUTOMATION_DISPATCH_INTENT_RECORDED, {
      automationId: definition.id,
      runId: run.id,
      intent: {
        firstTurnRequestId: run.firstTurnRequestId,
        threadId,
        authoritySnapshot: run.authoritySnapshot,
        promptDigest: "prompt-digest",
        recordedAt: later,
      },
    });
    appendRunEvent(harness, run.id, 3, AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED, {
      automationId: definition.id,
      runId: run.id,
      claim: {
        firstTurnRequestId: run.firstTurnRequestId,
        generation: 1,
        leaseExpiresAt: "2026-08-10T12:20:00.000Z",
        claimedAt: later,
      },
    });
    appendRunEvent(harness, run.id, 4, AUTOMATION_FIRST_TURN_ACCEPTED, {
      automationId: definition.id,
      runId: run.id,
      receipt: {
        firstTurnRequestId: run.firstTurnRequestId,
        runtimeReceipt: "provider-turn-1",
        acceptedAt: later,
      },
    });

    const projected = harness.projection.getRun(run.id);
    expect(projected?.threadId).toBe(threadId);
    expect(projected?.dispatchIntent?.threadId).toBe(threadId);
    expect(projected?.runtimeLaunchClaim?.generation).toBe(1);
    expect(projected?.firstTurnAcceptance?.runtimeReceipt).toBe("provider-turn-1");
    expect(projected?.version).toBe(5);

    // Replay is idempotent: re-applying the same frames changes nothing.
    const replay = harness.store.replayAll();
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    const rebuilt = new AutomationProjection();
    for (const envelope of replay.events) rebuilt.applyEnvelope(envelope);
    for (const envelope of replay.events) rebuilt.applyEnvelope(envelope);
    expect(rebuilt.getRun(run.id)).toEqual(projected);
    expect(rebuilt.getDefinition(definition.id)).toEqual(
      harness.projection.getDefinition(definition.id),
    );
  });
});
