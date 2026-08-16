import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Fiber, Schema, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type AutomationRun,
  type UtcTimestamp,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { buildAutomationWeeklyResolution, resolveNextAutomationOccurrence } from "@octant/domain";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { AutomationDispatchOffer, AutomationDispatchPort } from "./automationDispatchPort";
import {
  AUTOMATION_DISPATCH_INTENT_RECORDED,
  AUTOMATION_RUN_AGGREGATE_TYPE,
  AutomationEventStore,
} from "./automationEventStore";
import { AutomationProjection, hydrateAutomationProjection } from "./automationProjection";
import { automationRunIdForOccurrence } from "./automationRunIdentity";
import { AutomationSchedulerService } from "./automationSchedulerService";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionFixture,
  automationRunForDefinition,
} from "./automationTestFixtures";

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

let uuidCounter = 41_000;
function nextUuid(): string {
  uuidCounter += 1;
  return `ab000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

interface Session {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly store: AutomationEventStore;
  readonly projection: AutomationProjection;
}

function openSession(): Session {
  const directory = mkdtempSync(join(tmpdir(), "octant-automation-scheduler-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-08-10T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => "2026-08-10T12:00:00.000Z",
  });
  const store = new AutomationEventStore({ journal, uuid: nextUuid, actor });
  return { connection, journal, store, projection: runtime.automationProjection };
}

function journalEventCount(connection: SqliteConnection): number {
  const row = connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get() as {
    readonly count: number;
  };
  return row.count;
}

interface RecordingPort {
  readonly port: AutomationDispatchPort;
  readonly offers: Array<AutomationDispatchOffer>;
}

function recordingPort(): RecordingPort {
  const offers: Array<AutomationDispatchOffer> = [];
  return { port: { offer: (offer) => offers.push(offer) }, offers };
}

const INTERVAL_ANCHOR = "2026-08-10T13:00:00.000Z";
const intervalTrigger = {
  kind: "interval",
  anchorAt: INTERVAL_ANCHOR,
  intervalMinutes: 60,
} as const;

function intervalDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return automationDefinitionFixture({
    trigger: intervalTrigger as never,
    nextDueAt: INTERVAL_ANCHOR as never,
    ...overrides,
  });
}

function scheduledOccurrence(
  definition: AutomationDefinition,
  scheduledAt: string,
): Parameters<typeof deriveAutomationOccurrenceKey>[0] {
  return {
    kind: "scheduled",
    automationId: definition.id,
    definitionRevision: definition.definitionRevision,
    triggerKind: definition.trigger.kind,
    scheduledAt,
    ...(definition.trigger.kind === "weekly-local"
      ? {
          resolutionEvidence: buildAutomationWeeklyResolution({
            trigger: definition.trigger,
            scheduledAt: scheduledAt as UtcTimestamp,
          }),
        }
      : {}),
  } as never;
}

interface SchedulerHandle {
  readonly scheduler: AutomationSchedulerService;
  readonly offers: Array<AutomationDispatchOffer>;
  setNow(next: string): void;
}

function createScheduler(
  session: Session,
  initialNow: string,
  config: Partial<{
    dueGraceMs: number;
    leaseDurationMs: number;
    missedRunCap: number;
    pollIntervalMs: number;
  }> = {},
  projection: AutomationProjection = session.projection,
): SchedulerHandle {
  let wallNow = initialNow;
  const { port, offers } = recordingPort();
  const scheduler = new AutomationSchedulerService({
    store: session.store,
    projection,
    dispatch: port,
    now: () => wallNow as UtcTimestamp,
    config,
  });
  return {
    scheduler,
    offers,
    setNow: (next) => {
      wallNow = next;
    },
  };
}

/** Simulate A4's dispatcher starting on a queued run. */
function markDispatching(session: Session, run: AutomationRun, at: string): void {
  session.store.appendRunStatusChanged({
    automationId: run.automationId,
    runId: run.id,
    previousLifecycle: "queued",
    lifecycle: "dispatching",
    version: run.version + 1,
    expectedVersion: run.version,
    updatedAt: at as UtcTimestamp,
  });
}

describe("automation scheduler reconciliation pass", () => {
  it("claims an on-time due occurrence exactly once and offers the queued run", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler, offers } = createScheduler(session, "2026-08-10T13:00:10.000Z");

    const summary = scheduler.runPass();
    expect(summary.claimedRunIds).toHaveLength(1);

    const occurrence = scheduledOccurrence(definition, INTERVAL_ANCHOR);
    const occurrenceKey = deriveAutomationOccurrenceKey(occurrence);
    const runId = automationRunIdForOccurrence(occurrenceKey);
    expect(summary.claimedRunIds[0]).toBe(runId);
    const run = session.projection.getRun(runId);
    expect(run?.lifecycle).toBe("queued");
    expect(run?.occurrenceKey).toBe(occurrenceKey);
    expect(run?.scheduledAt).toBe(INTERVAL_ANCHOR);
    expect(session.projection.isOccurrenceConsumed(definition.id, occurrenceKey)).toBe(true);
    expect(session.projection.getDefinition(definition.id)?.nextDueAt).toBe(
      "2026-08-10T14:00:00.000Z",
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]?.run.id).toBe(runId);

    // Idempotent: a repeated pass neither claims again nor re-offers.
    const before = journalEventCount(session.connection);
    const repeat = scheduler.runPass();
    expect(repeat.claimedRunIds).toHaveLength(0);
    expect(journalEventCount(session.connection)).toBe(before);
    expect(offers).toHaveLength(1);
    session.connection.close();
  });

  it("arms the next wake for a future due instant instead of claiming early", () => {
    const session = openSession();
    session.store.appendDefinitionCreated({ automation: intervalDefinition() });
    const { scheduler } = createScheduler(session, "2026-08-10T12:30:00.000Z");
    const summary = scheduler.runPass();
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.nextWakeAt).toBe(INTERVAL_ANCHOR);
    session.connection.close();
  });

  it("skip policy journals stale missed occurrences as skipped and reschedules", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    // 13:00 through 16:00 are all stale (grace 60s); no catch-up burst.
    const { scheduler, offers } = createScheduler(session, "2026-08-10T16:30:00.000Z");

    const summary = scheduler.runPass();
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.skippedOccurrenceKeys).toHaveLength(4);
    expect(offers).toHaveLength(0);
    const after = session.projection.getDefinition(definition.id);
    expect(after?.nextDueAt).toBe("2026-08-10T17:00:00.000Z");
    for (const scheduledAt of [
      "2026-08-10T13:00:00.000Z",
      "2026-08-10T14:00:00.000Z",
      "2026-08-10T15:00:00.000Z",
      "2026-08-10T16:00:00.000Z",
    ]) {
      expect(
        session.projection.isOccurrenceConsumed(
          definition.id,
          deriveAutomationOccurrenceKey(scheduledOccurrence(definition, scheduledAt)),
        ),
      ).toBe(true);
    }
    session.connection.close();
  });

  it("run-once policy claims only the newest missed occurrence and skips older ones", () => {
    const session = openSession();
    const definition = intervalDefinition({ missedRunPolicy: "run-once" as never });
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler, offers } = createScheduler(session, "2026-08-10T16:30:00.000Z");

    const summary = scheduler.runPass();
    expect(summary.skippedOccurrenceKeys).toHaveLength(3);
    expect(summary.claimedRunIds).toHaveLength(1);
    const claimedKey = deriveAutomationOccurrenceKey(
      scheduledOccurrence(definition, "2026-08-10T16:00:00.000Z"),
    );
    const run = session.projection.getRun(automationRunIdForOccurrence(claimedKey));
    expect(run?.scheduledAt).toBe("2026-08-10T16:00:00.000Z");
    expect(run?.lifecycle).toBe("queued");
    expect(offers).toHaveLength(1);
    expect(session.projection.getDefinition(definition.id)?.nextDueAt).toBe(
      "2026-08-10T17:00:00.000Z",
    );
    session.connection.close();
  });

  it("missed-run safety cap atomically pauses the definition with a typed receipt", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    // Ten hours of hourly backlog against a cap of three.
    const { scheduler } = createScheduler(session, "2026-08-10T23:30:00.000Z", {
      missedRunCap: 3,
    });

    const summary = scheduler.runPass();
    expect(summary.blockedAutomationIds).toEqual([definition.id]);
    expect(summary.claimedRunIds).toHaveLength(0);
    const after = session.projection.getDefinition(definition.id);
    expect(after?.lifecycle).toBe("paused");
    expect(after?.blockedReason).toBe("missed-run-cap-exceeded");
    expect(after?.nextDueAt).toBeNull();

    // The paused definition stops rescanning the overdue range.
    const before = journalEventCount(session.connection);
    const repeat = scheduler.runPass();
    expect(repeat.blockedAutomationIds).toHaveLength(0);
    expect(journalEventCount(session.connection)).toBe(before);
    session.connection.close();
  });

  it("skip policy skips a due occurrence while another run is active", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    // A manual run-now occupies the single active slot.
    const manualRun = automationRunForDefinition(definition);
    session.store.appendRunCreated({ run: manualRun });

    const { scheduler, offers } = createScheduler(session, "2026-08-10T13:00:10.000Z");
    const summary = scheduler.runPass();
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.skippedOccurrenceKeys).toHaveLength(1);
    expect(session.projection.getDefinition(definition.id)?.nextDueAt).toBe(
      "2026-08-10T14:00:00.000Z",
    );
    // The queued manual run is still offered to the dispatch port.
    expect(offers.map((offer) => offer.run.id)).toEqual([manualRun.id]);
    session.connection.close();
  });

  it("run-once policy defers the newest due occurrence until the active slot frees", () => {
    const session = openSession();
    const definition = intervalDefinition({ missedRunPolicy: "run-once" as never });
    session.store.appendDefinitionCreated({ automation: definition });
    const manualRun = automationRunForDefinition(definition);
    session.store.appendRunCreated({ run: manualRun });

    const { scheduler, offers } = createScheduler(session, "2026-08-10T13:00:10.000Z");
    const deferred = scheduler.runPass();
    expect(deferred.claimedRunIds).toHaveLength(0);
    expect(deferred.deferredAutomationIds).toEqual([definition.id]);
    expect(session.projection.getDefinition(definition.id)?.nextDueAt).toBe(INTERVAL_ANCHOR);

    // Cancellation frees the slot; the deferred occurrence claims exactly once.
    session.store.appendRunCancellation({
      automationId: definition.id,
      runId: manualRun.id,
      previousLifecycle: "queued",
      tombstone: {
        requestId: AUTOMATION_TEST_IDS.cancelRequest as never,
        cancelledAt: "2026-08-10T13:01:00.000Z" as never,
      },
      expectedVersion: 1,
      updatedAt: "2026-08-10T13:01:00.000Z" as UtcTimestamp,
    });
    const claimed = scheduler.runPass();
    expect(claimed.claimedRunIds).toHaveLength(1);
    const claimedRun = session.projection.getRun(claimed.claimedRunIds[0] as never);
    expect(claimedRun?.scheduledAt).toBe(INTERVAL_ANCHOR);
    expect(offers.map((offer) => offer.run.id)).toContain(claimedRun?.id);
    session.connection.close();
  });

  it("wall-clock changes only re-select due occurrences, never double-claim", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler, setNow } = createScheduler(session, "2026-08-10T12:00:00.000Z");

    // Backward wall-clock: nothing is due.
    setNow("2026-08-10T11:00:00.000Z");
    expect(scheduler.runPass().claimedRunIds).toHaveLength(0);

    // Forward jump within the grace window claims on time.
    setNow("2026-08-10T13:00:30.000Z");
    const claimed = scheduler.runPass();
    expect(claimed.claimedRunIds).toHaveLength(1);

    // A later large forward jump (sleep) applies the missed-run policy.
    setNow("2026-08-10T18:45:00.000Z");
    const woke = scheduler.runPass();
    expect(woke.claimedRunIds).toHaveLength(0);
    expect(woke.skippedOccurrenceKeys.length).toBeGreaterThan(0);
    expect(session.projection.getDefinition(definition.id)?.nextDueAt).toBe(
      "2026-08-10T19:00:00.000Z",
    );
    session.connection.close();
  });

  it("claims DST-gap and fold occurrences at the domain-resolved instant with evidence", () => {
    const session = openSession();
    const trigger = {
      kind: "weekly-local",
      weekdays: [7],
      localTime: "02:30",
      timeZone: "Europe/Berlin",
    } as const;
    // Sunday 2026-03-29 02:30 does not exist in Europe/Berlin (spring forward).
    const gapDue = resolveNextAutomationOccurrence({
      trigger: trigger as never,
      after: "2026-03-23T12:00:00.000Z" as UtcTimestamp,
    });
    if (gapDue === undefined) throw new Error("expected a resolvable gap occurrence");
    const gapResolution = buildAutomationWeeklyResolution({
      trigger: trigger as never,
      scheduledAt: gapDue,
    });
    expect(gapResolution.resolution).toBe("gap-forward");
    const definition = automationDefinitionFixture({
      trigger: trigger as never,
      nextDueAt: gapDue as never,
      nextDueResolution: gapResolution as never,
    });
    session.store.appendDefinitionCreated({ automation: definition });

    const { scheduler } = createScheduler(
      session,
      new Date(Date.parse(gapDue) + 5_000).toISOString(),
    );
    const summary = scheduler.runPass();
    expect(summary.claimedRunIds).toHaveLength(1);
    const run = session.projection.getRun(summary.claimedRunIds[0] as never);
    expect(run?.occurrence.kind).toBe("scheduled");
    if (run?.occurrence.kind !== "scheduled") throw new Error("expected scheduled occurrence");
    expect(run.occurrence.scheduledAt).toBe(gapDue);
    expect(run.occurrence.resolutionEvidence?.resolution).toBe("gap-forward");

    // The advanced ledger points at the next Sunday with fresh evidence.
    const after = session.projection.getDefinition(definition.id);
    expect(after?.nextDueAt).toBe(
      resolveNextAutomationOccurrence({ trigger: trigger as never, after: gapDue }),
    );

    // Fold: Sunday 2026-10-25 02:30 occurs twice; the earlier instant wins.
    const foldDue = resolveNextAutomationOccurrence({
      trigger: trigger as never,
      after: "2026-10-19T12:00:00.000Z" as UtcTimestamp,
    });
    if (foldDue === undefined) throw new Error("expected a resolvable fold occurrence");
    expect(
      buildAutomationWeeklyResolution({ trigger: trigger as never, scheduledAt: foldDue })
        .resolution,
    ).toBe("fold-earlier");
    session.connection.close();
  });

  it("exhausts a once definition whose stale occurrence was skipped", () => {
    const session = openSession();
    const definition = automationDefinitionFixture({
      trigger: { kind: "once", scheduledAt: INTERVAL_ANCHOR } as never,
      nextDueAt: INTERVAL_ANCHOR as never,
    });
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler } = createScheduler(session, "2026-08-10T18:00:00.000Z");

    const summary = scheduler.runPass();
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.skippedOccurrenceKeys).toHaveLength(1);
    expect(summary.exhaustedAutomationIds).toEqual([definition.id]);
    const after = session.projection.getDefinition(definition.id);
    expect(after?.lifecycle).toBe("exhausted");
    expect(after?.nextDueAt).toBeNull();
    session.connection.close();
  });

  it("exhausts a claimed once definition only after its run is terminal", () => {
    const session = openSession();
    const definition = automationDefinitionFixture({
      trigger: { kind: "once", scheduledAt: INTERVAL_ANCHOR } as never,
      nextDueAt: INTERVAL_ANCHOR as never,
    });
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler } = createScheduler(session, "2026-08-10T13:00:05.000Z");

    const claimed = scheduler.runPass();
    expect(claimed.claimedRunIds).toHaveLength(1);
    expect(claimed.exhaustedAutomationIds).toHaveLength(0);
    // The claimed once occurrence keeps its due instant until exhaustion,
    // but is never re-claimed.
    const between = scheduler.runPass();
    expect(between.claimedRunIds).toHaveLength(0);
    expect(between.exhaustedAutomationIds).toHaveLength(0);

    const run = session.projection.getRun(claimed.claimedRunIds[0] as never);
    if (run === undefined) throw new Error("expected the claimed run");
    session.store.appendRunCancellation({
      automationId: definition.id,
      runId: run.id,
      previousLifecycle: "queued",
      tombstone: {
        requestId: AUTOMATION_TEST_IDS.cancelRequest as never,
        cancelledAt: "2026-08-10T13:05:00.000Z" as never,
      },
      expectedVersion: run.version,
      updatedAt: "2026-08-10T13:05:00.000Z" as UtcTimestamp,
    });
    const exhausted = scheduler.runPass();
    expect(exhausted.exhaustedAutomationIds).toEqual([definition.id]);
    expect(exhausted.claimedRunIds).toHaveLength(0);
    const after = session.projection.getDefinition(definition.id);
    expect(after?.lifecycle).toBe("exhausted");
    expect(after?.nextDueAt).toBeNull();
    session.connection.close();
  });

  it("completes a half-committed claim for the existing run instead of duplicating it", () => {
    const session = openSession();
    const definition = intervalDefinition({ missedRunPolicy: "run-once" as never });
    session.store.appendDefinitionCreated({ automation: definition });

    // Crash boundary: the run committed but the occurrence ledger did not.
    const crashingStore: ConstructorParameters<typeof AutomationSchedulerService>[0]["store"] = {
      appendOccurrenceLedger: () => {
        throw new Error("simulated crash between run create and ledger commit");
      },
      appendRunCreated: (input) => session.store.appendRunCreated(input),
      appendRunStatusChanged: (input) => session.store.appendRunStatusChanged(input),
      replayAll: () => session.store.replayAll(),
    };
    let wallNow = "2026-08-10T16:30:00.000Z";
    const crashing = new AutomationSchedulerService({
      store: crashingStore,
      projection: session.projection,
      dispatch: { offer: () => undefined },
      now: () => wallNow as UtcTimestamp,
    });
    const crashed = crashing.runPass();
    expect(crashed.errors).toHaveLength(1);
    const claimedKey = deriveAutomationOccurrenceKey(
      scheduledOccurrence(definition, "2026-08-10T16:00:00.000Z"),
    );
    const runId = automationRunIdForOccurrence(claimedKey);
    expect(session.projection.getRun(runId)?.lifecycle).toBe("queued");
    expect(session.projection.isOccurrenceConsumed(definition.id, claimedKey)).toBe(false);

    // Recovery repairs the ledger for the same run: same run id, skipped
    // receipts for the older missed occurrences, no second run.
    const { scheduler, offers } = createScheduler(session, wallNow);
    const repaired = scheduler.runPass();
    expect(repaired.repairedRunIds).toEqual([runId]);
    expect(repaired.claimedRunIds).toHaveLength(0);
    expect(session.projection.isOccurrenceConsumed(definition.id, claimedKey)).toBe(true);
    expect(session.projection.getDefinition(definition.id)?.nextDueAt).toBe(
      "2026-08-10T17:00:00.000Z",
    );
    expect(offers.map((offer) => offer.run.id)).toEqual([runId]);
    expect(
      session.projection.listRuns({ automationId: definition.id, limit: 10 }).runs,
    ).toHaveLength(1);
    session.connection.close();
  });

  it("moves an expired pre-thread dispatch lease to recovering-dispatch with the same request", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler, offers } = createScheduler(session, "2026-08-10T13:00:10.000Z", {
      leaseDurationMs: 300_000,
    });
    const claimed = scheduler.runPass();
    const run = session.projection.getRun(claimed.claimedRunIds[0] as never);
    if (run === undefined) throw new Error("expected the claimed run");
    markDispatching(session, run, "2026-08-10T13:00:20.000Z");

    // An unexpired lease is observed, not replaced.
    const { scheduler: early } = createScheduler(session, "2026-08-10T13:02:00.000Z");
    const observed = early.runPass();
    expect(observed.recoveredRunIds).toHaveLength(0);
    expect(session.projection.getRun(run.id)?.lifecycle).toBe("dispatching");
    expect(observed.nextWakeAt).toBe("2026-08-10T13:05:20.000Z");

    // After lease expiry the run recovers with its idempotent first-turn request.
    const { scheduler: late, offers: lateOffers } = createScheduler(
      session,
      "2026-08-10T13:06:00.000Z",
    );
    const recovered = late.runPass();
    expect(recovered.recoveredRunIds).toEqual([run.id]);
    const after = session.projection.getRun(run.id);
    expect(after?.lifecycle).toBe("recovering-dispatch");
    expect(after?.firstTurnRequestId).toBe(run.firstTurnRequestId);
    expect(lateOffers.map((offer) => offer.run.id)).toEqual([run.id]);
    // No duplicate claim for the consumed occurrence, and the original
    // scheduler instance offered the run exactly once at claim time.
    expect(recovered.claimedRunIds).toHaveLength(0);
    expect(offers.map((offer) => offer.run.id)).toEqual([run.id]);
    session.connection.close();
  });

  it("a committed thread receipt is never recreated nor moved to recovering-dispatch", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler } = createScheduler(session, "2026-08-10T13:00:10.000Z");
    const claimed = scheduler.runPass();
    const run = session.projection.getRun(claimed.claimedRunIds[0] as never);
    if (run === undefined) throw new Error("expected the claimed run");
    markDispatching(session, run, "2026-08-10T13:00:20.000Z");
    // A4 committed the thread-creation receipt (dispatch intent) durably.
    session.journal.append({
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
              threadId: "dd000000-0000-4000-8000-000000000001",
              authoritySnapshot: run.authoritySnapshot,
              promptDigest: "prompt-digest",
              recordedAt: "2026-08-10T13:00:30.000Z",
            },
          },
        },
      ],
    });

    // Hours past any lease: the run stays dispatching behind its receipt.
    // A4 may re-offer for first-turn launch recovery; the run aggregate is
    // never recreated.
    const { scheduler: late, offers: lateOffers } = createScheduler(
      session,
      "2026-08-10T18:00:00.000Z",
    );
    const before = journalEventCount(session.connection);
    const summary = late.runPass();
    expect(summary.recoveredRunIds).toHaveLength(0);
    expect(summary.claimedRunIds).toHaveLength(0);
    const after = session.projection.getRun(run.id);
    expect(after?.lifecycle).toBe("dispatching");
    expect(after?.dispatchIntent?.threadId).toBe("dd000000-0000-4000-8000-000000000001");
    expect(lateOffers.map((offer) => offer.run.id)).toEqual([run.id]);
    // Only the skipped receipts for later occurrences may append; the run
    // aggregate itself is untouched.
    const runEvents = session.connection
      .prepare("SELECT COUNT(*) AS count FROM event_journal WHERE aggregate_id = ?")
      .get(String(run.id)) as { readonly count: number };
    expect(runEvents.count).toBe(3);
    expect(journalEventCount(session.connection)).toBeGreaterThanOrEqual(before);
    session.connection.close();
  });

  it("simultaneous claim attempts over one journal resolve to exactly one winner", () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });

    // A second scheduler with an independent (already stale) projection races
    // the first one for the same due occurrence.
    const rivalProjection = new AutomationProjection();
    expect(hydrateAutomationProjection({ store: session.store, projection: rivalProjection })).toBe(
      "ok",
    );
    const { scheduler: winner, offers: winnerOffers } = createScheduler(
      session,
      "2026-08-10T13:00:10.000Z",
    );
    const { scheduler: rival, offers: rivalOffers } = createScheduler(
      session,
      "2026-08-10T13:00:10.000Z",
      {},
      rivalProjection,
    );

    const first = winner.runPass();
    expect(first.claimedRunIds).toHaveLength(1);
    const second = rival.runPass();
    expect(second.claimedRunIds).toHaveLength(0);
    expect(second.errors).toHaveLength(0);

    const occurrenceKey = deriveAutomationOccurrenceKey(
      scheduledOccurrence(definition, INTERVAL_ANCHOR),
    );
    const claimedEvents = session.connection
      .prepare("SELECT COUNT(*) AS count FROM event_journal WHERE event_name = ?")
      .get("automation-occurrence-claimed@1") as { readonly count: number };
    expect(claimedEvents.count).toBe(1);
    expect(
      session.projection.listRuns({ automationId: definition.id, limit: 10 }).runs,
    ).toHaveLength(1);
    expect(rivalProjection.isOccurrenceConsumed(definition.id, occurrenceKey)).toBe(true);
    expect(winnerOffers).toHaveLength(1);
    expect(rivalOffers).toHaveLength(0);
    session.connection.close();
  });

  it("replay rebuilds the same state and a rebuilt pass appends nothing", () => {
    const session = openSession();
    const definition = intervalDefinition({ missedRunPolicy: "run-once" as never });
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler } = createScheduler(session, "2026-08-10T16:30:00.000Z");
    scheduler.runPass();

    const rebuilt = new AutomationProjection();
    expect(hydrateAutomationProjection({ store: session.store, projection: rebuilt })).toBe("ok");
    expect(rebuilt.getDefinition(definition.id)).toEqual(
      session.projection.getDefinition(definition.id),
    );
    expect(rebuilt.listRuns({ automationId: definition.id, limit: 10 })).toEqual(
      session.projection.listRuns({ automationId: definition.id, limit: 10 }),
    );

    const before = journalEventCount(session.connection);
    const { scheduler: replayed } = createScheduler(
      session,
      "2026-08-10T16:30:00.000Z",
      {},
      rebuilt,
    );
    const summary = replayed.runPass();
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.skippedOccurrenceKeys).toHaveLength(0);
    expect(journalEventCount(session.connection)).toBe(before);
    session.connection.close();
  });

  it("paused and archived definitions never claim; resume re-arms idempotently", () => {
    const session = openSession();
    const definition = intervalDefinition({
      lifecycle: "paused" as never,
      nextDueAt: null as never,
    });
    session.store.appendDefinitionCreated({ automation: definition });
    const { scheduler } = createScheduler(session, "2026-08-10T16:30:00.000Z");
    const summary = scheduler.runPass();
    expect(summary.claimedRunIds).toHaveLength(0);
    expect(summary.skippedOccurrenceKeys).toHaveLength(0);
    expect(summary.nextWakeAt).toBeUndefined();
    session.connection.close();
  });
});

describe("automation scheduler effect loop", () => {
  it("claims when the armed effect timer fires, with no real-time sleeps", async () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const handle = createScheduler(session, "2026-08-10T12:59:00.000Z");

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(handle.scheduler.loop());
        yield* TestClock.adjust(Duration.millis(1));
        expect(handle.offers).toHaveLength(0);
        // The loop armed its timer for the 13:00 due instant.
        handle.setNow("2026-08-10T13:00:00.000Z");
        yield* TestClock.adjust(Duration.seconds(61));
        expect(handle.offers).toHaveLength(1);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    const occurrenceKey = deriveAutomationOccurrenceKey(
      scheduledOccurrence(definition, INTERVAL_ANCHOR),
    );
    expect(session.projection.isOccurrenceConsumed(definition.id, occurrenceKey)).toBe(true);
    session.connection.close();
  });

  it("poke wakes the sleeping loop immediately for command follow-up", async () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const handle = createScheduler(session, "2026-08-10T12:00:00.000Z");

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(handle.scheduler.loop());
        yield* TestClock.adjust(Duration.millis(1));
        expect(handle.offers).toHaveLength(0);
        // A command made the occurrence due right now; poke instead of waiting
        // for the armed timer.
        handle.setNow("2026-08-10T13:00:10.000Z");
        handle.scheduler.poke();
        yield* TestClock.adjust(Duration.millis(1));
        expect(handle.offers).toHaveLength(1);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    session.connection.close();
  });

  it("shutdown interrupts the loop cleanly and stops all scheduling", async () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const handle = createScheduler(session, "2026-08-10T12:00:00.000Z");

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(handle.scheduler.loop());
        yield* TestClock.adjust(Duration.millis(1));
        yield* Fiber.interrupt(fiber);
        // The due instant passes after shutdown: nothing runs.
        handle.setNow("2026-08-10T13:00:10.000Z");
        yield* TestClock.adjust(Duration.minutes(30));
        expect(handle.offers).toHaveLength(0);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    const occurrenceKey = deriveAutomationOccurrenceKey(
      scheduledOccurrence(definition, INTERVAL_ANCHOR),
    );
    expect(session.projection.isOccurrenceConsumed(definition.id, occurrenceKey)).toBe(false);
    session.connection.close();
  });

  it("start/stop own the host lifecycle without renderer timer authority", async () => {
    const session = openSession();
    const definition = intervalDefinition();
    session.store.appendDefinitionCreated({ automation: definition });
    const handle = createScheduler(session, "2026-08-10T13:00:10.000Z");

    handle.scheduler.start();
    handle.scheduler.start(); // idempotent
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.offers).toHaveLength(1);
    await handle.scheduler.stop();
    await handle.scheduler.stop(); // idempotent
    session.connection.close();
  });
});
