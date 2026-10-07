import { describe, expect, it } from "vitest";
import type { ReplicaInstanceId } from "@octant/contracts/replica-entry";
import {
  buildReplicaJoinMatchingPreimage,
  decideReplicaJoinApproval,
  decideReplicaRevocation,
  deriveReplicaMembership,
  replicaJoinRequestIsFresh,
  revocationCut,
  REPLICA_JOIN_REQUEST_TTL_MS,
  type ReplicaAdmissionRecord,
  type ReplicaJoinRequestKey,
  type ReplicaMembershipFacts,
  type ReplicaMembershipMember,
  type ReplicaRevocationRecord,
} from "./replicaMembershipPolicy";

const ids = {
  local: "11111111-1111-4111-8111-111111111111" as ReplicaInstanceId,
  joiner: "22222222-2222-4222-8222-222222222222" as ReplicaInstanceId,
  approver: "33333333-3333-4333-8333-333333333333" as ReplicaInstanceId,
  revoked: "44444444-4444-4444-8444-444444444444" as ReplicaInstanceId,
  fresh: "55555555-5555-4555-8555-555555555555" as ReplicaInstanceId,
  unknown: "66666666-6666-4666-8666-666666666666" as ReplicaInstanceId,
} as const;

function membership(overrides: Partial<ReplicaMembershipFacts> = {}): ReplicaMembershipFacts {
  return {
    localInstanceId: ids.local,
    members: [
      {
        instanceId: ids.local,
        displayName: "MacBook",
        publicKey: "pub-macbook",
      },
    ],
    revocations: [],
    ...overrides,
  };
}

describe("replica membership policy", () => {
  it("derives the same matching preimage from the same join facts on both computers", () => {
    const joinRequest = {
      origin: { instanceId: ids.joiner, displayName: "Mac mini" },
      subject: ids.joiner,
      publicKey: "pub-mac-mini",
    };
    const approver = { instanceId: ids.approver, publicKey: "pub-approver" };
    const founder = { instanceId: ids.local, publicKey: "pub-macbook" };
    const first = buildReplicaJoinMatchingPreimage({ joinRequest, approver, founder });
    const second = buildReplicaJoinMatchingPreimage({ joinRequest, approver, founder });
    expect(first).toBe(second);
    expect(first).toContain("octant.replica-join.v2");
    // A chain that names another key for the approver, or another founder,
    // describes a different join.
    expect(
      buildReplicaJoinMatchingPreimage({
        joinRequest,
        approver: { ...approver, publicKey: "pub-forged" },
        founder,
      }),
    ).not.toBe(first);
    expect(
      buildReplicaJoinMatchingPreimage({
        joinRequest,
        approver,
        founder: { instanceId: ids.fresh, publicKey: "pub-forged" },
      }),
    ).not.toBe(first);
  });

  it("refuses to approve a join request from an instance that is already a member", () => {
    const decision = decideReplicaJoinApproval({
      facts: membership(),
      joinRequest: {
        origin: { instanceId: ids.local, displayName: "MacBook" },
        subject: ids.local,
        publicKey: "pub-macbook",
      },
    });
    expect(decision).toEqual({ status: "refused", reason: "already-member" });
  });

  it("refuses to approve a join request from a revoked identity", () => {
    const decision = decideReplicaJoinApproval({
      facts: membership({ revocations: [{ instanceId: ids.revoked, lastAcceptedSequence: 0 }] }),
      joinRequest: {
        origin: { instanceId: ids.revoked, displayName: "Old PC" },
        subject: ids.revoked,
        publicKey: "pub-old-pc",
      },
    });
    expect(decision).toEqual({ status: "refused", reason: "revoked-instance" });
  });

  it("approves a fresh join request from an unknown instance", () => {
    const decision = decideReplicaJoinApproval({
      facts: membership(),
      joinRequest: {
        origin: { instanceId: ids.fresh, displayName: "New PC" },
        subject: ids.fresh,
        publicKey: "pub-new-pc",
      },
    });
    expect(decision).toEqual({ status: "approved" });
  });

  it("refuses to revoke an unknown instance", () => {
    const decision = decideReplicaRevocation(membership(), ids.unknown);
    expect(decision).toEqual({ status: "refused", reason: "unknown-instance" });
  });

  it("revokes a member and keeps it revoked", () => {
    expect(decideReplicaRevocation(membership(), ids.local)).toEqual({ status: "revoked" });
    expect(
      decideReplicaRevocation(
        membership({ revocations: [{ instanceId: ids.local, lastAcceptedSequence: 0 }] }),
        ids.local,
      ),
    ).toEqual({
      status: "refused",
      reason: "revoked-instance",
    });
  });

  it("takes the earliest cut when two members revoke the same instance", () => {
    const facts = membership({
      revocations: [
        { instanceId: ids.local, lastAcceptedSequence: 5 },
        { instanceId: ids.local, lastAcceptedSequence: 2 },
      ],
    });
    expect(revocationCut(facts, ids.local)).toBe(2);
  });

  it("does not offer a join request past its freshness window", () => {
    const requestedAt = 1_000;
    expect(replicaJoinRequestIsFresh(requestedAt, requestedAt + REPLICA_JOIN_REQUEST_TTL_MS)).toBe(
      true,
    );
    expect(
      replicaJoinRequestIsFresh(requestedAt, requestedAt + REPLICA_JOIN_REQUEST_TTL_MS + 1),
    ).toBe(false);
  });

  it("refuses a join request whose time has not happened yet", () => {
    const now = 1_000_000;
    expect(replicaJoinRequestIsFresh(now + 1, now)).toBe(false);
    expect(replicaJoinRequestIsFresh(now + REPLICA_JOIN_REQUEST_TTL_MS, now)).toBe(false);
    expect(replicaJoinRequestIsFresh(now - REPLICA_JOIN_REQUEST_TTL_MS, now)).toBe(true);
  });
});

