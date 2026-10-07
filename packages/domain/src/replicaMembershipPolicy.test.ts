import { describe, expect, it } from "vitest";
import type { ReplicaInstanceId } from "@octant/contracts/replica-entry";
import {
  buildReplicaJoinMatchingPreimage,
  decideReplicaJoinApproval,
  decideReplicaRevocation,
  replicaJoinRequestIsFresh,
  replicaMembershipAcceptsKey,
  revocationCut,
  REPLICA_JOIN_REQUEST_TTL_MS,
  type ReplicaMembershipFacts,
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
    const first = buildReplicaJoinMatchingPreimage({
      joinRequest,
      approverInstanceId: ids.approver,
    });
    const second = buildReplicaJoinMatchingPreimage({
      joinRequest,
      approverInstanceId: ids.approver,
    });
    expect(first).toBe(second);
    expect(first).toContain("octant.replica-join.v1");
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

  it("accepts a member key, and after a revocation only for entries up to its cut", () => {
    expect(replicaMembershipAcceptsKey(membership(), ids.local, "pub-macbook", 7)).toBe(true);
    const revoked = membership({
      revocations: [{ instanceId: ids.local, lastAcceptedSequence: 3 }],
    });
    expect(replicaMembershipAcceptsKey(revoked, ids.local, "pub-macbook", 3)).toBe(true);
    expect(replicaMembershipAcceptsKey(revoked, ids.local, "pub-macbook", 4)).toBe(false);
  });

  it("takes the earliest cut when two members revoke the same instance", () => {
    const facts = membership({
      revocations: [
        { instanceId: ids.local, lastAcceptedSequence: 5 },
        { instanceId: ids.local, lastAcceptedSequence: 2 },
      ],
    });
    expect(revocationCut(facts, ids.local)).toBe(2);
    expect(replicaMembershipAcceptsKey(facts, ids.local, "pub-macbook", 3)).toBe(false);
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
