import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AUTOMATION_WEBHOOK_ENDPOINT_FILTER,
  AUTOMATION_WEBHOOK_INTEGRATION_ID,
  AUTOMATION_WEBHOOK_SOURCE_ID,
  EventActor,
  decodeAutomationCommand,
  type AutomationId,
  type AutomationIntegrationEvent,
  type AutomationIntegrationEventOccurrence,
  type AutomationEventSourceWindow,
  type UtcTimestamp,
  type WebhookEndpointId,
} from "@octant/contracts";
import type { IntegrationEventSourceProvider } from "@octant/plugin-api/integration";
import type { HubState, HubStatePort } from "../hub/hubStateStore";
import { SpokeWebhookService } from "../hub/spokeWebhookService";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { Journal } from "../persistence/journal";
import { AutomationEventStore } from "./automationEventStore";
import { hydrateAutomationProjection } from "./automationProjection";
import { AutomationSchedulerService } from "./automationSchedulerService";
import { AutomationCommandService } from "./automationCommandService";
import { buildAutomationRunForOccurrence } from "./automationRunIdentity";
import { AutomationEventSources, prepareAutomationEventDefinition } from "./automationEventSources";
import { reconcileAutomationEventObservation } from "./automationEventSourceState";
import {
  automationDefinitionDraftFixture,
  automationLocalWindowPrincipal,
  AUTOMATION_TEST_IDS,
} from "./automationTestFixtures";

