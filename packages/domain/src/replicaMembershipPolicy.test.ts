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

  function derive(
    admissions: ReadonlyArray<ReplicaAdmissionRecord>,
    revocations: ReadonlyArray<ReplicaRevocationRecord>,
  ) {
    const derived = deriveReplicaMembership({ roots: [founder], admissions, revocations });
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

  it("gives a member the same key whichever approval of it arrived first", () => {
    const peers = [admission(ids.local, 2, taken), admission(ids.local, 3, kept)];
    const byTaken = admission(ids.joiner, 2, member(ids.fresh, "pub-from-taken"));
    const byKept = admission(ids.approver, 2, member(ids.fresh, "pub-from-kept"));
    const one = derive([...peers, byTaken, byKept], []).members;
    const other = derive([...peers, byKept, byTaken], []).members;
    expect(one).toEqual(other);
    expect(one).toContain(`${ids.fresh}:pub-from-taken`);
  });

  it("derives the same members and cuts for every order of the same records", () => {
    const records = [
      ...admissions,
      admission(ids.joiner, 2, member(ids.fresh, "pub-fresh")),
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
