// A hub, a spoke, a laptop, and a phone that is the person's owner device, each
// a real remote gateway behind a real TLS listener. What is proved here is the
// owner unlock a spoke may ask of a paired client's merge: the switch is off by
// default and set from the spoke's own window, the owner route issues a
// challenge for the merge route's own path and body to an owner only, and the
// spoke's check accepts that unlock once, for that merge alone, against its
// own owner list. Every missing, replayed, mismatched, unverified, or unlisted
// unlock is refused with its reason.

import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubMemberId } from "@octant/contracts";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { publicKeyFingerprint } from "./hubCrypto";
import { ownerCall, softwareAuthenticator } from "./hubOwner.test-support";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const MERGE = "/api/code/project-pull-requests/merge";
const BODY = JSON.stringify({
  projectId: "33333333-3333-4333-8333-333333333333",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 7,
  method: "squash",
  headSha: "a".repeat(40),
  confirmed: true,
});

async function joinHub(
  hub: HubTestHost,
  device: HubTestHost,
  input: { readonly owner: boolean; readonly unlockPublicKey?: string },
) {
  const minted = hub.hub.mintJoinCode({ owner: input.owner });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await device.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration.listPendingPairings().at(-1);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await device.spoke.finishJoin(
    window,
    input.unlockPublicKey === undefined ? {} : { unlockPublicKey: input.unlockPublicKey },
  );
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

/** A hub, a spoke that lists the phone as its owner, a laptop that is only a member, and the phone. */
async function startWorld() {
  const network = new HubTestNetwork();
  const [hub, spoke, laptop, phone] = [
    await startHubTestHost({ name: "Mac mini", address: "100.101.102.103", network, cleanups }),
    await startHubTestHost({ name: "Studio", address: "100.101.102.104", network, cleanups }),
    await startHubTestHost({ name: "Laptop", address: "100.101.102.105", network, cleanups }),
    await startHubTestHost({ name: "Phone", address: "100.101.102.106", network, cleanups }),
  ];
  const authenticator = softwareAuthenticator();
  hub.hub.enable(window);
  await joinHub(hub, phone, { owner: true, unlockPublicKey: authenticator.publicKey });
  await joinHub(hub, laptop, { owner: false });
  await joinHub(hub, spoke, { owner: false });
  await vi.waitFor(() => {
    const held = spoke.spoke.status();
    if (held.membership !== "member") throw new Error("Not a member.");
    expect(held.roster.roster.members.map((member) => member.name)).toEqual(
      expect.arrayContaining(["Phone", "Laptop"]),
    );
  });
  const listed = spoke.spoke.addOwners(
    [
      {
        memberId: decodeMemberId(phone.hostId),
        identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
        unlockKeyFingerprint: authenticator.fingerprint,
      },
    ],
    window,
  );
  if (listed.status !== "changed") throw new Error(JSON.stringify(listed));
  /** The proof an owner device's unlock key signs for this merge on the spoke, as its client sends it. */
  const unlockFor = async (
    device: HubTestHost,
    choice: {
      readonly shape?: "raw" | "webauthn";
      readonly flags?: number;
      readonly body?: string;
    } = {},
  ) =>
    ownerCall({
      device,
      network,
      target: spoke,
      route: MERGE,
      body: undefined,
      proofOnly: true,
      unlock: {
        authenticator,
        shape: choice.shape ?? "raw",
        ...(choice.flags === undefined ? {} : { flags: choice.flags }),
        boundTo: { route: MERGE, body: choice.body ?? BODY },
      },
    });
  return { hub, spoke, laptop, phone, unlockFor, network, authenticator };
}

describe("an owner unlock before a paired client's merge", () => {
  it("is off until the spoke's window turns it on, and each change is journaled", async () => {
    const { spoke } = await startWorld();

    expect(spoke.pairedMergeUnlock.required()).toBe(false);
    spoke.pairedMergeUnlock.setRequired(true, window);
    expect(spoke.pairedMergeUnlock.required()).toBe(true);
    spoke.pairedMergeUnlock.setRequired(false, window);

    expect(spoke.pairedMergeUnlock.required()).toBe(false);
    expect(
      spoke.records
        .filter((record) => record.change.startsWith("paired-merge-unlock"))
        .map((record) => [record.change, record.actingPrincipal]),
    ).toEqual([
      ["paired-merge-unlock-on", window],
      ["paired-merge-unlock-off", window],
    ]);
  });

  it("accepts the owner's unlock for this merge once, and journals the owner who gave it", async () => {
    const { spoke, phone, unlockFor } = await startWorld();
    const { proofHeader } = await unlockFor(phone);
    if (proofHeader === undefined) throw new Error("No challenge was issued.");

    const first = spoke.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof: proofHeader });
    const again = spoke.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof: proofHeader });

    expect(first).toEqual({ status: "unlocked", ownerMemberId: phone.hostId });
    expect(again).toEqual({
      status: "owner-unlock-required",
      reason: "no-such-challenge",
      hostMemberId: spoke.hostId,
    });
    expect(spoke.records.filter((record) => record.change === "owner-merge-unlocked")).toEqual([
      {
        change: "owner-merge-unlocked",
        actingPrincipal: { kind: "owner-unlock", memberId: phone.hostId },
        memberId: phone.hostId,
      },
    ]);
  });

  it("names this host and the reason when the unlock is missing, unreadable, or for another merge", async () => {
    const { spoke, phone, unlockFor } = await startWorld();
    const other = await unlockFor(phone, { body: BODY.replace('"number":7', '"number":8') });

    const verify = (proof: string | null) =>
      spoke.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof });

    expect(verify(null)).toEqual({
      status: "owner-unlock-required",
      reason: "missing",
      hostMemberId: spoke.hostId,
    });
    expect(verify("not-a-proof")).toMatchObject({ reason: "invalid" });
    expect(verify(other.proofHeader ?? null)).toMatchObject({ reason: "action-mismatch" });
  });

  it("refuses a passkey answer that does not say the person was verified", async () => {
    const { spoke, phone, unlockFor } = await startWorld();
    const { proofHeader } = await unlockFor(phone, { shape: "webauthn", flags: 0x01 });

    expect(
      spoke.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof: proofHeader ?? null }),
    ).toMatchObject({ reason: "user-verification-missing" });
  });

  it("issues no merge challenge to a member that is not on the spoke's owner list", async () => {
    const { laptop, unlockFor } = await startWorld();

    const asked = await unlockFor(laptop);

    expect(asked.proofHeader).toBeUndefined();
    expect(asked.json).toEqual({ status: "refused", kind: "not-an-owner" });
  });

  it("refuses an unlock whose owner was removed from the spoke's list before the merge arrived", async () => {
    const { spoke, phone, unlockFor } = await startWorld();
    const { proofHeader } = await unlockFor(phone);
    const removed = spoke.spoke.removeOwner(phone.hostId, window);
    if (removed.status !== "changed") throw new Error(JSON.stringify(removed));

    expect(
      spoke.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof: proofHeader ?? null }),
    ).toMatchObject({ reason: "not-an-owner" });
  });

  it("stays on after the spoke leaves its hub, so no paired merge goes through without an owner", async () => {
    const { spoke } = await startWorld();
    spoke.pairedMergeUnlock.setRequired(true, window);

    const left = await spoke.spoke.leave(window);
    if (left.status !== "left") throw new Error(JSON.stringify(left));

    expect(spoke.pairedMergeUnlock.required()).toBe(true);
    expect(spoke.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof: null })).toEqual({
      status: "owner-unlock-required",
      reason: "no-owner-list",
    });
  });

  it("judges an unlock on the hub against the hub's own owner list", async () => {
    const { hub, phone, network, authenticator } = await startWorld();
    const proof = await ownerCall({
      device: phone,
      network,
      target: hub,
      route: MERGE,
      proofOnly: true,
      unlock: { authenticator, shape: "raw", boundTo: { route: MERGE, body: BODY } },
    });

    expect(
      hub.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof: proof.proofHeader ?? null }),
    ).toEqual({ status: "unlocked", ownerMemberId: phone.hostId });
  });

  it("has no owner who could unlock on a host that is in no hub", async () => {
    const network = new HubTestNetwork();
    const alone = await startHubTestHost({
      name: "Alone",
      address: "100.101.102.110",
      network,
      cleanups,
    });

    expect(alone.pairedMergeUnlock.verify({ path: MERGE, body: BODY, proof: null })).toEqual({
      status: "owner-unlock-required",
      reason: "no-owner-list",
    });
  });
});
