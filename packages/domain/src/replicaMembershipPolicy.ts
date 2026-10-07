/**
 * Who may write to a replica store.
 *
 * Membership is the authority half of artifact sync: entries are signed by a
 * device key, and only a member's key is accepted after a pull. This module
 * decides membership transitions from facts the host already holds. It does
 * not touch a keychain, a store, or the network, and it never sees private
 * key material - only public keys, fingerprints, and the records a store
 * already returned.
 *
 * There is no secret in a join. The joining computer publishes its public key
 * and name; the approving computer shows a matching code derived from the
 * join-request facts. Both people compare screens, and only then does the
 * member write the approval that makes the joiner a member.
 */

import type { ReplicaInstanceId } from "@octant/contracts/replica-entry";

/** A join request older than this is not offered for approval. */
export const REPLICA_JOIN_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;
/**
 * Few enough digits to read aloud, enough that two different requests rarely
 * share a code by chance. The code is a comparison, not a secret: it does not
 * hold against a party that can write the store and searches keys offline
 * for a colliding one. The signatures carry the authority.
 */
export const REPLICA_JOIN_MATCHING_CODE_DIGITS = 6;
/** The pairing comparison code derivation works over a fixed-width digest. */
export const REPLICA_JOIN_MATCHING_CODE_MODULUS = 1_000_000;

export interface ReplicaMembershipMember {
  readonly instanceId: ReplicaInstanceId;
  readonly displayName: string;
  /** Base64-encoded SPKI of the device signing key this member writes with. */
  readonly publicKey: string;
}

export interface ReplicaMembershipFacts {
  readonly localInstanceId: ReplicaInstanceId;
  readonly members: ReadonlyArray<ReplicaMembershipMember>;
  /** Revocations the host has applied, in application order. */
  readonly revocations: ReadonlyArray<ReplicaInstanceId>;
}

export interface ReplicaJoinRequestFacts {
  readonly origin: { readonly instanceId: ReplicaInstanceId; readonly displayName: string };
  readonly subject: ReplicaInstanceId;
  /** Base64-encoded SPKI public key the joining computer writes entries with. */
  readonly publicKey: string;
}

export type ReplicaApprovalRefusalReason = "already-member" | "revoked-instance";

export type ReplicaApprovalResult =
  | { readonly status: "approved" }
  | { readonly status: "refused"; readonly reason: ReplicaApprovalRefusalReason };

export type ReplicaRevocationRefusalReason =
  | "unknown-instance"
  | "not-a-member"
  | "revoked-instance";

export type ReplicaRevocationResult =
  | { readonly status: "revoked" }
  | { readonly status: "refused"; readonly reason: ReplicaRevocationRefusalReason };

/**
 * The bytes a matching code is derived from. Both computers can build this
 * from the join-request facts alone, so the code can be compared on two
 * screens without either computer trusting the other's clock or state.
 */
export function buildReplicaJoinMatchingPreimage(input: {
  readonly joinRequest: ReplicaJoinRequestFacts;
  /** The approver's own instance id. */
  readonly approverInstanceId: ReplicaInstanceId;
}): string {
  return [
    "octant.replica-join.v1",
    String(input.joinRequest.origin.instanceId),
    input.joinRequest.origin.displayName,
    String(input.joinRequest.subject),
    input.joinRequest.publicKey,
    String(input.approverInstanceId),
  ].join("\n");
}

/**
 * Whether a join request may still be offered for approval. The joining
 * computer already wrote its request; a stale one is not offered again.
 *
 * The window runs one way: a request whose signed time is later than now has
 * not happened yet, and without the lower bound a far-future time would never
 * leave the window.
 */
export function replicaJoinRequestIsFresh(requestedAt: number, now: number): boolean {
  const age = now - requestedAt;
  return age >= 0 && age <= REPLICA_JOIN_REQUEST_TTL_MS;
}

/**
 * Decide whether this host may approve a join request it can see in the store.
 *
 * A member approves. The joining instance must not already be a member, and a
 * revoked identity cannot rejoin under the same instance id: re-joining is a
 * new identity, not the old one back.
 */
export function decideReplicaJoinApproval(input: {
  readonly facts: ReplicaMembershipFacts;
  readonly joinRequest: ReplicaJoinRequestFacts;
}): ReplicaApprovalResult {
  if (isRevoked(input.facts, input.joinRequest.subject)) {
    return { status: "refused", reason: "revoked-instance" };
  }
  if (isMember(input.facts, input.joinRequest.subject)) {
    return { status: "refused", reason: "already-member" };
  }
  return { status: "approved" };
}

/**
 * Whether revoking an instance is a coherent act right now. An unknown id has
 * no membership to remove; a non-member with a join request is not a member
 * yet; a revoked instance stays revoked.
 */
export function decideReplicaRevocation(
  facts: ReplicaMembershipFacts,
  subject: ReplicaInstanceId,
): ReplicaRevocationResult {
  if (isRevoked(facts, subject)) return { status: "refused", reason: "revoked-instance" };
  if (isMember(facts, subject)) return { status: "revoked" };
  return {
    status: "refused",
    reason: hasMembershipRecord(facts, subject) ? "not-a-member" : "unknown-instance",
  };
}

/**
 * Whether a signature verifier may trust a public key for an instance.
 *
 * A member that was revoked stays revoked: entries signed after the
 * revocation are refused, and re-joining writes a new identity rather than
 * resurrecting this one.
 */
export function replicaMembershipAcceptsKey(
  facts: ReplicaMembershipFacts,
  instanceId: ReplicaInstanceId,
  publicKey: string,
): boolean {
  if (isRevoked(facts, instanceId)) return false;
  const member = membershipRecord(facts, instanceId);
  return member !== undefined && member.publicKey === publicKey;
}

function isMember(facts: ReplicaMembershipFacts, instanceId: ReplicaInstanceId): boolean {
  return membershipRecord(facts, instanceId) !== undefined;
}

function isRevoked(facts: ReplicaMembershipFacts, instanceId: ReplicaInstanceId): boolean {
  return facts.revocations.some((revoked) => String(revoked) === String(instanceId));
}

function hasMembershipRecord(
  facts: ReplicaMembershipFacts,
  instanceId: ReplicaInstanceId,
): boolean {
  return facts.members.some((member) => String(member.instanceId) === String(instanceId));
}

function membershipRecord(
  facts: ReplicaMembershipFacts,
  instanceId: ReplicaInstanceId,
): ReplicaMembershipMember | undefined {
  return facts.members.find((member) => String(member.instanceId) === String(instanceId));
}
