// A hub and a spoke in one process, each the real remote gateway behind a real
// TLS listener. The spoke's person ticks Public and Wake, mints an endpoint, and
// the spoke hands the hub its secret sealed to the hub's own key. A delivery
// reaches the hub's real public entrance listener while the spoke's machine is
// stopped; the hub queues it and sends a Wake-on-LAN packet (a fake socket
// records it), and hands it on once the spoke is back. The spoke's scheduler
// and dispatcher start the routine once through the webhook source.

import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_WEBHOOK_ENDPOINT_FILTER,
  AUTOMATION_WEBHOOK_INTEGRATION_ID,
  AUTOMATION_WEBHOOK_SOURCE_ID,
  EventActor,
  decodeAutomationCommand,
  decodeWorkThreadId,
  type HubGrant,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  WORK_TURN_CAPABILITIES,
  decodeStartWorkThreadTurnCommand,
  decodeWorkTurnAccepted,
  decodeWorkTurnUpdated,
} from "@octant/contracts/work-turns";
import { AutomationCommandService } from "../automation/automationCommandService";
import {
  AutomationDispatchService,
  buildAutomationAuthorityFactsFromHost,
} from "../automation/automationDispatchService";
import {
  AutomationEventSources,
  prepareAutomationEventDefinition,
} from "../automation/automationEventSources";
import { AutomationEventStore } from "../automation/automationEventStore";
import { AutomationSchedulerService } from "../automation/automationSchedulerService";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionDraftFixture,
  automationLocalWindowPrincipal,
} from "../automation/automationTestFixtures";
import { createAutomationWorkDispatchPort } from "../automation/automationWorkDispatchPort";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { WorkTurnProjection } from "../work/workTurnProjection";
import { workExternalInputReceipt } from "../work/workExternalInput";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { startPublicEntrance } from "./publicEntrance";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const publicGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "wake", "public"],
  actProjects: [],
};

async function join(hub: HubTestHost, member: HubTestHost) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await member.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration.listPendingPairings().at(-1);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await member.spoke.finishJoin(window);
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

async function postDelivery(
  port: number,
  endpointId: string,
  secret: string,
  id: string,
): Promise<Response> {
  const body = '{"workflow":"nightly","conclusion":"failure"}';
  const seconds = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${seconds}.${body}`)
    .digest("base64");
  return fetch(`http://127.0.0.1:${port}/hooks/${endpointId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(seconds),
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
}

