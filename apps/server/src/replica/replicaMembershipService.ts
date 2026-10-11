/**
 * Commands a host person runs to manage who may write to a replica store, and
 * the read path that collects the membership records membership is derived
 * from.
 *
 * Reading keeps every valid record - signed by the key its own body names,
 * under the id that key certifies, at the path its body names - whoever wrote
 * it and whatever its standing, and refuses nothing on the way in. Membership
 * is then a pure function of the pinned founder and the records held, so what
 * a host holds never depends on what it refused or the order it read in.
 *
 * Every outcome - including refusals and store failures - is journaled,
 * because "why is that computer not a member" has to stay answerable after the
 * fact. A store failure never unwinds a local decision, and no secret ever
 * passes through the store: only public keys, names, and signed records.
 */

import { createHash } from "node:crypto";
import {
  REPLICA_ENTRY_FORMAT,
  ReplicaInstanceId,
  decodeReplicaEntryText,
  decodeReplicaMembershipEntry,
  encodeReplicaEntry,
  isReplicaMembershipEntry,
  replicaEntryRelativePaths,
  type HostId,
  type ReplicaArtifactEntry,
  type ReplicaCanvasEntry,
  type ReplicaArtifactReconciled,
  type ReplicaBroughtIn,
  type ReplicaEntry,
  type ReplicaJoinRequestEntry,
  type ReplicaMembershipCommand,
  type ReplicaJoinReadResult,
  type ReplicaMembershipEntry,
  type ReplicaMembershipResult,
  type ReplicaReadRefusal,
  type ReplicaRestoreProgress,
  type ReplicaRevocationEntry,
} from "@octant/contracts";
import {
  buildReplicaJoinMatchingPreimage,
  decideReplicaJoinApproval,
  decideReplicaRevocation,
  deriveReplicaMembership,
  isReplicaAncestor,
  replicaApprovalOf,
  replicaDescendants,
  replicaFounderReachedFrom,
  replicaInGoodStanding,
  replicaJoinRequestIsFresh,
  replicaMembershipNode,
  type ReplicaJoinRequestFacts,
} from "@octant/domain/replica-membership-policy";
import type { ReplicaStore } from "@octant/plugin-api/replica-store";
import { Schema } from "effect";
import {
  replicaInstanceIdOf,
  verifyReplicaEntrySignature,
  type ReplicaDeviceSignOutcome,
} from "./replicaDeviceKeyService";
import { REPLICA_ARTIFACT_EVENT_NAMES } from "./replicaArtifactEvents";
import {
  REPLICA_MEMBERSHIP_EVENT_NAMES,
  type ReplicaLocalIdentity,
  type ReplicaMembershipJournal,
  type ReplicaMembershipState,
} from "./replicaMembershipProjection";

/** Which store this host writes and reads, if any. */
export type ReplicaStoreSelection =
  | { readonly status: "not-configured" }
  | { readonly status: "selected"; readonly store: ReplicaStore };

/**
 * One valid entry about a Canvas a pull read - a version, a tombstone, or a
 * comment change - with the exact text it verified.
 */
export interface ReplicaArtifactRead {
  readonly instanceId: ReplicaInstanceId;
  readonly sequence: number;
  readonly entry: ReplicaCanvasEntry;
  readonly text: string;
}

/**
 * Decides and journals what each pulled artifact entry does to the library.
 * A pull hands it every valid artifact entry it read, after the membership
 * records from the same read are held, so standing is current.
 */
export interface ReplicaArtifactReconciler {
  readonly reconcile: (input: {
    readonly reads: ReadonlyArray<ReplicaArtifactRead>;
    /** Every slot the store listed in this read. */
    readonly listed: ReadonlyArray<Slot>;
    /** A restore read these newest first; see the reconcile policy. */
    readonly restoring?: boolean;
  }) => {
    readonly kept: ReadonlyArray<ReplicaArtifactReconciled>;
    readonly refused: ReadonlyArray<ReplicaReadRefusal>;
  };
}

/** What publishing one queued artifact entry did. */
export type ReplicaArtifactPublishOutcome =
  | { readonly status: "published"; readonly sequence: number }
  /** Sync is off or no store is chosen: nothing was called. */
  | { readonly status: "not-configured" }
  | {
      readonly status: "failed";
      readonly reason:
        | "not-a-member"
        | "key-unavailable"
        | "not-connected"
        | "refused"
        | "slots-squatted";
    };

export interface ReplicaMembershipPorts {
  /** The store this host is set up with. Asked once per command. */
  readonly store: () => ReplicaStoreSelection;
  /** Host credential store holding each instance's device signing key. */
  readonly credentials: {
    /** A new device key, stored under the instance id it certifies. */
    readonly create: () => Promise<{ readonly instanceId: string; readonly publicKey: string }>;
    readonly sign: (instanceId: string, payload: Uint8Array) => Promise<ReplicaDeviceSignOutcome>;
  };
  readonly journal: ReplicaMembershipJournal;
  /** Reconciles pulled artifact entries. Without it a pull reads membership records only. */
  readonly artifacts?: ReplicaArtifactReconciler;
  /** Membership facts, rebuilt from the journal. */
  readonly state: () => ReplicaMembershipState;
  readonly localHostId: HostId;
  readonly clock: () => number;
  /**
   * Whether the person stopped this identity's restore. Until it resumes,
   * every command that would read the store is refused before any store call.
   */
  readonly restoreStopped?: () => boolean;
}

export type ReplicaMembershipOutcome = ReplicaMembershipResult;
type RefusalReason = Extract<ReplicaMembershipOutcome, { kind: "refused" }>["reason"];

/** Bounds one pull so a hostile listing cannot keep the host walking forever. */
const MAX_LIST_PAGES = 1_000;
const MAX_ENTRIES_PER_INSTANCE = 100_000;
/**
 * How many slots in a row a publish skips when someone else's bytes already
 * sit in them. One squatted slot no longer wedges a member; a flood past this
 * stops its publishes with a visible error.
 */
export const REPLICA_MAX_SQUATTED_SLOTS = 32;
/**
 * How many store slots one batch of a restore, or of a join confirmation's
 * read, reads before it journals its progress and checks for a Stop.
 */
export const REPLICA_READ_BATCH = 25;
const ENTRY_KEY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([1-9][0-9]{0,15})\.(json|sig)$/;
const decodeInstanceId = Schema.decodeUnknownSync(ReplicaInstanceId);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An instance and the device key it signs with. */
interface KeyedInstance {
  readonly instanceId: ReplicaInstanceId;
  readonly publicKey: string;
}

/**
 * The six-digit code a person compares between the joining computer and the
 * approving one.
 *
 * It is a SHA-256 digest, reduced to six digits, of the joiner's instance id,
 * name, and device public key, the approver's instance id and device key, and
 * the founder's instance id and key. The approver computes it from what it
 * holds; the joining computer from the parent edges it reads from the store.
 * Equal codes mean both screens describe the same join request, the same
 * approver key, and the same founder. It is not a secret and proves nothing by
 * itself: anyone who can read the store can compute it, and six digits leave
 * room for a party that can also write the store to search keys offline until
 * one collides. The signatures on the stored records carry the authority.
 */
