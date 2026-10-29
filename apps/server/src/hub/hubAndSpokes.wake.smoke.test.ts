// Hosts in one process, each the real remote gateway behind a real TLS listener
// serving a certificate it made itself. A hub turns on the wake service, a spoke
// whose person ticked Wake tells it when its routines are next due, and a clock
// the test moves brings an occurrence into the lead time. The Wake-on-LAN socket
// is a fake that records what it was given; everything else is the real path.

import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubMemberId, UtcTimestamp, WakeRoutineId, type HubGrant } from "@octant/contracts";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, signHubLinkRequest } from "./hubLink";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";
import type { HubTransport } from "./pinnedHubTransport";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const MINUTE = 60_000;
const FAILOVER_AFTER_MS = 60;
const wakeGrant: HubGrant = { items: ["roster", "introduce", "owners", "wake"], actProjects: [] };
const wakeAndStandbyGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "wake", "standby"],
  actProjects: [],
};
const standbyGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "standby"],
  actProjects: [],
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One clock for every host in a test, so the signatures on a nudge agree with the checks. */
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
    wakeLeadMs: 2 * MINUTE,
    failoverAfterMs: FAILOVER_AFTER_MS,
    ...extra,
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

async function startPair(extra: Partial<Parameters<typeof startHubTestHost>[0]> = {}) {
  const network = new HubTestNetwork();
  const clock = makeClock();
  const hub = await start(network, clock, "Mac mini", 103);
  const laptop = await start(network, clock, "Laptop", 104, extra);
  const enabled = hub.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  await join(hub, laptop);
  const switched = await hub.wake.setEnabled(true, window);
  expect(switched).toEqual({ status: "changed", enabled: true });
  return { network, clock, hub, laptop };
}

const iso = (ms: number) => decodeTimestamp(new Date(ms).toISOString());

const nudges = (host: HubTestHost) =>
  host.requests.filter((entry) => entry === `POST ${HUB_LINK_ROUTES.wakeNudge}`).length;

