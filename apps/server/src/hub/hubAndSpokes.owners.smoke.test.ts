// Four hosts in one process, each a real remote gateway behind a real TLS
// listener: a hub, a spoke, and two devices of the same person. The phone is an
// owner device holding a software unlock key. It confirms a new member and
// changes the spoke's hub grant with a fresh unlock, while the same request
// without an unlock, replayed, bound to another action, expired, or sent by the
// hub is refused and changes nothing.

import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubMemberId, type HubGrant, type NewMemberConfirmation } from "@octant/contracts";
import { hubRosterSigningPayload, newMemberConfirmationSigningPayload } from "@octant/domain";
import {
  admitGuestOnSpoke,
  createInMemoryDeviceKeyStore,
  guestSpokeTargets,
  joinHubAsGuest,
  type PinnedListenerTransportPort,
} from "@octant/client-runtime";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { publicKeyFingerprint } from "./hubCrypto";
import { HUB_OWNER_ROUTES } from "./hubOwnerRoutes";
import {
  ownerCall,
  softwareAuthenticator,
  type SoftwareAuthenticator,
} from "./hubOwner.test-support";
import { createPinnedHubTransport } from "./pinnedHubTransport";
import { createRosterSigningKeyStore } from "./rosterSigningKey";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);

const GRANT_WITH_STATUS: HubGrant = {
  items: ["roster", "status", "introduce", "owners"],
  actProjects: [],
};
const GRANT_WITHOUT_OWNERS: HubGrant = { items: ["roster", "introduce"], actProjects: [] };

