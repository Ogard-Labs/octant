/**
 * Who shares this host's replica store, rebuilt from the journal.
 *
 * The journal holds only inputs: this host's own identity, the founder it
 * pinned, and every valid membership record it read or published, as bytes
 * plus signature. Members, keys, the parent tree, cuts, and which entries
 * count are derived from those on every read and never journaled as facts,
 * so two hosts holding the same records derive the same membership, and a
 * restart derives what the host had before. Every apply is idempotent:
 * replaying an event twice, or replaying the whole journal into a fresh
 * projection, ends in the same state.
 *
 * The state is small and lives in memory, so the projection holds no table and
 * replays from the start of the journal on every host start, like the managed
 * clone projection.
 */

import {
  decodeReplicaEntryText,
  ReplicaDevicePublicKey,
  ReplicaDisplayName,
  ReplicaInstanceId,
  ReplicaMembershipEntry,
  type EventEnvelope,
  type ReplicaJoinRequestEntry,
} from "@octant/contracts";
import {
  deriveReplicaMembership,
  replicaInGoodStanding,
  replicaMembers,
  replicaMembershipNode,
  type ReplicaDerivedMembership,
  type ReplicaHeldRecord,
  type ReplicaMembershipNode,
} from "@octant/domain/replica-membership-policy";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  REPLICA_ARTIFACT_EVENT_NAMES,
  REPLICA_FINAL_ARTIFACT_REFUSALS,
  decodeReplicaArtifactPublished,
  decodeReplicaArtifactReconciled,
  decodeReplicaArtifactSlotErased,
  registerReplicaArtifactEvents,
} from "./replicaArtifactEvents";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Sequence = Schema.Int.pipe(Schema.positive());
const Sha256Hex = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));

export const REPLICA_MEMBERSHIP_AGGREGATE_TYPE = "replica-membership";
export const REPLICA_MEMBERSHIP_EVENT_NAMES = {
  identityCreated: "replica.identity-created@2",
  founderPinned: "replica.founder-pinned@2",
  recordHeld: "replica.record-held@2",
  entrySigned: "replica.entry-signed@2",
  entryUnreadable: "replica.entry-unreadable@2",
  commandRefused: "replica.command-refused@2",
  storeFailure: "replica.store-failure@2",
} as const;

/**
 * Names an earlier draft of this protocol wrote. Nothing on a release wrote
 * them, but a developer journal may hold them: they decode to nothing and the
 * projection ignores them, so such a journal starts with no replica identity
 * instead of failing to replay.
 */
const RETIRED_REPLICA_EVENT_NAMES = [
  "replica.membership-created@1",
  "replica.join-requested@1",
  "replica.join-approved@1",
  "replica.join-confirmed@1",
  "replica.membership-revoked@1",
  "replica.entry-signed@1",
  "replica.entry-applied@1",
  "replica.entry-refused@1",
  "replica.membership-command-refused@1",
  "replica.membership-store-failure@1",
] as const;

/** This host took a new identity: it founded a replica, or asked to join one. */
export const ReplicaIdentityCreated = Schema.Struct({
  instanceId: ReplicaInstanceId,
  publicKey: ReplicaDevicePublicKey,
  displayName: ReplicaDisplayName,
  role: Schema.Literal("founder", "joiner"),
}).annotations(strict);

/**
 * The founder a joining host's membership is derived from: the root the
 * person confirmed by matching code. A founding host is pinned by its
 * founder-role identity instead, so it never depends on a second event.
 */
export const ReplicaFounderPinned = Schema.Struct({
  instanceId: ReplicaInstanceId,
  publicKey: ReplicaDevicePublicKey,
}).annotations(strict);

/**
 * A valid membership record this host read or published, kept as the exact
 * bytes and signature it verified. Keyed by slot and hash, so holding it
 * again changes nothing.
 */