describe("replica membership derivation", () => {
  const founder = member(ids.local, "pub-founder");
  const taken = member(ids.joiner, "pub-taken");
  const kept = member(ids.approver, "pub-kept");

  function member(instanceId: ReplicaInstanceId, publicKey: string): ReplicaMembershipMember {
    return { instanceId, displayName: String(instanceId).slice(0, 4), publicKey };
  }

  function admission(
    approver: ReplicaInstanceId,
    approverSequence: number,
    admitted: ReplicaMembershipMember,
  ): ReplicaAdmissionRecord {
    return { approver, approverSequence, member: admitted };
  }

  function revocation(
    revoker: ReplicaInstanceId,
    revokerSequence: number,
    subject: ReplicaInstanceId,
    lastAcceptedSequence: number,
  ): ReplicaRevocationRecord {
    return { revoker, revokerSequence, cut: { instanceId: subject, lastAcceptedSequence } };
  }

  // Each computer's own first join request, naming the key it signs with.
  const requests: ReadonlyArray<ReplicaJoinRequestKey> = [
    { instanceId: ids.joiner, publicKey: "pub-taken" },
    { instanceId: ids.approver, publicKey: "pub-kept" },
    { instanceId: ids.fresh, publicKey: "pub-fresh" },
    { instanceId: ids.unknown, publicKey: "pub-unknown" },
  ];

  function derive(
    admissions: ReadonlyArray<ReplicaAdmissionRecord>,
    revocations: ReadonlyArray<ReplicaRevocationRecord>,
    held: ReadonlyArray<ReplicaJoinRequestKey> = requests,
  ) {
    const derived = deriveReplicaMembership({
      roots: [founder],
      requests: held,
      admissions,
      revocations,
    });
    return {
      members: derived.members.map((m) => `${String(m.instanceId)}:${m.publicKey}`).sort(),
      cuts: derived.cuts
        .map((cut) => `${String(cut.instanceId)}@${cut.lastAcceptedSequence}`)
        .sort(),
    };
  }

  // The founder approves Taken (its 2) and Kept (its 3), then revokes Taken
  // (its 4) with a cut after Taken's join request. Taken answers by revoking
  // the founder (its 2).
  const admissions = [admission(ids.local, 2, taken), admission(ids.local, 3, kept)];
  const founderRevokesTaken = revocation(ids.local, 4, ids.joiner, 1);

  it("ignores a revocation whose cut removes its own revoker's admission, in either order", () => {
    const answer = revocation(ids.joiner, 2, ids.local, 0);
    for (const revocations of [
      [founderRevokesTaken, answer],
      [answer, founderRevokesTaken],
    ]) {
      expect(derive(admissions, revocations)).toEqual({
        members: ["11111111-1111-4111-8111-111111111111:pub-founder", ...keptAndTaken()],
        cuts: [`${ids.joiner}@1`],
      });
    }
  });

  it("lets the computer that approved another revoke it without being revoked back", () => {
    const answer = revocation(ids.joiner, 2, ids.local, 2);
    for (const revocations of [
      [founderRevokesTaken, answer],
      [answer, founderRevokesTaken],
    ]) {
      expect(derive(admissions, revocations)).toEqual({
        members: ["11111111-1111-4111-8111-111111111111:pub-founder", ...keptAndTaken()],
        cuts: [`${ids.joiner}@1`],
      });
    }
  });

  it("keeps both revoked when two computers, neither the other's approver, revoke each other", () => {
    const peers = [admission(ids.local, 2, taken), admission(ids.local, 3, kept)];
    const first = revocation(ids.joiner, 2, ids.approver, 1);
    const second = revocation(ids.approver, 2, ids.joiner, 1);
    for (const revocations of [
      [first, second],
      [second, first],
    ]) {
      expect(derive(peers, revocations).cuts).toEqual([`${ids.joiner}@1`, `${ids.approver}@1`]);
    }
  });

  // Kept approves Fresh with the key Fresh's own request names. Taken, a peer
  // of Kept with a lower id, also writes an approval of Fresh.
  const peers = [admission(ids.local, 2, taken), admission(ids.local, 3, kept)];
  const keptApprovesFresh = admission(ids.approver, 2, member(ids.fresh, "pub-fresh"));

  it("keeps a member's own key when another member approves it again with its own key", () => {
    const takeover = admission(ids.joiner, 2, member(ids.fresh, "pub-taken"));
    for (const records of [
      [...peers, keptApprovesFresh, takeover],
      [...peers, takeover, keptApprovesFresh],
    ]) {
      const { members } = derive(records, []);
      expect(members).toContain(`${ids.fresh}:pub-fresh`);
      expect(members).not.toContain(`${ids.fresh}:pub-taken`);
    }
  });

  it("does not make the writer of a second approval with the right key an ancestor", () => {
    const second = admission(ids.joiner, 2, member(ids.fresh, "pub-fresh"));
    const takenRevokesFresh = revocation(ids.joiner, 3, ids.fresh, 0);
    const freshRevokesTaken = revocation(ids.fresh, 1, ids.joiner, 2);
    for (const records of [
      [...peers, keptApprovesFresh, second],
      [...peers, second, keptApprovesFresh],
    ]) {
      const derived = derive(records, [takenRevokesFresh, freshRevokesTaken]);
      expect(derived.members).toContain(`${ids.fresh}:pub-fresh`);
      // Neither is the other's approver, so both stay revoked: Taken cannot
      // remove Fresh and refuse Fresh's answer.
      expect(derived.cuts).toEqual([`${ids.joiner}@2`, `${ids.fresh}@0`].sort());
    }
  });

  it("admits a joiner only through an approval naming its own request's key", () => {
    const forged = admission(ids.joiner, 2, member(ids.fresh, "pub-taken"));
    expect(
      derive([...peers, forged], []).members.some((m) => m.startsWith(String(ids.fresh))),
    ).toBe(false);
    for (const records of [
      [...peers, forged, keptApprovesFresh],
      [...peers, keptApprovesFresh, forged],
    ]) {
      expect(derive(records, []).members).toContain(`${ids.fresh}:pub-fresh`);
    }
  });

  it("admits nobody whose join requests name different keys, or who has none", () => {
    const records = [...peers, keptApprovesFresh];
    const conflicting = [...requests, { instanceId: ids.fresh, publicKey: "pub-taken" }];
    const without = requests.filter((request) => request.instanceId !== ids.fresh);
    for (const held of [conflicting, [...conflicting].reverse(), without]) {
      expect(derive(records, [], held).members.some((m) => m.startsWith(String(ids.fresh)))).toBe(
        false,
      );
    }
  });

  // A chain three deep - the founder approves Taken, Taken approves Kept, Kept
  // approves Fresh - and Unknown, approved by the founder directly.
  const deepChain = [
    admission(ids.local, 2, taken),
    admission(ids.joiner, 2, kept),
    admission(ids.approver, 2, member(ids.fresh, "pub-fresh")),
    admission(ids.local, 3, member(ids.unknown, "pub-unknown")),
  ];
  const nearerApprovesFresh = admission(ids.unknown, 2, member(ids.fresh, "pub-fresh"));

  it("does not let a computer nearer the founder become a deeper one's ancestor by approving it again", () => {
    // Fresh revokes Unknown first. Past that cut, Unknown approves Fresh with
    // its real key, which admits Fresh a round earlier, and revokes Fresh.
    const freshRevokesUnknown = revocation(ids.fresh, 2, ids.unknown, 1);
    const unknownRevokesFresh = revocation(ids.unknown, 3, ids.fresh, 1);
    const records = [...deepChain, nearerApprovesFresh, freshRevokesUnknown, unknownRevokesFresh];
    const results = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const shuffled = shuffle(records, seed);
      const derived = derive(
        shuffled.filter((record): record is ReplicaAdmissionRecord => "member" in record),
        shuffled.filter((record): record is ReplicaRevocationRecord => "cut" in record),
      );
      expect(derived.cuts).toEqual([`${ids.fresh}@1`, `${ids.unknown}@1`]);
      results.add(JSON.stringify(derived));
    }
    expect(results.size).toBe(1);
  });

  it("revokes both computers that revoke each other, with or without another approval of one", () => {
    const freshRevokesUnknown = revocation(ids.fresh, 2, ids.unknown, 1);
    const unknownRevokesFresh = revocation(ids.unknown, 3, ids.fresh, 1);
    for (const records of [deepChain, [...deepChain, nearerApprovesFresh]]) {
      for (const revocations of [
        [freshRevokesUnknown, unknownRevokesFresh],
        [unknownRevokesFresh, freshRevokesUnknown],
      ]) {
        expect(derive(records, revocations).cuts).toEqual([`${ids.fresh}@1`, `${ids.unknown}@1`]);
      }
    }
    // Kept approved Fresh, so alone it wins their exchange. Once Unknown has
    // approved Fresh too, Kept is no longer an ancestor every approval
    // shares, and the exchange ends with both revoked.
    const keptRevokesFresh = revocation(ids.approver, 3, ids.fresh, 1);
    const freshRevokesKept = revocation(ids.fresh, 2, ids.approver, 2);
    expect(derive(deepChain, [keptRevokesFresh, freshRevokesKept]).cuts).toEqual([
      `${ids.fresh}@1`,
    ]);
    expect(
      derive([...deepChain, nearerApprovesFresh], [keptRevokesFresh, freshRevokesKept]).cuts,
    ).toEqual([`${ids.approver}@2`, `${ids.fresh}@1`]);
  });

  it("derives the same members and cuts for every order of the same records", () => {
    const records = [
      ...admissions,
      admission(ids.joiner, 2, member(ids.fresh, "pub-fresh")),
      admission(ids.approver, 2, member(ids.fresh, "pub-kept")),
      admission(ids.approver, 3, member(ids.joiner, "pub-kept")),
      admission(ids.joiner, 4, member(ids.unknown, "pub-taken")),
      founderRevokesTaken,
      revocation(ids.approver, 2, ids.joiner, 3),
      revocation(ids.joiner, 3, ids.approver, 1),
    ];
    const results = new Set<string>();
    for (let seed = 1; seed <= 50; seed += 1) {
      const shuffled = shuffle(records, seed);
      const derived = derive(
        shuffled.filter((record): record is ReplicaAdmissionRecord => "member" in record),
        shuffled.filter((record): record is ReplicaRevocationRecord => "cut" in record),
      );
      results.add(JSON.stringify(derived));
    }
    expect(results.size).toBe(1);
  });

  function keptAndTaken(): ReadonlyArray<string> {
    return [`${ids.joiner}:pub-taken`, `${ids.approver}:pub-kept`].sort();
  }
});

function shuffle<T>(items: ReadonlyArray<T>, seed: number): ReadonlyArray<T> {
  const copy = [...items];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const other = state % (index + 1);
    const held = copy[index];
    const swapped = copy[other];
    if (held === undefined || swapped === undefined) continue;
    copy[index] = swapped;
    copy[other] = held;
  }
  return copy;
}
