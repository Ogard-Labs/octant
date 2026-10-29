import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeHubJoinRequest } from "@octant/contracts";
import { hubRosterSigningPayload } from "@octant/domain";
import { digestFromListenerPin, publicKeyFingerprint, verifySignature } from "./hubCrypto";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;

async function startHub(listenerStatus?: Parameters<typeof startHubTestHost>[0]["listenerStatus"]) {
  const network = new HubTestNetwork();
  const hub = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network,
    cleanups,
    ...(listenerStatus === undefined ? {} : { listenerStatus }),
  });
  const member = await startHubTestHost({
    name: "Laptop",
    address: "100.101.102.104",
    network,
    cleanups,
  });
  return { network, hub, member };
}

/** The request a joining host sends, as its own server would make it. */
function joinRequest(
  member: HubTestHost,
  ticket: { readonly ticketId: string; readonly ticketProof: string },
  overrides: { readonly listenerOrigin?: string; readonly identityKeyFingerprint?: string } = {},
) {
  return decodeHubJoinRequest({
    ticketId: ticket.ticketId,
    ticketProof: ticket.ticketProof,
    member: {
      memberId: member.hostId,
      name: member.name,
      identityKeyFingerprint:
        overrides.identityKeyFingerprint ?? publicKeyFingerprint(member.hostPublicKey),
      listenerPin: digestFromListenerPin(member.listener.tlsPin ?? "") ?? "",
      privateNames: [],
      addresses: [member.address],
    },
    identityPublicKey: member.hostPublicKey,
    listenerOrigin: overrides.listenerOrigin ?? member.origin,
  });
}

describe("the hub role of a host", () => {
  it("signs a roster that lists the hub, and bumps its sequence on every change", async () => {
    const { hub } = await startHub();

    const enabled = hub.hub.enable(window);
    if (enabled.status !== "enabled") throw new Error(enabled.status);

    expect(enabled.roster.roster.sequence).toBe(1);
    expect(enabled.roster.roster.members).toMatchObject([
      { name: "Mac mini", role: "hub", memberId: hub.hostId },
    ]);
    expect(hub.state.load().hub?.roster?.signature).toBe(enabled.roster.signature);
    expect(hub.hub.disable(window)).toEqual({ status: "disabled" });
    const again = hub.hub.enable(window);
    if (again.status !== "enabled") throw new Error(again.status);
    expect(again.roster.roster.sequence).toBe(2);
  });

  it("keeps its roster signing key and state where only the person's account reads them", async () => {
    const { hub } = await startHub();
    hub.hub.enable(window);

    const directory = join(hub.directory, "hub");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "roster-signing-key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "hub-state.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses to turn on over a certificate it cannot give members a pin for", async () => {
    const { hub } = await startHub({ tlsPin: null, certificateSource: "pasted" });

    expect(hub.hub.enable(window)).toEqual({ status: "refused", kind: "listener-has-no-pin" });
  });

  it("makes no join code while the hub role is off", async () => {
    const { hub } = await startHub();

    expect(hub.hub.mintJoinCode({ owner: false })).toEqual({
      status: "refused",
      kind: "hub-role-off",
    });
  });

  it("remembers which join codes it made for an owner", async () => {
    const { hub, member } = await startHub();
    hub.hub.enable(window);
    const ownerCode = hub.hub.mintJoinCode({ owner: true });
    const plainCode = hub.hub.mintJoinCode({ owner: false });
    if (ownerCode.status !== "minted" || plainCode.status !== "minted") throw new Error("no code");

    const tickets = hub.state.load().hub?.joinTickets ?? [];

    expect(tickets.map((ticket) => ticket.owner)).toEqual([true, false]);
    expect(member.spoke.status()).toEqual({ membership: "none" });
  });

  it("verifies its roster with the key it hands a joining member", async () => {
    const { hub, member } = await startHub();
    hub.hub.enable(window);
    const minted = hub.hub.mintJoinCode({ owner: false });
    if (minted.status !== "minted") throw new Error(minted.status);
    await member.spoke.startJoin({ code: minted.code });
    const [pending] = hub.administration.listPendingPairings();
    if (pending === undefined) throw new Error("No pairing to approve.");
    hub.administration.approvePairing({ ticketId: pending.ticketId });
    const ticket = hub.state.load().hub?.joinTickets[0];
    if (ticket === undefined) throw new Error("No join ticket.");

    const joined = hub.hub.acceptJoin(
      joinRequest(member, {
        ticketId: ticket.ticketId,
        // The proof the code carried reaches the hub only from the member.
        ticketProof: JSON.parse(
          Buffer.from(minted.code.slice("octant-pair-1.".length), "base64url").toString("utf8"),
        ).ticketProof,
      }),
    );

    if (joined.status !== "joined") throw new Error(joined.status);
    expect(
      verifySignature({
        payload: hubRosterSigningPayload(joined.response.roster.roster),
        signature: joined.response.roster.signature,
        publicKey: joined.response.hub.rosterSigningPublicKey,
      }),
    ).toBe(true);
  });
});