export function deriveReplicaJoinMatchingCode(input: {
  readonly joinRequest: ReplicaJoinRequestEntry;
  readonly approver: KeyedInstance;
  readonly founder: KeyedInstance;
}): string {
  return matchingCode(requestFacts(input.joinRequest), input.approver, input.founder);
}

function requestFacts(joinRequest: ReplicaJoinRequestEntry): ReplicaJoinRequestFacts {
  return {
    origin: {
      instanceId: joinRequest.origin.instanceId,
      displayName: joinRequest.origin.displayName,
    },
    subject: joinRequest.origin.instanceId,
    publicKey: joinRequest.origin.publicKey,
  };
}

function matchingCode(
  joinRequest: ReplicaJoinRequestFacts,
  approver: KeyedInstance,
  founder: KeyedInstance,
): string {
  const preimage = buildReplicaJoinMatchingPreimage({ joinRequest, approver, founder });
  const digest = createHash("sha256").update(preimage, "utf8").digest();
  const value = digest.readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

type WriteResult =
  | { readonly status: "published"; readonly signature: string }
  | {
      readonly status: "failed";
      readonly phase: "entry" | "signature";
      readonly reason: "not-connected" | "refused" | "slot-occupied";
    };

type ReadResult =
  | { readonly status: "ready"; readonly bytes: Uint8Array }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly reason: "not-connected" | "refused" };

type LocalPublish<E extends ReplicaEntry> =
  | { readonly status: "published"; readonly entry: E }
  | {
      readonly status: "stopped";
      readonly outcome: ReplicaMembershipOutcome;
      /** What the store answered, when the store is why it stopped. */
      readonly failure?: "not-connected" | "refused" | "slots-squatted";
    };

export interface Slot {
  readonly instanceId: ReplicaInstanceId;
  readonly sequence: number;
}

interface ReadSlots {
  readonly status: "read";
  readonly applied: number;
  readonly refused: ReadonlyArray<ReplicaReadRefusal>;
  /** Every valid entry about a Canvas this read met, counted or not. */
  readonly artifacts: ReadonlyArray<ReplicaArtifactRead>;
  /** Every slot the store listed. */
  readonly listed: ReadonlyArray<Slot>;
}

type PullRead = { readonly status: "unavailable" } | ReadSlots;

/** Every listed slot, by instance and then sequence, within the per-instance bound. */
function listedSlots(listing: ReadonlyMap<string, ReadonlySet<number>>): ReadonlyArray<Slot> {
  const slots: Slot[] = [];
  for (const [id, sequences] of [...listing].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const instanceId = decodeInstanceId(id);
    const ordered = [...sequences].sort((left, right) => left - right);
    for (const sequence of ordered.slice(0, MAX_ENTRIES_PER_INSTANCE)) {
      slots.push({ instanceId, sequence });
    }
  }
  return slots;
}

/**
 * The order a restore and a join confirmation read in: each computer's slots
 * newest first, taking one from each computer in turn, so every computer's
 * newest entries arrive before anyone's older history.
 */
export function replicaNewestFirst(slots: ReadonlyArray<Slot>): ReadonlyArray<Slot> {
  const byWriter = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = String(slot.instanceId);
    byWriter.set(key, [...(byWriter.get(key) ?? []), slot]);
  }
  const queues = [...byWriter.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, writer]) => writer.sort((left, right) => right.sequence - left.sequence));
  const ordered: Slot[] = [];
  for (let index = 0; ordered.length < slots.length; index += 1) {
    for (const writer of queues) {
      const slot = writer[index];
      if (slot !== undefined) ordered.push(slot);
    }
  }
  return ordered;
}

/** Commands that read the store, and so wait while a restore is stopped. */
const READS_STORE: ReadonlySet<ReplicaMembershipCommand["kind"]> = new Set([
  "pull",
  "approve-join",
  "revoke-preview",
  "revoke",
]);

export class ReplicaMembershipService {
  readonly #ports: ReplicaMembershipPorts;
  // Commands run one at a time: each one reads the next local sequence and
  // publishes into it, and two interleaved commands would race for one slot.
  #queue: Promise<unknown> = Promise.resolve();
  /** A join confirmation in this process is reading the store now. */
  #joinReading = false;

  constructor(ports: ReplicaMembershipPorts) {
    this.#ports = ports;
  }

  execute(command: ReplicaMembershipCommand): Promise<ReplicaMembershipOutcome> {
    return this.#serially(() => this.#run(command));
  }