export const ReplicaRecordHeld = Schema.Struct({
  instanceId: ReplicaInstanceId,
  sequence: Sequence,
  hash: Sha256Hex,
  text: Schema.String.pipe(Schema.maxLength(65_536)),
  signature: Schema.String.pipe(Schema.maxLength(256)),
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

/** A file in the store that is not a valid record. Diagnostic only. */
export const ReplicaEntryUnreadable = Schema.Struct({
  instanceId: ReplicaInstanceId,
  sequence: Sequence,
  reason: Schema.Literal("bad-signature", "path-mismatch", "unreadable"),
}).annotations(strict);

export const ReplicaMembershipCommandRefused = Schema.Struct({
  command: Schema.Literal(
    "create-replica",
    "write-join-request",
    "approve-join",
    "confirm-join",
    "revoke-preview",
    "revoke",
    "pull",
    "publish-artifact",
  ),
  reason: Schema.Literal(
    "not-configured",
    "already-member",
    "revoked-instance",
    "code-mismatch",
    "expired-join-request",
    "unknown-instance",
    "not-a-member",
    "not-a-descendant",
    "invalid-cut",
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
  let registered = registry
    .register(names.identityCreated, 1, ReplicaIdentityCreated)
    .register(names.founderPinned, 1, ReplicaFounderPinned)
    .register(names.recordHeld, 1, ReplicaRecordHeld)
    .register(names.entrySigned, 1, ReplicaEntrySigned)
    .register(names.entryUnreadable, 1, ReplicaEntryUnreadable)
    .register(names.commandRefused, 1, ReplicaMembershipCommandRefused)
    .register(names.storeFailure, 1, ReplicaMembershipStoreFailure);
  for (const name of RETIRED_REPLICA_EVENT_NAMES) {
    registered = registered.register(name, 1, Schema.Unknown);
  }
  return registerReplicaArtifactEvents(registered);
}

const decodeIdentity = Schema.decodeUnknownSync(ReplicaIdentityCreated);
const decodePinned = Schema.decodeUnknownSync(ReplicaFounderPinned);
const decodeHeld = Schema.decodeUnknownSync(ReplicaRecordHeld);
const decodeSigned = Schema.decodeUnknownSync(ReplicaEntrySigned);
const decodeUnreadable = Schema.decodeUnknownSync(ReplicaEntryUnreadable);
const decodeStoreFailure = Schema.decodeUnknownSync(ReplicaMembershipStoreFailure);

/** This host's own identity in the store, once it founded one or asked to join. */
export interface ReplicaLocalIdentity {
  readonly instanceId: ReplicaInstanceId;
  readonly displayName: ReplicaDisplayName;
  readonly publicKey: ReplicaDevicePublicKey;
  readonly role: "founder" | "joiner";
}

/** A record this host holds, with the bytes and signature it verified. */
export interface ReplicaHeldFile extends ReplicaHeldRecord {
  readonly text: string;
  readonly signature: string;
}

export interface ReplicaRevocationCut {
  readonly instanceId: ReplicaInstanceId;
  readonly lastAcceptedSequence: number;
}

export interface ReplicaMembershipState {
  readonly local: ReplicaLocalIdentity | undefined;
  /** The founder this host pinned, with the key its founding record carries. */
  readonly founder:
    | { readonly instanceId: ReplicaInstanceId; readonly publicKey: string }
    | undefined;
  readonly membership: ReplicaDerivedMembership;
  /** Admitted computers, revoked ones included: their entries up to a cut still count. */
  readonly members: ReadonlyArray<ReplicaMembershipNode>;
  /** Admitted computers with a cut. */
  readonly revocations: ReadonlyArray<ReplicaRevocationCut>;
  /** Highest sequence this identity published or skipped; 0 before any. */
  readonly localSequence: number;
  /** A signed local entry whose publish has not been confirmed yet. */
  readonly pending: ReplicaMembershipEntry | undefined;
  readonly records: ReadonlyArray<ReplicaHeldFile>;
  /**
   * Whether this host holds a record in that slot, or an artifact entry it
   * published there or settled from a pull, so a pull does not read it again.
   */
  readonly holds: (instanceId: ReplicaInstanceId, sequence: number) => boolean;
  /**
   * The highest sequence of an instance among the valid signed entries this
   * host holds: membership records, and artifact entries it published or
   * settled. It is the cut a revoke takes when the store cannot be read.
   */
  readonly heldSequence: (instanceId: ReplicaInstanceId) => number;
  /**
   * Every slot this host reached a lasting verdict on: what `holds` names,
   * and files that are not valid records. An artifact entry waits only on an
   * earlier listed slot of its writer that is not here.
   */
  readonly settledSlots: ReadonlyArray<{
    readonly instanceId: ReplicaInstanceId;
    readonly sequence: number;
  }>;
  /** Join requests held from computers that are not in the tree. */
  readonly joinRequests: ReadonlyArray<ReplicaJoinRequestEntry>;
  /** Whether this host published an accept for its own identity. */
  readonly localAccepted: boolean;
  /**
   * This identity is over: it accepted an approval and is no longer a member
   * in good standing - revoked, or cut out above it. Coming back is a new
   * identity. The founder never finishes; losing it means a new store.
   */
  readonly localFinished: boolean;
  /** Whether this unreadable file was already journaled, so a later pull does not repeat it. */
  readonly unreadableRecorded: (refusal: typeof ReplicaEntryUnreadable.Type) => boolean;
  /** The last store failure journaled, with when it happened. */
  readonly lastStoreFailure: ReplicaLastStoreFailure | undefined;
}

export interface ReplicaLastStoreFailure {
  readonly at: EventEnvelope["occurredAt"];
  readonly phase: typeof ReplicaMembershipStoreFailure.Type.phase;
  readonly reason: typeof ReplicaMembershipStoreFailure.Type.reason;
}

function same(left: ReplicaInstanceId, right: ReplicaInstanceId): boolean {
  return String(left) === String(right);
}

function slotKey(instanceId: ReplicaInstanceId, sequence: number): string {
  return `${String(instanceId)}/${String(sequence)}`;
}

function unreadableKey(refusal: typeof ReplicaEntryUnreadable.Type): string {
  return `${slotKey(refusal.instanceId, refusal.sequence)}/${refusal.reason}`;
}

export class ReplicaMembershipProjection implements Projection {
  readonly name = "replica-membership";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly holdsStateInMemory = true as const;
  #local: ReplicaLocalIdentity | undefined;
  #founder: { readonly instanceId: ReplicaInstanceId; readonly publicKey: string } | undefined;
  readonly #records = new Map<string, ReplicaHeldFile>();
  #skipped = 0;
  #pending: ReplicaMembershipEntry | undefined;
  readonly #unreadable = new Set<string>();
  #lastStoreFailure: ReplicaLastStoreFailure | undefined;
  /** Artifact entries published or settled here, by slot; membership records live in #records. */
  readonly #artifactSlots = new Map<
    string,
    { readonly instanceId: ReplicaInstanceId; readonly sequence: number }
  >();
  readonly #unreadableSlots = new Map<
    string,
    { readonly instanceId: ReplicaInstanceId; readonly sequence: number }
  >();
  #state: ReplicaMembershipState | undefined;

  reset(_connection: SqliteConnection): void {
    this.#local = undefined;
    this.#founder = undefined;
    this.#records.clear();
    this.#skipped = 0;
    this.#pending = undefined;
    this.#unreadable.clear();
    this.#lastStoreFailure = undefined;
    this.#artifactSlots.clear();
    this.#unreadableSlots.clear();
    this.#state = undefined;
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.aggregateType !== REPLICA_MEMBERSHIP_AGGREGATE_TYPE || event.eventVersion !== 1) {
      return;
    }
    const names = REPLICA_MEMBERSHIP_EVENT_NAMES;
    switch (event.eventName) {
      case names.identityCreated: {
        const created = decodeIdentity(event.payload);
        // A new identity starts its own sequence and pins its own founder. A
        // founding identity is its own founder, so the pin comes with the
        // identity: a host that stopped after this event is still pinned.
        this.#local = created;
        this.#founder =
          created.role === "founder"
            ? { instanceId: created.instanceId, publicKey: created.publicKey }
            : undefined;
        this.#skipped = 0;
        this.#pending = undefined;
        break;
      }
      case names.founderPinned:
        this.#founder = decodePinned(event.payload);
        break;
      case names.recordHeld: {
        const held = decodeHeld(event.payload);
        const key = `${slotKey(held.instanceId, held.sequence)}#${held.hash}`;
        if (this.#records.has(key)) return;
        const entry = decodeReplicaEntryText(held.text);
        // Only membership records are held; the service never journals others.
        if (entry.kind === "artifact-version" || entry.kind === "artifact-tombstone") return;
        this.#records.set(key, {
          entry,
          hash: held.hash,
          text: held.text,
          signature: held.signature,
        });
        break;
      }
      case names.entrySigned: {
        const { entry } = decodeSigned(event.payload);
        // Only this host's current identity has a slot worth finishing.
        if (this.#local !== undefined && same(entry.origin.instanceId, this.#local.instanceId)) {
          this.#pending = entry;
        }
        break;
      }
      case names.entryUnreadable: {
        const unreadable = decodeUnreadable(event.payload);
        this.#unreadable.add(unreadableKey(unreadable));
        this.#unreadableSlots.set(slotKey(unreadable.instanceId, unreadable.sequence), {
          instanceId: unreadable.instanceId,
          sequence: unreadable.sequence,
        });
        break;
      }
      case REPLICA_ARTIFACT_EVENT_NAMES.published: {
        const published = decodeReplicaArtifactPublished(event.payload);
        this.#artifactSlots.set(slotKey(published.instanceId, published.sequence), {
          instanceId: published.instanceId,
          sequence: published.sequence,
        });
        break;
      }
      case REPLICA_ARTIFACT_EVENT_NAMES.slotErased: {
        const erased = decodeReplicaArtifactSlotErased(event.payload);
        this.#artifactSlots.set(slotKey(erased.instanceId, erased.sequence), erased);
        break;
      }
      case REPLICA_ARTIFACT_EVENT_NAMES.reconciled: {
        const reconciled = decodeReplicaArtifactReconciled(event.payload);
        // A refusal that standing or another slot could still change leaves
        // the slot to be read again.
        if (
          reconciled.outcome === "refused" &&
          !REPLICA_FINAL_ARTIFACT_REFUSALS.has(reconciled.reason)
        ) {
          return;
        }
        this.#artifactSlots.set(slotKey(reconciled.instanceId, reconciled.sequence), {
          instanceId: reconciled.instanceId,
          sequence: reconciled.sequence,
        });
        break;
      }
      case names.storeFailure: {
        const failure = decodeStoreFailure(event.payload);
        this.#lastStoreFailure = {
          at: event.occurredAt,
          phase: failure.phase,
          reason: failure.reason,
        };
        // A squatted slot of this identity is skipped: the next publish goes
        // one past it.
        if (
          failure.reason === "slot-occupied" &&
          failure.instanceId !== undefined &&
          failure.sequence !== undefined &&
          this.#local !== undefined &&
          same(failure.instanceId, this.#local.instanceId)
        ) {
          this.#skipped = Math.max(this.#skipped, failure.sequence);
        }
        break;
      }
      default:
        return;
    }
    this.#state = undefined;
  }

  state(): ReplicaMembershipState {
    this.#state ??= this.#derive();
    return this.#state;
  }

  #derive(): ReplicaMembershipState {
    const records = [...this.#records.values()];
    const local = this.#local;
    const founder = this.#founder;
    const membership = deriveReplicaMembership(founder?.instanceId, records);
    const held = new Map<string, number>();
    const slots = new Set<string>();
    const settled = new Map<
      string,
      { readonly instanceId: ReplicaInstanceId; readonly sequence: number }
    >();
    const holdSlot = (instanceId: ReplicaInstanceId, sequence: number) => {
      const id = String(instanceId);
      held.set(id, Math.max(held.get(id) ?? 0, sequence));
      slots.add(slotKey(instanceId, sequence));
      settled.set(slotKey(instanceId, sequence), { instanceId, sequence });
    };
    for (const { entry } of records) holdSlot(entry.origin.instanceId, entry.origin.sequence);
    for (const slot of this.#artifactSlots.values()) holdSlot(slot.instanceId, slot.sequence);
    for (const [key, slot] of this.#unreadableSlots) settled.set(key, slot);
    const localSequence =
      local === undefined ? 0 : Math.max(held.get(String(local.instanceId)) ?? 0, this.#skipped);
    const localAccepted =
      local !== undefined &&
      records.some(
        ({ entry }) =>
          entry.kind === "join-accepted" && same(entry.origin.instanceId, local.instanceId),
      );
    const localFinished =
      local !== undefined &&
      local.role === "joiner" &&
      localAccepted &&
      !replicaInGoodStanding(membership, local.instanceId);
    // A finished identity's stopped publish is never finished: the slot
    // belongs to an identity this host no longer writes as.
    const pending =
      !localFinished && this.#pending !== undefined && this.#pending.origin.sequence > localSequence
        ? this.#pending
        : undefined;
    const members = replicaMembers(membership);
    const unreadable = new Set(this.#unreadable);
    return {
      local,
      founder,
      membership,
      members,
      revocations: members.flatMap((node) =>
        node.cut === undefined
          ? []
          : [{ instanceId: node.instanceId, lastAcceptedSequence: node.cut }],
      ),
      localSequence,
      pending,
      records,
      holds: (instanceId, sequence) => slots.has(slotKey(instanceId, sequence)),
      heldSequence: (instanceId) => held.get(String(instanceId)) ?? 0,
      settledSlots: [...settled.values()],
      joinRequests: records.flatMap(({ entry }) =>
        entry.kind === "join-request" &&
        replicaMembershipNode(membership, entry.origin.instanceId) === undefined
          ? [entry]
          : [],
      ),
      localAccepted,
      localFinished,
      unreadableRecorded: (refusal) => unreadable.has(unreadableKey(refusal)),
      lastStoreFailure: this.#lastStoreFailure,
    };
  }
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