describe("webhook triggers through the hub", () => {
  it("a delivery to a sleeping spoke wakes it and starts its routine once through the public entrance and scheduler", async () => {
    const network = new HubTestNetwork();
    const hub = await startHubTestHost({
      name: "Mac mini",
      address: "100.101.102.103",
      network,
      cleanups,
    });
    const laptop = await startHubTestHost({
      name: "Laptop",
      address: "100.101.102.104",
      network,
      cleanups,
    });
    expect(hub.hub.enable(window).status).toBe("enabled");
    await join(hub, laptop);
    await hub.wake.setEnabled(true, window);
    laptop.spoke.setGrant(publicGrant, window);
    laptop.spokeWake.setHardwareAddress("aa:bb:cc:00:11:22");
    await laptop.spokeWake.report();

    const entrance = await startPublicEntrance({
      port: 0,
      role: () => "serve",
      handlers: () => ({ webhook: (request) => hub.webhooks.handle(request) }),
    });
    cleanups.push(() => entrance.close());

    const created = await laptop.spokeWebhooks.create({
      scheme: "standard-webhooks",
      label: "Nightly CI",
    });
    if (created.status !== "created") throw new Error(created.status);
    expect(created.published).toBe(true);
    expect(hub.webhooks.status().endpoints).toBe(1);

    // Wire the spoke's real automation journal, command service, scheduler, dispatcher, and event sources.
    const autoDir = mkdtempSync(joinPath(tmpdir(), "octant-webhook-smoke-auto-"));
    cleanups.push(() => rmSync(autoDir, { recursive: true, force: true }));
    const connection = openSqlite(joinPath(autoDir, "events.sqlite3"));
    cleanups.push(() => connection.close());
    let elapsed = 0;
    const baseMs = Date.now();
    const now = () => new Date(baseMs + elapsed).toISOString() as UtcTimestamp;
    applyMigrations(connection, MIGRATIONS, now);
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.automationProjection;
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: now,
    });
    const actor = Schema.decodeUnknownSync(EventActor)({
      kind: "system",
      actorId: AUTOMATION_TEST_IDS.actor,
    });
    const store = new AutomationEventStore({
      journal,
      uuid: randomUUID,
      actor,
    });
    const commands = new AutomationCommandService({
      store,
      projection,
      hostId: "local",
      clock: now,
    });
    const workTurns = new WorkTurnProjection();
    const launchedThreads: string[] = [];
    const launchedTurns: Array<{
      readonly threadId: string;
      readonly prompt: string;
      readonly externalDataText?: string | undefined;
    }> = [];
    const work = createAutomationWorkDispatchPort({
      threads: {
        bootstrap: async () => ({ threads: [] }),
        execute: async (_scope, raw) => {
          if (typeof raw !== "object" || raw === null || !("threadId" in raw)) {
            throw new Error("Missing created work thread identity.");
          }
          const threadId = decodeWorkThreadId(raw.threadId);
          launchedThreads.push(String(threadId));
          return { kind: "thread-created", thread: { id: threadId } };
        },
      },
      turns: {
        startFirstTurn: async (_scope, raw, options) => {
          const command = decodeStartWorkThreadTurnCommand(raw);
          launchedTurns.push({
            threadId: String(command.threadId),
            prompt: command.prompt,
            externalDataText: options?.externalData?.content.text,
          });
          const acceptedAt = now();
          const externalInput =
            options?.externalData === undefined
              ? undefined
              : workExternalInputReceipt(options.externalData);
          const accepted = decodeWorkTurnAccepted({
            kind: "turn-accepted",
            requestId: command.requestId,
            threadId: command.threadId,
            turnId: command.turnId,
            projectId: AUTOMATION_TEST_IDS.project,
            authority: command.authority,
            providerSessionId: command.requestId,
            prompt: command.prompt,
            ...(externalInput === undefined ? {} : { externalInput }),
            capabilities: WORK_TURN_CAPABILITIES,
            acceptedAt,
          });
          const completed = decodeWorkTurnUpdated({
            kind: "turn-updated",
            requestId: command.requestId,
            threadId: command.threadId,
            turnId: command.turnId,
            status: "completed",
            response: "Webhook routine completed",
            updatedAt: acceptedAt,
          });
          journal.append({
            aggregate: { aggregateType: "work-turn", aggregateId: command.requestId },
            expectedVersion: 0,
            events: [
              {
                eventId: randomUUID(),
                eventName: "work.turn-accepted@1",
                eventVersion: 1,
                correlationId: randomUUID(),
                actor,
                payload: accepted,
                occurredAt: accepted.acceptedAt,
              },
              {
                eventId: randomUUID(),
                eventName: "work.turn-updated@1",
                eventVersion: 1,
                correlationId: randomUUID(),
                actor,
                payload: completed,
                occurredAt: completed.updatedAt,
              },
            ],
          });
          workTurns.apply(accepted);
          workTurns.apply(completed);
          const persisted = workTurns.lookup(command.requestId);
          if (persisted === undefined) throw new Error("Missing journaled Work turn.");
          return { kind: "accepted", turn: persisted };
        },
      },
      readTurn: (requestId) => workTurns.lookup(requestId),
      prepareFileInput: async () => () => true,
      markFileInput: () => true,
      clock: now,
      uuid: randomUUID,
    });
    const dispatch = new AutomationDispatchService({
      store,
      projection,
      code: {
        createApprovalGatedThread: async () => {
          throw new Error("Unexpected Code dispatch in Work webhook routine smoke.");
        },
        startOrRecoverFirstTurn: async () => {
          throw new Error("Unexpected Code turn launch in Work webhook routine smoke.");
        },
      },
      work,
      capacity: {
        admit: () => ({ kind: "admitted", release: () => undefined }),
      },
      resolveFacts: ({ definition }) =>
        buildAutomationAuthorityFactsFromHost({
          hostId: "local",
          project: {
            id: definition.projectId,
            type: definition.mode,
            lifecycle: "active",
            version: definition.projectVersion,
            binding: { canonicalRoot: autoDir },
            bindingHistory: [
              {
                revisionId: AUTOMATION_TEST_IDS.bindingRevision,
                currentBinding: { canonicalRoot: autoDir },
              },
            ],
          } as never,
          providerInstance: {
            id: AUTOMATION_TEST_IDS.providerInstance,
            enabled: true,
          } as never,
          providerSupportsModel: true,
          executionProfileMatches: true,
          authorityDigestMatches: true,
          codeBindingMatches: true,
          workBindingMatches: true,
        }),
      now,
    });
    const scheduler = new AutomationSchedulerService({
      store,
      projection,
      dispatch,
      now,
    });

    const provider = laptop.spokeWebhooks.eventSources();
    const draft = automationDefinitionDraftFixture({
      missedRunPolicy: "skip",
      trigger: {
        kind: "integration-event",
        integrationId: AUTOMATION_WEBHOOK_INTEGRATION_ID,
        sourceId: AUTOMATION_WEBHOOK_SOURCE_ID,
        filters: { [AUTOMATION_WEBHOOK_ENDPOINT_FILTER]: created.endpointId },
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
    if (preparation === undefined) throw new Error("The webhook source did not prepare.");
    const routineCreated = commands.execute(
      decodeAutomationCommand({
        kind: "create-automation",
        automationId: AUTOMATION_TEST_IDS.automation,
        expectedVersion: 0,
        principal: automationLocalWindowPrincipal(),
        origin: { kind: "interactive" },
        definition: preparation.definition,
      }),
      undefined,
      undefined,
      preparation,
    );
    if (routineCreated.kind !== "automation-created") {
      throw new Error(`Expected automation-created, got ${routineCreated.kind}`);
    }

    let wakes = 0;
    const sources = new AutomationEventSources({
      projection,
      scheduler,
      sources: provider,
      current: () => true,
      now,
      monotonic: () => elapsed,
      wake: () => {
        wakes += 1;
      },
    });
    cleanups.push(() => sources.stop());

    const look = async () => {
      elapsed += 60_000;
      const beforeRevision =
        projection.getEventSource(routineCreated.automation.id)?.observationRevision ?? 0;
      const beforeWakes = wakes;
      sources.reconcile();
      await vi.waitFor(() => {
        expect(
          projection.getEventSource(routineCreated.automation.id)?.observationRevision,
        ).toBeGreaterThan(beforeRevision);
        expect(wakes).toBeGreaterThan(beforeWakes);
      });
    };

    // The routine is armed before anything arrives: its first look is the baseline.
    await look();
    expect(launchedThreads).toEqual([]);
    expect(launchedTurns).toEqual([]);

    network.stop(laptop.address);
    const answer = await postDelivery(entrance.port, created.endpointId, created.secret, "msg_1");
    expect(answer.status).toBe(202);
    await hub.webhooks.tick();
    expect(hub.webhooks.status().queued).toBe(1);
    expect(hub.magicPackets).toHaveLength(1);

    network.start(laptop.address);
    await hub.webhooks.tick();
    expect(hub.webhooks.status()).toMatchObject({ queued: 0, forwarded: 1 });
    await look();
    await vi.waitFor(() => {
      expect(launchedThreads).toHaveLength(1);
      expect(launchedTurns).toHaveLength(1);
      expect(projection.activeRun(routineCreated.automation.id)?.lifecycle).toBe("running");
    });
    const firstRun = projection.activeRun(routineCreated.automation.id);
    if (firstRun === undefined) throw new Error("Expected active running routine run.");
    expect(firstRun.threadId).toBe(launchedThreads[0]);
    expect(firstRun.occurrence.kind).toBe("integration-event");
    if (firstRun.occurrence.kind === "integration-event") {
      expect(firstRun.occurrence.source.event.id).toBe(`${created.endpointId}:msg_1`);
    }
    expect(launchedTurns[0]?.externalDataText).toContain("Nightly CI");
    expect(launchedTurns[0]?.externalDataText).toContain("msg_1");

    // Complete the run so a duplicate delivery would launch a second thread if dedupe did not stop it.
    store.appendRunStatusChanged({
      automationId: routineCreated.automation.id,
      runId: firstRun.id,
      previousLifecycle: firstRun.lifecycle,
      lifecycle: "completed",
      version: firstRun.version + 1,
      expectedVersion: firstRun.version,
      updatedAt: now(),
    });

    // The sender redelivers the same id through the real public entrance once the hub's queue is
    // empty: the spoke's own claim stops it and the scheduler dispatches no second run or thread.
    expect(
      (await postDelivery(entrance.port, created.endpointId, created.secret, "msg_1")).status,
    ).toBe(202);
    await hub.webhooks.tick();
    expect(laptop.spokeWebhooks.view().log.at(-1)?.outcome).toBe("duplicate");
    await look();
    expect(launchedThreads).toHaveLength(1);
    expect(launchedTurns).toHaveLength(1);
    expect(
      projection.listRuns({ automationId: routineCreated.automation.id, limit: 10 }).runs,
    ).toHaveLength(1);
  });

  it("refuses deliveries on a spoke whose person never ticked Public, and the hub never holds its endpoints", async () => {
    const network = new HubTestNetwork();
    const hub = await startHubTestHost({
      name: "Mac mini",
      address: "100.101.102.105",
      network,
      cleanups,
    });
    const laptop = await startHubTestHost({
      name: "Laptop",
      address: "100.101.102.106",
      network,
      cleanups,
    });
    expect(hub.hub.enable(window).status).toBe("enabled");
    await join(hub, laptop);
    expect(await laptop.spokeWebhooks.create({ scheme: "github", label: "Pushes" })).toEqual({
      status: "refused",
      kind: "public-not-granted",
    });
    expect(hub.webhooks.status().endpoints).toBe(0);
  });

  it("a guest's request to put webhook endpoints on the hub is refused", async () => {
    const network = new HubTestNetwork();
    const hub = await startHubTestHost({
      name: "Mac mini",
      address: "100.101.102.107",
      network,
      cleanups,
    });
    const laptop = await startHubTestHost({
      name: "Laptop",
      address: "100.101.102.108",
      network,
      cleanups,
    });
    expect(hub.hub.enable(window).status).toBe("enabled");
    await join(hub, laptop);
    laptop.spoke.setGrant(publicGrant, window);
    // The hub's roster now lists this member as a guest, as it lists a device.
    const state = hub.state.load();
    const held = state.hub;
    const roster = held?.roster;
    if (held === undefined || roster === undefined) throw new Error("The hub holds no roster.");
    hub.state.save({
      ...state,
      hub: {
        ...held,
        roster: {
          ...roster,
          roster: {
            ...roster.roster,
            members: roster.roster.members.map((member) =>
              String(member.memberId) === laptop.hostId
                ? { ...member, role: "guest" as const }
                : member,
            ),
          },
        },
      },
    });
    const created = await laptop.spokeWebhooks.create({ scheme: "github", label: "Pushes" });
    if (created.status !== "created") throw new Error(created.status);
    expect(created.published).toBe(false);
    expect(hub.webhooks.status().endpoints).toBe(0);
  });
});