  /**
   * Publish one queued artifact entry at this identity's next free slot.
   *
   * It runs in the same line as membership commands, because both take the
   * next sequence of one identity. A membership entry whose publish stopped
   * part-way is finished first, so an artifact never takes its slot. The
   * entry is built for the slot it is about to take; retried at that same
   * slot it is the same bytes and the same signature, so a publish that
   * landed before the host stopped is found already there rather than written
   * twice. The landed slot is journaled here, inside the line, so the next
   * command starts after it.
   */
  publishArtifact(input: {
    readonly queueId: string;
    readonly build: (origin: ReplicaArtifactEntry["origin"]) => ReplicaCanvasEntry;
  }): Promise<ReplicaArtifactPublishOutcome> {
    return this.#serially(async () => {
      const selection = this.#ports.store();
      if (selection.status === "not-configured") return { status: "not-configured" };
      const state = this.#ports.state();
      const local = state.local;
      if (local === undefined || state.localFinished) {
        return { status: "failed", reason: "not-a-member" };
      }
      const store = selection.store;
      const finished = await this.#finishPending(store, "publish-artifact");
      if (finished !== undefined) {
        return {
          status: "failed",
          reason: finished.kind === "refused" ? "key-unavailable" : "not-connected",
        };
      }
      const publish = await this.#publishNext(store, "publish-artifact", local, input.build, {
        journalSigned: false,
        landed: (entry) =>
          this.#journal(REPLICA_ARTIFACT_EVENT_NAMES.published, {
            queueId: input.queueId,
            instanceId: entry.origin.instanceId,
            displayName: entry.origin.displayName,
            sequence: entry.origin.sequence,
            contentHash: entry.contentHash,
          }),
      });
      if (publish.status === "published") {
        return { status: "published", sequence: publish.entry.origin.sequence };
      }
      return { status: "failed", reason: publish.failure ?? "key-unavailable" };
    });
  }

  #serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #run(command: ReplicaMembershipCommand): Promise<ReplicaMembershipOutcome> {
    const selection = this.#ports.store();
    if (selection.status === "not-configured") {
      return this.#refuse(
        command.kind,
        "not-configured",
        "No replica store is set up on this computer.",
      );
    }
    const store = selection.store;
    // Stop means the store is not read until Resume: the person asked for
    // that, and a command they press meanwhile is refused, not run quietly.
    if (READS_STORE.has(command.kind) && this.#ports.restoreStopped?.() === true) {
      return this.#refuse(
        command.kind,
        "restore-stopped",
        "The restore is stopped, so this computer reads nothing from the store. Resume the restore first.",
      );
    }
    if (
      command.kind === "approve-join" ||
      command.kind === "confirm-join" ||
      command.kind === "revoke"
    ) {
      // A local entry whose publish stopped part-way is finished before the
      // next decision, so that decision sees what the earlier one already did.
      const finished = await this.#finishPending(store, command.kind);
      if (finished !== undefined) return finished;
    }
    switch (command.kind) {
      case "create-replica":
        return this.#createReplica(store, command.displayName);
      case "write-join-request":
        return this.#writeJoinRequest(store, command.displayName);
      case "approve-join":
        return this.#approveJoin(store, command.joinRequest, command.confirmationCode);
      case "confirm-join":
        return this.#confirmJoin(store, command.approver, command.confirmationCode);
      case "revoke-preview":
        return this.#revokePreview(store, command.subject);
      case "revoke":
        return this.#revoke(store, command.subject, command.cut, command.alsoRevoke ?? []);
      case "pull":
        return this.#pull(store);
    }
  }

  async #createReplica(
    store: ReplicaStore,
    displayName: string,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    // A finished identity cannot come back; starting over is a new identity.
    if (state.local !== undefined && !state.localFinished) {
      return this.#refuse(
        "create-replica",
        "already-member",
        "This computer already has an identity in a replica store.",
      );
    }
    const key = await this.#newKey();
    if (key === undefined) {
      return this.#refuse(
        "create-replica",
        "key-unavailable",
        "The device signing key could not be created.",
      );
    }
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "replica-founded",
      origin: { instanceId: key.instanceId, displayName, sequence: 1, publicKey: key.publicKey },
    });
    if (entry.kind !== "replica-founded")
      throw new Error("A founding record decoded as another kind.");
    const published = await this.#publishFirst(store, "create-replica", entry, "founder");
    // The founder-role identity pins itself, so no separate pin can be lost.
    if (published !== undefined) return published;
    return { kind: "replica-created", instanceId: key.instanceId, entry };
  }

  async #writeJoinRequest(
    store: ReplicaStore,
    displayName: string,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    const local = state.local;
    if (
      local !== undefined &&
      !state.localFinished &&
      (local.role === "founder" || state.localAccepted)
    ) {
      return this.#refuse(
        "write-join-request",
        "already-member",
        "This computer is already a member.",
      );
    }
    // A request is an identity's sequence 1. Asking again - after a request
    // went stale, after a revocation, or after a cut removed the approval that
    // admitted this computer - is a new identity with a new key, never the
    // old one back.
    const key = await this.#newKey();
    if (key === undefined) {
      return this.#refuse(
        "write-join-request",
        "key-unavailable",
        "The device signing key could not be created.",
      );
    }
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-request",
      origin: { instanceId: key.instanceId, displayName, sequence: 1, publicKey: key.publicKey },
      requestedAt: this.#ports.clock(),
    });
    if (entry.kind !== "join-request") throw new Error("A join request decoded as another kind.");
    const published = await this.#publishFirst(store, "write-join-request", entry, "joiner");
    if (published !== undefined) return published;
    return { kind: "join-requested", instanceId: key.instanceId, entry };
  }

  async #approveJoin(
    store: ReplicaStore,
    joinRequest: ReplicaJoinRequestEntry,
    confirmationCode: string,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    const subject = joinRequest.origin.instanceId;
    const local = state.local;
    const founder = state.founder;
    if (
      local === undefined ||
      founder === undefined ||
      !replicaInGoodStanding(state.membership, local.instanceId)
    ) {
      return this.#refuse(
        "approve-join",
        "not-a-member",
        "Only a member of the replica can approve a join.",
        subject,
      );
    }
    // The caller's copy proves nothing: the matching code is derived from
    // these same fields, so a request that was never written to the store -
    // or was rewritten since - would still match its own code. Approval is
    // published only for the entry the store holds and the joiner signed.
    const read = await this.#readSigned(store, subject, joinRequest.origin.sequence);
    if (read.status === "unavailable") {
      return this.#refuse(
        "approve-join",
        "store-unavailable",
        "The replica store cannot be read.",
        subject,
      );
    }
    if (read.status === "missing") {
      return this.#refuse(
        "approve-join",
        "unknown-instance",
        "No join request from that computer is in the store.",
        subject,
      );
    }
    if (read.status !== "ready" || read.text !== encodeReplicaEntry(joinRequest)) {
      return this.#refuse(
        "approve-join",
        "code-mismatch",
        "The stored join request does not verify.",
        subject,
      );
    }
    if (!replicaJoinRequestIsFresh(joinRequest.requestedAt, this.#ports.clock())) {
      return this.#refuse(
        "approve-join",
        "expired-join-request",
        "That join request is no longer fresh.",
        subject,
      );
    }
    const decision = decideReplicaJoinApproval({
      membership: state.membership,
      local: local.instanceId,
      subject,
    });
    if (decision.status === "refused") {
      return this.#refuse(
        "approve-join",
        decision.reason,
        decision.reason === "already-member"
          ? "That computer is already a member."
          : decision.reason === "revoked-instance"
            ? "That identity lost its place and cannot rejoin; it asks again as a new computer."
            : "Only a member of the replica can approve a join.",
        subject,
      );
    }
    if (
      confirmationCode !== deriveReplicaJoinMatchingCode({ joinRequest, approver: local, founder })
    ) {
      return this.#refuse(
        "approve-join",
        "code-mismatch",
        "The matching codes do not agree.",
        subject,
      );
    }
    this.#hold(read);
    const publish = await this.#publishLocal(store, "approve-join", local, (origin) =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-approved",
        origin,
        subject,
        subjectKey: joinRequest.origin.publicKey,
        subjectName: joinRequest.origin.displayName,
      }),
    );
    if (publish.status === "stopped") return publish.outcome;
    if (publish.entry.kind !== "join-approved")
      throw new Error("An approval decoded as another kind.");
    return { kind: "join-approved", subject, entry: publish.entry };
  }

  /**
   * The joining computer's half of a join: after the person compared codes, it
   * reads the store, walks parent edges up from the approver to the one
   * founder they reach, pins that founder, and signs a `join-accepted` record
   * naming the approval it accepted. Until that record exists, the approval
   * alone admits nobody.
   */
  async #confirmJoin(
    store: ReplicaStore,
    approver: ReplicaInstanceId,
    confirmationCode: string,
  ): Promise<ReplicaMembershipOutcome> {
    const initial = this.#ports.state();
    const local = initial.local;
    if (local === undefined) {
      return this.#refuse(
        "confirm-join",
        "not-a-member",
        "This computer has not asked to join a replica.",
        approver,
      );
    }
    if (local.role === "founder" || (initial.localAccepted && !initial.localFinished)) {
      return this.#refuse(
        "confirm-join",
        "already-member",
        "This computer is already a member.",
        approver,
      );
    }
    if (initial.localFinished) {
      return this.#refuse(
        "confirm-join",
        "revoked-instance",
        "This identity is no longer a member and cannot rejoin; ask to join again.",
        approver,
      );
    }
    if (String(approver) === String(local.instanceId)) {
      return this.#refuse(
        "confirm-join",
        "unknown-instance",
        "That computer cannot approve this one.",
        approver,
      );
    }
    const read = await this.#joinRead(store, local.instanceId);
    if (read.status === "unavailable") {
      return this.#refuse(
        "confirm-join",
        "store-unavailable",
        "The replica store cannot be read.",
        approver,
      );
    }
    if (read.status === "stopped") {
      return this.#refuse(
        "confirm-join",
        "join-stopped",
        `Stopped after reading ${String(read.done)} of ${String(read.total)} entries. Confirm again to carry on where it stopped.`,
        approver,
      );
    }
    const state = this.#ports.state();
    const approval = replicaApprovalOf(state.records, approver, local.instanceId);
    if (approval === undefined) {
      return this.#refuse(
        "confirm-join",
        "unknown-instance",
        "No approval of this computer by that computer is in the store.",
        approver,
      );
    }
    const root = replicaFounderReachedFrom(state.records, approver);
    if (root === undefined) {
      return this.#refuse(
        "confirm-join",
        "unknown-instance",
        "No chain of accepted approvals from a founder reaches that computer.",
        approver,
      );
    }
    const founder = { instanceId: root.origin.instanceId, publicKey: root.origin.publicKey };
    // The code names the approver's key and the founder as this computer read
    // them. The approver computed its code from its own key and founder, so a
    // store someone tampered with gives another code.
    const expected = matchingCode(
      {
        origin: { instanceId: local.instanceId, displayName: local.displayName },
        subject: local.instanceId,
        publicKey: local.publicKey,
      },
      { instanceId: approver, publicKey: approval.entry.origin.publicKey },
      founder,
    );
    if (confirmationCode !== expected) {
      return this.#refuse(
        "confirm-join",
        "code-mismatch",
        "The matching codes do not agree.",
        approver,
      );
    }
    if (
      state.founder !== undefined &&
      String(state.founder.instanceId) !== String(founder.instanceId)
    ) {
      return this.#refuse(
        "confirm-join",
        "unknown-instance",
        "That computer belongs to a different replica than the one this computer confirmed.",
        approver,
      );
    }
    const accept = (origin: ReplicaMembershipEntry["origin"]) =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-accepted",
        origin,
        approver,
        approvalSequence: approval.entry.origin.sequence,
        approvalHash: approval.hash,
        founder: founder.instanceId,
      });
    // An identity has one parent forever, so an accept that would not admit
    // it is never published: it would end this identity for nothing.
    const preview = deriveReplicaMembership(founder.instanceId, [
      ...state.records,
      { entry: accept(originFor(local, state.localSequence + 1)), hash: "0".repeat(64) },
    ]);
    if (!replicaInGoodStanding(preview, local.instanceId)) {
      return this.#refuse(
        "confirm-join",
        "revoked-instance",
        "A revocation in the store cuts the approval that would admit this computer.",
        approver,
      );
    }
    if (state.founder === undefined) {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.founderPinned, founder);
    }
    const publish = await this.#publishLocal(store, "confirm-join", local, accept);
    if (publish.status === "stopped") return publish.outcome;
    return { kind: "join-confirmed", approver, founder: founder.instanceId };
  }

  /**
   * The read a join confirmation makes before it decides: every slot this
   * computer holds nothing in and did not already read, newest first, in
   * batches, journaling progress after each one. Membership records are held
   * as they are read; the other slots it read are journaled as passed, so a
   * Stop, a restart, or a refused confirmation carries on at the next unread
   * slot. Artifact entries count only once this computer is a member, so the
   * restore after the join reads them again.
   */
  async #joinRead(
    store: ReplicaStore,
    instanceId: ReplicaInstanceId,
  ): Promise<
    | { readonly status: "read" }
    | { readonly status: "unavailable" }
    | { readonly status: "stopped"; readonly done: number; readonly total: number }
  > {
    this.#joinReading = true;
    try {
      const listing = await this.#listInstances(store);
      if (listing === undefined) return { status: "unavailable" };
      const listed = listedSlots(listing);
      const state = this.#ports.state();
      const unread = listed.filter(
        (slot) =>
          !state.holds(slot.instanceId, slot.sequence) &&
          !state.joinReadPassed(slot.instanceId, slot.sequence),
      );
      const names = REPLICA_MEMBERSHIP_EVENT_NAMES;
      const before = state.joinRead;
      let done: number;
      let total: number;
      if (before === undefined) {
        done = 0;
        total = unread.length;
        this.#journal(names.joinReadStarted, { instanceId, total });
      } else {
        // What the store gained since the last read counts toward the total.
        done = Math.max(before.done, before.total - unread.length);
        total = Math.max(before.total, done + unread.length);
        if (before.state !== "running") this.#journal(names.joinReadResumed, { instanceId });
        if (done !== before.done || total !== before.total) {
          this.#journal(names.joinReadProgress, { instanceId, done, total, passed: [] });
        }
      }
      const running = () => this.#ports.state().joinRead?.state === "running";
      const order = replicaNewestFirst(unread);
      for (let start = 0; start < order.length; start += REPLICA_READ_BATCH) {
        if (!running()) return { status: "stopped", done, total };
        const batch = order.slice(start, start + REPLICA_READ_BATCH);
        const read = await this.#readSlots(store, batch);
        if (read.status === "unavailable") return read;
        done = Math.min(total, done + batch.length);
        this.#journal(names.joinReadProgress, {
          instanceId,
          done,
          total,
          passed: [
            ...read.artifacts.map(({ instanceId: writer, sequence }) => ({
              instanceId: writer,
              sequence,
            })),
            ...read.refused.map(({ instanceId: writer, sequence }) => ({
              instanceId: writer,
              sequence,
            })),
          ],
        });
      }
      // A Stop pressed during the last batch still stops the confirmation.
      if (!running()) return { status: "stopped", done, total };
      this.#journal(names.joinReadFinished, { instanceId });
      return { status: "read" };
    } finally {
      this.#joinReading = false;
    }
  }

  /**
   * This identity's join confirmation read, as Settings shows it. A read the
   * journal says is running while no confirmation here is reading was cut
   * off by a restart, so it shows as stopped.
   */
  joinReadProgress(): ReplicaRestoreProgress | undefined {
    const read = this.#ports.state().joinRead;
    if (read === undefined) return undefined;
    return {
      state: read.state === "running" && !this.#joinReading ? "stopped" : read.state,
      done: read.done,
      total: read.total,
    };
  }

  /**
   * Stop a join confirmation's read after the batch it is reading. It runs
   * outside the command line, which the confirmation holds while it reads.
   */
  stopJoinRead(): ReplicaJoinReadResult {
    const state = this.#ports.state();
    const read = state.joinRead;
    if (state.local === undefined || read === undefined || read.state === "finished") {
      return {
        kind: "refused",
        reason: "no-join-read",
        message: "This computer is not reading the store to confirm a join.",
      };
    }
    if (read.state === "running") {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinReadStopped, {
        instanceId: state.local.instanceId,
      });
    }
    const progress = this.joinReadProgress();
    return { kind: "join-read", joinRead: progress ?? { ...read, state: "stopped" } };
  }

  async #revokePreview(
    store: ReplicaStore,
    subject: ReplicaInstanceId,
  ): Promise<ReplicaMembershipOutcome> {
    const checked = await this.#beforeRevoke(store, "revoke-preview", subject);
    if (checked.status === "refused") return checked.outcome;
    const state = this.#ports.state();
    return {
      kind: "revoke-preview",
      subject,
      cut: checked.highestSigned(subject),
      broughtIn: broughtIn(state, subject),
      subjectRevocations: state.records
        .flatMap(({ entry }) =>
          entry.kind === "revocation" && same(entry.origin.instanceId, subject)
            ? [{ sequence: entry.origin.sequence, subject: entry.subject, cut: entry.cut }]
            : [],
        )
        .sort((left, right) => left.sequence - right.sequence),
      readStore: checked.readStore,
    };
  }

  /**
   * Revoke a computer this one brought in, directly or through others. The
   * store is read first, so the cut keeps what the revoked computer signed
   * that this one had not read yet, artifact entries included; a person can
   * only move the cut earlier.
   *
   * Each revocation is its own publish. When the subject's lands and a later
   * one stops, the outcome names what landed and what did not, so nothing
   * the person asked for is dropped without saying so.
   */
  async #revoke(
    store: ReplicaStore,
    subject: ReplicaInstanceId,
    requestedCut: number | undefined,
    alsoRevoke: ReadonlyArray<ReplicaInstanceId>,
  ): Promise<ReplicaMembershipOutcome> {
    const checked = await this.#beforeRevoke(store, "revoke", subject);
    if (checked.status === "refused") return checked.outcome;
    const state = this.#ports.state();
    const local = checked.local;
    const highest = checked.highestSigned(subject);
    if (requestedCut !== undefined && requestedCut > highest) {
      return this.#refuse(
        "revoke",
        "invalid-cut",
        "A cut can only fall at or before the last signed entry of that computer this one read.",
        subject,
      );
    }
    for (const other of alsoRevoke) {
      const node = replicaMembershipNode(state.membership, other);
      if (
        node === undefined ||
        !node.admitted ||
        !isReplicaAncestor(state.membership, subject, other)
      ) {
        return this.#refuse(
          "revoke",
          "not-a-descendant",
          "Only a computer the revoked one brought in can be revoked with it.",
          other,
        );
      }
      if (node.cut !== undefined) {
        return this.#refuse(
          "revoke",
          "revoked-instance",
          "That identity is already revoked.",
          other,
        );
      }
    }
    const targets = [
      { subject, cut: requestedCut ?? highest },
      ...alsoRevoke.map((other) => ({ subject: other, cut: checked.highestSigned(other) })),
    ];
    const entries: ReplicaRevocationEntry[] = [];
    for (const [index, target] of targets.entries()) {
      const publish = await this.#publishLocal(store, "revoke", local, (origin) =>
        decodeReplicaMembershipEntry({
          format: REPLICA_ENTRY_FORMAT,
          kind: "revocation",
          origin,
          subject: target.subject,
          cut: target.cut,
        }),
      );
      if (publish.status === "stopped") {
        const [first, ...alsoRevoked] = entries;
        if (first === undefined) return publish.outcome;
        return {
          kind: "revoked-in-part",
          subject,
          entry: first,
          alsoRevoked,
          notRevoked: targets.slice(index).map((rest) => rest.subject),
          message:
            publish.outcome.kind === "refused" || publish.outcome.kind === "store-failed"
              ? publish.outcome.message
              : "The revocation could not be published.",
          readStore: checked.readStore,
        };
      }
      if (publish.entry.kind !== "revocation")
        throw new Error("A revocation decoded as another kind.");
      entries.push(publish.entry);
    }
    const [entry, ...alsoRevoked] = entries;
    if (entry === undefined) throw new Error("A revoke published no revocation.");
    return { kind: "revoked", subject, entry, alsoRevoked, readStore: checked.readStore };
  }

  async #beforeRevoke(
    store: ReplicaStore,
    command: "revoke" | "revoke-preview",
    subject: ReplicaInstanceId,
  ): Promise<
    | { readonly status: "refused"; readonly outcome: ReplicaMembershipOutcome }
    | {
        readonly status: "ready";
        readonly local: ReplicaLocalIdentity;
        readonly readStore: boolean;
        /**
         * The highest sequence of an instance's valid signed entries this
         * host holds or just read, artifact entries included: the default
         * cut, and the latest a requested cut may fall.
         */
        readonly highestSigned: (instanceId: ReplicaInstanceId) => number;
      }
  > {
    const local = this.#ports.state().local;
    if (local === undefined) {
      return {
        status: "refused",
        outcome: this.#refuse(command, "not-a-member", "Only a member can revoke.", subject),
      };
    }
    // Read first, so a person does not cut away approvals the revoked
    // computer made that this one has not read yet. A store that cannot be
    // read leaves the cut at what this computer already holds.
    const pulled = await this.#readStore(store);
    const state = this.#ports.state();
    const decision = decideReplicaRevocation({
      membership: state.membership,
      local: local.instanceId,
      subject,
    });
    if (decision.status === "refused") {
      const messages: Record<typeof decision.reason, string> = {
        "not-a-member": "Only a member in good standing can revoke another computer.",
        "unknown-instance": "No member has that id.",
        "not-a-descendant":
          "Only a computer this one brought in can be revoked from here; revoke it from the computer that approved it.",
        "revoked-instance": "That identity is already revoked.",
      };
      return {
        status: "refused",
        outcome: this.#refuse(command, decision.reason, messages[decision.reason], subject),
      };
    }
    const artifacts = pulled.status === "read" ? pulled.artifacts : [];
    return {
      status: "ready",
      local,
      readStore: pulled.status === "read",
      highestSigned: (instanceId) =>
        artifacts.reduce(
          (highest, slot) =>
            same(slot.instanceId, instanceId) ? Math.max(highest, slot.sequence) : highest,
          state.heldSequence(instanceId),
        ),
    };
  }

  async #pull(store: ReplicaStore): Promise<ReplicaMembershipOutcome> {
    if (this.#ports.state().local === undefined) {
      return this.#refuse(
        "pull",
        "not-a-member",
        "This computer has no identity in a replica store.",
      );
    }
    const read = await this.#readStore(store);
    if (read.status === "unavailable") {
      return this.#refuse("pull", "store-unavailable", "The replica store cannot be read.");
    }
    const reconciled = this.#ports.artifacts?.reconcile({
      reads: read.artifacts,
      listed: read.listed,
    });
    const now = this.#ports.clock();
    const joinRequests = this.#ports
      .state()
      .joinRequests.filter((entry) => replicaJoinRequestIsFresh(entry.requestedAt, now));
    return {
      kind: "pulled",
      applied: read.applied,
      refused: [...read.refused, ...(reconciled?.refused ?? [])],
      artifacts: reconciled?.kept ?? [],
      joinRequests,
    };
  }

  /**
   * Read every slot in the store this host holds no record in, from any
   * instance, member or not, and keep each valid membership record. Nothing
   * depends on read order: there are no passes and no walk that stops at a
   * gap. A record from a computer that is not a member yet is held anyway, so
   * when the approval admitting it arrives later its earlier records count
   * without being read again. A slot already held is not read again.
   *
   * Valid artifact entries are returned for the pull to reconcile once the
   * membership records from this same read are held. A slot whose artifact
   * entry was published or settled here is not read again.
   */
  async #readStore(store: ReplicaStore): Promise<PullRead> {
    const listing = await this.#listInstances(store);
    if (listing === undefined) return { status: "unavailable" };
    const listed = listedSlots(listing);
    const read = await this.#readSlots(store, listed);
    return read.status === "unavailable" ? read : { ...read, listed };
  }

  /**
   * Read each slot this host holds nothing in, in the order given, and hold
   * every valid membership record among them. Valid entries about a Canvas
   * are returned for the caller to reconcile.
   */
  async #readSlots(
    store: ReplicaStore,
    slots: ReadonlyArray<Slot>,
  ): Promise<Exclude<PullRead, { readonly status: "read" }> | Omit<ReadSlots, "listed">> {
    let applied = 0;
    const refused: ReplicaReadRefusal[] = [];
    const artifacts: ReplicaArtifactRead[] = [];
    for (const { instanceId, sequence } of slots) {
      if (this.#ports.state().holds(instanceId, sequence)) continue;
      const read = await this.#readSigned(store, instanceId, sequence);
      if (read.status === "unavailable") return { status: "unavailable" };
      if (read.status === "missing") continue;
      if (read.status !== "ready") {
        refused.push(this.#unreadable({ instanceId, sequence, reason: read.status }));
        continue;
      }
      if (!isReplicaMembershipEntry(read.entry)) {
        artifacts.push({ instanceId, sequence, entry: read.entry, text: read.text });
        continue;
      }
      try {
        this.#hold(read);
      } catch {
        // A record the journal will not take is unreadable here, not a
        // failed pull: otherwise its slot stays unheld and every later
        // read stops on it again.
        refused.push(this.#unreadable({ instanceId, sequence, reason: "unreadable" }));
        continue;
      }
      applied += 1;
    }
    return { status: "read", applied, refused, artifacts };
  }

  /**
   * What a restore reads: every slot the store lists, and those this host
   * holds nothing in yet. It runs in the command line, like a pull.
   */
  restoreListing(): Promise<
    | {
        readonly status: "listed";
        readonly listed: ReadonlyArray<Slot>;
        readonly unread: ReadonlyArray<Slot>;
      }
    | { readonly status: "not-configured" | "unavailable" }
  > {
    return this.#serially(async () => {
      const selection = this.#ports.store();
      if (selection.status === "not-configured" || this.#ports.state().local === undefined) {
        return { status: "not-configured" };
      }
      const listing = await this.#listInstances(selection.store);
      if (listing === undefined) return { status: "unavailable" };
      const listed = listedSlots(listing);
      const state = this.#ports.state();
      return {
        status: "listed",
        listed,
        unread: listed.filter((slot) => !state.holds(slot.instanceId, slot.sequence)),
      };
    });
  }

  /**
   * Read one batch of a restore: hold its membership records, then reconcile
   * its entries about a Canvas as a restore, so an artifact version applies
   * ahead of its writer's earlier slots. Everything it keeps is journaled
   * before it returns, so a restart resumes at the next unread slot. Each
   * batch takes the command line once, so publishes and commands run
   * between batches.
   */
  restoreRead(input: {
    readonly slots: ReadonlyArray<Slot>;
    readonly listed: ReadonlyArray<Slot>;
  }): Promise<
    | {
        readonly status: "read";
        readonly kept: ReadonlyArray<ReplicaArtifactReconciled>;
        readonly refused: ReadonlyArray<ReplicaReadRefusal>;
      }
    | { readonly status: "not-configured" | "unavailable" }
  > {
    return this.#serially(async () => {
      const selection = this.#ports.store();
      if (selection.status === "not-configured" || this.#ports.state().local === undefined) {
        return { status: "not-configured" };
      }
      const read = await this.#readSlots(selection.store, input.slots);
      if (read.status === "unavailable") return read;
      const reconciled = this.#ports.artifacts?.reconcile({
        reads: read.artifacts,
        listed: input.listed,
        restoring: true,
      });
      return {
        status: "read",
        kept: reconciled?.kept ?? [],
        refused: [...read.refused, ...(reconciled?.refused ?? [])],
      };
    });
  }

  async #listInstances(
    store: ReplicaStore,
  ): Promise<ReadonlyMap<string, ReadonlySet<number>> | undefined> {
    const instances = new Map<string, Set<number>>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const listed = await store.list(cursor);
      if (listed.status !== "ready") {
        this.#storeFailure({ phase: "list", reason: listed.status });
        return undefined;
      }
      for (const { key } of listed.entries) {
        const match = ENTRY_KEY.exec(key);
        if (match === null || match[3] !== "json") continue;
        const id = match[1];
        const sequence = Number(match[2]);
        if (id === undefined || !Number.isSafeInteger(sequence)) continue;
        const known = instances.get(id) ?? new Set<number>();
        known.add(sequence);
        instances.set(id, known);
      }
      if (listed.nextCursor === undefined) return instances;
      cursor = listed.nextCursor;
    }
    // A listing that does not end inside the bound is refused, not read in
    // part: a partial view would skip whole instances - their revocations
    // too - without saying so.
    this.#storeFailure({ phase: "list", reason: "truncated" });
    return undefined;
  }

  /**
   * Read one slot and decide whether its file is a valid record on its own:
   * the body decodes and is its entry's canonical encoding, its origin is the
   * path, its id is its key's id, an approval's subject is its subject key's
   * id, and the signature is canonical base64 that verifies under the key the
   * body names. Nothing else is consulted, so every reader reaches the same
   * verdict on the same file.
   */
  async #readSigned(
    store: ReplicaStore,
    instanceId: ReplicaInstanceId,
    sequence: number,
  ): Promise<SignedRead> {
    const paths = replicaEntryRelativePaths(instanceId, sequence);
    const body = await readStore(store, paths.entry);
    if (body.status === "unavailable") {
      this.#storeFailure({ phase: "read", reason: body.reason, instanceId, sequence });
      return { status: "unavailable" };
    }
    if (body.status === "missing") return { status: "missing" };
    const text = decoder.decode(body.bytes);
    let entry: ReplicaEntry;
    try {
      entry = decodeReplicaEntryText(text);
    } catch {
      return { status: "unreadable" };
    }
    // Only the canonical encoding is a record. A padded copy still verifies
    // under its writer's key, but it is a second byte form of one entry and can
    // exceed the bounds a held record is journaled under.
    if (text !== encodeReplicaEntry(entry)) return { status: "unreadable" };
    if (
      String(entry.origin.instanceId) !== String(instanceId) ||
      entry.origin.sequence !== sequence
    ) {
      return { status: "path-mismatch" };
    }
    const signature = await readStore(store, paths.signature);
    if (signature.status === "unavailable") {
      this.#storeFailure({ phase: "read", reason: signature.reason, instanceId, sequence });
      return { status: "unavailable" };
    }
    const signatureText = signature.status === "ready" ? decoder.decode(signature.bytes) : "";
    if (
      signature.status !== "ready" ||
      !isCanonicalSignatureText(signatureText) ||
      replicaInstanceIdOf(entry.origin.publicKey) !== String(instanceId) ||
      (entry.kind === "join-approved" &&
        replicaInstanceIdOf(entry.subjectKey) !== String(entry.subject)) ||
      !verifyReplicaEntrySignature({
        publicKeyBase64: entry.origin.publicKey,
        payload: body.bytes,
        signatureBase64: signatureText,
      })
    ) {
      return { status: "bad-signature" };
    }
    return { status: "ready", entry, bytes: body.bytes, text, signature: signatureText };
  }

  /**
   * Publish the first entry of a fresh identity. Nobody can accept an identity
   * whose first entry did not land, so a failure abandons it and the next
   * attempt starts a new one.
   */
  async #publishFirst(
    store: ReplicaStore,
    command: "create-replica" | "write-join-request",
    entry: ReplicaMembershipEntry,
    role: "founder" | "joiner",
  ): Promise<ReplicaMembershipOutcome | undefined> {
    const encoded = encoder.encode(encodeReplicaEntry(entry));
    const signature = await this.#sign(entry, encoded);
    if (signature === undefined) {
      return this.#refuse(command, "key-unavailable", "The entry could not be signed.");
    }
    const written = await writeSigned(store, entry, encoded, signature);
    if (written.status === "failed") return this.#publishFailed(entry, written);
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.identityCreated, {
      instanceId: entry.origin.instanceId,
      publicKey: entry.origin.publicKey,
      displayName: entry.origin.displayName,
      role,
    });
    this.#holdPublished(entry, encoded, signature);
    return undefined;
  }

  /**
   * Publish an entry under this host's established identity at its next
   * sequence.
   *
   * The signed entry is journaled before either file is written. If the
   * publish stops part-way, the next command finishes it first with the same
   * bytes and the same signature - Ed25519 signs deterministically - so a
   * write-once signature already in the slot matches. A slot that already
   * holds bytes this computer did not write is skipped, up to
   * {@link REPLICA_MAX_SQUATTED_SLOTS} in a row; readers allow the gap.
   */
  async #publishLocal(
    store: ReplicaStore,
    command: "approve-join" | "confirm-join" | "revoke",
    local: ReplicaLocalIdentity,
    build: (origin: ReplicaMembershipEntry["origin"]) => ReplicaMembershipEntry,
  ): Promise<LocalPublish<ReplicaMembershipEntry>> {
    return this.#publishNext(store, command, local, build, {
      journalSigned: true,
      landed: (entry, encoded, signature) => this.#holdPublished(entry, encoded, signature),
    });
  }

  /**
   * The write path every local entry takes: build for the next sequence,
   * sign, and publish write-once, skipping a slot someone else's bytes took.
   * A membership entry is journaled signed first so a stopped publish can be
   * finished; an artifact entry is rebuilt from its queue at the same slot
   * instead.
   */
  async #publishNext<E extends ReplicaEntry>(
    store: ReplicaStore,
    command: LocalCommand,
    local: ReplicaLocalIdentity,
    build: (origin: ReplicaMembershipEntry["origin"]) => E,
    options: {
      readonly journalSigned: boolean;
      readonly landed: (entry: E, encoded: Uint8Array, signature: string) => void;
    },
  ): Promise<LocalPublish<E>> {
    for (let attempt = 0; attempt < REPLICA_MAX_SQUATTED_SLOTS; attempt += 1) {
      const entry = build(originFor(local, this.#ports.state().localSequence + 1));
      const encoded = encoder.encode(encodeReplicaEntry(entry));
      const signature = await this.#sign(entry, encoded);
      if (signature === undefined) {
        return {
          status: "stopped",
          outcome: this.#refuse(command, "key-unavailable", "The entry could not be signed."),
        };
      }
      if (options.journalSigned) {
        this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.entrySigned, { entry });
      }
      const written = await writeSigned(store, entry, encoded, signature);
      if (written.status === "published") {
        options.landed(entry, encoded, signature);
        return { status: "published", entry };
      }
      if (written.reason !== "slot-occupied") {
        return {
          status: "stopped",
          outcome: this.#publishFailed(entry, written),
          failure: written.reason,
        };
      }
      // Journaling the squatted slot moves this identity's next sequence past it.
      this.#storeFailure({
        phase: written.phase,
        reason: "slot-occupied",
        instanceId: entry.origin.instanceId,
        sequence: entry.origin.sequence,
      });
    }
    return {
      status: "stopped",
      outcome: { kind: "store-failed", message: SQUATTED_SLOTS_MESSAGE },
      failure: "slots-squatted",
    };
  }

  async #finishPending(
    store: ReplicaStore,
    command: LocalCommand,
  ): Promise<ReplicaMembershipOutcome | undefined> {
    const state = this.#ports.state();
    const entry = state.pending;
    // The projection drops a finished identity's stopped publish.
    if (entry === undefined || state.local === undefined) return undefined;
    const encoded = encoder.encode(encodeReplicaEntry(entry));
    const signature = await this.#sign(entry, encoded);
    if (signature === undefined) {
      return this.#refuse(command, "key-unavailable", "The entry could not be signed.");
    }
    const written = await writeSigned(store, entry, encoded, signature);
    if (written.status === "published") {
      this.#holdPublished(entry, encoded, signature);
      return undefined;
    }
    if (written.reason === "slot-occupied") {
      // Someone else's bytes took the slot: the stopped publish is dropped and
      // the slot skipped, and this command decides afresh.
      this.#storeFailure({
        phase: written.phase,
        reason: "slot-occupied",
        instanceId: entry.origin.instanceId,
        sequence: entry.origin.sequence,
      });
      return undefined;
    }
    return this.#publishFailed(entry, written);
  }

  async #sign(entry: ReplicaEntry, encoded: Uint8Array): Promise<string | undefined> {
    try {
      const signed = await this.#ports.credentials.sign(entry.origin.instanceId, encoded);
      return signed.status === "signed" ? signed.signature : undefined;
    } catch {
      return undefined;
    }
  }

  async #newKey(): Promise<
    { readonly instanceId: ReplicaInstanceId; readonly publicKey: string } | undefined
  > {
    try {
      const key = await this.#ports.credentials.create();
      return { instanceId: decodeInstanceId(key.instanceId), publicKey: key.publicKey };
    } catch {
      return undefined;
    }
  }

  #publishFailed(
    entry: ReplicaEntry,
    failure: Extract<WriteResult, { status: "failed" }>,
  ): ReplicaMembershipOutcome {
    this.#storeFailure({
      phase: failure.phase,
      reason: failure.reason,
      instanceId: entry.origin.instanceId,
      sequence: entry.origin.sequence,
    });
    return {
      kind: "store-failed",
      message:
        failure.phase === "signature"
          ? "The replica store did not take the signature."
          : "The replica store did not take the entry.",
    };
  }

  #holdPublished(entry: ReplicaMembershipEntry, encoded: Uint8Array, signature: string): void {
    this.#journalHeld(entry, encoded, decoder.decode(encoded), signature);
  }

  #hold(read: Extract<SignedRead, { status: "ready" }>): void {
    if (!isReplicaMembershipEntry(read.entry)) return;
    this.#journalHeld(read.entry, read.bytes, read.text, read.signature);
  }

  #journalHeld(
    entry: ReplicaMembershipEntry,
    bytes: Uint8Array,
    text: string,
    signature: string,
  ): void {
    const hash = sha256Hex(bytes);
    if (
      this.#ports
        .state()
        .records.some(
          (record) =>
            record.hash === hash &&
            String(record.entry.origin.instanceId) === String(entry.origin.instanceId) &&
            record.entry.origin.sequence === entry.origin.sequence,
        )
    ) {
      return;
    }
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.recordHeld, {
      instanceId: entry.origin.instanceId,
      sequence: entry.origin.sequence,
      hash,
      text,
      signature,
    });
  }

  #unreadable(refusal: {
    readonly instanceId: ReplicaInstanceId;
    readonly sequence: number;
    readonly reason: "bad-signature" | "path-mismatch" | "unreadable";
  }): ReplicaReadRefusal {
    // Journaled once. A later pull meets the same file again until it
    // changes, and repeating the record would say nothing new.
    if (!this.#ports.state().unreadableRecorded(refusal)) {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.entryUnreadable, refusal);
    }
    return refusal;
  }

  #storeFailure(input: {
    readonly phase: "entry" | "signature" | "read" | "list";
    readonly reason: "not-connected" | "refused" | "slot-occupied" | "truncated";
    readonly instanceId?: ReplicaInstanceId;
    readonly sequence?: number;
  }): void {
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure, input);
  }

  #journal(eventName: string, payload: unknown): void {
    this.#ports.journal.append({ eventName, payload });
  }

  #refuse(
    command: ReplicaMembershipCommand["kind"] | "publish-artifact",
    reason: RefusalReason,
    message: string,
    subject?: ReplicaInstanceId,
  ): ReplicaMembershipOutcome {
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.commandRefused, {
      command,
      reason,
      ...(subject === undefined ? {} : { subject }),
    });
    return { kind: "refused", reason, message };
  }
}