/** A request to `recipient`'s listener signed with `signer`'s identity key, as the signer's own server would. */
function signedRequest(input: {
  readonly signer: HubTestHost;
  readonly recipient: HubTestHost;
  readonly clock: Clock;
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly body: unknown;
  readonly senderId?: string;
  readonly presentKey?: boolean;
}) {
  const body = JSON.stringify(input.body);
  return input.recipient.hubLink(
    new Request(`${input.recipient.origin}${input.path}`, {
      method: input.method,
      headers: {
        host: `${input.recipient.address}:8443`,
        "content-type": "application/json",
        ...(input.presentKey === false
          ? {}
          : { [HUB_PEER_KEY_HEADER]: input.signer.hostPublicKey }),
        [HUB_LINK_HEADER]: signHubLinkRequest({
          signHostPayload: input.signer.signHostPayload,
          senderMemberId: input.senderId ?? input.signer.hostId,
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

describe("waking a spoke before its routine is due", () => {
  it("nudges the spoke inside the lead time, once, and the spoke only wakes its own scheduler", async () => {
    const { clock, hub, laptop } = await startPair();
    laptop.spoke.setGrant(wakeGrant, window);
    laptop.routines.push({
      id: "automation-nightly",
      enabled: true,
      nextDueAt: iso(clock.now() + 10 * MINUTE),
    });

    expect(await laptop.spokeWake.report()).toEqual({ status: "sent", count: 1 });
    expect(hub.wake.status()).toMatchObject({
      enabled: true,
      spokes: [{ memberId: laptop.hostId, upcoming: 1 }],
    });

    // Outside the lead time nothing is sent.
    await hub.wake.tick();
    expect(nudges(laptop)).toBe(0);
    expect(laptop.schedulerPokes.count).toBe(0);

    // Inside it the hub nudges once; a second look does not nudge again.
    clock.state.offset = 9 * MINUTE;
    await hub.wake.tick();
    await hub.wake.tick();
    expect(nudges(laptop)).toBe(1);
    expect(laptop.schedulerPokes.count).toBe(1);
    expect(hub.magicPackets).toEqual([]);
    expect(hub.wake.status().spokes[0]?.lastResult).toMatchObject({ result: "nudged" });

    // The spoke's routine is as it was: the nudge started nothing and changed nothing.
    expect(laptop.routines).toEqual([
      { id: "automation-nightly", enabled: true, nextDueAt: expect.any(String) },
    ]);
    expect(
      hub.records.map((record) => [record.change, record.actingPrincipal.kind]).slice(-3),
    ).toEqual([
      ["wake-switch-changed", "local-window"],
      ["wake-times-reported", "peer"],
      ["wake-nudge-sent", "hub"],
    ]);
  });

  it("sends a magic packet only when the person entered the hardware address on the spoke", async () => {
    const { clock, hub, laptop } = await startPair();
    laptop.spoke.setGrant(wakeGrant, window);
    laptop.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 10 * MINUTE),
    });
    await laptop.spokeWake.report();
    clock.state.offset = 9 * MINUTE;
    await hub.wake.tick();
    // No address was entered: a nudge went out and no packet did.
    expect(nudges(laptop)).toBe(1);
    expect(hub.magicPackets).toEqual([]);

    // The person enters one; the next report carries it and the next occurrence is woken with a packet.
    clock.state.offset = 0;
    expect(laptop.spokeWake.setHardwareAddress("AA-BB-CC-00-11-22")).toEqual({
      status: "changed",
      hardwareAddress: "aa:bb:cc:00:11:22",
    });
    laptop.routines.push({
      id: "automation-b",
      enabled: true,
      nextDueAt: iso(clock.now() + 40 * MINUTE),
    });
    await vi.waitFor(async () => {
      await laptop.spokeWake.report();
      expect(hub.state.load().hub?.wake?.spokes[0]?.hardwareAddress).toBe("aa:bb:cc:00:11:22");
    });
    clock.state.offset = 39 * MINUTE;
    await hub.wake.tick();

    expect(hub.magicPackets).toHaveLength(1);
    const packet = hub.magicPackets[0];
    expect(packet).toHaveLength(102);
    expect([...(packet?.slice(0, 6) ?? [])]).toEqual([255, 255, 255, 255, 255, 255]);
    for (let repeat = 0; repeat < 16; repeat += 1) {
      expect([...(packet?.slice(6 + repeat * 6, 12 + repeat * 6) ?? [])]).toEqual([
        0xaa, 0xbb, 0xcc, 0x00, 0x11, 0x22,
      ]);
    }
  });

  it("records an occurrence as unreachable when neither the packet nor the nudge reaches the spoke", async () => {
    const { network, clock, hub, laptop } = await startPair();
    laptop.spoke.setGrant(wakeGrant, window);
    laptop.spokeWake.setHardwareAddress("aa:bb:cc:00:11:22");
    laptop.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 10 * MINUTE),
    });
    await vi.waitFor(async () => {
      await laptop.spokeWake.report();
      expect(hub.state.load().hub?.wake?.spokes).toHaveLength(1);
    });
    network.stop(laptop.address);

    // Inside the lead time the hub tries, and keeps trying until the occurrence.
    clock.state.offset = 9 * MINUTE;
    await hub.wake.tick();
    expect(hub.magicPackets).toHaveLength(1);
    expect(hub.wake.status().spokes[0]?.lastResult).toBeUndefined();
    await hub.wake.tick();
    expect(hub.magicPackets).toHaveLength(1);

    // At the occurrence it gives up and says so; the spoke's own missed-run policy takes over.
    clock.state.offset = 10 * MINUTE + 1_000;
    await hub.wake.tick();
    expect(hub.wake.status().spokes[0]?.lastResult).toMatchObject({ result: "unreachable" });
    expect(hub.records.at(-1)).toMatchObject({
      change: "wake-unreachable",
      actingPrincipal: { kind: "hub" },
      memberId: laptop.hostId,
    });
    expect(laptop.schedulerPokes.count).toBe(0);
  });
});

describe("what a spoke tells the hub", () => {
  it("is only opaque ids and times, never the routine's own id or anything about it", async () => {
    const bodies: string[] = [];
    const spy =
      (transport: HubTransport): HubTransport =>
      (target) => {
        const fetcher = transport(target);
        return (url, init) => {
          if (String(url).endsWith(HUB_LINK_ROUTES.wakeTimes)) bodies.push(String(init?.body));
          return fetcher(url, init);
        };
      };
    const { clock, hub, laptop } = await startPair({ wakeTransport: spy });
    laptop.spoke.setGrant(wakeGrant, window);
    laptop.routines.push(
      { id: "automation-secret-name", enabled: true, nextDueAt: iso(clock.now() + 30 * MINUTE) },
      { id: "automation-paused", enabled: false, nextDueAt: iso(clock.now() + 20 * MINUTE) },
      { id: "automation-exhausted", enabled: true, nextDueAt: null },
    );

    await laptop.spokeWake.report();

    expect(bodies).toHaveLength(1);
    const [body] = bodies;
    const parsed = JSON.parse(body ?? "") as { times: Array<Record<string, string>> };
    expect(Object.keys(parsed)).toEqual(["times"]);
    expect(parsed.times).toHaveLength(1);
    expect(Object.keys(parsed.times[0] ?? {}).sort()).toEqual(["nextAt", "routineId"]);
    for (const content of ["automation", "secret", "paused", "exhausted", "prompt", "project"]) {
      expect(body).not.toContain(content);
    }
    // The hub holds the same and nothing else.
    expect(JSON.stringify(hub.state.load().hub?.wake)).not.toContain("automation");
  });

  it("is sent again when the next occurrence changes, and a removed or disabled routine is withdrawn", async () => {
    const { clock, hub, laptop } = await startPair();
    laptop.spoke.setGrant(wakeGrant, window);
    const routine = {
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 30 * MINUTE),
    };
    laptop.routines.push(routine);
    expect(await laptop.spokeWake.report()).toEqual({ status: "sent", count: 1 });
    expect(await laptop.spokeWake.report()).toEqual({ status: "unchanged" });
    const first = hub.state.load().hub?.wake?.spokes[0]?.times[0];

    laptop.routines[0] = { ...routine, nextDueAt: iso(clock.now() + 60 * MINUTE) };
    expect(await laptop.spokeWake.report()).toEqual({ status: "sent", count: 1 });
    const second = hub.state.load().hub?.wake?.spokes[0]?.times[0];
    // The same routine keeps its id; only the time moved.
    expect(second?.routineId).toBe(first?.routineId);
    expect(second?.nextAt).not.toBe(first?.nextAt);

    laptop.routines[0] = { ...routine, enabled: false };
    expect(await laptop.spokeWake.report()).toEqual({ status: "sent", count: 0 });
    expect(hub.wake.status().spokes).toEqual([]);
  });

  it("is sent only while the spoke's person has Wake ticked, and withdrawn when they untick it", async () => {
    const { clock, hub, laptop } = await startPair();
    laptop.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 30 * MINUTE),
    });

    expect(await laptop.spokeWake.report()).toEqual({
      status: "refused",
      kind: "wake-not-granted",
    });
    expect(hub.wake.status().spokes).toEqual([]);
    expect(laptop.spokeWake.status().sharing).toBe(false);

    laptop.spoke.setGrant(wakeGrant, window);
    expect(await laptop.spokeWake.report()).toEqual({ status: "sent", count: 1 });
    expect(hub.wake.status().spokes).toHaveLength(1);

    laptop.spoke.setGrant({ items: ["roster", "introduce", "owners"], actProjects: [] }, window);
    expect(await laptop.spokeWake.report()).toEqual({ status: "sent", count: 0 });
    expect(hub.wake.status().spokes).toEqual([]);
  });

  it("is filed under the member whose key signed it, and the body cannot name another", async () => {
    const { clock, hub, laptop } = await startPair();
    const times = [
      { routineId: decodeNudgeId("r".repeat(22)), nextAt: iso(clock.now() + 5 * MINUTE) },
    ];

    const named = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.wakeTimes,
      body: { times, memberId: hub.hostId },
    });
    expect(named?.status).toBe(400);

    const filed = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.wakeTimes,
      body: { times },
    });
    expect(filed?.status).toBe(200);
    expect(hub.state.load().hub?.wake?.spokes.map((spoke) => String(spoke.memberId))).toEqual([
      laptop.hostId,
    ]);

    // The hub's own id is not a spoke, and a stranger's signature proves nothing.
    expect(await hub.wake.receiveReport(hub.hostId, { times })).toEqual({
      status: "refused",
      kind: "not-a-spoke",
    });
    const stranger = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.wakeTimes,
      body: { times },
      senderId: "99999999-9999-4999-8999-999999999999",
    });
    expect(stranger?.status).toBe(401);
  });

  it("is refused while the hub's wake service is off, and by a host that is not a hub", async () => {
    const { clock, hub, laptop } = await startPair();
    const times = [
      { routineId: decodeNudgeId("r".repeat(22)), nextAt: iso(clock.now() + 5 * MINUTE) },
    ];
    await hub.wake.setEnabled(false, window);

    const off = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.wakeTimes,
      body: { times },
    });
    expect(off?.status).toBe(403);
    expect(await off?.json()).toEqual({ status: "refused", kind: "wake-service-off" });

    const notAHub = await signedRequest({
      signer: hub,
      recipient: laptop,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.wakeTimes,
      body: { times },
    });
    expect(notAHub?.status).toBe(403);
    expect(await notAHub?.json()).toEqual({ status: "refused", kind: "hub-role-off" });
  });
});