/** A device joins the hub the way a person does: a code, a comparison on both screens, approval on the hub. */
async function joinHub(
  hub: HubTestHost,
  device: HubTestHost,
  input: { readonly owner: boolean; readonly unlockPublicKey?: string },
) {
  const minted = hub.hub.mintJoinCode({ owner: input.owner });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await device.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const [pending] = hub.administration.listPendingPairings();
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await device.spoke.finishJoin(
    window,
    input.unlockPublicKey === undefined ? {} : { unlockPublicKey: input.unlockPublicKey },
  );
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

async function startHosts(count: number) {
  const network = new HubTestNetwork();
  const hosts: HubTestHost[] = [];
  for (const [index, name] of ["Mac mini", "Laptop", "Phone", "Tablet"].slice(0, count).entries()) {
    hosts.push(
      await startHubTestHost({
        name,
        address: `100.101.102.${103 + index}`,
        network,
        cleanups,
      }),
    );
  }
  return { network, hosts };
}

/** A hub, a laptop spoke, and a phone that is the hub's first owner; the laptop's person has not listed it yet. */
async function startOwnerWorld() {
  const { network, hosts } = await startHosts(3);
  const [hub, spoke, phone] = hosts as [HubTestHost, HubTestHost, HubTestHost];
  const authenticator = softwareAuthenticator();
  hub.hub.enable(window);
  await joinHub(hub, phone, { owner: true, unlockPublicKey: authenticator.publicKey });
  await joinHub(hub, spoke, { owner: false });
  return { network, hub, spoke, phone, authenticator };
}

/** The laptop's person lists the phone as an owner, having compared its name and fingerprint. */
function listAsOwner(spoke: HubTestHost, phone: HubTestHost, authenticator: SoftwareAuthenticator) {
  return spoke.spoke.addOwners(
    [
      {
        memberId: decodeMemberId(phone.hostId),
        identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
        unlockKeyFingerprint: authenticator.fingerprint,
      },
    ],
    window,
  );
}

const grantItems = (spoke: HubTestHost) => {
  const status = spoke.spoke.status();
  if (status.membership !== "member") throw new Error("Not a member.");
  return status.grant.items;
};

describe("owner devices administering a spoke", () => {
  it("changes the spoke's hub grant when the owner device presents a fresh unlock, and journals it as the owner", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    expect(listAsOwner(spoke, phone, authenticator).status).toBe("changed");

    const answered = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });

    expect(answered.status).toBe(200);
    expect(grantItems(spoke)).toEqual(["roster", "status", "introduce", "owners"]);
    const changed = spoke.records.filter((entry) => entry.change === "hub-grant-changed").at(-1);
    expect(changed?.actingPrincipal).toEqual({
      kind: "owner-unlock",
      memberId: phone.hostId,
    });
  });

  it("refuses the same request without an unlock and changes nothing", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);

    const answered = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
    });

    expect(answered.status).toBe(403);
    expect(answered.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce", "owners"]);
  });

  it("refuses an unlock that is sent again", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    const first = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });
    expect(first.status).toBe(200);
    spoke.spoke.setGrant({ items: ["roster", "owners"], actProjects: [] }, window);

    const replayed = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      ...(first.proofHeader === undefined
        ? {}
        : { unlock: { authenticator, shape: "raw", reuse: first.proofHeader } }),
    });

    expect(replayed.status).toBe(403);
    expect(replayed.json).toEqual({ status: "refused", kind: "unlock-no-such-challenge" });
    expect(grantItems(spoke)).toEqual(["roster", "owners"]);
  });

  it("refuses an unlock that was issued for a different action or a different body", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);

    const otherRoute = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: {
        authenticator,
        shape: "raw",
        boundTo: {
          route: HUB_OWNER_ROUTES.confirmNewMembers,
          body: JSON.stringify({ enabled: true }),
        },
      },
    });
    const otherBody = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: {
        authenticator,
        shape: "raw",
        boundTo: { route: HUB_OWNER_ROUTES.grant, body: JSON.stringify(GRANT_WITHOUT_OWNERS) },
      },
    });

    expect(otherRoute.json).toEqual({ status: "refused", kind: "unlock-action-mismatch" });
    expect(otherBody.json).toEqual({ status: "refused", kind: "unlock-action-mismatch" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce", "owners"]);
  });

  it("refuses an unlock that was held longer than its minute", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);

    const answered = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw", delayMs: 61_000 },
    });

    expect(answered.json).toEqual({ status: "refused", kind: "unlock-expired" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce", "owners"]);
  });

  it("accepts a passkey assertion as the unlock and refuses one without user verification", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);

    const unverified = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "webauthn", flags: 0x01 },
    });
    const verified = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "webauthn" },
    });

    expect(unverified.json).toEqual({
      status: "refused",
      kind: "unlock-user-verification-missing",
    });
    expect(verified.status).toBe(200);
    expect(grantItems(spoke)).toEqual(["roster", "status", "introduce", "owners"]);
  });

  it("refuses an unlock signed by a key the spoke never recorded for the owner", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);

    const answered = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator: softwareAuthenticator(), shape: "raw" },
    });

    expect(answered.json).toEqual({ status: "refused", kind: "unlock-signature-invalid" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce", "owners"]);
  });

  it("adds nobody to the owner list because the hub's roster marks them as an owner", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    const held = spoke.spoke.status();
    if (held.membership !== "member") throw new Error("Not a member.");
    expect(held.roster.roster.members.find((member) => member.name === "Phone")?.owner).toBe(true);

    const answered = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });

    expect(answered.json).toEqual({ status: "refused", kind: "not-an-owner" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce", "owners"]);
  });

  it("refuses the hub even when it presents what looks like an unlock", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);

    const answered = await ownerCall({
      device: hub,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: { items: ["roster", "status", "act", "owners"], actProjects: [] },
      unlock: { authenticator, shape: "raw" },
    });

    expect(answered.json).toEqual({ status: "refused", kind: "hub-principal" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce", "owners"]);
  });

  it("refuses a member that is not on the owner list, even with an unlock key of its own", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    const tablet = await startTablet(network);
    await joinHub(hub, tablet, { owner: false });
    await vi.waitFor(() => {
      const held = spoke.spoke.status();
      if (held.membership !== "member") throw new Error("Not a member.");
      expect(held.roster.roster.members.map((member) => member.name)).toContain("Tablet");
    });

    const answered = await ownerCall({
      device: tablet,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator: softwareAuthenticator(), shape: "raw" },
    });

    expect(answered.json).toEqual({ status: "refused", kind: "not-an-owner" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce", "owners"]);
  });

  it("refuses an owner device on a spoke whose person unticked Owners", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    spoke.spoke.setGrant(GRANT_WITHOUT_OWNERS, window);

    const answered = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });

    expect(answered.json).toEqual({ status: "refused", kind: "owners-not-honored" });
    expect(grantItems(spoke)).toEqual(["roster", "introduce"]);
  });

  it("refuses a request that carries no member signature or one from a stranger", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    const pin = spoke.listener.tlsPin;
    if (pin === null) throw new Error("No pin.");
    const unsigned = await createPinnedHubTransport(network.network)({
      origin: spoke.origin,
      pin,
    })(`${spoke.origin}${HUB_OWNER_ROUTES.leave}`, { method: "POST", body: "" });
    const stranger = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.leave,
      omitIdentityKey: true,
    });

    expect(unsigned.status).toBe(401);
    expect(stranger.status).toBe(401);
    expect(spoke.spoke.status().membership).toBe("member");
  });

  it("lets an owner device with a fresh unlock add another owner, and remove one", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    const tablet = await startTablet(network);
    const tabletKey = softwareAuthenticator();
    await joinHub(hub, tablet, { owner: true, unlockPublicKey: tabletKey.publicKey });
    await vi.waitFor(() => {
      const held = spoke.spoke.status();
      if (held.membership !== "member") throw new Error("Not a member.");
      expect(held.roster.roster.members.map((member) => member.name)).toContain("Tablet");
    });

    const added = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.ownersAdd,
      body: {
        owners: [
          {
            memberId: tablet.hostId,
            identityKeyFingerprint: publicKeyFingerprint(tablet.hostPublicKey),
            unlockKeyFingerprint: tabletKey.fingerprint,
          },
        ],
      },
      unlock: { authenticator, shape: "raw" },
    });
    const listed = spoke.spoke.status();
    const removed = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.ownersRemove,
      body: { memberId: tablet.hostId },
      unlock: { authenticator, shape: "raw" },
    });

    expect(added.status).toBe(200);
    expect(listed.membership === "member" && listed.owners.map((owner) => owner.name)).toEqual([
      "Phone",
      "Tablet",
    ]);
    expect(removed.status).toBe(200);
    const after = spoke.spoke.status();
    expect(after.membership === "member" && after.owners.map((owner) => owner.name)).toEqual([
      "Phone",
    ]);
    expect(
      spoke.records
        .filter((entry) => entry.change === "owner-added" || entry.change === "owner-removed")
        .map((entry) => [entry.change, entry.actingPrincipal.kind]),
    ).toEqual([
      ["owner-added", "local-window"],
      ["owner-added", "owner-unlock"],
      ["owner-removed", "owner-unlock"],
    ]);
  });

  it("refuses to list the hub, a different device key, or a different unlock key as an owner", async () => {
    const { hub, spoke, phone, authenticator } = await startOwnerWorld();

    const hubAsOwner = spoke.spoke.addOwners(
      [
        {
          memberId: decodeMemberId(hub.hostId),
          identityKeyFingerprint: publicKeyFingerprint(hub.hostPublicKey),
          unlockKeyFingerprint: authenticator.fingerprint,
        },
      ],
      window,
    );
    const wrongFingerprint = spoke.spoke.addOwners(
      [
        {
          memberId: decodeMemberId(phone.hostId),
          identityKeyFingerprint: publicKeyFingerprint(authenticator.publicKey),
          unlockKeyFingerprint: authenticator.fingerprint,
        },
      ],
      window,
    );
    const otherUnlockKey = spoke.spoke.addOwners(
      [
        {
          memberId: decodeMemberId(phone.hostId),
          identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
          unlockKeyFingerprint: softwareAuthenticator().fingerprint,
        },
      ],
      window,
    );

    expect(hubAsOwner).toMatchObject({ status: "refused", kind: "cannot-own-the-hub" });
    expect(wrongFingerprint).toMatchObject({ status: "refused", kind: "identity-mismatch" });
    expect(otherUnlockKey).toMatchObject({ status: "refused", kind: "unlock-key-mismatch" });
    expect(spoke.spoke.status()).toMatchObject({ owners: [] });
  });

  it("refuses to list a member whose roster entry carries no unlock key", async () => {
    const { network, hub, spoke } = await startOwnerWorld();
    const tablet = await startTablet(network);
    await joinHub(hub, tablet, { owner: false });
    await vi.waitFor(() => {
      const held = spoke.spoke.status();
      if (held.membership !== "member") throw new Error("Not a member.");
      expect(held.roster.roster.members.map((member) => member.name)).toContain("Tablet");
    });

    const listed = spoke.spoke.addOwners(
      [
        {
          memberId: decodeMemberId(tablet.hostId),
          identityKeyFingerprint: publicKeyFingerprint(tablet.hostPublicKey),
          unlockKeyFingerprint: softwareAuthenticator().fingerprint,
        },
      ],
      window,
    );

    expect(listed).toMatchObject({ status: "refused", kind: "no-unlock-key-listed" });
  });

  it("lets the owner device leave the hub from the spoke, and nobody else", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);

    const fromHub = await ownerCall({
      device: hub,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.leave,
      unlock: { authenticator, shape: "raw" },
    });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    expect(spoke.spoke.status().membership).toBe("member");

    const left = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.leave,
      unlock: { authenticator, shape: "raw" },
    });

    expect(left.status).toBe(200);
    expect(spoke.spoke.status()).toEqual({ membership: "none" });
  });
});

