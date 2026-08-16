import {
  createHash,
  randomBytes as defaultRandomBytes,
  randomUUID as defaultRandomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  REMOTE_ACCESS_EVENT_NAMES,
  decodeDeviceRegistrationV1,
  decodePairingDecisionV1,
  decodePairingRequestV1,
  decodePairingTicketV1,
  type DeviceId,
  type DeviceRegistrationV1,
  type PairingDecisionV1,
  type PairingRequestV1,
  type PairingStatusResultV1,
  type PairingTicketId,
  type PairingTicketV1,
  type StableHostId,
} from "@octant/contracts/remote-access";
import {
  DEVICE_ABSOLUTE_TTL_MS,
  DEVICE_INACTIVITY_TTL_MS,
  evaluatePairingClaim,
  nextDeviceExpiry,
  normalizeDeviceLabel,
  PAIRING_TICKET_TTL_MS,
} from "@octant/domain/remote-access-policy";
import {
  evaluatePairingStatus,
  MAX_LIVE_PAIRING_TICKETS,
  MAX_UNDECIDED_PAIRING_CLAIMS,
  buildClientHelloTranscriptPayload,
} from "@octant/domain/remote-protocol-policy";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { readDeviceRegistrations } from "../persistence/remoteAccessProjection";
import { canonicalDeviceKeyFacts, deviceKeyFingerprintMatches } from "./deviceKeyFacts";
import {
  derivePairingComparisonCode,
  sanitizeClaimRecord,
  sha256DigestHex,
  type RetainedClaimFacts,
} from "./pairingClaimRecord";

export type RandomBytes = (size: number) => Uint8Array;

export class PairingDeviceLifecycleError extends Error {
  readonly category: "invalid" | "unauthorized" | "unavailable";

  constructor(category: PairingDeviceLifecycleError["category"], message: string) {
    super(message);
    this.name = "PairingDeviceLifecycleError";
    this.category = category;
  }
}

type SourceClass = PairingTicketV1["sourceClass"];

interface TicketRecord {
  readonly ticketId: PairingTicketId;
  readonly hostId: StableHostId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly sourceClass: SourceClass;
  readonly proofDigest: Buffer;
  state: PairingTicketV1["state"];
  claimState: "unclaimed" | "claimed";
  failedAttempts: number;
  claim?: RetainedClaimFacts;
  decision?: PairingDecisionV1;
  deviceId?: DeviceId;
}

export interface PairingDeviceLifecycleServiceOptions {
  readonly hostId: StableHostId;
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly now?: () => number;
  readonly randomBytes?: RandomBytes;
  readonly uuid?: () => string;
  readonly correlationId?: () => string;
  readonly actorId?: () => string;
}

export interface CreatePairingTicketInput {
  readonly sourceClass: SourceClass;
}

export interface CreatePairingTicketResult {
  readonly ticketId: PairingTicketId;
  readonly ticketProof: string;
  readonly expiresAt: number;
  readonly sourceClass: SourceClass;
}

export interface PairingClaimResult {
  readonly kind: "pending";
  readonly ticketId: PairingTicketId;
  readonly hostId: StableHostId;
  readonly deviceLabel: string;
  readonly deviceKeyFingerprint: string;
  readonly origin: string;
  readonly sourceClass: SourceClass;
  readonly comparisonCode: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export interface ApprovePairingTicketInput {
  readonly ticketId: string;
}

export interface DenyPairingTicketInput {
  readonly ticketId: string;
  readonly reasonCode: string;
}

export interface RenameDeviceInput {
  readonly deviceId: string;
  readonly deviceLabel: string;
}

export class PairingDeviceLifecycleService {
  readonly #hostId: StableHostId;
  readonly #journal: Journal;
  readonly #connection: SqliteConnection;
  readonly #now: () => number;
  readonly #randomBytes: RandomBytes;
  readonly #uuid: () => string;
  readonly #correlationId: () => string;
  readonly #actorId: () => string;
  readonly #tickets = new Map<string, TicketRecord>();
  readonly #selectAggregateHead;

  constructor(options: PairingDeviceLifecycleServiceOptions) {
    this.#hostId = options.hostId;
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#now = options.now ?? (() => Date.now());
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#uuid = options.uuid ?? defaultRandomUUID;
    this.#correlationId = options.correlationId ?? defaultRandomUUID;
    this.#actorId = options.actorId ?? defaultRandomUUID;
    this.#selectAggregateHead = options.connection.prepare(
      `SELECT aggregate_version
       FROM aggregate_heads
       WHERE aggregate_type = ? AND aggregate_id = ?`,
    );
  }

