// Hosts in one process, each the real remote gateway behind a real TLS listener
// serving a certificate it made itself. A hub names a standby; the test stops
// the hub, and the members switch to the standby after a shortened failover
// time. The standby adds and removes members, the hub returns, and the
// standby's changes merge back with a removal winning.

import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HubMemberId,
  encodeSignedHubRoster,
  type HubGrant,
  type SignedHubRoster,
} from "@octant/contracts";
import { hubRosterSigningPayload } from "@octant/domain";
import { HUB_PEER_KEY_HEADER, signHubLinkRequest, HUB_LINK_HEADER } from "./hubLink";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const FAILOVER_AFTER_MS = 60;
const standbyGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "standby"],
  actProjects: [],
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function start(network: HubTestNetwork, name: string, last: number) {
  return startHubTestHost({
    name,
    address: `100.101.102.${last}`,
    network,
    cleanups,
    failoverAfterMs: FAILOVER_AFTER_MS,
  });
}

/** The way a person joins: a code from the hub, a comparison on both screens, approval on the hub. */
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

/** A hub, a spoke the person means to name standby, and a plain member. */
async function startFamily() {
  const network = new HubTestNetwork();
  const hub = await start(network, "Mac mini", 103);
  const standby = await start(network, "Standby", 104);
  const member = await start(network, "Laptop", 105);
  const enabled = hub.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  await join(hub, standby);
  await join(hub, member);
  return { network, hub, standby, member };
}

function roster(host: HubTestHost) {
  const held = host.spoke.status();
  if (held.membership === "none") throw new Error("Not a member.");
  return held.roster;
}

const names = (signed: SignedHubRoster) => signed.roster.members.map((entry) => entry.name);

/** A roster the standby signs with its own identity key, sent to a member as the standby's own server would. */
async function sendStandbyRoster(
  standby: HubTestHost,
  member: HubTestHost,
  change: (held: SignedHubRoster["roster"]) => SignedHubRoster["roster"],
) {
  const held = roster(standby).roster;
  const next = change({ ...held, sequence: held.sequence + 10 });
  const body = JSON.stringify(
    encodeSignedHubRoster({
      roster: next,
      signedBy: { kind: "standby", memberId: decodeMemberId(standby.hostId) },
      signature: standby.signHostPayload(hubRosterSigningPayload(next)),
    }),
  );
  return member.hubLink(
    new Request(`https://${member.address}:8443${HUB_LINK_ROUTES.roster}`, {
      method: "PUT",
      headers: {
        host: `${member.address}:8443`,
        "content-type": "application/json",
        [HUB_PEER_KEY_HEADER]: standby.hostPublicKey,
        [HUB_LINK_HEADER]: signHubLinkRequest({
          signHostPayload: standby.signHostPayload,
          senderMemberId: standby.hostId,
          recipientMemberId: member.hostId,
          method: "PUT",
          path: HUB_LINK_ROUTES.roster,
          body,
          now: Date.now(),
        }),
      },
      body,
    }),
  );
}

describe("the standby order", () => {
  it("is set by the hub's window, travels in the signed roster, and reaches the standby and every member", async () => {
    const { hub, standby, member } = await startFamily();
    standby.spoke.setGrant(standbyGrant, window);

    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);

    expect(ordered.status).toBe("ordered");
    for (const host of [standby, member]) {
      const held = roster(host);
      expect(held.roster.standbyOrder.map(String)).toEqual([standby.hostId]);
      expect(held.roster.members.map((entry) => [entry.name, entry.role])).toEqual([
        ["Mac mini", "hub"],
        ["Standby", "standby-hub"],
        ["Laptop", "spoke"],
      ]);
      expect(held.signedBy.kind).toBe("hub");
    }
    expect(hub.records.at(-1)).toMatchObject({
      change: "standby-order-changed",
      actingPrincipal: { kind: "local-window" },
      memberIds: [standby.hostId],
    });
  });

  it("refuses a spoke whose person did not tick Standby and leaves the order as it was", async () => {
    const { hub, standby } = await startFamily();
    const before = hub.hub.status().roster;

    const refused = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);

    expect(refused).toEqual({
      status: "refused",
      kind: "standby-not-granted",
      memberId: standby.hostId,
    });
    expect(hub.hub.status().roster).toEqual(before);
    expect(hub.records.map((record) => record.change)).not.toContain("standby-order-changed");
  });

  it("refuses the hub, a guest, an unknown member, and a repeated member", async () => {
    const { hub, standby } = await startFamily();
    const kind = async (ids: ReadonlyArray<string>) => {
      const result = await hub.hub.setStandbyOrder(
        ids.map((id) => decodeMemberId(id)),
        window,
      );
      return result.status === "refused" ? result.kind : result.status;
    };

    expect(await kind([hub.hostId])).toBe("not-a-spoke");
    expect(await kind(["99999999-9999-4999-8999-999999999999"])).toBe("unknown-member");
    expect(await kind([standby.hostId, standby.hostId])).toBe("duplicate-member");
  });
});