describe("owner keys carried by the roster", () => {
  it("carries the owner's unlock key on its roster entry and adds nobody on the spoke until the window confirms it", async () => {
    const { network, spoke, phone, authenticator } = await startOwnerWorld();
    const held = spoke.spoke.status();
    if (held.membership !== "member") throw new Error("Not a member.");
    expect(held.roster.roster.members.find((member) => member.name === "Phone")).toMatchObject({
      owner: true,
      ownerUnlockPublicKey: authenticator.publicKey,
    });

    // Listed in the signed roster, the phone is a candidate and nothing more.
    expect(held.owners).toEqual([]);
    expect(held.ownerCandidates).toEqual([
      {
        memberId: phone.hostId,
        name: "Phone",
        identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
        unlockKeyFingerprint: authenticator.fingerprint,
      },
    ]);
    const beforeConfirm = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });
    expect(beforeConfirm.json).toEqual({ status: "refused", kind: "not-an-owner" });

    expect(listAsOwner(spoke, phone, authenticator).status).toBe("changed");
    const afterConfirm = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });

    expect(afterConfirm.status).toBe(200);
    const listed = spoke.spoke.status();
    expect(listed.membership === "member" && listed.ownerCandidates).toEqual([]);
  });

  it("keeps the key the spoke confirmed when a later roster lists another, and shows the mismatch", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    const swapped = softwareAuthenticator();
    const held = spoke.spoke.status();
    if (held.membership !== "member") throw new Error("Not a member.");
    const roster = {
      ...held.roster.roster,
      sequence: held.roster.roster.sequence + 1,
      members: held.roster.roster.members.map((member) =>
        member.name === "Phone" ? { ...member, ownerUnlockPublicKey: swapped.publicKey } : member,
      ),
    };

    const received = spoke.spoke.receiveRoster({
      roster,
      signedBy: { kind: "hub", memberId: decodeMemberId(hub.hostId) },
      signature: createRosterSigningKeyStore(hub.directory)
        .signer()
        .sign(hubRosterSigningPayload(roster)),
    });

    expect(received.status).toBe("accepted");
    const after = spoke.spoke.status();
    if (after.membership !== "member") throw new Error("Not a member.");
    expect(after.owners.map((owner) => [owner.name, owner.unlockKeyFingerprint])).toEqual([
      ["Phone", authenticator.fingerprint],
    ]);
    expect(after.ownerKeyMismatches).toEqual([
      {
        memberId: phone.hostId,
        name: "Phone",
        heldUnlockKeyFingerprint: authenticator.fingerprint,
        rosterUnlockKeyFingerprint: swapped.fingerprint,
      },
    ]);
    expect(after.ownerCandidates).toEqual([]);
    // The key the spoke confirmed still opens the owner's actions; the swapped one does not.
    const withHeld = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });
    const withSwapped = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITHOUT_OWNERS,
      unlock: { authenticator: swapped, shape: "raw" },
    });
    expect(withHeld.status).toBe(200);
    expect(withSwapped.json).toEqual({ status: "refused", kind: "unlock-signature-invalid" });
  });
});