  createTicket(input: CreatePairingTicketInput): CreatePairingTicketResult {
    if (!isSourceClass(input.sourceClass) || input.sourceClass === "unknown") {
      throw new PairingDeviceLifecycleError("invalid", "Pairing source class is invalid.");
    }
    if ("ttlMs" in (input as object)) {
      throw new PairingDeviceLifecycleError("invalid", "Pairing ticket TTL is invalid.");
    }
    const now = this.#now();
    this.#purgeExpired(now);
    if (this.#tickets.size >= MAX_LIVE_PAIRING_TICKETS) {
      throw new PairingDeviceLifecycleError("unavailable", "Pairing ticket is unavailable.");
    }
    const ticketId = this.#uuid() as PairingTicketId;
    const ticketProof = Buffer.from(this.#randomBytes(32)).toString("base64url");
    const expiresAt = now + PAIRING_TICKET_TTL_MS;
    const ticket = decodePairingTicketV1({
      ticketId,
      hostId: this.#hostId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      failedAttempts: 0,
      state: "pending",
      sourceClass: input.sourceClass,
    });
    this.#tickets.set(ticket.ticketId, {
      ticketId: ticket.ticketId,
      hostId: ticket.hostId,
      createdAt: now,
      expiresAt,
      sourceClass: ticket.sourceClass,
      proofDigest: digestProof(ticketProof),
      state: "pending",
      claimState: "unclaimed",
      failedAttempts: 0,
    });
    return {
      ticketId: ticket.ticketId,
      ticketProof,
      expiresAt,
      sourceClass: ticket.sourceClass,
    };
  }

  claimTicket(input: unknown, nowOverride?: number): PairingClaimResult {
    const now = nowOverride ?? this.#now();
    this.#purgeExpired(now);
    if (typeof input !== "object" || input === null) {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    const raw = input as Record<string, unknown>;
    if ("sourceClass" in raw) {
      // source class is server/transport-owned; client-supplied values are rejected.
      const supplied = raw.sourceClass;
      if (!isSourceClass(supplied) || supplied === "unknown") {
        throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
      }
    }
    const { sourceClass: _ignored, ...requestInput } = raw;
    let request: PairingRequestV1;
    try {
      request = decodePairingRequestV1(requestInput);
    } catch {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    const label = normalizeDeviceLabel(request.deviceLabel);
    if (label.kind === "rejected") {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    const keyFacts = canonicalDeviceKeyFacts(request.devicePublicKey);
    if (
      keyFacts === undefined ||
      !deviceKeyFingerprintMatches(request.deviceKeyFingerprint, keyFacts)
    ) {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    const record = this.#tickets.get(request.ticketId);
    if (record === undefined || record.hostId !== this.#hostId) {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    if ("sourceClass" in raw && raw.sourceClass !== record.sourceClass) {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    const decision = evaluatePairingClaim({
      state: record.state,
      claimState: record.claimState,
      attempts: record.failedAttempts,
      now,
      expiresAt: record.expiresAt,
      proofMatches: proofMatches(record.proofDigest, request.ticketProof),
    });
    if (decision.kind === "rejected") {
      if (decision.attempts !== undefined) {
        record.failedAttempts = decision.attempts;
      }
      if (decision.reason === "expired" || decision.reason === "attempt-limit") {
        record.state = "expired";
        this.#tickets.delete(record.ticketId);
      }
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    let undecidedClaims = 0;
    for (const ticket of this.#tickets.values()) {
      if (ticket.claimState === "claimed" && ticket.state === "pending") {
        undecidedClaims += 1;
      }
    }
    if (undecidedClaims >= MAX_UNDECIDED_PAIRING_CLAIMS) {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing claim is invalid.");
    }
    const claim = sanitizeClaimRecord({
      devicePublicKey: keyFacts.canonicalPem,
      deviceKeyFingerprint: request.deviceKeyFingerprint,
      deviceLabel: label.deviceLabel,
      origin: request.origin,
      clientHelloDigest: sha256DigestHex(buildClientHelloTranscriptPayload(request.clientHello)),
      hostHelloNonceDigest: sha256DigestHex(request.hostHelloNonce),
      claimedAt: now,
    });
    const comparisonCode = derivePairingComparisonCode({
      hostId: this.#hostId,
      ticketId: record.ticketId,
      sourceClass: record.sourceClass,
      ticketProofDigest: record.proofDigest.toString("hex"),
      claim,
    });
    record.claimState = "claimed";
    record.claim = claim;
    return {
      kind: "pending",
      ticketId: record.ticketId,
      hostId: this.#hostId,
      deviceLabel: label.deviceLabel,
      deviceKeyFingerprint: request.deviceKeyFingerprint,
      origin: request.origin,
      sourceClass: record.sourceClass,
      comparisonCode,
      claimedAt: new Date(now).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  deriveComparisonCode(ticketId: string): string | undefined {
    const record = this.#tickets.get(ticketId);
    if (record === undefined || record.hostId !== this.#hostId || record.claim === undefined) {
      return undefined;
    }
    return derivePairingComparisonCode({
      hostId: this.#hostId,
      ticketId: record.ticketId,
      sourceClass: record.sourceClass,
      ticketProofDigest: record.proofDigest.toString("hex"),
      claim: record.claim,
    });
  }

  /**
   * Returns only the bounded, non-secret facts needed by the local approval
   * surface. Ticket proofs, public-key material, and raw hello values remain
   * private to the in-memory ticket record.
   */
  listPendingClaims(): ReadonlyArray<PairingClaimResult> {
    const now = this.#now();
    this.#purgeExpired(now);
    return [...this.#tickets.values()]
      .filter(
        (record) =>
          record.state === "pending" &&
          record.claimState === "claimed" &&
          record.claim !== undefined,
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => {
        const claim = record.claim!;
        return {
          kind: "pending" as const,
          ticketId: record.ticketId,
          hostId: record.hostId,
          deviceLabel: claim.deviceLabel,
          deviceKeyFingerprint: claim.deviceKeyFingerprint,
          origin: claim.origin,
          sourceClass: record.sourceClass,
          comparisonCode: derivePairingComparisonCode({
            hostId: this.#hostId,
            ticketId: record.ticketId,
            sourceClass: record.sourceClass,
            ticketProofDigest: record.proofDigest.toString("hex"),
            claim,
          }),
          claimedAt: new Date(claim.claimedAt).toISOString(),
          expiresAt: new Date(record.expiresAt).toISOString(),
        };
      });
  }

  ticketStatus(input: {
    readonly ticketId: string;
    readonly ticketProof: string;
  }): PairingStatusResultV1 {
    const now = this.#now();
    this.#purgeExpired(now);
    const record = this.#tickets.get(input.ticketId);
    if (record === undefined || record.hostId !== this.#hostId) {
      return { status: "failed" };
    }
    const decision = evaluatePairingStatus({
      state: record.state,
      attempts: record.failedAttempts,
      now,
      expiresAt: record.expiresAt,
      proofMatches: proofMatches(record.proofDigest, input.ticketProof),
    });
    if (decision.kind === "pending") return { status: "pending" };
    if (decision.kind === "failed") {
      if (decision.attempts !== undefined) {
        record.failedAttempts = decision.attempts;
      }
      if (decision.exhausted === true) {
        record.state = "expired";
        this.#tickets.delete(record.ticketId);
      }
      return { status: "failed" };
    }
    if (record.deviceId === undefined) return { status: "failed" };
    const device = this.#readDevice(record.deviceId);
    if (device === undefined) return { status: "failed" };
    return {
      status: "approved",
      deviceId: device.deviceId,
      credentialGeneration: device.credentialGeneration,
    };
  }

  approveTicket(input: ApprovePairingTicketInput): {
    readonly decision: PairingDecisionV1;
    readonly device: DeviceRegistrationV1;
  } {
    const now = this.#now();
    this.#purgeExpired(now);
    const existing = this.#tickets.get(input.ticketId);
    if (existing?.state === "approved" && existing.decision !== undefined && existing.deviceId) {
      const device = this.#readDevice(existing.deviceId);
      if (device === undefined) {
        throw new PairingDeviceLifecycleError("unavailable", "Pairing ticket is unavailable.");
      }
      return { decision: existing.decision, device };
    }
    const record = this.#requireClaimedPending(input.ticketId, now);
    if (record.decision?.decision === "denied") {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing ticket is unavailable.");
    }
    const claim = record.claim!;
    const deviceId = this.#uuid() as DeviceId;
    const createdAt = now;
    const expiresAt = nextDeviceExpiry({ createdAt, lastSeenAt: createdAt });
    const device = decodeDeviceRegistrationV1({
      hostId: this.#hostId,
      deviceId,
      deviceKeyFingerprint: claim.deviceKeyFingerprint,
      devicePublicKey: claim.devicePublicKey,
      deviceLabel: claim.deviceLabel,
      origin: claim.origin,
      protocolFloor: 1,
      credentialGeneration: 1,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      lastSeenAt: new Date(createdAt).toISOString(),
      state: "active",
    });
    const decision = decodePairingDecisionV1({
      ticketId: record.ticketId,
      hostId: this.#hostId,
      decision: "approved",
      decidedAt: new Date(now).toISOString(),
      reasonCode: "user-approved",
    });
    const correlationId = this.#correlationId();
    this.#journal.append({
      aggregate: { aggregateType: "remote-device", aggregateId: device.deviceId },
      expectedVersion: this.#aggregateVersion("remote-device", device.deviceId),
      events: [
        {
          eventId: this.#uuid(),
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceRegistered,
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId: this.#actorId() },
          occurredAt: new Date(now).toISOString(),
          payload: { device },
        },
        {
          eventId: this.#uuid(),
          eventName: REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded,
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId: this.#actorId() },
          occurredAt: new Date(now).toISOString(),
          payload: {
            record: {
              eventKind: "device-approved",
              hostId: this.#hostId,
              deviceId: device.deviceId,
              protocolVersion: 1,
              credentialGeneration: 1,
              sourceClass: record.sourceClass,
              resultCategory: "approved",
              reasonCode: "user-approved",
              correlationId,
              occurredAt: new Date(now).toISOString(),
            },
          },
        },
      ],
    });
    record.state = "approved";
    record.decision = decision;
    record.deviceId = device.deviceId;
    // The comparison code is no longer derivable after a decision; the claim
    // is cleared so deriveComparisonCode returns undefined. Same-decision
    // idempotency survives from decision/deviceId, not the retained claim.
    delete record.claim;
    return { decision, device };
  }

  denyTicket(input: DenyPairingTicketInput): PairingDecisionV1 {
    const now = this.#now();
    this.#purgeExpired(now);
    const existing = this.#tickets.get(input.ticketId);
    if (existing?.state === "denied" && existing.decision !== undefined) {
      const reason = normalizeReasonCode(input.reasonCode);
      if (reason === undefined || reason !== existing.decision.reasonCode) {
        throw new PairingDeviceLifecycleError("unauthorized", "Pairing ticket is unavailable.");
      }
      return existing.decision;
    }
    if (existing?.state === "approved") {
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing ticket is unavailable.");
    }
    const record = this.#requireClaimedPending(input.ticketId, now);
    const reason = normalizeReasonCode(input.reasonCode);
    if (reason === undefined) {
      throw new PairingDeviceLifecycleError("invalid", "Pairing denial reason is invalid.");
    }
    const decision = decodePairingDecisionV1({
      ticketId: record.ticketId,
      hostId: this.#hostId,
      decision: "denied",
      decidedAt: new Date(now).toISOString(),
      reasonCode: reason,
    });
    const correlationId = this.#correlationId();
    this.#journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: this.#hostId },
      expectedVersion: this.#aggregateVersion("remote-host", this.#hostId),
      events: [
        {
          eventId: this.#uuid(),
          eventName: REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded,
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId: this.#actorId() },
          occurredAt: new Date(now).toISOString(),
          payload: {
            record: {
              eventKind: "device-denied",
              hostId: this.#hostId,
              protocolVersion: 1,
              credentialGeneration: 1,
              sourceClass: record.sourceClass,
              resultCategory: "denied",
              reasonCode: reason,
              correlationId,
              occurredAt: new Date(now).toISOString(),
            },
          },
        },
      ],
    });
    record.state = "denied";
    record.decision = decision;
    // The comparison code is no longer derivable after a decision; the claim
    // is cleared so deriveComparisonCode returns undefined. Same-decision
    // idempotency survives from decision, not the retained claim.
    delete record.claim;
    return decision;
  }

  renameDevice(input: RenameDeviceInput): DeviceRegistrationV1 {
    const label = normalizeDeviceLabel(input.deviceLabel);
    if (label.kind === "rejected") {
      throw new PairingDeviceLifecycleError("invalid", "Device label is invalid.");
    }
    const current = this.#readDevice(input.deviceId);
    if (current === undefined || current.hostId !== this.#hostId) {
      throw new PairingDeviceLifecycleError("invalid", "Device is unknown.");
    }
    if (current.state !== "active") {
      throw new PairingDeviceLifecycleError("invalid", "Device is not active.");
    }
    const now = this.#now();
    const renamed = decodeDeviceRegistrationV1({
      hostId: current.hostId,
      deviceId: current.deviceId,
      deviceKeyFingerprint: current.deviceKeyFingerprint,
      devicePublicKey: current.devicePublicKey,
      deviceLabel: label.deviceLabel,
      origin: current.origin,
      protocolFloor: current.protocolFloor,
      credentialGeneration: current.credentialGeneration,
      createdAt: current.createdAt,
      expiresAt: current.expiresAt,
      lastSeenAt: current.lastSeenAt,
      state: current.state,
    });
    this.#journal.append({
      aggregate: { aggregateType: "remote-device", aggregateId: current.deviceId },
      expectedVersion: this.#aggregateVersion("remote-device", current.deviceId),
      events: [
        {
          eventId: this.#uuid(),
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceRegistered,
          eventVersion: 1,
          correlationId: this.#correlationId(),
          actor: { kind: "system", actorId: this.#actorId() },
          occurredAt: new Date(now).toISOString(),
          payload: { device: renamed },
        },
      ],
    });
    return renamed;
  }

  listDevices(): ReadonlyArray<DeviceRegistrationV1> {
    return readDeviceRegistrations(this.#connection).map((row) =>
      decodeDeviceRegistrationV1({
        hostId: row.host_id,
        deviceId: row.device_id,
        deviceKeyFingerprint: row.device_key_fingerprint,
        devicePublicKey: row.device_public_key,
        deviceLabel: row.device_label,
        origin: row.origin,
        protocolFloor: row.protocol_floor,
        credentialGeneration: row.credential_generation,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
        state: row.state,
        ...(row.revoked_at === null || row.revoked_at === undefined
          ? {}
          : { revokedAt: row.revoked_at }),
        ...(row.revoked_reason === null || row.revoked_reason === undefined
          ? {}
          : { revokedReason: row.revoked_reason }),
      }),
    );
  }

  clearEphemeralState(): void {
    this.#tickets.clear();
  }

  #requireClaimedPending(ticketId: string, now: number): TicketRecord {
    const record = this.#tickets.get(ticketId);
    if (
      record === undefined ||
      record.hostId !== this.#hostId ||
      record.state !== "pending" ||
      record.claimState !== "claimed" ||
      record.claim === undefined ||
      now >= record.expiresAt
    ) {
      if (record !== undefined && now >= record.expiresAt) {
        record.state = "expired";
        this.#tickets.delete(record.ticketId);
      }
      throw new PairingDeviceLifecycleError("unauthorized", "Pairing ticket is unavailable.");
    }
    return record;
  }

  #readDevice(deviceId: string): DeviceRegistrationV1 | undefined {
    return this.listDevices().find((device) => device.deviceId === deviceId);
  }

  #aggregateVersion(aggregateType: string, aggregateId: string): number {
    const row = this.#selectAggregateHead.get(aggregateType, aggregateId) as
      | { readonly aggregate_version: number }
      | undefined;
    return row?.aggregate_version ?? 0;
  }

  #purgeExpired(now: number): void {
    for (const [ticketId, record] of this.#tickets) {
      if (now >= record.expiresAt) {
        if (record.state === "pending") {
          record.state = "expired";
        }
        this.#tickets.delete(ticketId);
      }
    }
  }
}

function digestProof(proof: string): Buffer {
  return createHash("sha256").update(proof, "utf8").digest();
}

function proofMatches(expectedDigest: Buffer, candidate: string): boolean {
  const actual = digestProof(candidate);
  return actual.length === expectedDigest.length && timingSafeEqual(actual, expectedDigest);
}

function isSourceClass(value: unknown): value is SourceClass {
  return (
    value === "loopback" || value === "lan-private" || value === "tailscale" || value === "unknown"
  );
}

function normalizeReasonCode(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmed) || trimmed.length > 128) return undefined;
  return trimmed;
}

export const PAIRING_DEVICE_LIFECYCLE_CONSTANTS = {
  ticketTtlMs: PAIRING_TICKET_TTL_MS,
  deviceAbsoluteTtlMs: DEVICE_ABSOLUTE_TTL_MS,
  deviceInactivityTtlMs: DEVICE_INACTIVITY_TTL_MS,
} as const;
