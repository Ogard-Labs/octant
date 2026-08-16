import {
  createHash,
  randomBytes as defaultRandomBytes,
  randomUUID as defaultRandomUUID,
} from "node:crypto";
import {
  decodeHostHelloV1,
  decodeNegotiatedProtocolV1,
  decodeNegotiationRequestV1,
  decodePairingRequestV1,
  decodePairingStatusRequestV1,
  REMOTE_ACCESS_EVENT_NAMES,
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR,
  REMOTE_AUTHENTICATION_PROTOCOL_VERSION,
  REMOTE_SECURITY_FLOOR,
  type DeviceId,
  type HostHelloV1,
  type NegotiatedProtocolV1,
  type PairingStatusResultV1,
  type PairingTicketV1,
  type ProtocolRange,
  type StableHostId,
} from "@octant/contracts/remote-access";
import {
  negotiateRemoteProtocol,
  REMOTE_DEVICE_SECURITY_FLOOR,
} from "@octant/domain/remote-access-policy";
import {
  buildHostHelloSignaturePayload,
  buildNegotiatedProtocolPayload,
  HOST_HELLO_NONCE_TTL_MS,
  MAX_HOST_HELLO_NONCES,
  MAX_PENDING_NEGOTIATIONS,
  selectAuthenticationProtocolVersion,
} from "@octant/domain/remote-protocol-policy";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { readDeviceRegistration } from "../persistence/remoteAccessProjection";
import {
  PairingDeviceLifecycleError,
  PairingDeviceLifecycleService,
  type PairingClaimResult,
  type RandomBytes,
} from "./pairingDeviceLifecycleService";

export const REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST = createHash("sha256")
  .update(REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR, "utf8")
  .digest("hex");

/**
 * Server-owned host-signing port. The desktop Keychain broker implements it;
 * the server never imports desktop code and never receives a private key.
 */
export interface HostSigningPort {
  readonly hostKeyFingerprint: string;
  signHostPayload(payload: string): string;
}

export type RemoteSourceClass = PairingTicketV1["sourceClass"];

export class RemoteProtocolError extends Error {
  readonly category: "invalid" | "unauthorized" | "unavailable";
  readonly reasonCode: "expired" | "revoked" | undefined;

  constructor(
    category: RemoteProtocolError["category"],
    message: string,
    reasonCode?: "expired" | "revoked",
  ) {
    super(message);
    this.name = "RemoteProtocolError";
    this.category = category;
    this.reasonCode = reasonCode;
  }
}

export interface RemoteProtocolServiceOptions {
  readonly hostId: StableHostId;
  readonly displayName: string;
  readonly serverBuildVersion: string;
  readonly remoteOrigin: string;
  readonly supportedProtocolRange: ProtocolRange;
  readonly securityFloor: number;
  readonly authenticationProtocolVersions?: ReadonlyArray<number>;
  readonly signing: HostSigningPort;
  readonly lifecycle: PairingDeviceLifecycleService;
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly now?: () => number;
  readonly randomBytes?: RandomBytes;
  readonly uuid?: () => string;
  readonly correlationId?: () => string;
  readonly actorId?: () => string;
}

interface NonceRecord {
  readonly expiresAt: number;
}

interface NegotiationRecord {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly origin: string;
  readonly protocolVersion: number;
  readonly authenticationVersion: number;
  readonly capabilityDigest: string;
  readonly expiresAt: number;
}

interface ChallengeRow {
  readonly host_id: string;
  readonly device_id: string;
  readonly credential_generation: number;
  readonly expires_at: number;
  readonly consumed: number;
}

export class RemoteProtocolService {
  readonly #hostId: StableHostId;
  readonly #displayName: string;
  readonly #serverBuildVersion: string;
  readonly #remoteOrigin: string;
  readonly #supportedProtocolRange: ProtocolRange;
  readonly #securityFloor: number;
  readonly #authenticationProtocolVersions: ReadonlyArray<number>;
  readonly #signing: HostSigningPort;
  readonly #lifecycle: PairingDeviceLifecycleService;
  readonly #journal: Journal;
  readonly #connection: SqliteConnection;
  readonly #now: () => number;
  readonly #randomBytes: RandomBytes;
  readonly #uuid: () => string;
  readonly #correlationId: () => string;
  readonly #actorId: () => string;
  readonly #nonces = new Map<string, NonceRecord>();
  readonly #negotiations = new Map<string, NegotiationRecord>();
  readonly #selectChallenge;
  readonly #selectAggregateHead;