describe("a spoke deciding what a nudge is worth", () => {
  const hubSender = (hub: HubTestHost) => ({
    kind: "hub" as const,
    memberId: decodeMemberId(hub.hostId),
  });

  async function readyPair() {
    const pair = await startPair();
    pair.laptop.spoke.setGrant(wakeGrant, window);
    pair.laptop.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(pair.clock.now() + 5 * MINUTE),
    });
    await pair.laptop.spokeWake.report();
    const [reported] = pair.hub.state.load().hub?.wake?.spokes[0]?.times ?? [];
    if (reported === undefined) throw new Error("Nothing was reported.");
    return { ...pair, reported };
  }

  it("does nothing and starts nothing for an id it does not have", async () => {
    const { hub, laptop, reported } = await readyPair();

    const result = await laptop.spokeWake.receiveNudge(hubSender(hub), {
      routineId: decodeNudgeId("x".repeat(22)),
      occurrenceAt: reported.nextAt,
    });

    expect(result).toEqual({ status: "ignored", kind: "unknown-routine" });
    expect(laptop.schedulerPokes.count).toBe(0);
    expect(laptop.records.at(-1)).toMatchObject({
      change: "wake-nudge-refused",
      actingPrincipal: { kind: "hub" },
      wakeReason: "unknown-routine",
    });
  });

  it("does nothing for an id whose routine was disabled or removed since it was reported", async () => {
    const { hub, laptop, reported } = await readyPair();
    laptop.routines.length = 0;

    const result = await laptop.spokeWake.receiveNudge(hubSender(hub), {
      routineId: reported.routineId,
      occurrenceAt: reported.nextAt,
    });

    expect(result).toEqual({ status: "ignored", kind: "unknown-routine" });
    expect(laptop.schedulerPokes.count).toBe(0);
  });

  it("does nothing for a time that is not its own next occurrence", async () => {
    const { hub, laptop, reported } = await readyPair();

    const result = await laptop.spokeWake.receiveNudge(hubSender(hub), {
      routineId: reported.routineId,
      occurrenceAt: iso(Date.parse(reported.nextAt) + 30 * MINUTE),
    });

    expect(result).toEqual({ status: "ignored", kind: "time-mismatch" });
    expect(laptop.schedulerPokes.count).toBe(0);
  });

  it("does nothing for an occurrence that is still far off", async () => {
    const pair = await startPair();
    const { clock, hub, laptop } = pair;
    laptop.spoke.setGrant(wakeGrant, window);
    laptop.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 3 * 60 * MINUTE),
    });
    await laptop.spokeWake.report();
    const [reported] = hub.state.load().hub?.wake?.spokes[0]?.times ?? [];
    if (reported === undefined) throw new Error("Nothing was reported.");

    const result = await laptop.spokeWake.receiveNudge(hubSender(hub), {
      routineId: reported.routineId,
      occurrenceAt: reported.nextAt,
    });

    expect(result).toEqual({ status: "ignored", kind: "too-early" });
    expect(laptop.schedulerPokes.count).toBe(0);
  });

  it("wakes its scheduler for a nudge that checks out, and a nudge is never a command to run", async () => {
    const { hub, laptop, reported } = await readyPair();
    const before = structuredClone(laptop.routines);

    const result = await laptop.spokeWake.receiveNudge(hubSender(hub), {
      routineId: reported.routineId,
      occurrenceAt: reported.nextAt,
    });

    expect(result).toEqual({ status: "accepted" });
    // The only thing the spoke can do with a nudge is poke the scheduler it already runs.
    expect(laptop.schedulerPokes.count).toBe(1);
    expect(laptop.routines).toEqual(before);
  });

  it("refuses a nudge, whoever sends it, once the person unticks Wake", async () => {
    const { clock, hub, laptop } = await readyPair();
    laptop.spoke.setGrant({ items: ["roster", "introduce", "owners"], actProjects: [] }, window);

    clock.state.offset = 4 * MINUTE;
    await hub.wake.tick();

    expect(laptop.schedulerPokes.count).toBe(0);
    expect(hub.wake.status().spokes[0]?.lastResult).toMatchObject({ result: "refused" });
    expect(laptop.records.at(-1)).toMatchObject({
      change: "wake-nudge-refused",
      wakeReason: "wake-not-granted",
    });
    expect(hub.records.at(-1)).toMatchObject({
      change: "wake-nudge-refused",
      actingPrincipal: { kind: "hub" },
      wakeReason: "wake-not-granted",
    });
  });

  it("refuses a nudge from a member that is neither the hub nor a named standby", async () => {
    const { network, clock, hub, laptop, reported } = await readyPair();
    const desk = await start(network, clock, "Desk", 105);
    await join(hub, desk);
    const body = { routineId: reported.routineId, occurrenceAt: reported.nextAt };

    const fromPeer = await signedRequest({
      signer: desk,
      recipient: laptop,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.wakeNudge,
      body,
    });
    const claimingToBeTheHub = await signedRequest({
      signer: desk,
      recipient: laptop,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.wakeNudge,
      body,
      senderId: hub.hostId,
    });

    expect(fromPeer?.status).toBe(403);
    expect(await fromPeer?.json()).toEqual({ status: "refused", kind: "not-a-named-standby" });
    expect(claimingToBeTheHub?.status).toBe(401);
    expect(laptop.schedulerPokes.count).toBe(0);
  });
});