describe("a standby-signed roster", () => {
  it("is refused by a member that can reach the hub", async () => {
    const { hub, standby, member } = await startFamily();
    standby.spoke.setGrant(standbyGrant, window);
    member.spoke.setGrant(standbyGrant, window);
    await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    await member.failover.tick();
    await pause(FAILOVER_AFTER_MS + 40);
    const before = roster(member);

    const response = await sendStandbyRoster(standby, member, (held) => held);

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ status: "refused", kind: "hub-reachable" });
    expect(roster(member)).toEqual(before);
  });

  it("is refused from a spoke the latest hub-signed roster does not name", async () => {
    const { standby, member } = await startFamily();
    member.spoke.setGrant(standbyGrant, window);

    const response = await sendStandbyRoster(standby, member, (held) => held);

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ status: "refused", kind: "not-a-named-standby" });
  });

  it("is refused by a spoke whose person did not tick Standby, even with the hub unreachable", async () => {
    const { network, hub, standby, member } = await startFamily();
    standby.spoke.setGrant(standbyGrant, window);
    await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    await member.failover.tick();
    await standby.failover.tick();
    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);

    const response = await sendStandbyRoster(standby, member, (held) => held);
    await member.failover.tick();

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ status: "refused", kind: "standby-not-granted" });
    expect(roster(member).signedBy.kind).toBe("hub");
    expect(member.failover.status().followingStandby).toBeUndefined();
  });

  it("is refused when it changes the standby order, even from the named standby with the hub unreachable", async () => {
    const { network, hub, standby, member } = await startFamily();
    standby.spoke.setGrant(standbyGrant, window);
    member.spoke.setGrant(standbyGrant, window);
    await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    await member.failover.tick();
    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);

    const response = await sendStandbyRoster(standby, member, (held) => ({
      ...held,
      standbyOrder: [],
    }));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      status: "refused",
      kind: "standby-changed-standby-order",
    });
  });
});

describe("a hub that stops and comes back", () => {
  it("lets the members switch to the standby, which adds and removes members, and takes its changes back with removal winning", async () => {
    const network = new HubTestNetwork();
    const hub = await start(network, "Mac mini", 103);
    const standby = await start(network, "Standby", 104);
    const member = await start(network, "Laptop", 105);
    const newcomer = await start(network, "Desk", 106);
    const enabled = hub.hub.enable(window);
    if (enabled.status !== "enabled") throw new Error(enabled.status);
    await join(hub, standby);
    await join(hub, member);
    standby.spoke.setGrant(standbyGrant, window);
    member.spoke.setGrant(standbyGrant, window);
    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    if (ordered.status !== "ordered") throw new Error(JSON.stringify(ordered));
    // Every member has seen the hub once, so the failover time counts from now.
    await standby.failover.tick();
    await member.failover.tick();

    // The hub stops. Before the failover time has passed nobody switches.
    network.stop(hub.address);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(false);
    await pause(FAILOVER_AFTER_MS + 40);

    // A member that is not the named standby never stands in; it tries the
    // standby, which is not standing in yet, and stays where it is.
    await member.failover.tick();
    expect(member.failover.standingIn()).toBe(false);
    expect(member.failover.status().followingStandby).toBeUndefined();

    // The standby has seen no hub for the whole time, so it stands in and tells the members.
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(true);
    await vi.waitFor(() => expect(roster(member).signedBy.kind).toBe("standby"));
    await member.failover.tick();
    expect(member.failover.status().followingStandby).toBe(standby.hostId);
    const standingStatus = standby.spoke.status();
    if (standingStatus.membership !== "member") throw new Error("Standby is not a member.");
    expect(standingStatus.standIn).toMatchObject({ added: 0, removed: 0 });

    // A computer that joins during the stand-in reads the standby's code and
    // receives the hub-signed roster that names the standby with the update.
    const minted = standby.failover.mintJoinCode();
    if (minted.status !== "minted") throw new Error(minted.status);
    const started = await newcomer.spoke.startJoin({ code: minted.code });
    if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
    const [pending] = standby.administration.listPendingPairings();
    if (pending === undefined) throw new Error("The standby shows no pairing to approve.");
    expect(pending.comparisonCode).toBe(started.comparisonCode);
    standby.administration.approvePairing({ ticketId: pending.ticketId });
    const joined = await newcomer.spoke.finishJoin(window);
    if (joined.status !== "joined") throw new Error(JSON.stringify(joined));
    const newcomerRoster = roster(newcomer);
    expect(newcomerRoster.signedBy).toEqual({
      kind: "standby",
      memberId: decodeMemberId(standby.hostId),
    });
    expect(names(newcomerRoster)).toEqual(["Mac mini", "Standby", "Laptop", "Desk"]);
    const newcomerLink = newcomer.state.load().link;
    expect(String(newcomerLink?.hubMemberId)).toBe(hub.hostId);
    expect(newcomerLink?.hubSignedRoster?.signedBy.kind).toBe("hub");
    await vi.waitFor(() => expect(names(roster(member))).toContain("Desk"));

    // The standby removes the laptop; the laptop learns of it from the roster.
    const removed = await standby.failover.removeMember(member.hostId, window);
    expect(removed.status).toBe("removed");
    await vi.waitFor(() => expect(member.spoke.status().membership).toBe("removed"));

    // The hub, which still lists the laptop, comes back. The standby sees it and hands its changes back.
    network.start(hub.address);
    await standby.failover.tick();

    const merged = hub.hub.status().roster;
    if (merged === undefined) throw new Error("The hub holds no roster.");
    expect(merged.signedBy.kind).toBe("hub");
    expect(names(merged)).toEqual(["Mac mini", "Standby", "Desk"]);
    expect(merged.roster.standbyOrder.map(String)).toEqual([standby.hostId]);
    expect(hub.hub.memberKey(newcomer.hostId)).toBeDefined();
    expect(hub.hub.memberKey(member.hostId)).toBeUndefined();

    // The standby stepped down and holds the hub's roster again.
    expect(standby.failover.standingIn()).toBe(false);
    expect(roster(standby)).toEqual(merged);
    // The new member returns to the hub and holds the hub's roster.
    await newcomer.failover.tick();
    await vi.waitFor(() => expect(roster(newcomer)).toEqual(merged));
    expect(newcomer.failover.status().followingStandby).toBeUndefined();
    // The laptop was removed on the standby and stays removed.
    expect(member.spoke.status().membership).toBe("removed");

    const standInChanges = new Set([
      "stand-in-started",
      "member-added",
      "member-removed",
      "stand-in-ended",
    ]);
    expect(
      standby.records
        .filter((record) => standInChanges.has(record.change))
        .map((record) => [record.change, record.actingPrincipal.kind]),
    ).toEqual([
      ["stand-in-started", "hub"],
      ["member-added", "remote-device"],
      ["member-removed", "local-window"],
      ["stand-in-ended", "hub"],
    ]);
    expect(hub.records.map((record) => record.change)).toEqual(
      expect.arrayContaining(["standby-order-changed", "stand-in-merged"]),
    );
  });
});

