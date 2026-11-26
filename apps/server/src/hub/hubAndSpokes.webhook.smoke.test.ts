// A hub and a spoke in one process, each the real remote gateway behind a real
// TLS listener. The spoke's person ticks Public and Wake, mints an endpoint, and
// the spoke hands the hub its secret sealed to the hub's own key. A delivery
// reaches the hub while the spoke's machine is stopped; the hub queues it and
// sends a Wake-on-LAN packet (a fake socket records it), and hands it on once
// the spoke is back. The spoke's routine reads it through the webhook source.

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationIntegrationEventTrigger, HubGrant, UtcTimestamp } from "@octant/contracts";
import {
  initialAutomationEventCheckpoint,
  reconcileAutomationEventObservation,
} from "../automation/automationEventSourceState";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import type { PublicRequest } from "./publicEntrance";

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

function delivery(endpointId: string, secret: string, id: string): PublicRequest {
  const body = Buffer.from('{"workflow":"nightly","conclusion":"failure"}');
  const seconds = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${seconds}.`)
    .update(body)
    .digest("base64");
  return {
    route: "webhook",
    params: { id: endpointId },
    method: "POST",
    path: `/hooks/${endpointId}`,
    headers: new Map([
      ["webhook-id", id],
      ["webhook-timestamp", String(seconds)],
      ["webhook-signature", `v1,${signature}`],
    ]),
    principal: { kind: "webhook", endpointId },
    readBody: async () => ({ status: "read", bytes: body }),
    signal: new AbortController().signal,
  };
}

describe("webhook triggers through the hub", () => {
  it("a delivery to a sleeping spoke wakes it and runs once on return", async () => {
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

    const created = await laptop.spokeWebhooks.create({
      scheme: "standard-webhooks",
      label: "Nightly CI",
    });
    if (created.status !== "created") throw new Error(created.status);
    expect(created.published).toBe(true);
    expect(hub.webhooks.status().endpoints).toBe(1);

    // The routine is armed before anything arrives: its first look is the baseline.
    const trigger: AutomationIntegrationEventTrigger = {
      kind: "integration-event",
      integrationId: "octant.webhooks",
      sourceId: "endpoint",
      filters: { endpoint: created.endpointId },
      pollMinutes: 1,
      automaticStartLimit: 8,
    };
    const source = await laptop.spokeWebhooks
      .eventSources()
      .bind(trigger, new AbortController().signal);
    if (source === undefined) throw new Error("The webhook source did not bind.");
    const at = () => new Date().toISOString() as UtcTimestamp;
    let checkpoint = initialAutomationEventCheckpoint(source.identity, at());
    const claims: string[] = [];
    const look = async () => {
      const read = await source.read(new AbortController().signal);
      if (read.kind !== "complete") throw new Error(read.kind);
      const observed = reconcileAutomationEventObservation({
        previous: checkpoint,
        trigger,
        events: read.events,
        semantics: source.semantics,
        observedAt: at(),
        coverageGap: false,
        missedRunPolicy: "skip",
        busy: false,
      });
      if (observed.kind === "claim") {
        claims.push(observed.receipt.event.id);
        checkpoint = observed.receipt.checkpoint;
      } else checkpoint = observed.checkpoint;
    };
    await look();

    network.stop(laptop.address);
    const answer = await hub.webhooks.handle(delivery(created.endpointId, created.secret, "msg_1"));
    expect(answer.status).toBe(202);
    await hub.webhooks.tick();
    expect(hub.webhooks.status().queued).toBe(1);
    expect(hub.magicPackets).toHaveLength(1);

    network.start(laptop.address);
    await hub.webhooks.tick();
    expect(hub.webhooks.status()).toMatchObject({ queued: 0, forwarded: 1 });
    await look();
    expect(claims).toEqual([`${created.endpointId}:msg_1`]);

    // The sender redelivers the same id once the hub's queue is empty: the spoke's own claim stops it.
    expect(
      (await hub.webhooks.handle(delivery(created.endpointId, created.secret, "msg_1"))).status,
    ).toBe(202);
    await hub.webhooks.tick();
    expect(laptop.spokeWebhooks.view().log.at(-1)?.outcome).toBe("duplicate");
    await look();
    expect(claims).toHaveLength(1);
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