/** A command that publishes under this host's established identity. */
type LocalCommand = "approve-join" | "confirm-join" | "revoke" | "publish-artifact";

const SQUATTED_SLOTS_MESSAGE =
  "The replica store holds files this computer did not write in its next slots. Remove them with the storage provider's tools, rotate the store credentials, or move to a new store.";

type SignedRead =
  | {
      readonly status: "ready";
      readonly entry: ReplicaEntry;
      readonly bytes: Uint8Array;
      readonly text: string;
      readonly signature: string;
    }
  | { readonly status: "missing" }
  | { readonly status: "unreadable" }
  | { readonly status: "path-mismatch" }
  | { readonly status: "bad-signature" }
  | { readonly status: "unavailable" };

function originFor(
  local: ReplicaLocalIdentity,
  sequence: number,
): ReplicaMembershipEntry["origin"] {
  return {
    instanceId: local.instanceId,
    displayName: local.displayName,
    sequence,
    publicKey: local.publicKey,
  };
}

/**
 * The computers `subject` brought in that are not revoked yet, for the revoke
 * screen to list and offer to revoke in the same step.
 */
function broughtIn(
  state: ReplicaMembershipState,
  subject: ReplicaInstanceId,
): ReadonlyArray<ReplicaBroughtIn> {
  return replicaDescendants(state.membership, subject).flatMap((node) =>
    node.cut !== undefined || node.parent === undefined || node.approvalSequence === undefined
      ? []
      : [
          {
            instanceId: node.instanceId,
            displayName: node.displayName,
            parent: node.parent,
            approvalSequence: node.approvalSequence,
          },
        ],
  );
}