describe("replacing the hub for good", () => {
  it("makes a named standby the hub from its own window and lets each spoke accept it from theirs", async () => {
    const { hub, standby, member } = await startFamily();
    standby.spoke.setGrant(standbyGrant, window);
    await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);

    const promoted = standby.hub.promote(window);

    if (promoted.status !== "promoted") throw new Error(JSON.stringify(promoted));
    expect(standby.hub.status().enabled).toBe(true);
    expect(standby.spoke.status()).toEqual({ membership: "none" });
    expect(promoted.roster.roster.members.map((entry) => [entry.name, entry.role])).toEqual([
      ["Standby", "hub"],
      ["Laptop", "spoke"],
    ]);
    expect(promoted.roster.roster.standbyOrder).toEqual([]);
    expect(standby.records.at(-1)).toMatchObject({
      change: "hub-promoted",
      actingPrincipal: { kind: "local-window" },
    });
    // Nothing reaches the spoke until its own person accepts the new hub.
    const held = member.spoke.status();
    if (held.membership !== "member") throw new Error("Laptop is not a member.");
    expect(held.hub.name).toBe("Mac mini");

    const accepted = await member.spoke.acceptNewHub(standby.hostId, window);

    expect(accepted).toEqual({ status: "accepted", sequence: promoted.roster.roster.sequence });
    const after = member.spoke.status();
    if (after.membership !== "member") throw new Error("Laptop is not a member.");
    expect(after.hub.name).toBe("Standby");
    expect(String(after.hub.memberId)).toBe(standby.hostId);
    expect(after.roster.signedBy.kind).toBe("hub");
    expect(member.records.at(-1)).toMatchObject({
      change: "new-hub-accepted",
      actingPrincipal: { kind: "local-window" },
    });
    // The new hub hears the laptop leave, though it never held the laptop's key.
    expect(await member.spoke.leave(window)).toEqual({ status: "left", hubNotified: true });
    expect(names(standby.hub.status().roster ?? promoted.roster)).toEqual(["Standby"]);
  });

  it("refuses to promote a spoke the hub did not name, and a spoke to accept a member that is not a named standby", async () => {
    const { standby, member } = await startFamily();

    expect(standby.hub.promote(window)).toEqual({ status: "refused", kind: "not-a-named-standby" });
    expect(await member.spoke.acceptNewHub(standby.hostId, window)).toEqual({
      status: "refused",
      kind: "not-a-named-standby",
    });
    expect(standby.hub.status().enabled).toBe(false);
  });
});
