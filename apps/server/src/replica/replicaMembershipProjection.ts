/**
 * Who shares this host's replica store, rebuilt from the journal.
 *
 * The membership service and the store-read path both decide from these
 * facts, and they reach them only through journaled events, so a restart
 * replays the same members, keys, revocations, applied sequences, and next
 * local sequence the host had before. Every apply is idempotent: replaying an
 * event twice, or replaying the whole journal into a fresh projection, ends in
 * the same state.
 *
 * The state is small and lives in memory, so the projection holds no table and
 * replays from the start of the journal on every host start, like the managed
 * clone projection.
 */

import {
  ReplicaDevicePublicKey,
  ReplicaDisplayName,
  ReplicaInstanceId,
  ReplicaMembershipEntry,
  ReplicaReadRefusal,
  type EventEnvelope,
} from "@octant/contracts";
import type {
  ReplicaMembershipMember,
  ReplicaRevocationCut,
} from "@octant/domain/replica-membership-policy";
import type { ReplicaAppliedEntry } from "@octant/domain/replica-entry-policy";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Sequence = Schema.Int.pipe(Schema.positive());

export const REPLICA_MEMBERSHIP_AGGREGATE_TYPE = "replica-membership";
export const REPLICA_MEMBERSHIP_EVENT_NAMES = {
  replicaCreated: "replica.membership-created@1",
  joinRequested: "replica.join-requested@1",
  joinApproved: "replica.join-approved@1",
  joinConfirmed: "replica.join-confirmed@1",
  revoked: "replica.membership-revoked@1",
  entrySigned: "replica.entry-signed@1",
  entryApplied: "replica.entry-applied@1",
  entryRefused: "replica.entry-refused@1",
  commandRefused: "replica.membership-command-refused@1",
  storeFailure: "replica.membership-store-failure@1",
} as const;

/** This host founded the replica: its own self-approval is sequence 1. */
export const ReplicaMembershipCreated = Schema.Struct({
  instanceId: ReplicaInstanceId,
  displayName: ReplicaDisplayName,
  publicKey: ReplicaDevicePublicKey,
  sequence: Sequence,
}).annotations(strict);