function same(left: ReplicaInstanceId, right: ReplicaInstanceId): boolean {
  return String(left) === String(right);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * An Ed25519 signature is 64 bytes, and only its padded standard base64 is a
 * signature file. Node's decoder skips whitespace and stray characters, so a
 * looser check would accept many texts for one signature.
 */
function isCanonicalSignatureText(text: string): boolean {
  const bytes = Buffer.from(text, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === text;
}

async function readStore(store: ReplicaStore, key: string): Promise<ReadResult> {
  const read = await store.get(key);
  if (read.status === "ready") return { status: "ready", bytes: read.bytes };
  if (read.status === "missing") return { status: "missing" };
  return { status: "unavailable", reason: read.status };
}

/**
 * Write the signature, then the entry, each write-once. The signature goes in
 * first, so a reader that finds an entry finds its signature beside it. A key
 * that already holds exactly these bytes is this same publish finished
 * earlier, not a conflict.
 */
async function writeSigned(
  store: ReplicaStore,
  entry: ReplicaEntry,
  encoded: Uint8Array,
  signature: string,
): Promise<WriteResult> {
  const paths = replicaEntryRelativePaths(entry.origin.instanceId, entry.origin.sequence);
  const signatureWrite = await putOnce(store, paths.signature, encoder.encode(signature));
  if (signatureWrite !== "stored") {
    return { status: "failed", phase: "signature", reason: signatureWrite };
  }
  const entryWrite = await putOnce(store, paths.entry, encoded);
  if (entryWrite !== "stored") return { status: "failed", phase: "entry", reason: entryWrite };
  return { status: "published", signature };
}

async function putOnce(
  store: ReplicaStore,
  key: string,
  bytes: Uint8Array,
): Promise<"stored" | "not-connected" | "refused" | "slot-occupied"> {
  const put = await store.putIfAbsent(key, bytes);
  if (put.status === "stored") return "stored";
  if (put.status === "not-connected" || put.status === "refused") return put.status;
  const existing = await readStore(store, key);
  if (existing.status === "unavailable") return existing.reason;
  if (existing.status === "ready" && sameBytes(existing.bytes, bytes)) return "stored";
  return "slot-occupied";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