describe("owner devices administering a hub", () => {
  it("registers the unlock key an owner presents at join as the hub's first owner", async () => {
    const { hub, phone, authenticator } = await startOwnerWorld();

    expect(hub.hub.listOwners()).toEqual([
      {
        memberId: phone.hostId,
        name: "Phone",
        identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
        unlockKeyFingerprint: authenticator.fingerprint,
      },
    ]);
    expect(
      hub.records.filter((entry) => entry.change === "owner-added").map((entry) => entry.memberId),
    ).toEqual([phone.hostId]);
  });

  it("lets the first owner make join codes and remove members with a fresh unlock, and refuses it without one", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    expect(hub.hub.listOwners().map((owner) => owner.name)).toEqual(["Phone"]);

    const without = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.joinCode,
      body: { owner: false },
    });
    const minted = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.joinCode,
      body: { owner: false },
      unlock: { authenticator, shape: "webauthn" },
    });
    const removed = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.removeMember,
      body: { memberId: spoke.hostId },
      unlock: { authenticator, shape: "raw" },
    });

    expect(without.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(minted.status).toBe(200);
    expect(minted.json).toMatchObject({ status: "minted", owner: false });
    expect(removed.status).toBe(200);
    expect(hub.hub.status().roster?.roster.members.map((member) => member.name)).toEqual([
      "Mac mini",
      "Phone",
    ]);
    expect(
      hub.records
        .filter((entry) => entry.actingPrincipal.kind === "owner-unlock")
        .map((entry) => entry.change),
    ).toEqual(["join-code-minted", "member-removed"]);
  });

  it("adds a new first owner with an owner code when every owner device is lost, keeping the list until a window removes the old ones", async () => {
    const { network, hub, phone, authenticator } = await startOwnerWorld();
    const tablet = await startTablet(network);
    const tabletKey = softwareAuthenticator();

    await joinHub(hub, tablet, { owner: true, unlockPublicKey: tabletKey.publicKey });

    expect(hub.hub.listOwners().map((owner) => owner.name)).toEqual(["Phone", "Tablet"]);
    // The lost phone's owner entry goes only when a window on the hub removes it.
    expect(hub.hub.removeOwner(phone.hostId, window).status).toBe("changed");
    expect(hub.hub.listOwners().map((owner) => owner.name)).toEqual(["Tablet"]);
    const stale = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.joinCode,
      body: { owner: false },
      unlock: { authenticator, shape: "raw" },
    });
    expect(stale.json).toEqual({ status: "refused", kind: "not-an-owner" });
  });

  it("ends an owner phone's powers on the hub once its paired device is revoked there", async () => {
    const { network, hub, phone, authenticator } = await startOwnerWorld();
    const device = hub.state
      .load()
      .hub?.members.find((member) => String(member.memberId) === phone.hostId);
    if (device === undefined) throw new Error("The hub holds no device for the phone.");
    const ticketsBefore = hub.state.load().hub?.joinTickets.length;

    hub.administration.revokeDevice({ deviceId: device.deviceId });

    const challenge = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.challenge,
      body: { method: "POST", path: HUB_OWNER_ROUTES.joinCode, bodyHash: "a".repeat(64) },
    });
    const minted = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.joinCode,
      body: { owner: false },
      unlock: { authenticator, shape: "raw" },
    });

    expect(challenge).toMatchObject({ status: 403, json: { kind: "device-revoked" } });
    expect(minted).toMatchObject({ status: 403, json: { kind: "device-revoked" } });
    expect(hub.state.load().hub?.joinTickets.length).toBe(ticketsBefore);
  });

  it("answers a former hub's spoke owners and refuses its old hub owners once it joined another hub", async () => {
    const { network, hub, spoke: laptop, phone, authenticator } = await startOwnerWorld();
    const laptopKey = softwareAuthenticator();
    const newHub = await startTablet(network);

    expect(hub.hub.disable(window).status).toBe("disabled");
    newHub.hub.enable(window);
    await laptop.spoke.leave(window);
    await joinHub(newHub, laptop, { owner: true, unlockPublicKey: laptopKey.publicKey });
    await joinHub(newHub, hub, { owner: false });
    await vi.waitFor(() => {
      const held = hub.spoke.status();
      if (held.membership !== "member") throw new Error("Not a member.");
      expect(held.roster.roster.members.map((member) => member.name)).toContain("Laptop");
    });
    expect(listAsOwner(hub, laptop, laptopKey).status).toBe("changed");

    const spokeOwner = await ownerCall({
      device: laptop,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator: laptopKey, shape: "raw" },
    });
    const oldHubOwner = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      unlock: { authenticator, shape: "raw" },
    });

    expect(spokeOwner.status).toBe(200);
    expect(oldHubOwner.status).toBeGreaterThanOrEqual(400);
  });

  it("ignores an unlock key presented with a code that is not an owner code", async () => {
    const { hub, spoke } = await startOwnerWorld();
    const before = hub.hub.listOwners();
    const sneaky = softwareAuthenticator();

    await spoke.spoke.leave(window);
    await joinHub(hub, spoke, { owner: false, unlockPublicKey: sneaky.publicKey });

    expect(hub.hub.listOwners()).toEqual(before);
  });
});