/** This host wrote a join request naming itself. It is not a member yet. */
export const ReplicaJoinRequested = Schema.Struct({
  instanceId: ReplicaInstanceId,
  displayName: ReplicaDisplayName,
  publicKey: ReplicaDevicePublicKey,
  sequence: Sequence,
  requestedAt: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);

/** This host, a member, published an approval of another computer. */
export const ReplicaJoinApproved = Schema.Struct({
  approver: ReplicaInstanceId,
  sequence: Sequence,
  subject: ReplicaInstanceId,
  subjectDisplayName: ReplicaDisplayName,
  subjectDeviceKey: ReplicaDevicePublicKey,
}).annotations(strict);

/**
 * The person on this joining computer confirmed a member's signed approval of
 * this computer's request. The approver becomes a member here, and so does
 * this computer, with the key its own request carried.
 */
export const ReplicaJoinConfirmed = Schema.Struct({
  approver: ReplicaInstanceId,
  approverDisplayName: ReplicaDisplayName,
  approverDeviceKey: ReplicaDevicePublicKey,
  approvalSequence: Sequence,
}).annotations(strict);

/** This host, a member, published a revocation of another computer. */
export const ReplicaMembershipRevoked = Schema.Struct({
  revoker: ReplicaInstanceId,
  sequence: Sequence,
  subject: ReplicaInstanceId,
  /** The cut the published revocation names. */
  lastAcceptedSequence: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);

/**
 * A signed entry this host is about to publish under its own next sequence.
 * It is journaled before the store sees either file, so a publish that stops
 * after one of the two write-once files landed can be finished with the same
 * bytes rather than leaving that sequence slot unusable.
 */
export const ReplicaEntrySigned = Schema.Struct({
  entry: ReplicaMembershipEntry,
}).annotations(strict);

/** A membership entry read from the store verified and was applied. */
export const ReplicaEntryApplied = Schema.Struct({
  entry: ReplicaMembershipEntry,
  outcome: Schema.Literal("request-approval", "member-added", "member-revoked", "already-present"),
}).annotations(strict);

export const ReplicaEntryRefused = ReplicaReadRefusal;

export const ReplicaMembershipCommandRefused = Schema.Struct({
  command: Schema.Literal(
    "create-replica",
    "write-join-request",
    "approve-join",
    "confirm-join",
    "revoke",
    "pull",
  ),
  reason: Schema.Literal(
    "not-configured",
    "already-member",
    "revoked-instance",
    "code-mismatch",
    "expired-join-request",
    "unknown-instance",
    "not-a-member",
    "store-unavailable",
    "key-unavailable",
  ),
  subject: Schema.optional(ReplicaInstanceId),
}).annotations(strict);

export const ReplicaMembershipStoreFailure = Schema.Struct({
  phase: Schema.Literal("entry", "signature", "read", "list"),
  reason: Schema.Literal("not-connected", "refused", "slot-occupied", "truncated"),
  instanceId: Schema.optional(ReplicaInstanceId),
  sequence: Schema.optional(Sequence),
}).annotations(strict);

export function registerReplicaMembershipEvents(registry: EventRegistry): EventRegistry {
  const names = REPLICA_MEMBERSHIP_EVENT_NAMES;
  return registry
    .register(names.replicaCreated, 1, ReplicaMembershipCreated)
    .register(names.joinRequested, 1, ReplicaJoinRequested)
    .register(names.joinApproved, 1, ReplicaJoinApproved)
    .register(names.joinConfirmed, 1, ReplicaJoinConfirmed)
    .register(names.revoked, 1, ReplicaMembershipRevoked)
    .register(names.entrySigned, 1, ReplicaEntrySigned)
    .register(names.entryApplied, 1, ReplicaEntryApplied)
    .register(names.entryRefused, 1, ReplicaEntryRefused)
    .register(names.commandRefused, 1, ReplicaMembershipCommandRefused)
    .register(names.storeFailure, 1, ReplicaMembershipStoreFailure);
}

const decodeCreated = Schema.decodeUnknownSync(ReplicaMembershipCreated);
const decodeRequested = Schema.decodeUnknownSync(ReplicaJoinRequested);
const decodeApproved = Schema.decodeUnknownSync(ReplicaJoinApproved);
const decodeConfirmed = Schema.decodeUnknownSync(ReplicaJoinConfirmed);
const decodeRevoked = Schema.decodeUnknownSync(ReplicaMembershipRevoked);
const decodeSigned = Schema.decodeUnknownSync(ReplicaEntrySigned);
const decodeApplied = Schema.decodeUnknownSync(ReplicaEntryApplied);
const decodeRefused = Schema.decodeUnknownSync(ReplicaEntryRefused);

/** This host's own identity in the store, once it founded one or asked to join. */
export interface ReplicaLocalIdentity {
  readonly instanceId: ReplicaInstanceId;
  readonly displayName: ReplicaDisplayName;
  readonly publicKey: ReplicaDevicePublicKey;
}

export interface ReplicaMembershipState {
  readonly local: ReplicaLocalIdentity | undefined;
  readonly members: ReadonlyArray<ReplicaMembershipMember>;
  /** Applied revocations, each a cut on the revoked instance's sequence. */
  readonly revocations: ReadonlyArray<ReplicaRevocationCut>;
  /** Highest sequence this host published under its own instance; 0 before any. */
  readonly localSequence: number;
  /** A signed local entry whose publish has not been confirmed yet. */
  readonly pending: ReplicaMembershipEntry | undefined;
  /** Entries from other instances this host verified and applied. */
  readonly applied: ReadonlyArray<ReplicaAppliedEntry>;
  /** The latest join request read from each computer that is not a member. */
  readonly joinRequests: ReadonlyArray<ReplicaMembershipEntry>;
  /** Whether this refusal was already journaled, so a later pull does not repeat it. */
  readonly refusalRecorded: (refusal: ReplicaReadRefusal) => boolean;
}

function refusalKey(refusal: ReplicaReadRefusal): string {
  return `${String(refusal.instanceId)}/${String(refusal.sequence)}/${refusal.reason}`;
}

function same(left: ReplicaInstanceId, right: ReplicaInstanceId): boolean {
  return String(left) === String(right);
}

/** One approval this host holds: who admitted whom, at which of its sequences. */
interface Admission {
  readonly approver: ReplicaInstanceId;
  readonly approverSequence: number;
  readonly member: ReplicaMembershipMember;
}

/** One revocation this host holds: a cut on the subject, written by the revoker. */
interface Revocation {
  readonly revoker: ReplicaInstanceId;
  readonly revokerSequence: number;
  readonly cut: ReplicaRevocationCut;
}

export class ReplicaMembershipProjection implements Projection {
  readonly name = "replica-membership";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly holdsStateInMemory = true as const;
  #local: ReplicaLocalIdentity | undefined;
  /** Members trusted by this host's own act: its founding, or a confirmed approver. */
  readonly #roots = new Map<string, ReplicaMembershipMember>();
  readonly #admissions: Admission[] = [];
  readonly #revocations: Revocation[] = [];
  readonly #recorded = new Set<string>();
  #localSequence = 0;
  #pending: ReplicaMembershipEntry | undefined;
  readonly #applied = new Map<string, ReplicaAppliedEntry>();
  readonly #joinRequests = new Map<string, ReplicaMembershipEntry>();
  readonly #refusals = new Set<string>();

  reset(_connection: SqliteConnection): void {
    this.#local = undefined;
    this.#roots.clear();
    this.#admissions.length = 0;
    this.#revocations.length = 0;
    this.#recorded.clear();
    this.#localSequence = 0;
    this.#pending = undefined;
    this.#applied.clear();
    this.#joinRequests.clear();
    this.#refusals.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.aggregateType !== REPLICA_MEMBERSHIP_AGGREGATE_TYPE || event.eventVersion !== 1) {
      return;
    }
    const names = REPLICA_MEMBERSHIP_EVENT_NAMES;
    switch (event.eventName) {
      case names.replicaCreated: {
        const created = decodeCreated(event.payload);
        this.#startIdentity(created.instanceId);
        this.#local = {
          instanceId: created.instanceId,
          displayName: created.displayName,
          publicKey: created.publicKey,
        };
        this.#roots.set(String(created.instanceId), {
          instanceId: created.instanceId,
          displayName: created.displayName,
          publicKey: created.publicKey,
        });
        this.#published(created.sequence);
        return;
      }
      case names.joinRequested: {
        const requested = decodeRequested(event.payload);
        this.#startIdentity(requested.instanceId);
        this.#local = {
          instanceId: requested.instanceId,
          displayName: requested.displayName,
          publicKey: requested.publicKey,
        };
        this.#published(requested.sequence);
        return;
      }
      case names.joinApproved: {
        const approved = decodeApproved(event.payload);
        this.#admit(approved.approver, approved.sequence, {
          instanceId: approved.subject,
          displayName: approved.subjectDisplayName,
          publicKey: approved.subjectDeviceKey,
        });
        this.#published(approved.sequence);
        return;
      }
      case names.joinConfirmed: {
        const confirmed = decodeConfirmed(event.payload);
        this.#roots.set(String(confirmed.approver), {
          instanceId: confirmed.approver,
          displayName: confirmed.approverDisplayName,
          publicKey: confirmed.approverDeviceKey,
        });
        if (this.#local !== undefined) {
          this.#admit(confirmed.approver, confirmed.approvalSequence, {
            instanceId: this.#local.instanceId,
            displayName: this.#local.displayName,
            publicKey: this.#local.publicKey,
          });
        }
        return;
      }
      case names.revoked: {
        const revoked = decodeRevoked(event.payload);
        this.#recordRevocation(revoked.revoker, revoked.sequence, {
          instanceId: revoked.subject,
          lastAcceptedSequence: revoked.lastAcceptedSequence,
        });
        this.#published(revoked.sequence);
        return;
      }
      case names.entrySigned: {
        const { entry } = decodeSigned(event.payload);
        // Only this host's established identity has a slot worth finishing. A
        // first entry for a fresh identity is not journaled as pending: if it
        // fails, nobody can accept that identity, and the next attempt starts
        // a new one.
        if (
          this.#local !== undefined &&
          same(entry.origin.instanceId, this.#local.instanceId) &&
          entry.origin.sequence > this.#localSequence
        ) {
          this.#pending = entry;
        }
        return;
      }
      case names.entryApplied: {
        this.#applyRead(decodeApplied(event.payload));
        return;
      }
      case names.entryRefused: {
        this.#refusals.add(refusalKey(decodeRefused(event.payload)));
        return;
      }
      default:
        return;
    }
  }

  state(): ReplicaMembershipState {
    const refusals = new Set(this.#refusals);
    const { members, cuts } = this.#derive();
    const local = this.#local;
    const pending =
      this.#pending !== undefined &&
      local !== undefined &&
      cuts.some((cut) => same(cut.instanceId, local.instanceId))
        ? undefined
        : this.#pending;
    return {
      local,
      members,
      revocations: cuts,
      localSequence: this.#localSequence,
      // A revoked identity's stopped publish is never finished.
      pending,
      applied: [...this.#applied.values()],
      joinRequests: [...this.#joinRequests.values()].filter(
        (entry) =>
          !members.some((member) => same(member.instanceId, entry.subject)) &&
          !cuts.some((cut) => same(cut.instanceId, entry.subject)),
      ),
      refusalRecorded: (refusal) => refusals.has(refusalKey(refusal)),
    };
  }

  /**
   * Members and revocations, decided the same way whatever order the records
   * arrived in.
   *
   * A member is a root, or is admitted by an approval whose approver is a
   * member and signed it at or before every cut on that approver. A
   * revocation counts when its revoker could sign it under the same rule.
   * Revocations can cut each other's revokers, so this is a fixed point:
   * the set that is certainly valid grows from nothing, and every revocation
   * that set leaves possible is honoured. Two computers that revoked each
   * other without seeing the other's record both stay revoked - when it is
   * unclear, the answer is the narrower membership.
   */
  #derive(): {
    readonly members: ReadonlyArray<ReplicaMembershipMember>;
    readonly cuts: ReadonlyArray<ReplicaRevocationCut>;
  } {
    const valid = (counted: ReadonlyArray<Revocation>): ReadonlyArray<Revocation> => {
      const admitted = this.#admitted(counted);
      return this.#revocations.filter((revocation) =>
        signedWithin(admitted, counted, revocation.revoker, revocation.revokerSequence),
      );
    };
    let certain: ReadonlyArray<Revocation> = [];
    for (let round = 0; round <= this.#revocations.length + 1; round += 1) {
      const next = valid(valid(certain));
      if (next.length === certain.length) break;
      certain = next;
    }
    const honoured = valid(certain);
    return {
      members: [...this.#admitted(honoured).values()],
      cuts: honoured.map((revocation) => revocation.cut),
    };
  }

  #admitted(counted: ReadonlyArray<Revocation>): Map<string, ReplicaMembershipMember> {
    const admitted = new Map(this.#roots);
    for (let changed = true; changed;) {
      changed = false;
      for (const admission of this.#admissions) {
        if (admitted.has(String(admission.member.instanceId))) continue;
        if (!signedWithin(admitted, counted, admission.approver, admission.approverSequence)) {
          continue;
        }
        admitted.set(String(admission.member.instanceId), admission.member);
        changed = true;
      }
    }
    return admitted;
  }

  #applyRead(applied: typeof ReplicaEntryApplied.Type): void {
    const { entry, outcome } = applied;
    this.#applied.set(`${String(entry.origin.instanceId)}/${String(entry.origin.sequence)}`, {
      instanceId: entry.origin.instanceId,
      sequence: entry.origin.sequence,
      kind: entry.kind,
      subject: entry.subject,
    });
    if (entry.kind === "join-request") {
      if (outcome === "request-approval") this.#joinRequests.set(String(entry.subject), entry);
      return;
    }
    if (entry.kind === "join-approved") {
      // A self-approval proves nothing by itself; only an approval of another
      // computer admits anyone.
      if (same(entry.subject, entry.origin.instanceId) || entry.subjectDeviceKey === undefined) {
        return;
      }
      this.#admit(entry.origin.instanceId, entry.origin.sequence, {
        instanceId: entry.subject,
        displayName: entry.subjectDisplayName,
        publicKey: entry.subjectDeviceKey,
      });
      return;
    }
    this.#recordRevocation(entry.origin.instanceId, entry.origin.sequence, {
      instanceId: entry.subject,
      lastAcceptedSequence: entry.lastAcceptedSequence ?? 0,
    });
  }

  #admit(
    approver: ReplicaInstanceId,
    approverSequence: number,
    member: ReplicaMembershipMember,
  ): void {
    const key = `admit/${String(approver)}/${String(approverSequence)}`;
    if (this.#recorded.has(key)) return;
    this.#recorded.add(key);
    this.#admissions.push({ approver, approverSequence, member });
  }

  #recordRevocation(
    revoker: ReplicaInstanceId,
    revokerSequence: number,
    cut: ReplicaRevocationCut,
  ): void {
    const key = `revoke/${String(revoker)}/${String(revokerSequence)}`;
    if (this.#recorded.has(key)) return;
    this.#recorded.add(key);
    this.#revocations.push({ revoker, revokerSequence, cut });
  }

  /**
   * A new local identity - after a revocation, re-joining is one - starts its
   * own sequence. Carrying the old identity's sequence over would open a gap
   * every reader refuses.
   */
  #startIdentity(instanceId: ReplicaInstanceId): void {
    if (this.#local !== undefined && same(this.#local.instanceId, instanceId)) return;
    this.#localSequence = 0;
    this.#pending = undefined;
  }

  #published(sequence: number): void {
    if (sequence > this.#localSequence) this.#localSequence = sequence;
    if (this.#pending !== undefined && this.#pending.origin.sequence <= this.#localSequence) {
      this.#pending = undefined;
    }
  }
}