const decodeNudgeId = Schema.decodeUnknownSync(WakeRoutineId);

describe("the wake service in a failover", () => {
  async function startFamily(standbyExtra: Partial<Parameters<typeof startHubTestHost>[0]> = {}) {
    const network = new HubTestNetwork();
    const clock = makeClock();
    const hub = await start(network, clock, "Mac mini", 103);
    const standby = await start(network, clock, "Standby", 104, standbyExtra);
    const member = await start(network, clock, "Laptop", 105);
    const enabled = hub.hub.enable(window);
    if (enabled.status !== "enabled") throw new Error(enabled.status);
    await join(hub, standby);
    await join(hub, member);
    await hub.wake.setEnabled(true, window);
    return { network, clock, hub, standby, member };
  }

  it("hands the hub's wake times to a standby, which wakes a spoke that ticked Wake and Standby, and hands back what spokes told it", async () => {
    const { network, clock, hub, standby, member } = await startFamily();
    standby.spoke.setGrant(standbyGrant, window);
    member.spoke.setGrant(wakeAndStandbyGrant, window);
    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    if (ordered.status !== "ordered") throw new Error(JSON.stringify(ordered));
    member.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 10 * MINUTE),
    });
    expect(await member.spokeWake.report()).toEqual({ status: "sent", count: 1 });
    // The hub hands the standby a copy of what it holds.
    await vi.waitFor(() => expect(standby.state.load().link?.wakeCopy).toHaveLength(1));
    const copied = standby.state.load().link?.wakeCopy?.[0];
    expect(String(copied?.memberId)).toBe(member.hostId);
    expect(copied?.times).toEqual(hub.state.load().hub?.wake?.spokes[0]?.times);
    expect(JSON.stringify(copied)).not.toContain("automation");
    await standby.failover.tick();
    await member.failover.tick();

    // The hub stops; the standby stands in and the member follows it.
    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(true);
    await vi.waitFor(() =>
      expect(member.spoke.status()).toMatchObject({ rosterSignedBy: "standby" }),
    );

    // A routine the member adds now is reported to the standby, which keeps it apart from the copy.
    member.routines.push({
      id: "automation-b",
      enabled: true,
      nextDueAt: iso(clock.now() + 30 * MINUTE),
    });
    expect(await member.spokeWake.report()).toEqual({ status: "sent", count: 2 });
    expect(standby.state.load().link?.standIn?.wakeReports?.[0]?.times).toHaveLength(2);

    // Inside the lead time the standby nudges the member, which believes it: the standby is
    // named, the member ticked Standby, and the member cannot reach the hub.
    clock.state.offset = 9 * MINUTE;
    await standby.wake.tick();
    expect(member.schedulerPokes.count).toBe(1);
    expect(standby.records.at(-1)).toMatchObject({
      change: "wake-nudge-sent",
      actingPrincipal: { kind: "hub" },
      memberId: member.hostId,
    });

    // The hub returns; the standby steps down and hands back the times spokes told it.
    clock.state.offset = 0;
    network.start(hub.address);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(false);
    const held = hub.state.load().hub?.wake?.spokes ?? [];
    expect(held.map((spoke) => String(spoke.memberId))).toEqual([member.hostId]);
    expect(held[0]?.times).toHaveLength(2);
    expect(hub.records.map((record) => record.change)).toEqual(
      expect.arrayContaining(["stand-in-merged", "wake-times-merged"]),
    );
  });

  it("asks a spoke to report again while the standby hands back, and the hub then holds the times it kept", async () => {
    let release: () => void = () => undefined;
    let gate = Promise.resolve();
    let handbacks = 0;
    const { network, clock, hub, standby, member } = await startFamily({
      failoverTransport: (transport) => (target) => {
        const fetchTo = transport(target);
        return async (url, init) => {
          if (init?.method !== "POST" || !url.endsWith("/api/hub/handback")) {
            return fetchTo(url, init);
          }
          handbacks += 1;
          await gate;
          return fetchTo(url, init);
        };
      },
    });
    standby.spoke.setGrant(standbyGrant, window);
    member.spoke.setGrant(wakeAndStandbyGrant, window);
    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    if (ordered.status !== "ordered") throw new Error(JSON.stringify(ordered));
    member.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 10 * MINUTE),
    });
    expect(await member.spokeWake.report()).toEqual({ status: "sent", count: 1 });
    await vi.waitFor(() => expect(standby.state.load().link?.wakeCopy).toHaveLength(1));
    await standby.failover.tick();
    await member.failover.tick();
    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(true);
    await vi.waitFor(() =>
      expect(member.spoke.status()).toMatchObject({ rosterSignedBy: "standby" }),
    );

    // The hub answers again and the hand-back starts, then waits on the gate.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    network.start(hub.address);
    const stepping = standby.failover.tick();
    await vi.waitFor(() => expect(handbacks).toBe(1));

    member.routines.push({
      id: "automation-b",
      enabled: true,
      nextDueAt: iso(clock.now() + 30 * MINUTE),
    });
    expect(await member.spokeWake.report()).toEqual({
      status: "declined",
      kind: "handing-back",
    });
    expect(standby.state.load().link?.standIn?.wakeReports ?? []).toEqual([]);

    release();
    await stepping;
    expect(standby.failover.standingIn()).toBe(false);

    // The spoke still has the times to send, so it reports them to the hub it follows next.
    await member.failover.tick();
    await vi.waitFor(async () =>
      expect(await member.spokeWake.report()).toEqual({ status: "sent", count: 2 }),
    );
    expect(hub.state.load().hub?.wake?.spokes[0]?.times).toHaveLength(2);
  });

  it("refuses a standby's nudge from a spoke that did not tick Standby, and while the hub is reachable", async () => {
    const { clock, hub, standby, member } = await startFamily();
    standby.spoke.setGrant(standbyGrant, window);
    member.spoke.setGrant(wakeGrant, window);
    await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    member.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 5 * MINUTE),
    });
    await member.spokeWake.report();
    const [reported] = hub.state.load().hub?.wake?.spokes[0]?.times ?? [];
    if (reported === undefined) throw new Error("Nothing was reported.");
    const body = { routineId: reported.routineId, occurrenceAt: reported.nextAt };
    const nudge = () =>
      signedRequest({
        signer: standby,
        recipient: member,
        clock,
        method: "POST",
        path: HUB_LINK_ROUTES.wakeNudge,
        body,
      });

    const withoutStandby = await nudge();
    expect(withoutStandby?.status).toBe(403);
    expect(await withoutStandby?.json()).toEqual({
      status: "refused",
      kind: "standby-not-granted",
    });

    member.spoke.setGrant(wakeAndStandbyGrant, window);
    const hubReachable = await nudge();
    expect(hubReachable?.status).toBe(403);
    expect(await hubReachable?.json()).toEqual({ status: "refused", kind: "hub-reachable" });
    expect(member.schedulerPokes.count).toBe(0);
  });

  it("refuses a wake copy from anyone but the hub, and from a hub to a spoke that did not tick Standby", async () => {
    const { clock, hub, standby, member } = await startFamily();
    const body = { spokes: [] };

    const fromMember = await signedRequest({
      signer: member,
      recipient: standby,
      clock,
      method: "PUT",
      path: HUB_LINK_ROUTES.wakeCopy,
      body,
    });
    const withoutStandby = await signedRequest({
      signer: hub,
      recipient: standby,
      clock,
      method: "PUT",
      path: HUB_LINK_ROUTES.wakeCopy,
      body,
    });

    expect(fromMember?.status).toBe(401);
    expect(withoutStandby?.status).toBe(403);
    expect(await withoutStandby?.json()).toEqual({ status: "refused", kind: "item-not-granted" });
    expect(standby.state.load().link?.wakeCopy).toBeUndefined();
  });
});

