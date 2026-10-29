// Three hosts in one process: a hub, a spoke, and a guest client. The hub and
// the spoke are real remote gateways behind real TLS listeners serving
// certificates they made themselves; the guest is the client runtime's own
// guest client, holding connections to those certificates' pins. The guest
// joins the hub with a code, receives the signed roster, and reaches the spoke
// directly at the address and pin the roster gives.

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hubRosterSigningPayload } from "@octant/domain";
import {
  acceptGuestRoster,
  admitGuestOnSpoke,
  createGuestSigner,
  createInMemoryDeviceKeyStore,
  guestSpokeTargets,
  joinHubAsGuest,
  refreshGuestRoster,
  type PinnedListenerTransportPort,
} from "@octant/client-runtime";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { HUB_LINK_HEADER, signHubLinkRequest } from "./hubLink";
import { createPinnedHubTransport } from "./pinnedHubTransport";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;

/** The guest's connections: pinned, private-only, and dialled through the test network. */
function guestTransport(network: HubTestNetwork): PinnedListenerTransportPort {
  const transport = createPinnedHubTransport(network.network);
  return ({ origin, trust }) => {
    if (trust.current.kind !== "pinned") return { status: "unavailable" };
    const pinned = transport({ origin, pin: trust.current.pin });
    return {
      status: "available",
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        return pinned(url, {
          ...(init?.method === undefined ? {} : { method: init.method }),
          headers,
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
          ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
        });
      },
    };
  };
}

async function startHubAndSpoke() {
  const network = new HubTestNetwork();
  const hub = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network,
    cleanups,
  });
  const spoke = await startHubTestHost({
    name: "Laptop",
    address: "100.101.102.104",
    network,
    cleanups,
  });
  const enabled = hub.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  await joinSpoke(hub, spoke);
  return { network, hub, spoke };
}

async function joinSpoke(hub: HubTestHost, spoke: HubTestHost) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await spoke.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const [pending] = hub.administration.listPendingPairings();
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await spoke.spoke.finishJoin(window);
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

/** A phone joins the hub the way a person does: a code, a comparison on both screens, approval on the hub. */
async function joinGuest(hub: HubTestHost, network: HubTestNetwork, spoke?: HubTestHost) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const store = createInMemoryDeviceKeyStore();
  const started = await joinHubAsGuest({
    code: minted.code,
    deviceLabel: "Phone",
    transport: guestTransport(network),
    webBuildVersion: "test",
    deviceKeyStore: store,
  });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const [pending] = hub.administration.listPendingPairings();
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  expect(pending.comparisonCode).toBe(started.comparisonCode);
  expect(await started.finish()).toEqual({ status: "awaiting-approval" });
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await started.finish();
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
  // The hub sends a new roster to its spokes in the background.
  if (spoke !== undefined) {
    await vi.waitFor(() => {
      const held = spoke.spoke.status();
      if (held.membership !== "member") throw new Error("The spoke is not a member.");
      expect(held.roster.roster.sequence).toBe(finished.record.roster.roster.sequence);
    });
  }
  return finished;
}

