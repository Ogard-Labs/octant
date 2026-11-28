// Hosts in one process, each the real remote gateway behind a real TLS listener
// serving a certificate it made itself. A spoke whose person ticked Push hands
// checked v2 push messages to the hub; the hub re-checks every free-text field
// and sends directly to Apple/Google using its own credentials. Older v1 spoke
// handoffs are refused with `update-member`.

import { afterEach, describe, expect, it } from "vitest";
import { decodeStableHostId, type HubGrant, type UtcTimestamp } from "@octant/contracts";
import { buildPushAlert } from "@octant/domain/push-notification-policy";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, signHubLinkRequest } from "./hubLink";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const FAILOVER_AFTER_MS = 60;
const pushGrant: HubGrant = { items: ["roster", "introduce", "owners", "push"], actProjects: [] };
const noPushGrant: HubGrant = { items: ["roster", "introduce", "owners"], actProjects: [] };

function makeClock() {
  const state = { offset: 0 };
  return { state, now: () => Date.now() + state.offset };
}
type Clock = ReturnType<typeof makeClock>;

function start(
  network: HubTestNetwork,
  clock: Clock,
  name: string,
  last: number,
  extra: Partial<Parameters<typeof startHubTestHost>[0]> = {},
) {
  return startHubTestHost({
    name,
    address: `100.101.102.${last}`,
    network,
    cleanups,
    wakeClock: clock.now,
    failoverAfterMs: FAILOVER_AFTER_MS,
    ...extra,
  });
}

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

function signedRequest(input: {
  readonly signer: HubTestHost;
  readonly recipient: HubTestHost;
  readonly clock: Clock;
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly body: unknown;
}) {
  const body = JSON.stringify(input.body);
  return input.recipient.hubLink(
    new Request(`${input.recipient.origin}${input.path}`, {
      method: input.method,
      headers: {
        host: `${input.recipient.address}:8443`,
        "content-type": "application/json",
        [HUB_PEER_KEY_HEADER]: input.signer.hostPublicKey,
        [HUB_LINK_HEADER]: signHubLinkRequest({
          signHostPayload: input.signer.signHostPayload,
          senderMemberId: input.signer.hostId,
          recipientMemberId: input.recipient.hostId,
          method: input.method,
          path: input.path,
          body,
          now: input.clock.now(),
        }),
      },
      body,
    }),
  );
}

const sampleAlert = (hostId: string, threadTitle?: string) =>
  buildPushAlert({
    source: "thread",
    kind: "approval-needed",
    hostId: decodeStableHostId(hostId),
    threadId: "00000000-0000-4000-8000-000000000001",
    mode: "code",
    computerLabel: "Laptop",
    ...(threadTitle === undefined ? {} : { threadTitle }),
    threadTitles: threadTitle !== undefined,
    collapseId: "B".repeat(22),
    sequence: 1,
    occurredAt: "2026-11-28T12:00:00.000Z" as UtcTimestamp,
    heldSecrets: { status: "ready", values: [] },
  });

async function startPair(
  hubExtra: Partial<Parameters<typeof startHubTestHost>[0]> = {},
  laptopExtra: Partial<Parameters<typeof startHubTestHost>[0]> = {},
) {
  const network = new HubTestNetwork();
  const clock = makeClock();
  const hub = await start(network, clock, "Mac mini", 103, hubExtra);
  const laptop = await start(network, clock, "Laptop", 104, laptopExtra);
  const enabled = hub.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  await join(hub, laptop);
  hub.directPush.setEnabled(true, window);
  expect(await hub.push.setEnabled(true, window)).toEqual({ status: "changed", enabled: true });
  laptop.spoke.setGrant(pushGrant, window);
  return { network, clock, hub, laptop };
}

describe("v2 hub direct push forwarding", () => {
  it("forwards a spoke's checked v2 message directly through the hub's own sender", async () => {
    const { hub, laptop } = await startPair();
    const message = sampleAlert(laptop.hostId, "Ship release");

    expect(laptop.pushDelivery.providerDelivery()).toBe("available");
    await expect(
      laptop.pushDelivery.send({
        destination: { deviceId: "device-1", platform: "ios", token: "apns-token-1" },
        message,
      }),
    ).resolves.toEqual({ kind: "delivered" });

    expect(hub.directSent).toHaveLength(1);
    expect(hub.directSent[0]?.platform).toBe("ios");
    expect(hub.directSent[0]?.token).toBe("apns-token-1");
    expect(hub.directSent[0]?.message).toMatchObject({
      type: "alert",
      alert: {
        version: 2,
        kind: "approval-needed",
        title: "Approval needed: Ship release",
      },
    });
  });

  it("refuses a spoke that has not granted Push, refuses when hub sender is off, and enforces per-spoke rate limits", async () => {
    const { hub, laptop } = await startPair({ pushMaxPerMinute: 3 });
    const message = sampleAlert(laptop.hostId);

    laptop.spoke.setGrant(noPushGrant, window);
    expect(laptop.pushDelivery.providerDelivery()).toBe("unavailable");

    laptop.spoke.setGrant(pushGrant, window);
    hub.directPush.setEnabled(false, window);
    await expect(
      laptop.pushDelivery.send({
        destination: { deviceId: "device-1", platform: "ios", token: "apns-token-1" },
        message,
      }),
    ).resolves.toMatchObject({ kind: "failed", retryable: false, category: "hub-refused" });

    hub.directPush.setEnabled(true, window);
    for (let i = 0; i < 2; i += 1) {
      await expect(
        laptop.pushDelivery.send({
          destination: { deviceId: "device-1", platform: "ios", token: "apns-token-1" },
          message,
        }),
      ).resolves.toEqual({ kind: "delivered" });
    }
    await expect(
      laptop.pushDelivery.send({
        destination: { deviceId: "device-1", platform: "ios", token: "apns-token-1" },
        message,
      }),
    ).resolves.toMatchObject({ kind: "failed", retryable: true, category: "hub-refused" });
  });

  it("refuses a legacy v1 sealed handoff from an older spoke with update-member", async () => {
    const { clock, hub, laptop } = await startPair();
    const response = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: {
        body: '{"capability":"v1.k1.legacy","envelope":{}}',
        hostKey: laptop.hostPublicKey,
        timestamp: new Date(clock.now()).toISOString(),
        signature: "legacy-sig",
      },
    });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ status: "refused", kind: "update-member" });
    expect(hub.directSent).toHaveLength(0);
  });
});