describe("the wake service's own switch", () => {
  it("is off until the hub's window turns it on, works only on a hub, and forgets every time when turned off", async () => {
    const network = new HubTestNetwork();
    const clock = makeClock();
    const hub = await start(network, clock, "Mac mini", 103);
    const laptop = await start(network, clock, "Laptop", 104);

    expect(await hub.wake.setEnabled(true, window)).toEqual({
      status: "refused",
      kind: "hub-role-off",
    });
    hub.hub.enable(window);
    await join(hub, laptop);
    expect(hub.wake.status().enabled).toBe(false);
    laptop.spoke.setGrant(wakeGrant, window);
    laptop.routines.push({
      id: "automation-a",
      enabled: true,
      nextDueAt: iso(clock.now() + 30 * MINUTE),
    });
    // Off: the hub takes no report.
    expect(await laptop.spokeWake.report()).toEqual({
      status: "declined",
      kind: "wake-service-off",
    });

    await hub.wake.setEnabled(true, window);
    expect(await laptop.spokeWake.report()).toEqual({ status: "sent", count: 1 });
    expect(hub.wake.status().spokes).toHaveLength(1);

    await hub.wake.setEnabled(false, window);
    expect(hub.wake.status()).toEqual({ enabled: false, spokes: [] });
    expect(hub.records.filter((record) => record.change === "wake-switch-changed")).toHaveLength(2);
  });
});