  constructor(options: RemoteProtocolServiceOptions) {
    this.#hostId = options.hostId;
    this.#displayName = options.displayName;
    this.#serverBuildVersion = options.serverBuildVersion;
    this.#remoteOrigin = options.remoteOrigin;
    this.#supportedProtocolRange = options.supportedProtocolRange;
    this.#securityFloor = options.securityFloor;
    this.#authenticationProtocolVersions = options.authenticationProtocolVersions ?? [
      REMOTE_AUTHENTICATION_PROTOCOL_VERSION,
    ];
    this.#signing = options.signing;
    this.#lifecycle = options.lifecycle;
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#now = options.now ?? (() => Date.now());
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#uuid = options.uuid ?? defaultRandomUUID;
    this.#correlationId = options.correlationId ?? defaultRandomUUID;
    this.#actorId = options.actorId ?? defaultRandomUUID;
    if (
      !isCoherentProtocolRange(this.#supportedProtocolRange) ||
      !isPositiveSafeInteger(this.#securityFloor) ||
      this.#securityFloor < REMOTE_SECURITY_FLOOR ||
      this.#securityFloor > this.#supportedProtocolRange.max ||
      this.#securityFloor < this.#supportedProtocolRange.min ||
      !areValidAuthenticationVersions(this.#authenticationProtocolVersions) ||
      !isHttpsOrigin(this.#remoteOrigin)
    ) {
      throw new RemoteProtocolError("invalid", "Remote protocol request is invalid.");
    }
    this.#selectChallenge = options.connection.prepare(
      `SELECT host_id, device_id, credential_generation, expires_at, consumed
       FROM remote_auth_challenge_store
       WHERE challenge_id_digest = ?`,
    );
    this.#selectAggregateHead = options.connection.prepare(
      `SELECT aggregate_version
       FROM aggregate_heads
       WHERE aggregate_type = ? AND aggregate_id = ?`,
    );
  }

  issueHostHello(): HostHelloV1 {
    const now = this.#now();
    this.#purgeNonces(now);
    if (this.#nonces.size >= MAX_HOST_HELLO_NONCES) {
      throw new RemoteProtocolError("unavailable", "Remote protocol request is unavailable.");
    }
    const nonce = Buffer.from(this.#randomBytes(32)).toString("base64url");
    const expiresAt = now + HOST_HELLO_NONCE_TTL_MS;
    this.#nonces.set(digest(nonce), { expiresAt });
    const unsigned = {
      productId: "octant" as const,
      hostId: this.#hostId,
      displayName: this.#displayName,
      hostKeyFingerprint: this.#signing.hostKeyFingerprint,
      serverBuildVersion: this.#serverBuildVersion,
      supportedProtocolRange: this.#supportedProtocolRange,
      authenticationProtocolVersions: [...this.#authenticationProtocolVersions],
      securityFloor: this.#securityFloor,
      remoteOrigin: this.#remoteOrigin,
      nonce,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const signature = this.#signing.signHostPayload(buildHostHelloSignaturePayload(unsigned));
    return decodeHostHelloV1({ ...unsigned, signature });
  }

  claimPairing(input: {
    readonly sourceClass: RemoteSourceClass;
    readonly request: unknown;
  }): PairingClaimResult {
    this.#requireTrustedSourceClass(input.sourceClass);
    let request;
    try {
      request = decodePairingRequestV1(input.request);
    } catch {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    this.#consumeNonce(request.hostHelloNonce);
    if (request.origin !== this.#remoteOrigin) {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    try {
      return this.#lifecycle.claimTicket({ ...request, sourceClass: input.sourceClass });
    } catch (error) {
      if (error instanceof PairingDeviceLifecycleError) {
        throw new RemoteProtocolError(
          error.category,
          error.category === "unavailable"
            ? "Remote protocol request is unavailable."
            : "Remote protocol request is unauthorized.",
        );
      }
      throw error;
    }
  }

  pairingStatus(input: unknown): PairingStatusResultV1 {
    let request;
    try {
      request = decodePairingStatusRequestV1(input);
    } catch {
      return { status: "failed" };
    }
    return this.#lifecycle.ticketStatus(request);
  }

  negotiate(input: {
    readonly sourceClass: RemoteSourceClass;
    readonly request: unknown;
  }): NegotiatedProtocolV1 {
    this.#requireTrustedSourceClass(input.sourceClass);
    let request;
    try {
      request = decodeNegotiationRequestV1(input.request);
    } catch {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    const now = this.#now();
    this.#consumeNonce(request.hostHelloNonce);
    if (request.origin !== this.#remoteOrigin) {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    const challenge = this.#selectChallenge.get(digest(request.challengeId)) as
      | ChallengeRow
      | undefined;
    if (
      challenge === undefined ||
      challenge.consumed !== 0 ||
      now >= challenge.expires_at ||
      challenge.host_id !== this.#hostId ||
      challenge.device_id !== request.deviceId
    ) {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    const device = readDeviceRegistration(this.#connection, request.deviceId);
    if (
      device === undefined ||
      device.hostId !== this.#hostId ||
      device.state !== "active" ||
      device.origin !== request.origin ||
      device.credentialGeneration !== challenge.credential_generation
    ) {
      throw new RemoteProtocolError(
        "unauthorized",
        "Remote protocol request is unauthorized.",
        device?.hostId === this.#hostId && device.origin === request.origin
          ? device.state === "expired"
            ? "expired"
            : device.state === "revoked"
              ? "revoked"
              : undefined
          : undefined,
      );
    }
    const selected = negotiateRemoteProtocol({
      server: { ...this.#supportedProtocolRange, securityFloor: this.#securityFloor },
      client: {
        ...request.clientHello.supportedProtocolRange,
        securityFloor: REMOTE_DEVICE_SECURITY_FLOOR,
      },
    });
    if (selected.kind === "rejected" || selected.protocolVersion < device.protocolFloor) {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    const authenticationVersion = selectAuthenticationProtocolVersion(
      this.#authenticationProtocolVersions,
    );
    if (authenticationVersion === undefined) {
      throw new RemoteProtocolError("unavailable", "Remote protocol request is unavailable.");
    }
    // B6: an already-installed negotiation for this challenge is immutable.
    // The nonce is already consumed; reject before any signer/journal side effect.
    const challengeKey = digest(request.challengeId);
    if (this.#negotiations.has(challengeKey)) {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    this.#purgeNegotiations(now);
    if (this.#negotiations.size >= MAX_PENDING_NEGOTIATIONS) {
      throw new RemoteProtocolError("unavailable", "Remote protocol request is unavailable.");
    }
    const record: NegotiationRecord = {
      hostId: this.#hostId,
      deviceId: request.deviceId,
      credentialGeneration: challenge.credential_generation,
      origin: request.origin,
      protocolVersion: selected.protocolVersion,
      authenticationVersion,
      capabilityDigest: REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST,
      expiresAt: challenge.expires_at,
    };
    // B5: build unsigned → sign/decode signed → append audit → install map → return.
    // No negotiation is installed or resolvable unless every fallible step succeeds.
    const unsigned = {
      hostId: this.#hostId,
      deviceId: request.deviceId as DeviceId,
      challengeId: request.challengeId,
      protocolVersion: record.protocolVersion,
      authenticationVersion: record.authenticationVersion,
      credentialGeneration: record.credentialGeneration,
      origin: record.origin,
      capabilityDigest: record.capabilityDigest,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
    let signed: NegotiatedProtocolV1;
    try {
      const hostSignature = this.#signing.signHostPayload(buildNegotiatedProtocolPayload(unsigned));
      signed = decodeNegotiatedProtocolV1({ ...unsigned, hostSignature });
    } catch {
      throw new RemoteProtocolError("unavailable", "Remote protocol request is unavailable.");
    }
    try {
      this.#recordNegotiationAudit(input.sourceClass, record, now);
    } catch {
      throw new RemoteProtocolError("unavailable", "Remote protocol request is unavailable.");
    }
    this.#negotiations.set(challengeKey, record);
    return signed;
  }

  resolveNegotiation(input: {
    readonly challengeId: string;
    readonly hostId: string;
    readonly deviceId: string;
    readonly credentialGeneration: number;
  }):
    | {
        readonly origin: string;
        readonly protocolVersion: number;
        readonly authenticationVersion: number;
        readonly capabilityDigest: string;
      }
    | undefined {
    const key = digest(input.challengeId);
    const record = this.#negotiations.get(key);
    if (record === undefined) return undefined;
    if (this.#now() >= record.expiresAt) {
      this.#negotiations.delete(key);
      return undefined;
    }
    if (
      record.hostId !== input.hostId ||
      record.deviceId !== input.deviceId ||
      record.credentialGeneration !== input.credentialGeneration
    ) {
      return undefined;
    }
    return {
      origin: record.origin,
      protocolVersion: record.protocolVersion,
      authenticationVersion: record.authenticationVersion,
      capabilityDigest: record.capabilityDigest,
    };
  }

  clearEphemeralState(): void {
    this.#nonces.clear();
    this.#negotiations.clear();
    this.#lifecycle.clearEphemeralState();
  }

  #consumeNonce(nonce: string): void {
    const now = this.#now();
    this.#purgeNonces(now);
    const key = digest(nonce);
    const record = this.#nonces.get(key);
    if (record === undefined || now >= record.expiresAt) {
      throw new RemoteProtocolError("unauthorized", "Remote protocol request is unauthorized.");
    }
    // Single-use: a presented nonce is burned whether or not later checks pass.
    this.#nonces.delete(key);
  }

  #requireTrustedSourceClass(sourceClass: RemoteSourceClass): void {
    if (
      sourceClass !== "loopback" &&
      sourceClass !== "lan-private" &&
      sourceClass !== "tailscale"
    ) {
      throw new RemoteProtocolError("invalid", "Remote protocol request is invalid.");
    }
  }

  #recordNegotiationAudit(
    sourceClass: RemoteSourceClass,
    record: NegotiationRecord,
    now: number,
  ): void {
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
              eventKind: "session-negotiated",
              hostId: this.#hostId,
              deviceId: record.deviceId,
              protocolVersion: record.protocolVersion,
              credentialGeneration: record.credentialGeneration,
              sourceClass,
              resultCategory: "negotiated",
              reasonCode: "negotiated",
              correlationId,
              occurredAt: new Date(now).toISOString(),
            },
          },
        },
      ],
    });
  }

  #aggregateVersion(aggregateType: string, aggregateId: string): number {
    const row = this.#selectAggregateHead.get(aggregateType, aggregateId) as
      | { readonly aggregate_version: number }
      | undefined;
    return row?.aggregate_version ?? 0;
  }

  #purgeNonces(now: number): void {
    for (const [key, record] of this.#nonces) {
      if (now >= record.expiresAt) this.#nonces.delete(key);
    }
  }

  #purgeNegotiations(now: number): void {
    for (const [key, record] of this.#negotiations) {
      if (now >= record.expiresAt) this.#negotiations.delete(key);
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isHttpsOrigin(value: string): boolean {
  // Exact canonical HTTPS origin: value must equal the URL origin exactly.
  // This accepts canonical explicit non-default ports (e.g. https://host:8443)
  // and rejects trailing slash, path, query, fragment, userinfo, uppercase
  // scheme/host aliases, and explicit default :443.
  if (!value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      value === parsed.origin
    );
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isCoherentProtocolRange(range: { readonly min: number; readonly max: number }): boolean {
  return (
    isPositiveSafeInteger(range.min) && isPositiveSafeInteger(range.max) && range.min <= range.max
  );
}

function areValidAuthenticationVersions(versions: ReadonlyArray<number>): boolean {
  return (
    versions.length > 0 &&
    versions.every(isPositiveSafeInteger) &&
    selectAuthenticationProtocolVersion(versions) !== undefined
  );
}