/** Whether `instanceId` is a member and signed `sequence` at or before every counted cut on it. */
function signedWithin(
  admitted: ReadonlyMap<string, ReplicaMembershipMember>,
  counted: ReadonlyArray<Revocation>,
  instanceId: ReplicaInstanceId,
  sequence: number,
): boolean {
  if (!admitted.has(String(instanceId))) return false;
  return counted.every(
    (revocation) =>
      !same(revocation.cut.instanceId, instanceId) ||
      sequence <= revocation.cut.lastAcceptedSequence,
  );
}

export interface ReplicaMembershipJournal {
  readonly append: (input: { readonly eventName: string; readonly payload: unknown }) => void;
}

/**
 * Appends membership frames to the host journal.
 *
 * Each frame is its own aggregate, written with `expectedVersion: 0`: these
 * are records of what happened, and the service already runs one command at a
 * time, so two frames never contend.
 */
export function createReplicaMembershipJournal(options: {
  readonly journal: { readonly append: (input: unknown) => unknown };
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: { readonly kind: "system" | "local-user"; readonly actorId: string };
}): ReplicaMembershipJournal {
  return {
    append: (input) => {
      options.journal.append({
        aggregate: {
          aggregateType: REPLICA_MEMBERSHIP_AGGREGATE_TYPE,
          aggregateId: options.uuid(),
        },
        expectedVersion: 0,
        events: [
          {
            eventId: options.uuid(),
            eventName: input.eventName,
            eventVersion: 1,
            correlationId: options.uuid(),
            actor: options.actor,
            occurredAt: options.clock(),
            payload: input.payload,
          },
        ],
      });
    },
  };
}