/** A guest phone joins the hub; the client runtime's own guest client, pinned and dialled through the test network. */
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

async function joinGuest(
  hub: HubTestHost,
  network: HubTestNetwork,
  spoke: HubTestHost,
  label: string,
) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await joinHubAsGuest({
    code: minted.code,
    deviceLabel: label,
    transport: guestTransport(network),
    webBuildVersion: "test",
    deviceKeyStore: createInMemoryDeviceKeyStore(),
  });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration
    .listPendingPairings()
    .find((entry) => entry.comparisonCode === started.comparisonCode);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await started.finish();
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
  await vi.waitFor(() => {
    const held = spoke.spoke.status();
    if (held.membership !== "member") throw new Error("The spoke is not a member.");
    expect(held.roster.roster.sequence).toBe(finished.record.roster.roster.sequence);
  });
  const target = guestSpokeTargets(finished.record).find((entry) => entry.name === spoke.name);
  if (target === undefined) throw new Error("The roster gave no spoke.");
  const memberId = finished.record.roster.roster.members.find(
    (member) => member.name === label,
  )?.memberId;
  if (memberId === undefined) throw new Error("The roster does not list the guest.");
  const knock = () =>
    admitGuestOnSpoke({
      target,
      signer: finished.signer,
      deviceLabel: label,
      transport: guestTransport(network),
    });
  return { memberId: String(memberId), knock, record: finished.record };
}

