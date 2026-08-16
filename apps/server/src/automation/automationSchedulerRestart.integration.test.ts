import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type UtcTimestamp,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { AutomationDispatchOffer } from "./automationDispatchPort";
import {
  AUTOMATION_DISPATCH_INTENT_RECORDED,
  AUTOMATION_RUN_AGGREGATE_TYPE,
  AutomationEventStore,
} from "./automationEventStore";
import { hydrateAutomationProjection, type AutomationProjection } from "./automationProjection";
import { automationRunIdForOccurrence } from "./automationRunIdentity";
import { AutomationSchedulerService } from "./automationSchedulerService";
import { AUTOMATION_TEST_IDS, automationDefinitionFixture } from "./automationTestFixtures";

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

let uuidCounter = 61_000;
function nextUuid(): string {
  uuidCounter += 1;
  return `ad000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function storePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return join(directory, "octant.sqlite3");
}

interface Session {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly store: AutomationEventStore;
  readonly projection: AutomationProjection;
  readonly offers: Array<AutomationDispatchOffer>;
  scheduler(now: () => string): AutomationSchedulerService;
}

/** Mirror the production startup order: checkpointed catch-up, then journal hydration. */
function openSession(path: string): Session {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => "2026-08-10T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => "2026-08-10T12:00:00.000Z",
  });
  catchUpProjection({
    connection,
    journal,
    projection: runtime.automationProjection,
    clock: () => "2026-08-10T12:00:00.000Z",
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  expect(hydrateAutomationProjection({ store, projection: runtime.automationProjection })).toBe(
    "ok",
  );
  const offers: Array<AutomationDispatchOffer> = [];
  return {
    connection,
    journal,
    store,
    projection: runtime.automationProjection,
    offers,
    scheduler: (now) =>
      new AutomationSchedulerService({
        store,
        projection: runtime.automationProjection,
        dispatch: { offer: (offer) => offers.push(offer) },
        now: () => now() as UtcTimestamp,
      }),
  };
}

function journalEventCount(connection: SqliteConnection): number {
  const row = connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get() as {
    readonly count: number;
  };
  return row.count;
}

const INTERVAL_ANCHOR = "2026-08-10T13:00:00.000Z";

function intervalDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return automationDefinitionFixture({
    trigger: {
      kind: "interval",
      anchorAt: INTERVAL_ANCHOR,
      intervalMinutes: 60,
    } as never,
    nextDueAt: INTERVAL_ANCHOR as never,
    ...overrides,
  });
}

describe("automation scheduler restart recovery", () => {
  it("repairs a claim that crashed between run create and ledger commit", () => {
    const path = storePath("octant-scheduler-crash-claim-");
    const first = openSession(path);
    const definition = intervalDefinition({ missedRunPolicy: "run-once" as never });
    first.store.appendDefinitionCreated({ automation: definition });

    // The pass commits the run aggregate, then crashes before the ledger.
    const crashingStore: ConstructorParameters<typeof AutomationSchedulerService>[0]["store"] = {
      appendOccurrenceLedger: () => {
        throw new Error("power loss between run create and ledger commit");
      },
      appendRunCreated: (input) => first.store.appendRunCreated(input),
      appendRunStatusChanged: (input) => first.store.appendRunStatusChanged(input),
      replayAll: () => first.store.replayAll(),
    };
    const crashing = new AutomationSchedulerService({
      store: crashingStore,
      projection: first.projection,
      dispatch: { offer: () => undefined },
      now: () => "2026-08-10T16:30:00.000Z" as UtcTimestamp,
    });
    expect(crashing.runPass().errors).toHaveLength(1);
    first.connection.close();

    const second = openSession(path);
    const occurrence = {
      kind: "scheduled",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      triggerKind: "interval",
      scheduledAt: "2026-08-10T16:00:00.000Z",
    } as const;
    const runId = automationRunIdForOccurrence(deriveAutomationOccurrenceKey(occurrence as never));
    // The committed run survived the crash but the occurrence is unconsumed.
    expect(second.projection.getRun(runId)?.lifecycle).toBe("queued");
    expect(
      second.projection.isOccurrenceConsumed(
        definition.id,
        deriveAutomationOccurrenceKey(occurrence as never),
      ),
    ).toBe(false);

    const scheduler = second.scheduler(() => "2026-08-10T16:31:00.000Z");
    const summary = scheduler.runPass();
    expect(summary.repairedRunIds).toEqual([runId]);
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.errors).toHaveLength(0);
    expect(
      second.projection.listRuns({ automationId: definition.id, limit: 10 }).runs,
    ).toHaveLength(1);
    expect(second.projection.getDefinition(definition.id)?.nextDueAt).toBe(
      "2026-08-10T17:00:00.000Z",
    );
    expect(second.offers.map((offer) => offer.run.id)).toEqual([runId]);

    // Idempotent after repair: replayed passes append nothing.
    const before = journalEventCount(second.connection);
    expect(scheduler.runPass().repairedRunIds).toHaveLength(0);
    expect(journalEventCount(second.connection)).toBe(before);
    second.connection.close();
  });

  it("recovers an interrupted pre-thread dispatch lease exactly once across restart", () => {
    const path = storePath("octant-scheduler-crash-lease-");
    const first = openSession(path);
    const definition = intervalDefinition();
    first.store.appendDefinitionCreated({ automation: definition });
    const claimed = first.scheduler(() => "2026-08-10T13:00:10.000Z").runPass();
    expect(claimed.claimedRunIds).toHaveLength(1);
    const runId = claimed.claimedRunIds[0] as never;
    const run = first.projection.getRun(runId);
    if (run === undefined) throw new Error("expected the claimed run");
    // A4's dispatcher started, then the host crashed mid-dispatch.
    first.store.appendRunStatusChanged({
      automationId: definition.id,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });
    first.connection.close();

    // Restart before lease expiry observes the claim instead of replacing it.
    const early = openSession(path);
    const observed = early.scheduler(() => "2026-08-10T13:03:00.000Z").runPass();
    expect(observed.recoveredRunIds).toHaveLength(0);
    expect(early.projection.getRun(runId)?.lifecycle).toBe("dispatching");
    expect(observed.nextWakeAt).toBe("2026-08-10T13:05:20.000Z");
    early.connection.close();

    // Restart after expiry journals exactly one recovering-dispatch
    // transition and retries only the same idempotent first-turn request.
    const late = openSession(path);
    const scheduler = late.scheduler(() => "2026-08-10T13:06:00.000Z");
    const recovered = scheduler.runPass();
    expect(recovered.recoveredRunIds).toEqual([runId]);
    const after = late.projection.getRun(runId);
    expect(after?.lifecycle).toBe("recovering-dispatch");
    expect(after?.firstTurnRequestId).toBe(run.firstTurnRequestId);
    expect(late.offers.map((offer) => offer.run.id)).toEqual([run.id]);
    const before = journalEventCount(late.connection);
    expect(scheduler.runPass().recoveredRunIds).toHaveLength(0);
    expect(journalEventCount(late.connection)).toBe(before);
    late.connection.close();
  });

  it("never recreates a run behind a committed thread receipt across restart", () => {
    const path = storePath("octant-scheduler-crash-receipt-");
    const first = openSession(path);
    const definition = intervalDefinition();
    first.store.appendDefinitionCreated({ automation: definition });
    const claimed = first.scheduler(() => "2026-08-10T13:00:10.000Z").runPass();
    const runId = claimed.claimedRunIds[0] as never;
    const run = first.projection.getRun(runId);
    if (run === undefined) throw new Error("expected the claimed run");
    first.store.appendRunStatusChanged({
      automationId: definition.id,
      runId: run.id,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: "2026-08-10T13:00:20.000Z" as UtcTimestamp,
    });
    // A4 committed the thread-creation receipt, then the host crashed.
    first.journal.append({
      aggregate: { aggregateType: AUTOMATION_RUN_AGGREGATE_TYPE, aggregateId: String(run.id) },
      expectedVersion: 2,
      events: [
        {
          eventId: nextUuid() as never,
          eventName: AUTOMATION_DISPATCH_INTENT_RECORDED,
          eventVersion: 1,
          correlationId: nextUuid() as never,
          actor,
          occurredAt: "2026-08-10T13:00:30.000Z" as never,
          payload: {
            automationId: definition.id,
            runId: run.id,
            intent: {
              firstTurnRequestId: run.firstTurnRequestId,
              threadId: "dd000000-0000-4000-8000-000000000002",
              authoritySnapshot: run.authoritySnapshot,
              promptDigest: "prompt-digest",
              recordedAt: "2026-08-10T13:00:30.000Z",
            },
          },
        },
      ],
    });
    first.connection.close();

    // Hours later, way past any lease: the receipt holds across restart.
    // A4 re-offers the same run for first-turn launch recovery (no claim yet),
    // but never recreates the thread or a second run aggregate.
    const second = openSession(path);
    const summary = second.scheduler(() => "2026-08-10T18:00:00.000Z").runPass();
    expect(summary.recoveredRunIds).toHaveLength(0);
    expect(summary.claimedRunIds).toHaveLength(0);
    const after = second.projection.getRun(runId);
    expect(after?.lifecycle).toBe("dispatching");
    expect(after?.dispatchIntent?.threadId).toBe("dd000000-0000-4000-8000-000000000002");
    expect(
      second.projection.listRuns({ automationId: definition.id, limit: 10 }).runs,
    ).toHaveLength(1);
    expect(second.offers.map((offer) => offer.run.id)).toEqual([runId]);
    second.connection.close();
  });

  it("replays the whole scheduler history into identical projection state", () => {
    const path = storePath("octant-scheduler-replay-");
    const first = openSession(path);
    const definition = intervalDefinition({ missedRunPolicy: "run-once" as never });
    first.store.appendDefinitionCreated({ automation: definition });
    // Claim, skip a backlog, and recover a lease in one history.
    const claimed = first.scheduler(() => "2026-08-10T16:30:00.000Z").runPass();
    expect(claimed.claimedRunIds).toHaveLength(1);
    const runId = claimed.claimedRunIds[0] as never;
    first.store.appendRunStatusChanged({
      automationId: definition.id,
      runId,
      previousLifecycle: "queued",
      lifecycle: "dispatching",
      version: 2,
      expectedVersion: 1,
      updatedAt: "2026-08-10T16:31:00.000Z" as UtcTimestamp,
    });
    expect(first.scheduler(() => "2026-08-10T16:40:00.000Z").runPass().recoveredRunIds).toEqual([
      runId,
    ]);
    const expectedDefinition = first.projection.getDefinition(definition.id);
    const expectedRuns = first.projection.listRuns({ automationId: definition.id, limit: 10 });
    first.connection.close();

    const second = openSession(path);
    expect(second.projection.getDefinition(definition.id)).toEqual(expectedDefinition);
    expect(second.projection.listRuns({ automationId: definition.id, limit: 10 })).toEqual(
      expectedRuns,
    );
    const before = journalEventCount(second.connection);
    const summary = second.scheduler(() => "2026-08-10T16:40:00.000Z").runPass();
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.skippedOccurrenceKeys).toHaveLength(0);
    expect(summary.recoveredRunIds).toHaveLength(0);
    expect(journalEventCount(second.connection)).toBe(before);
    second.connection.close();
  });
});