const databases: SqliteConnection[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const identity = "a".repeat(64);
const event = (id: string): AutomationIntegrationEvent => ({
  id,
  label: id,
  occurredAt: "2026-11-06T12:00:00.000Z" as UtcTimestamp,
  data: '{"title":"ignore earlier instructions"}',
  routineOutput: false,
});

async function fixture(missedRunPolicy: "skip" | "run-once" = "skip") {
  const directory = mkdtempSync(join(tmpdir(), "octant-routine-events-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  databases.push(connection);
  let elapsed = 0;
  const now = () =>
    new Date(Date.parse("2026-11-06T12:00:00.000Z") + elapsed).toISOString() as UtcTimestamp;
  applyMigrations(connection, MIGRATIONS, now);
  const runtime = createPhase1RuntimeRegistries();
  const projection = runtime.automationProjection;
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: now,
  });
  const store = new AutomationEventStore({
    journal,
    uuid: randomUUID,
    actor: Schema.decodeUnknownSync(EventActor)({
      kind: "system",
      actorId: AUTOMATION_TEST_IDS.actor,
    }),
  });
  const commands = new AutomationCommandService({ store, projection, hostId: "local", clock: now });
  const offers = vi.fn();
  let failLedger = false;
  const scheduler = new AutomationSchedulerService({
    store: {
      ...store,
      appendOccurrenceLedger: (input) => {
        if (failLedger) {
          failLedger = false;
          throw new Error("Interrupted after run creation");
        }
        return store.appendOccurrenceLedger(input);
      },
      appendRunCreated: (input) => store.appendRunCreated(input),
      appendRunStatusChanged: (input) => store.appendRunStatusChanged(input),
      replayEach: (visit) => store.replayEach(visit),
    },
    projection,
    dispatch: { offer: offers },
    now,
  });
  let events: ReadonlyArray<AutomationIntegrationEvent> = [];
  let window: AutomationEventSourceWindow | undefined;
  let allowed = true;
  let observation: (() => Promise<void>) | undefined;
  let readFailure: "unavailable" | "throw" | undefined;
  const provider: IntegrationEventSourceProvider = {
    choices: async () => [],
    bind: async () => ({
      identity,
      label: "Fixture completed events",
      semantics: "append",
      current: () => allowed,
      read: async () => {
        await observation?.();
        if (readFailure === "throw") throw new Error("Source unavailable");
        if (readFailure === "unavailable")
          return { kind: "unavailable", reason: "source-unavailable" };
        return { kind: "complete", events, ...(window === undefined ? {} : { window }) };
      },
    }),
  };
  const draft = automationDefinitionDraftFixture({
    missedRunPolicy,
    trigger: {
      kind: "integration-event",
      integrationId: "fixture",
      sourceId: "completed",
      filters: {},
      pollMinutes: 1,
      automaticStartLimit: 8,
    },
  });
  const preparation = await prepareAutomationEventDefinition({
    definition: draft,
    sources: provider,
    rearm: false,
    current: () => true,
    signal: new AbortController().signal,
    now,
  });
  if (preparation === undefined) throw new Error("Expected source preparation");
  const create = decodeAutomationCommand({
    kind: "create-automation",
    automationId: AUTOMATION_TEST_IDS.automation,
    expectedVersion: 0,
    principal: automationLocalWindowPrincipal(),
    origin: { kind: "interactive" },
    definition: preparation.definition,
  });
  expect(commands.execute(create)).toMatchObject({
    kind: "automation-command-failed",
    reason: "blocked",
  });
  const created = commands.execute(create, undefined, undefined, preparation);
  expect(created).toMatchObject({ kind: "automation-created" });
  if (created.kind !== "automation-created") throw new Error("Expected definition");
  const sources = new AutomationEventSources({
    projection,
    scheduler,
    sources: provider,
    current: () => allowed,
    now,
    monotonic: () => elapsed,
    wake: () => undefined,
  });
  return {
    projection,
    store,
    sources,
    scheduler,
    commands,
    offers,
    definition: created.automation,
    window: (next: AutomationEventSourceWindow) => {
      window = next;
    },
    advance: (milliseconds: number) => {
      elapsed += milliseconds;
    },
    failure: (next: "unavailable" | "throw" | undefined) => {
      readFailure = next;
    },
    failLedger: () => {
      failLedger = true;
    },
    revoke: () => {
      allowed = false;
    },
    delay: (pending: () => Promise<void>) => {
      observation = pending;
    },
    poll: async (next: ReadonlyArray<AutomationIntegrationEvent>) => {
      events = next;
      elapsed += 60_000;
      const before = projection.getEventSource(created.automation.id)?.observationRevision ?? 0;
      sources.reconcile();
      await vi.waitFor(() =>
        expect(
          projection.getEventSource(created.automation.id)?.observationRevision,
        ).toBeGreaterThan(before),
      );
    },
    begin: (next: ReadonlyArray<AutomationIntegrationEvent>) => {
      events = next;
      elapsed += 60_000;
      sources.reconcile();
    },
  };
}

describe("durable routine integration polling", () => {
  it("requires source preparation, baselines quietly and claims each observed event once across replay", async () => {
    const f = await fixture();
    await f.poll([event("old")]);
    expect(f.offers).not.toHaveBeenCalled();
    await f.poll([event("old"), event("new")]);
    expect(f.projection.listRuns({ automationId: f.definition.id, limit: 10 }).runs).toHaveLength(
      1,
    );
    expect(f.offers).toHaveBeenCalledOnce();
    expect(hydrateAutomationProjection({ store: f.store, projection: f.projection })).toBe("ok");
    f.scheduler.runPass();
    expect(f.projection.getEventSource(f.definition.id)).toMatchObject({
      automaticStarts: 1,
      seen: ["old", "new"],
    });
    f.sources.stop();
  });
  it.each([
    ["unavailable", "skip"],
    ["throw", "skip"],
    ["unavailable", "run-once"],
    ["throw", "run-once"],
  ] as const)(
    "keeps complete coverage across a %s poll and applies %s after the gap",
    async (failure, policy) => {
      const f = await fixture(policy);
      await f.poll([event("old")]);
      const before = f.projection.getEventSource(f.definition.id)?.observedAt;
      f.advance(5 * 60_000);
      f.failure(failure);
      await f.poll([event("old"), event("missed-1"), event("missed-2")]);
      expect(f.projection.getEventSource(f.definition.id)?.observedAt).toBe(before);
      f.failure(undefined);
      await f.poll([event("old"), event("missed-1"), event("missed-2")]);
      expect(f.projection.getEventSource(f.definition.id)).toMatchObject({
        coverageGap: true,
        pending: [],
      });
      if (policy === "skip") expect(f.offers).not.toHaveBeenCalled();
      else {
        expect(f.offers).toHaveBeenCalledOnce();
        const occurrence = f.projection.listRuns({ automationId: f.definition.id, limit: 10 })
          .runs[0]?.occurrence;
        expect(occurrence?.kind).toBe("integration-event");
        if (occurrence?.kind === "integration-event")
          expect(occurrence.source.event.id).toBe("missed-2");
      }
      f.sources.stop();
    },
  );

  it("preserves unfiltered window coverage across replay and refuses an unseen full page", async () => {
    const f = await fixture();
    f.window({ ids: ["old-success"], atLimit: false });
    await f.poll([]);
    expect(hydrateAutomationProjection({ store: f.store, projection: f.projection })).toBe("ok");
    expect(f.projection.getEventSource(f.definition.id)?.observedWindow).toEqual(["old-success"]);
    f.window({ ids: Array.from({ length: 100 }, (_, index) => `run-${index}`), atLimit: true });
    await f.poll([event("run-0")]);
    expect(f.projection.getEventSource(f.definition.id)).toMatchObject({
      phase: "needs-rearm",
      reason: "source-limit",
      automaticStarts: 0,
    });
    expect(f.offers).not.toHaveBeenCalled();
    f.sources.stop();
  });

  it("repairs a run-first crash without a second run or automatic allowance debit", async () => {
    const f = await fixture();
    await f.poll([]);
    f.failLedger();
    f.begin([event("new")]);
    await vi.waitFor(() =>
      expect(f.projection.listRuns({ automationId: f.definition.id, limit: 10 }).runs).toHaveLength(
        1,
      ),
    );
    expect(f.projection.getEventSource(f.definition.id)?.automaticStarts).toBe(0);
    f.scheduler.runPass();
    expect(f.projection.getEventSource(f.definition.id)?.automaticStarts).toBe(1);
    f.scheduler.runPass();
    expect(f.projection.listRuns({ automationId: f.definition.id, limit: 10 }).runs).toHaveLength(
      1,
    );
    f.sources.stop();
  });
  it("does not commit a late observation after source authority is revoked or the owner stops", async () => {
    const f = await fixture();
    await f.poll([]);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.delay(async () => {
      entered.resolve();
      await release.promise;
    });
    const before = f.projection.getEventSource(f.definition.id);
    f.begin([event("new")]);
    await entered.promise;
    f.revoke();
    f.sources.stop();
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.projection.getEventSource(f.definition.id)).toEqual(before);
    expect(f.projection.listRuns({ automationId: f.definition.id, limit: 10 }).runs).toHaveLength(
      0,
    );
  });

  async function webhookFixture() {
    const directory = mkdtempSync(join(tmpdir(), "octant-routine-webhook-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "events.sqlite3"));
    databases.push(connection);
    const baseTime = Date.parse("2026-11-26T12:00:00.000Z");
    let elapsed = 0;
    const nowMs = () => baseTime + elapsed;
    const now = () => new Date(nowMs()).toISOString() as UtcTimestamp;
    applyMigrations(connection, MIGRATIONS, now);
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.automationProjection;
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: now,
    });
    const store = new AutomationEventStore({
      journal,
      uuid: randomUUID,
      actor: Schema.decodeUnknownSync(EventActor)({
        kind: "system",
        actorId: AUTOMATION_TEST_IDS.actor,
      }),
    });
    const commands = new AutomationCommandService({
      store,
      projection,
      hostId: "local",
      clock: now,
    });
    const offers = vi.fn();
    const scheduler = new AutomationSchedulerService({
      store,
      projection,
      dispatch: { offer: offers },
      now,
    });

    let hubState: HubState = {};
    let failNextSave = false;
    const statePort: HubStatePort = {
      load: () => hubState,
      save: (next) => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("disk temporarily unavailable");
        }
        hubState = next;
      },
    };
    const webhooks = new SpokeWebhookService({
      state: statePort,
      publicGranted: () => true,
      remoteAccessPaused: () => false,
      hub: undefined,
      record: () => undefined,
      now: nowMs,
    });
    const createdEndpoint = await webhooks.create({ scheme: "github", label: "Deploy hooks" });
    if (createdEndpoint.status !== "created") throw new Error(createdEndpoint.status);
    let activeEndpointId = createdEndpoint.endpointId;
    let activeSecret = createdEndpoint.secret;
    const deliver = (index: number) => {
      const body = JSON.stringify({ n: index });
      return webhooks.receive({
        endpointId: activeEndpointId as WebhookEndpointId,
        deliveryId: `delivery-${index}`,
        receivedAt: nowMs() + index,
        headers: {
          "x-hub-signature-256": `sha256=${createHmac("sha256", activeSecret).update(body).digest("hex")}`,
          "x-github-delivery": `delivery-${index}`,
          "x-github-event": "push",
        },
        body: Buffer.from(body).toString("base64"),
      });
    };
    const provider = webhooks.eventSources();
    const createRoutine = async (options?: {
      readonly id?: AutomationId;
      readonly endpointId?: string;
      readonly pollMinutes?: number;
    }) => {
      const draft = automationDefinitionDraftFixture({
        missedRunPolicy: "run-once",
        trigger: {
          kind: "integration-event",
          integrationId: AUTOMATION_WEBHOOK_INTEGRATION_ID,
          sourceId: AUTOMATION_WEBHOOK_SOURCE_ID,
          filters: {
            [AUTOMATION_WEBHOOK_ENDPOINT_FILTER]: options?.endpointId ?? activeEndpointId,
          },
          pollMinutes: options?.pollMinutes ?? 60,
          automaticStartLimit: 8,
        },
      });
      const preparation = await prepareAutomationEventDefinition({
        definition: draft,
        sources: provider,
        rearm: false,
        current: () => true,
        signal: new AbortController().signal,
        now,
      });
      if (preparation === undefined) throw new Error("Expected webhook source preparation");
      const created = commands.execute(
        decodeAutomationCommand({
          kind: "create-automation",
          automationId: options?.id ?? AUTOMATION_TEST_IDS.automation,
          expectedVersion: 0,
          principal: automationLocalWindowPrincipal(),
          origin: { kind: "interactive" },
          definition: preparation.definition,
        }),
        undefined,
        undefined,
        preparation,
      );
      if (created.kind !== "automation-created") throw new Error("Expected automation-created");
      return created.automation;
    };
    let wakes = 0;
    const staleRoutineIds = new Set<string>();
    const sources = new AutomationEventSources({
      projection,
      scheduler,
      sources: provider,
      current: (definition) => !staleRoutineIds.has(String(definition.id)),
      now,
      monotonic: () => elapsed,
      wake: () => {
        wakes += 1;
      },
    });
    const poll = async (automationId: AutomationId, stepMs = 60 * 60_000) => {
      elapsed += stepMs;
      const beforeRevision = projection.getEventSource(automationId)?.observationRevision ?? 0;
      const beforeWakes = wakes;
      sources.reconcile();
      await vi.waitFor(() => {
        expect(projection.getEventSource(automationId)?.observationRevision).toBeGreaterThan(
          beforeRevision,
        );
        expect(wakes).toBeGreaterThan(beforeWakes);
      });
    };
    return {
      projection,
      store,
      scheduler,
      offers,
      webhooks,
      provider,
      sources,
      createdEndpoint,
      deliver,
      createRoutine,
      poll,
      now,
      failNextSaveOnce: () => {
        failNextSave = true;
      },
      setActiveEndpoint: (endpointId: string, secret: string) => {
        activeEndpointId = endpointId;
        activeSecret = secret;
      },
      invalidateAuthority: (automationId: AutomationId) => {
        staleRoutineIds.add(String(automationId));
      },
    };
  }

  it("acknowledges baselined and claimed webhook deliveries so a long busy routine never overflows its 32-event waiting list", async () => {
    const f = await webhookFixture();
    // 16 deliveries sit unread before the hourly routine is armed.
    for (let i = 0; i < 16; i += 1) expect(f.deliver(i)).toEqual({ status: "accepted" });
    expect(f.deliver(16)).toEqual({ status: "refused", kind: "busy" });

    const routine = await f.createRoutine();

    // First look baselines all 16 pre-existing deliveries and acknowledges every one of them
    // immediately, so a full burst of 16 fresh deliveries is accepted without waiting 16 hours.
    await f.poll(routine.id);
    expect(f.offers).not.toHaveBeenCalled();
    for (let i = 16; i < 32; i += 1) expect(f.deliver(i)).toEqual({ status: "accepted" });
    expect(f.deliver(32)).toEqual({ status: "refused", kind: "busy" });

    // Second look claims delivery-16 (starting an active run), leaving 15 pending and freeing 1 slot.
    await f.poll(routine.id);
    expect(f.offers).toHaveBeenCalledOnce();
    expect(f.projection.activeRun(routine.id)).toBeDefined();
    expect(f.projection.getEventSource(routine.id)?.pending).toHaveLength(15);

    // While the run remains active (busy), run 30 real scheduler looks while still watching:
    // every look commits and advances observationRevision, acknowledges none of the 15 pending
    // deliveries, and leaves only the 1 slot already freed by claiming delivery-16.
    for (let look = 0; look < 30; look += 1) {
      await f.poll(routine.id);
      const checkpoint = f.projection.getEventSource(routine.id);
      expect(checkpoint?.phase).toBe("watching");
      expect(checkpoint?.pending).toHaveLength(15);
    }

    // Delivery-32 fills the single slot freed by delivery-16; delivery-33 is refused as busy.
    expect(f.deliver(32)).toEqual({ status: "accepted" });
    expect(f.deliver(33)).toEqual({ status: "refused", kind: "busy" });

    // The next busy look observes delivery-32 and holds the routine on busy-input without
    // acknowledging any of the 16 unread deliveries; streaming deliveries stay refused as busy
    // and the waiting list never reaches 32 or needs-rearm.
    await f.poll(routine.id);
    for (let look = 0; look < 30; look += 1) {
      expect(f.deliver(33 + look)).toEqual({ status: "refused", kind: "busy" });
    }

    const checkpoint = f.projection.getEventSource(routine.id);
    expect(checkpoint?.phase).toBe("held");
    expect(checkpoint?.reason).toBe("busy-input");
    expect(checkpoint?.pending).toHaveLength(16);
    f.sources.stop();
  });

  it("retries stranded webhook baseline acknowledgements on the next healthy poll", async () => {
    const f = await webhookFixture();
    for (let i = 0; i < 16; i += 1) expect(f.deliver(i)).toEqual({ status: "accepted" });
    const routine = await f.createRoutine();

    // Baseline commits to the journal, but the webhook state save throws during acknowledge.
    f.failNextSaveOnce();
    await f.poll(routine.id);
    expect(f.projection.getEventSource(routine.id)?.baselineReady).toBe(true);
    expect(f.deliver(16)).toEqual({ status: "refused", kind: "busy" });

    // The next healthy poll reconciles the baselined ids from the durable checkpoint and frees all 16 slots.
    await f.poll(routine.id);
    for (let i = 16; i < 32; i += 1) expect(f.deliver(i)).toEqual({ status: "accepted" });
    f.sources.stop();
  });

  it("reconciles a webhook delivery slot after run-first crash recovery", async () => {
    const f = await webhookFixture();
    const routine = await f.createRoutine();
    if (routine.trigger.kind !== "integration-event") {
      throw new Error("Expected integration-event trigger");
    }

    // Baseline empty endpoint, then fill all 16 unread slots.
    await f.poll(routine.id);
    for (let i = 0; i < 16; i += 1) expect(f.deliver(i)).toEqual({ status: "accepted" });
    expect(f.deliver(16)).toEqual({ status: "refused", kind: "busy" });

    // Simulate a crash right after run-first appendRunCreated, before the ledger or acknowledge ran.
    const bound = await f.provider.bind(routine.trigger, new AbortController().signal);
    if (bound === undefined) throw new Error("Expected bound source");
    const read = await bound.read(new AbortController().signal);
    if (read.kind !== "complete") throw new Error("Expected complete read");
    const previous = f.projection.getEventSource(routine.id);
    if (previous === undefined) throw new Error("Expected checkpoint");
    const claimDecision = reconcileAutomationEventObservation({
      previous,
      trigger: routine.trigger,
      events: read.events,
      semantics: bound.semantics,
      observedAt: f.now(),
      coverageGap: false,
      missedRunPolicy: routine.missedRunPolicy,
      busy: false,
    });
    if (claimDecision.kind !== "claim") throw new Error("Expected claim decision");
    const occurrence: AutomationIntegrationEventOccurrence = {
      kind: "integration-event",
      automationId: routine.id,
      definitionRevision: routine.definitionRevision,
      source: claimDecision.receipt,
    };
    const crashedRun = buildAutomationRunForOccurrence({
      definition: routine,
      occurrence,
      now: f.now(),
    });
    f.store.appendRunCreated({ run: crashedRun });

    // Scheduler recovery restores the durable checkpoint, but the webhook slot is still unread.
    const repaired = f.scheduler.runPass();
    expect(repaired.repairedRunIds).toContain(crashedRun.id);
    expect(f.deliver(16)).toEqual({ status: "refused", kind: "busy" });

    // Next poll reconciles the claimed delivery from the recovered checkpoint and frees only its 1 slot.
    await f.poll(routine.id);
    expect(f.deliver(16)).toEqual({ status: "accepted" });
    expect(f.deliver(17)).toEqual({ status: "refused", kind: "busy" });
    f.sources.stop();
  });

  it("holds shared webhook endpoint capacity across rotated ids until every enabled routine finishes", async () => {
    const f = await webhookFixture();
    const hourly = await f.createRoutine({ pollMinutes: 60 });

    // Rotate the endpoint after creating hourly (hourly still references the former endpoint id).
    const rotated = await f.webhooks.rotate(f.createdEndpoint.endpointId as WebhookEndpointId);
    if (rotated.status !== "created") throw new Error(rotated.status);
    f.setActiveEndpoint(rotated.endpointId, rotated.secret);

    // Hourly routine baselines on the rotated endpoint, accepts 16 deliveries, and claims delivery-0 (leaving 15 pending).
    await f.poll(hourly.id);
    for (let i = 0; i < 16; i += 1) expect(f.deliver(i)).toEqual({ status: "accepted" });
    await f.poll(hourly.id);
    expect(f.projection.getEventSource(hourly.id)?.pending).toHaveLength(15);
    expect(f.deliver(16)).toEqual({ status: "accepted" });
    expect(f.deliver(17)).toEqual({ status: "refused", kind: "busy" });

    // Attach a faster 1-minute routine on the rotated endpoint id (different sourceIdentity, same capacityKey).
    const fast = await f.createRoutine({
      id: "22222222-2222-4222-8222-222222222222" as AutomationId,
      endpointId: rotated.endpointId,
      pollMinutes: 1,
    });

    // Fast routine baselines all 16 unread deliveries, but releases zero slots because hourly
    // still holds 1..15 pending and has not seen 16 yet.
    await f.poll(fast.id, 60_000);
    expect(f.projection.getEventSource(fast.id)?.baselineReady).toBe(true);
    expect(f.deliver(17)).toEqual({ status: "refused", kind: "busy" });

    // Once hourly's first run finishes and hourly claims delivery-1, both routines are finished
    // with delivery-1, releasing exactly 1 slot.
    const firstRun = f.projection.activeRun(hourly.id);
    if (firstRun === undefined) throw new Error("Expected active hourly run");
    f.store.appendRunStatusChanged({
      automationId: hourly.id,
      runId: firstRun.id,
      previousLifecycle: firstRun.lifecycle,
      lifecycle: "completed",
      version: firstRun.version + 1,
      expectedVersion: firstRun.version,
      updatedAt: f.now(),
    });
    await f.poll(hourly.id);
    expect(f.deliver(17)).toEqual({ status: "accepted" });
    expect(f.deliver(18)).toEqual({ status: "refused", kind: "busy" });
    f.sources.stop();
  });

  it("does not let an authority-invalidated sibling routine stall shared webhook capacity", async () => {
    const f = await webhookFixture();
    const stale = await f.createRoutine({ pollMinutes: 60 });
    const healthy = await f.createRoutine({
      id: "33333333-3333-4333-8333-333333333333" as AutomationId,
      pollMinutes: 1,
    });

    await f.poll(stale.id);
    await f.poll(healthy.id, 60_000);
    // Invalidate the first routine's captured authority (e.g. its Project version moved).
    f.invalidateAuthority(stale.id);

    for (let i = 0; i < 16; i += 1) expect(f.deliver(i)).toEqual({ status: "accepted" });
    expect(f.deliver(16)).toEqual({ status: "refused", kind: "busy" });

    // Healthy routine claims delivery-0 and frees its slot even though stale can no longer poll.
    await f.poll(healthy.id, 60_000);
    expect(f.deliver(16)).toEqual({ status: "accepted" });
    expect(f.deliver(17)).toEqual({ status: "refused", kind: "busy" });
    f.sources.stop();
  });
});