async function startTablet(network: HubTestNetwork): Promise<HubTestHost> {
  return startHubTestHost({ name: "Tablet", address: "100.101.102.106", network, cleanups });
}

function confirmationFor(input: {
  readonly spoke: HubTestHost;
  readonly phone: HubTestHost;
  readonly memberId: string;
  readonly fingerprint: string;
  readonly authenticator: SoftwareAuthenticator;
}): NewMemberConfirmation {
  const unsigned = {
    spokeId: decodeMemberId(input.spoke.hostId),
    memberId: decodeMemberId(input.memberId),
    identityKeyFingerprint: input.fingerprint,
    confirmedBy: decodeMemberId(input.phone.hostId),
    unlockKeyFingerprint: input.authenticator.fingerprint,
    confirmedAt: new Date().toISOString() as NewMemberConfirmation["confirmedAt"],
  };
  return {
    ...unsigned,
    signature: input.authenticator.sign(newMemberConfirmationSigningPayload(unsigned)),
  };
}

describe("Confirm new members on a spoke", () => {
  it("holds a new guest status-only until an owner's signed unlock confirms it, and the hub cannot", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    expect(spoke.spoke.setConfirmNewMembers(true, window)).toEqual({
      status: "changed",
      enabled: true,
    });

    const guest = await joinGuest(hub, network, spoke, "Pocket");
    const held = spoke.spoke.status();
    if (held.membership !== "member") throw new Error("Not a member.");
    expect(held.awaitingConfirmation).toEqual([guest.memberId]);
    expect(await guest.knock()).toMatchObject({ status: "refused", kind: "guest-not-confirmed" });
    expect(spoke.administration.listDevices()).toEqual([]);

    const guestFingerprint =
      guest.record.roster.roster.members.find((member) => member.name === "Pocket")
        ?.identityKeyFingerprint ?? "";
    const confirmation = confirmationFor({
      spoke,
      phone,
      memberId: guest.memberId,
      fingerprint: guestFingerprint,
      authenticator,
    });
    // The hub signs a request with the confirmation in it; it is not the owner.
    const fromHub = await ownerCall({
      device: hub,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.confirmMember,
      body: confirmation,
      unlock: { authenticator, shape: "raw" },
    });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    // The owner without an unlock, and with a confirmation signed by another key, also fail.
    const noUnlock = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.confirmMember,
      body: confirmation,
    });
    const forged = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.confirmMember,
      body: confirmationFor({
        spoke,
        phone,
        memberId: guest.memberId,
        fingerprint: guestFingerprint,
        authenticator: softwareAuthenticator(),
      }),
      unlock: { authenticator, shape: "raw" },
    });
    expect(noUnlock.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(forged.json).toMatchObject({ status: "refused", kind: "confirmation-invalid" });
    expect(await guest.knock()).toMatchObject({ kind: "guest-not-confirmed" });

    const confirmed = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.confirmMember,
      body: confirmation,
      unlock: { authenticator, shape: "raw" },
    });

    expect(confirmed.json).toMatchObject({ status: "confirmed", memberId: guest.memberId });
    expect((await guest.knock()).status).toBe("admitted");
    expect(
      spoke.records
        .filter((entry) => entry.change === "new-member-confirmed")
        .map((entry) => entry.actingPrincipal),
    ).toEqual([{ kind: "owner-unlock", memberId: phone.hostId }]);
  });

  it("confirms a held member when a passkey answers the confirmation as a WebAuthn assertion, and refuses another key or an unverified person", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    spoke.spoke.setConfirmNewMembers(true, window);
    const guest = await joinGuest(hub, network, spoke, "Pocket");
    const fingerprint =
      guest.record.roster.roster.members.find((member) => member.name === "Pocket")
        ?.identityKeyFingerprint ?? "";
    const passkeyConfirmation = (signer: SoftwareAuthenticator, flags?: number) => {
      const unsigned = {
        spokeId: decodeMemberId(spoke.hostId),
        memberId: decodeMemberId(guest.memberId),
        identityKeyFingerprint: fingerprint,
        confirmedBy: decodeMemberId(phone.hostId),
        unlockKeyFingerprint: authenticator.fingerprint,
        confirmedAt: new Date().toISOString() as NewMemberConfirmation["confirmedAt"],
      };
      return {
        ...unsigned,
        ...signer.assert(newMemberConfirmationSigningPayload(unsigned), flags),
      };
    };
    const confirm = (confirmation: NewMemberConfirmation) =>
      ownerCall({
        device: phone,
        network,
        target: spoke,
        route: HUB_OWNER_ROUTES.confirmMember,
        body: confirmation,
        unlock: { authenticator, shape: "webauthn" },
      });

    const otherKey = await confirm(passkeyConfirmation(softwareAuthenticator()));
    const unverified = await confirm(passkeyConfirmation(authenticator, 0x01));
    expect(otherKey.json).toMatchObject({ status: "refused", kind: "confirmation-invalid" });
    expect(unverified.json).toMatchObject({ status: "refused", kind: "confirmation-invalid" });
    expect(await guest.knock()).toMatchObject({ kind: "guest-not-confirmed" });

    const confirmed = await confirm(passkeyConfirmation(authenticator));

    expect(confirmed.json).toMatchObject({ status: "confirmed", memberId: guest.memberId });
    expect((await guest.knock()).status).toBe("admitted");
  });

  it("lists the members it holds for an owner device without an unlock, and not for the hub", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    spoke.spoke.setConfirmNewMembers(true, window);
    const read = (device: HubTestHost) =>
      ownerCall({
        device,
        network,
        target: spoke,
        route: HUB_OWNER_ROUTES.heldMembers,
        method: "GET",
      });
    expect((await read(phone)).json).toEqual({ members: [] });

    const guest = await joinGuest(hub, network, spoke, "Pocket");
    const held = await read(phone);
    const fromHub = await read(hub);

    expect(held.status).toBe(200);
    expect(held.json).toEqual({
      members: [
        {
          memberId: guest.memberId,
          name: "Pocket",
          role: "guest",
          identityKeyFingerprint:
            guest.record.roster.roster.members.find((member) => member.name === "Pocket")
              ?.identityKeyFingerprint ?? "",
        },
      ],
    });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    spoke.spoke.confirmMemberFromWindow(guest.memberId, window);
    expect((await read(phone)).json).toEqual({ members: [] });
  });

  it("lets a window on the spoke confirm a held guest, which then gets a device", async () => {
    const { network, hub, spoke } = await startOwnerWorld();
    spoke.spoke.setConfirmNewMembers(true, window);
    const guest = await joinGuest(hub, network, spoke, "Pocket");
    expect(await guest.knock()).toMatchObject({ kind: "guest-not-confirmed" });

    const confirmed = spoke.spoke.confirmMemberFromWindow(guest.memberId, window);

    expect(confirmed).toMatchObject({ status: "confirmed" });
    expect((await guest.knock()).status).toBe("admitted");
    expect(spoke.spoke.confirmMemberFromWindow(guest.memberId, window)).toEqual({
      status: "refused",
      kind: "not-awaiting-confirmation",
    });
  });

  it("accepts a new guest as a full member when Confirm new members is off", async () => {
    const { network, hub, spoke } = await startOwnerWorld();
    const guest = await joinGuest(hub, network, spoke, "Pocket");

    expect((await guest.knock()).status).toBe("admitted");
  });
});