describe("a guest joining a hub that has a spoke", () => {
  it("joins with a code as a guest, receives the signed roster, and is admitted by the spoke directly", async () => {
    const { network, hub, spoke } = await startHubAndSpoke();

    const { record, signer } = await joinGuest(hub, network, spoke);

    expect(
      record.roster.roster.members.map((member) => [member.name, member.role, member.owner]),
    ).toEqual([
      ["Mac mini", "hub", false],
      ["Laptop", "spoke", false],
      ["Phone", "guest", false],
    ]);
    // The roster carries the spoke's address, port, and pin, and the guest's
    // entry carries none, because a phone runs no listener.
    const targets = guestSpokeTargets(record);
    expect(targets.map((target) => [target.name, target.role, target.origin])).toEqual([
      ["Mac mini", "hub", "https://100.101.102.103:8443"],
      ["Laptop", "spoke", "https://100.101.102.104:8443"],
    ]);
    // The spoke accepted the guest from the roster and holds no device for it yet.
    expect(spoke.spoke.peerGrantCount()).toBe(1);
    expect(
      spoke.administration.listDevices().filter((device) => device.deviceLabel === "Phone"),
    ).toEqual([]);

    const hubRequestsBefore = hub.requests.length;
    const target = targets.find((entry) => entry.role === "spoke");
    if (target === undefined) throw new Error("The roster gave no spoke.");
    const admitted = await admitGuestOnSpoke({
      target,
      signer,
      deviceLabel: "Phone",
      transport: guestTransport(network),
    });

    expect(admitted.status).toBe("admitted");
    const phone = spoke.administration
      .listDevices()
      .find((device) => device.deviceKeyFingerprint === signer.fingerprint);
    expect(phone?.state).toBe("active");
    expect(phone?.deviceLabel).toBe("Phone");
    // The hub never saw the spoke traffic.
    expect(hub.requests.slice(hubRequestsBefore)).toEqual([]);
    expect(spoke.requests).toContain("POST /api/hub/guest");
    // Journaled on the spoke, as the hub's introduction.
    expect(
      spoke.records
        .filter((entry) => entry.change === "guest-admitted")
        .map((entry) => entry.actingPrincipal.kind),
    ).toEqual(["hub"]);
  });

  it("is refused by a spoke that did not tick Introduce, which creates no device", async () => {
    const { network, hub, spoke } = await startHubAndSpoke();
    const granted = spoke.spoke.setGrant({ items: ["roster"], actProjects: [] }, window);
    expect(granted.status).toBe("changed");

    const { record, signer } = await joinGuest(hub, network, spoke);
    const target = guestSpokeTargets(record).find((entry) => entry.role === "spoke");
    if (target === undefined) throw new Error("The roster gave no spoke.");
    const refused = await admitGuestOnSpoke({
      target,
      signer,
      deviceLabel: "Phone",
      transport: guestTransport(network),
    });

    expect(refused).toEqual({ status: "refused", httpStatus: 403, kind: "guest-not-accepted" });
    expect(spoke.spoke.peerGrantCount()).toBe(0);
    expect(spoke.administration.listDevices()).toEqual([]);
  });

  it("is refused by a spoke whose verified roster does not list the guest", async () => {
    const { network, hub, spoke } = await startHubAndSpoke();
    const stranger = await createGuestSigner({
      memberId: "7d444840-9dc0-4f6e-8b4a-3c0c6e1a1b11",
      keyPair: await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]),
    });
    const { record } = await joinGuest(hub, network);
    const target = guestSpokeTargets(record).find((entry) => entry.role === "spoke");
    if (target === undefined) throw new Error("The roster gave no spoke.");

    const refused = await admitGuestOnSpoke({
      target,
      signer: stranger,
      deviceLabel: "Intruder",
      transport: guestTransport(network),
    });

    expect(refused).toEqual({ status: "refused", httpStatus: 403, kind: "not-in-roster" });
    expect(spoke.administration.listDevices()).toEqual([]);
  });

  it("is refused when a listed guest's id is presented with a different key", async () => {
    const { network, hub, spoke } = await startHubAndSpoke();
    const { record, signer } = await joinGuest(hub, network, spoke);
    const impostor = await createGuestSigner({
      memberId: signer.memberId,
      keyPair: await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]),
    });
    const target = guestSpokeTargets(record).find((entry) => entry.role === "spoke");
    if (target === undefined) throw new Error("The roster gave no spoke.");

    const refused = await admitGuestOnSpoke({
      target,
      signer: impostor,
      deviceLabel: "Phone",
      transport: guestTransport(network),
    });

    expect(refused).toEqual({ status: "refused", httpStatus: 403, kind: "key-mismatch" });
    expect(spoke.administration.listDevices()).toEqual([]);
  });

  it("loses its device on the spoke when a newer roster no longer lists it", async () => {
    const { network, hub, spoke } = await startHubAndSpoke();
    const { record, signer } = await joinGuest(hub, network, spoke);
    const target = guestSpokeTargets(record).find((entry) => entry.role === "spoke");
    if (target === undefined) throw new Error("The roster gave no spoke.");
    await admitGuestOnSpoke({
      target,
      signer,
      deviceLabel: "Phone",
      transport: guestTransport(network),
    });

    const removed = await hub.hub.removeMember({ memberId: signer.memberId }, window);

    expect(removed.status).toBe("removed");
    expect(spoke.spoke.peerGrantCount()).toBe(0);
    expect(spoke.administration.listDevices().map((device) => device.state)).toEqual(["revoked"]);
    expect(spoke.records.map((entry) => entry.change)).toContain("guest-dropped");
    // The removed guest can no longer read the roster from the hub.
    const refresh = await refreshGuestRoster({
      record,
      signer,
      transport: guestTransport(network),
    });
    expect(refresh).toEqual({ status: "hub-refused", httpStatus: 401, kind: "unknown-sender" });
  });

  it("reads a newer roster from the hub and keeps the one it holds when nothing changed", async () => {
    const { network, hub } = await startHubAndSpoke();
    const { record, signer } = await joinGuest(hub, network);
    const unchanged = await refreshGuestRoster({
      record,
      signer,
      transport: guestTransport(network),
    });
    expect(unchanged.status).toBe("unchanged");

    const second = await startHubTestHost({
      name: "Desktop",
      address: "100.101.102.105",
      network,
      cleanups,
    });
    await joinSpoke(hub, second);
    const refreshed = await refreshGuestRoster({
      record,
      signer,
      transport: guestTransport(network),
    });

    if (refreshed.status !== "accepted") throw new Error(JSON.stringify(refreshed));
    expect(refreshed.record.roster.roster.members.map((member) => member.name)).toEqual([
      "Mac mini",
      "Laptop",
      "Phone",
      "Desktop",
    ]);
  });

  it("refuses the guest routes to a member that is not a guest", async () => {
    const { hub, spoke } = await startHubAndSpoke();
    const header = signHubLinkRequest({
      signHostPayload: spoke.signHostPayload,
      senderMemberId: spoke.hostId,
      recipientMemberId: hub.hostId,
      method: "GET",
      path: "/api/hub/guest-roster",
      body: "",
      now: Date.now(),
    });

    const response = await hub.hubLink(
      new Request(`${hub.origin}/api/hub/guest-roster`, {
        headers: { [HUB_LINK_HEADER]: header },
      }),
    );

    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ status: "refused", kind: "unknown-sender" });
  });

  it("refuses a roster signed by any key but the hub's and one older than the roster it holds", async () => {
    const { network, hub } = await startHubAndSpoke();
    const { record } = await joinGuest(hub, network);
    const forgedKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forgedRoster = {
      ...record.roster.roster,
      sequence: record.roster.roster.sequence + 1,
      members: record.roster.roster.members.filter((member) => member.role !== "spoke"),
    };
    const forged = {
      roster: forgedRoster,
      signedBy: record.roster.signedBy,
      signature: cryptoSign("sha256", Buffer.from(hubRosterSigningPayload(forgedRoster), "utf8"), {
        key: forgedKeys.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
    };

    expect(await acceptGuestRoster({ record, candidate: forged })).toEqual({
      status: "refused",
      kind: "signature-invalid",
    });

    const newer = {
      ...record,
      roster: { ...record.roster, roster: { ...record.roster.roster, sequence: 9 } },
    };
    expect(await acceptGuestRoster({ record: newer, candidate: record.roster })).toEqual({
      status: "refused",
      kind: "stale-sequence",
    });
  });
});