describe("admitting a member that asks to join", () => {
  it("refuses a pairing ticket that was not made as a join code", async () => {
    const { hub, member } = await startHub();
    hub.hub.enable(window);
    // A phone's pairing ticket pairs a device; it does not make a member.
    const ticket = hub.administration.createPairingTicket({ sourceClass: "tailscale" });

    const outcome = hub.hub.acceptJoin(
      joinRequest(member, { ticketId: String(ticket.ticketId), ticketProof: ticket.ticketProof }),
    );

    expect(outcome).toEqual({ status: "refused", kind: "not-a-join-code" });
  });

  it("refuses a join code the person has not approved", async () => {
    const { hub, member } = await startHub();
    hub.hub.enable(window);
    const minted = hub.hub.mintJoinCode({ owner: false });
    if (minted.status !== "minted") throw new Error(minted.status);
    await member.spoke.startJoin({ code: minted.code });
    const ticket = hub.state.load().hub?.joinTickets[0];
    if (ticket === undefined) throw new Error("No join ticket.");

    const outcome = hub.hub.acceptJoin(
      joinRequest(member, { ticketId: ticket.ticketId, ticketProof: "A".repeat(43) }),
    );

    expect(outcome).toEqual({ status: "refused", kind: "not-approved" });
  });

  it("refuses a member that names a public listener address", async () => {
    const { hub, member } = await startHub();
    hub.hub.enable(window);

    const outcome = hub.hub.acceptJoin(
      joinRequest(
        member,
        { ticketId: "11111111-1111-4111-8111-111111111111", ticketProof: "A".repeat(43) },
        { listenerOrigin: "https://203.0.113.7:8443" },
      ),
    );

    expect(outcome).toEqual({ status: "refused", kind: "member-origin-not-private" });
  });

  it("refuses a key that is not the one the member's roster entry names", async () => {
    const { hub, member } = await startHub();
    hub.hub.enable(window);

    const outcome = hub.hub.acceptJoin(
      joinRequest(
        member,
        { ticketId: "11111111-1111-4111-8111-111111111111", ticketProof: "A".repeat(43) },
        { identityKeyFingerprint: "0".repeat(64) },
      ),
    );

    expect(outcome).toEqual({ status: "refused", kind: "identity-mismatch" });
  });

  it("admits nobody while the hub role is off", async () => {
    const { hub, member } = await startHub();

    const outcome = hub.hub.acceptJoin(
      joinRequest(member, {
        ticketId: "11111111-1111-4111-8111-111111111111",
        ticketProof: "A".repeat(43),
      }),
    );

    expect(outcome).toEqual({ status: "refused", kind: "hub-role-off" });
  });

  it("refuses to remove the hub itself or a member it does not know", async () => {
    const { hub } = await startHub();
    hub.hub.enable(window);

    expect(await hub.hub.removeMember({ memberId: hub.hostId }, window)).toEqual({
      status: "refused",
      kind: "cannot-remove-the-hub",
    });
    expect(
      await hub.hub.removeMember({ memberId: "44444444-4444-4444-8444-444444444444" }, window),
    ).toEqual({ status: "refused", kind: "not-a-member" });
  });
});