describe("new-member alerts on a spoke", () => {
  it("records an alert for each member a newer roster adds, which an owner device reads, dismisses, or removes", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    const first = await joinGuest(hub, network, spoke, "Pocket");
    const second = await joinGuest(hub, network, spoke, "Spare");
    const status = spoke.spoke.status();
    if (status.membership !== "member") throw new Error("Not a member.");
    expect(status.alerts.map((alert) => [alert.name, alert.role])).toEqual([
      ["Pocket", "guest"],
      ["Spare", "guest"],
    ]);
    expect(
      spoke.records
        .filter((entry) => entry.change === "new-member-alerted")
        .map((entry) => entry.actingPrincipal.kind),
    ).toEqual(["hub", "hub"]);

    const read = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.alerts,
      method: "GET",
    });
    const alerts = (read.json as { alerts: Array<{ alertId: string; name: string }> }).alerts;
    expect(alerts.map((alert) => alert.name)).toEqual(["Pocket", "Spare"]);
    const [pocket, spare] = alerts as [(typeof alerts)[number], (typeof alerts)[number]];

    // Reading changes nothing and needs no unlock; dismissing and removing do.
    const unlockless = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.alertDismiss,
      body: { alertId: pocket.alertId },
    });
    expect(unlockless.json).toEqual({ status: "refused", kind: "unlock-required" });
    const dismissed = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.alertDismiss,
      body: { alertId: pocket.alertId },
      unlock: { authenticator, shape: "raw" },
    });
    expect(dismissed.json).toMatchObject({ status: "dismissed" });

    expect((await second.knock()).status).toBe("admitted");
    const removed = await ownerCall({
      device: phone,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.alertRemove,
      body: { alertId: spare.alertId },
      unlock: { authenticator, shape: "raw" },
    });

    expect(removed.json).toMatchObject({ status: "removed" });
    const after = spoke.spoke.status();
    if (after.membership !== "member") throw new Error("Not a member.");
    expect(after.alerts).toEqual([]);
    expect(after.acceptedMemberIds).not.toContain(second.memberId);
    expect(after.acceptedMemberIds).toContain(first.memberId);
    // What this spoke gave the removed guest is revoked, and it stays out of later rosters.
    expect(spoke.administration.listDevices().every((device) => device.state === "revoked")).toBe(
      true,
    );
    expect((await second.knock()).status).toBe("refused");
    await joinGuest(hub, network, spoke, "Third");
    const later = spoke.spoke.status();
    if (later.membership !== "member") throw new Error("Not a member.");
    expect(later.acceptedMemberIds).not.toContain(second.memberId);
  });

  it("raises an alert the hub cannot write, dismiss, or remove", async () => {
    const { network, hub, spoke, phone, authenticator } = await startOwnerWorld();
    listAsOwner(spoke, phone, authenticator);
    await joinGuest(hub, network, spoke, "Pocket");
    const status = spoke.spoke.status();
    if (status.membership !== "member") throw new Error("Not a member.");
    const [alert] = status.alerts;
    if (alert === undefined) throw new Error("No alert.");

    const fromHub = await ownerCall({
      device: hub,
      network,
      target: spoke,
      route: HUB_OWNER_ROUTES.alertDismiss,
      body: { alertId: alert.alertId },
      unlock: { authenticator, shape: "raw" },
    });

    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    const after = spoke.spoke.status();
    expect(after.membership === "member" && after.alerts.length).toBe(1);
  });

  it("lets a window on the spoke dismiss an alert", async () => {
    const { network, hub, spoke } = await startOwnerWorld();
    await joinGuest(hub, network, spoke, "Pocket");
    const status = spoke.spoke.status();
    if (status.membership !== "member") throw new Error("Not a member.");
    const [alert] = status.alerts;
    if (alert === undefined) throw new Error("No alert.");

    expect(spoke.spoke.dismissAlert(String(alert.alertId), window)).toMatchObject({
      status: "dismissed",
    });
    expect(spoke.spoke.dismissAlert(String(alert.alertId), window)).toEqual({
      status: "refused",
      kind: "no-such-alert",
    });
  });
});
