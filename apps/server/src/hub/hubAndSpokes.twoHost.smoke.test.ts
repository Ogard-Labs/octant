// Two hosts in one process, each the real remote gateway behind a real TLS
// listener serving a certificate it made itself. Host A turns on the hub role
// and makes a join code; host B joins with it, pinned to A's certificate; A
// then removes B and B learns of it from the next signed roster.

import { afterEach, describe, expect, it } from "vitest";
import { buildPairingCode } from "@octant/domain";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;

async function startPair() {
  const network = new HubTestNetwork();
  const a = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network,
    cleanups,
  });
  const b = await startHubTestHost({
    name: "Laptop",
    address: "100.101.102.104",
    network,
    cleanups,
  });
  return { network, a, b };
}

/** B joins A the way a person does: a code from A, a comparison on both screens, approval on A. */
async function join(a: HubTestHost, b: HubTestHost, input: { readonly owner: boolean }) {
  const enabled = a.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  const minted = a.hub.mintJoinCode({ owner: input.owner });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await b.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const [pending] = a.administration.listPendingPairings();
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  expect(pending.comparisonCode).toBe(started.comparisonCode);
  expect(await b.spoke.finishJoin(window)).toEqual({ status: "awaiting-approval" });
  a.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await b.spoke.finishJoin(window);
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
  return { enabled, finished, pending };
}

describe("a hub and a spoke on two hosts", () => {
  it("joins with a code, receives the signed roster, and learns of its removal from the next one", async () => {
    const { a, b } = await startPair();

    const { enabled, finished } = await join(a, b, { owner: true });

    expect(enabled.roster.roster.sequence).toBe(1);
    expect(finished.rosterSequence).toBe(2);
    expect(finished.grant.items).toEqual(["roster", "introduce", "owners"]);
    const joined = b.spoke.status();
    if (joined.membership !== "member") throw new Error("B did not join.");
    expect(joined.hub.name).toBe("Mac mini");
    expect(
      joined.roster.roster.members.map((member) => [member.name, member.role, member.owner]),
    ).toEqual([
      ["Mac mini", "hub", false],
      ["Laptop", "spoke", true],
    ]);
    expect(joined.roster.signedBy.kind).toBe("hub");

    const removed = await a.hub.removeMember({ memberId: b.hostId }, window);
    expect(removed).toEqual({ status: "removed", sequence: 3 });

    const after = b.spoke.status();
    if (after.membership !== "removed") throw new Error("B still thinks it is a member.");
    expect(after.roster.roster.sequence).toBe(3);
    expect(after.roster.roster.members.map((member) => member.name)).toEqual(["Mac mini"]);
    // The hub revoked B's device when it removed B.
    expect(a.administration.listDevices().map((device) => device.state)).toEqual(["revoked"]);

    // Each change is journaled with the principal that petitioned.
    expect(a.records.map((record) => [record.change, record.actingPrincipal.kind])).toEqual([
      ["hub-role-enabled", "local-window"],
      ["member-added", "remote-device"],
      ["member-removed", "local-window"],
    ]);
    expect(b.records.map((record) => [record.change, record.actingPrincipal.kind])).toEqual([
      ["joined-hub", "local-window"],
      ["roster-accepted", "hub"],
    ]);
  });

  it("drops a member that tells the hub it left from the next roster and revokes its device", async () => {
    const { a, b } = await startPair();
    await join(a, b, { owner: false });

    const left = await b.spoke.leave(window);

    expect(left).toEqual({ status: "left", hubNotified: true });
    expect(b.spoke.status()).toEqual({ membership: "none" });
    expect(a.hub.status().roster?.roster.members.map((member) => member.name)).toEqual([
      "Mac mini",
    ]);
    expect(a.hub.status().roster?.roster.sequence).toBe(3);
    expect(a.administration.listDevices().every((device) => device.state === "revoked")).toBe(true);
    expect(a.records.map((record) => record.change)).toContain("member-left");
  });

  it("refuses a join code whose address was changed to a public one without contacting anything", async () => {
    const { network, a, b } = await startPair();
    a.hub.enable(window);
    const minted = a.hub.mintJoinCode({ owner: false });
    if (minted.status !== "minted") throw new Error(minted.status);
    const payload = JSON.parse(
      Buffer.from(minted.code.slice("octant-pair-1.".length), "base64url").toString("utf8"),
    ) as Record<string, string>;
    const tampered = buildPairingCode({
      origin: "https://203.0.113.7:8443",
      ticketId: payload.ticketId ?? "",
      ticketProof: payload.ticketProof ?? "",
      pin: payload.pin ?? "",
    });
    const forged = `octant-pair-1.${Buffer.from(
      JSON.stringify({ ...payload, origin: "https://203.0.113.7:8443" }),
    ).toString("base64url")}`;

    const started = await b.spoke.startJoin({ code: forged });

    expect(tampered.status).toBe("refused");
    expect(started).toEqual({ status: "refused", kind: "hub-origin-not-private" });
    expect(network.dialled).toEqual([]);
    expect(a.requests).toEqual([]);
  });

  it("refuses a join code whose pin is not the hub's key before anything reaches the hub", async () => {
    const { a, b } = await startPair();
    a.hub.enable(window);
    const minted = a.hub.mintJoinCode({ owner: false });
    if (minted.status !== "minted") throw new Error(minted.status);
    const payload = JSON.parse(
      Buffer.from(minted.code.slice("octant-pair-1.".length), "base64url").toString("utf8"),
    ) as Record<string, string>;
    const wrongPin = `sha256-${Buffer.alloc(32, 9).toString("base64url")}`;
    const built = buildPairingCode({
      origin: payload.origin ?? "",
      ticketId: payload.ticketId ?? "",
      ticketProof: payload.ticketProof ?? "",
      pin: wrongPin,
    });
    if (built.status !== "built") throw new Error(built.reason);

    const started = await b.spoke.startJoin({ code: built.code });

    expect(started).toEqual({ status: "refused", kind: "hub-identity-unproven" });
    expect(a.administration.listPendingPairings()).toEqual([]);
    expect(b.spoke.status()).toEqual({ membership: "none" });
  });
});
