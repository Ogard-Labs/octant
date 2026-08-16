import { createHash, randomBytes, randomUUID, verify } from "node:crypto";
import {
  decodeRemoteAuthenticatedRequestResultV1,
  decodeRemoteAuthChallengeV1,
  decodeRemoteSessionIssuedV1,
  decodeRemoteRequestFactsV1,
  type RemoteAuthenticatedRequestResultV1,
  type RemoteAuthChallengeV1,
  type RemoteRequestFactsV1,
  type RemoteSessionIssuedV1,
} from "@octant/contracts/remote-request-proof";
import {
  REMOTE_REQUEST_NONCE_RETENTION_MS,
  buildRemoteChallengeProofPayload,
  buildRemoteRequestProofPayload,
  canonicalizeRemotePathQuery,
  evaluateRemoteRequestFreshness,
  sessionExpiry,
} from "@octant/domain";
import { SESSION_IDLE_TTL_MS } from "@octant/domain";
import { readDeviceRegistration } from "./persistence/remoteAccessProjection";
import type { SqliteConnection } from "./persistence/sqlitePort";

const CHALLENGE_TTL_MS = 60_000;
const MAX_NONCES_PER_SESSION = 4_096;
const MAX_TOKEN_ATTEMPTS = 8;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type RemoteRequestProofFailureCategory =
  | "invalid"
  | "expired"
  | "replayed"
  | "capacity"
  | "unavailable";

export class RemoteRequestProofError extends Error {
  readonly category: RemoteRequestProofFailureCategory;
  readonly reasonCode: "expired" | "revoked" | undefined;

  constructor(category: RemoteRequestProofFailureCategory, reasonCode?: "expired" | "revoked") {
    super("Remote authentication proof was rejected.");
    this.name = "RemoteRequestProofError";
    this.category = category;
    this.reasonCode = reasonCode;
  }
}

interface ChallengeRow {
  readonly challenge_id_digest: string;
  readonly host_id: string;
  readonly device_id: string;
  readonly credential_generation: number;
  readonly nonce_digest: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly consumed: number;
}

interface SessionRow {
  readonly session_id_digest: string;
  readonly host_id: string;
  readonly device_id: string;
  readonly credential_generation: number;
  readonly origin: string;
  readonly protocol_version: number;
  readonly capability_digest: string;
  readonly issued_at: number;
  readonly last_seen_at: number;
  readonly idle_expires_at: number;
  readonly absolute_expires_at: number;
  readonly csrf_digest: string;
  readonly state: "active" | "expired" | "revoked";
  readonly device_public_key: string;
  readonly device_state: "active" | "expired" | "revoked";
  readonly device_origin: string;
  readonly device_credential_generation: number;
}

export interface RemoteSessionFacts {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly origin: string;
  readonly protocolVersion: number;
  readonly capabilityDigest: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface RemoteRequestProofServiceOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomUUID?: () => string;
  readonly verifySignature?: (input: {
    readonly publicKey: string;
    readonly payload: string;
    readonly signature: string;
  }) => boolean;
  readonly resolveNegotiation?: (input: {
    readonly challengeId: string;
    readonly hostId: string;
    readonly deviceId: string;
    readonly credentialGeneration: number;
  }) =>
    | {
        readonly origin: string;
        readonly protocolVersion: number;
        readonly authenticationVersion: number;
        readonly capabilityDigest: string;
      }
    | undefined;
}

export class RemoteRequestProofService {
  readonly #connection: SqliteConnection;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #randomUUID: () => string;
  readonly #verifySignature: NonNullable<RemoteRequestProofServiceOptions["verifySignature"]>;
  readonly #resolveNegotiation: RemoteRequestProofServiceOptions["resolveNegotiation"];

  constructor(connection: SqliteConnection, options: RemoteRequestProofServiceOptions = {}) {
    this.#connection = connection;
    this.#now = options.now ?? (() => Date.now());
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#verifySignature = options.verifySignature ?? verifyP256Signature;
    this.#resolveNegotiation = options.resolveNegotiation;
  }

  issueChallenge(input: {
    readonly hostId: string;
    readonly deviceId: string;
    readonly credentialGeneration: number;
  }): RemoteAuthChallengeV1 {
    const device = readDeviceRegistration(this.#connection, input.deviceId);
    if (device === undefined || device.hostId !== input.hostId) {
      throw new RemoteRequestProofError("invalid");
    }
    if (device.state === "expired") {
      throw new RemoteRequestProofError("invalid", "expired");
    }
    if (device.state === "revoked") {
      throw new RemoteRequestProofError("invalid", "revoked");
    }
    if (device.credentialGeneration !== input.credentialGeneration) {
      throw new RemoteRequestProofError("invalid");
    }

    const now = this.#now();
    this.#connection
      .prepare("DELETE FROM remote_auth_challenge_store WHERE expires_at <= ?")
      .run(now);
    const challengeId = this.#uniqueToken("challenge_id_digest");
    const nonce = toBase64Url(this.#randomBytes(32));
    let challenge: RemoteAuthChallengeV1;
    try {
      challenge = decodeRemoteAuthChallengeV1({
        challengeId: challengeId.raw,
        hostId: input.hostId,
        deviceId: input.deviceId,
        credentialGeneration: input.credentialGeneration,
        nonce,
        issuedAt: toUtc(now),
        expiresAt: toUtc(now + CHALLENGE_TTL_MS),
      });
    } catch {
      throw new RemoteRequestProofError("invalid");
    }
    this.#connection
      .prepare(
        `INSERT INTO remote_auth_challenge_store (
          challenge_id_digest, host_id, device_id, credential_generation,
          nonce_digest, issued_at, expires_at, consumed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        digest(challenge.challengeId),
        challenge.hostId,
        challenge.deviceId,
        challenge.credentialGeneration,
        digest(challenge.nonce),
        now,
        now + CHALLENGE_TTL_MS,
      );
    return challenge;
  }

  issueSession(
    input: RemoteAuthChallengeV1 & { readonly signature: string },
  ): RemoteSessionIssuedV1 {
    let challenge: RemoteAuthChallengeV1;
    try {
      challenge = decodeRemoteAuthChallengeV1({
        challengeId: input.challengeId,
        hostId: input.hostId,
        deviceId: input.deviceId,
        credentialGeneration: input.credentialGeneration,
        nonce: input.nonce,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      });
    } catch {
      throw new RemoteRequestProofError("invalid");
    }
    const now = this.#now();
    const row = this.#connection
      .prepare("SELECT * FROM remote_auth_challenge_store WHERE challenge_id_digest = ?")
      .get(digest(challenge.challengeId)) as ChallengeRow | undefined;
    if (
      row === undefined ||
      row.consumed !== 0 ||
      now >= row.expires_at ||
      row.host_id !== challenge.hostId ||
      row.device_id !== challenge.deviceId ||
      row.credential_generation !== challenge.credentialGeneration ||
      row.nonce_digest !== digest(challenge.nonce) ||
      row.issued_at !== Date.parse(challenge.issuedAt) ||
      row.expires_at !== Date.parse(challenge.expiresAt)
    ) {
      throw new RemoteRequestProofError("expired");
    }
    const negotiation = this.#resolveNegotiation?.({
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      deviceId: challenge.deviceId,
      credentialGeneration: challenge.credentialGeneration,
    });
    if (negotiation === undefined) throw new RemoteRequestProofError("invalid");
    const device = readDeviceRegistration(this.#connection, challenge.deviceId);
    if (
      device === undefined ||
      device.hostId !== challenge.hostId ||
      device.credentialGeneration !== challenge.credentialGeneration ||
      device.origin !== negotiation.origin ||
      negotiation.protocolVersion < device.protocolFloor
    ) {
      throw new RemoteRequestProofError(
        "invalid",
        device?.state === "expired"
          ? "expired"
          : device?.state === "revoked"
            ? "revoked"
            : undefined,
      );
    }
    if (device.state !== "active") {
      throw new RemoteRequestProofError(
        "invalid",
        device.state === "expired" ? "expired" : "revoked",
      );
    }
    if (
      !this.#verifySignature({
        publicKey: device.devicePublicKey,
        payload: buildRemoteChallengeProofPayload({
          challenge,
          sessionFacts: {
            ...negotiation,
            ...sessionExpiry(Date.parse(challenge.issuedAt)),
          },
        }),
        signature: input.signature,
      })
    ) {
      this.#consumeChallenge(row.challenge_id_digest);
      throw new RemoteRequestProofError("invalid");
    }

    const sessionId = this.#uniqueToken("session_id_digest");
    const csrfToken = toBase64Url(this.#randomBytes(32));
    const expiry = sessionExpiry(Date.parse(challenge.issuedAt));
    let issued: RemoteSessionIssuedV1;
    try {
      issued = decodeRemoteSessionIssuedV1({
        hostId: challenge.hostId,
        deviceId: challenge.deviceId,
        sessionId: sessionId.raw,
        credentialGeneration: challenge.credentialGeneration,
        origin: negotiation.origin,
        protocolVersion: negotiation.protocolVersion,
        authenticationVersion: negotiation.authenticationVersion,
        capabilityDigest: negotiation.capabilityDigest,
        ...expiry,
        csrfToken,
      });
    } catch {
      throw new RemoteRequestProofError("invalid");
    }
    try {
      this.#connection.transaction(() => {
        const consumed = this.#connection
          .prepare(
            "UPDATE remote_auth_challenge_store SET consumed = 1 WHERE challenge_id_digest = ? AND consumed = 0",
          )
          .run(row.challenge_id_digest).changes;
        if (consumed !== 1) throw new RemoteRequestProofError("replayed");
        const currentDevice = this.#connection
          .prepare(
            "SELECT state, credential_generation FROM remote_device_projection WHERE device_id = ? AND host_id = ?",
          )
          .get(issued.deviceId, issued.hostId) as
          | {
              readonly state: "active" | "expired" | "revoked";
              readonly credential_generation: number;
            }
          | undefined;
        if (
          currentDevice === undefined ||
          currentDevice.state !== "active" ||
          currentDevice.credential_generation !== issued.credentialGeneration
        ) {
          throw new RemoteRequestProofError("invalid");
        }
        this.#connection
          .prepare(
            `INSERT INTO remote_session_store (
              session_id_digest, host_id, device_id, credential_generation,
              origin, protocol_version, capability_digest, issued_at, last_seen_at,
              idle_expires_at, absolute_expires_at, csrf_digest, state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          )
          .run(
            digest(issued.sessionId),
            issued.hostId,
            issued.deviceId,
            issued.credentialGeneration,
            issued.origin,
            issued.protocolVersion,
            issued.capabilityDigest,
            Date.parse(issued.issuedAt),
            Date.parse(issued.issuedAt),
            Date.parse(issued.idleExpiresAt),
            Date.parse(issued.absoluteExpiresAt),
            digest(issued.csrfToken),
          );
      })();
    } catch (error) {
      if (error instanceof RemoteRequestProofError) throw error;
      throw new RemoteRequestProofError("unavailable");
    }
    return issued;
  }

  describeSession(sessionId: string): RemoteSessionFacts | undefined {
    if (
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        sessionId,
      )
    )
      return undefined;
    const now = this.#now();
    const row = this.#connection
      .prepare(
        `SELECT s.host_id, s.device_id, s.credential_generation, s.origin,
                s.protocol_version, s.capability_digest, s.idle_expires_at, s.absolute_expires_at
         FROM remote_session_store s
         JOIN remote_device_projection d
           ON d.device_id = s.device_id AND d.host_id = s.host_id
         WHERE s.session_id_digest = ?
           AND s.state = 'active'
           AND d.state = 'active'
           AND d.credential_generation = s.credential_generation
           AND d.origin = s.origin
           AND s.idle_expires_at > ?
           AND s.absolute_expires_at > ?`,
      )
      .get(digest(sessionId), now, now) as
      | {
          readonly host_id: string;
          readonly device_id: string;
          readonly credential_generation: number;
          readonly origin: string;
          readonly protocol_version: number;
          readonly capability_digest: string;
          readonly idle_expires_at: number;
          readonly absolute_expires_at: number;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      hostId: row.host_id,
      deviceId: row.device_id,
      credentialGeneration: row.credential_generation,
      origin: row.origin,
      protocolVersion: row.protocol_version,
      capabilityDigest: row.capability_digest,
      idleExpiresAt: toUtc(row.idle_expires_at),
      absoluteExpiresAt: toUtc(row.absolute_expires_at),
    };
  }

  verifyRequest(input: unknown): RemoteAuthenticatedRequestResultV1 {
    let facts: RemoteRequestFactsV1;
    try {
      facts = decodeRemoteRequestFactsV1(input);
    } catch {
      throw new RemoteRequestProofError("invalid");
    }
    const canonicalPathQuery = canonicalizeRemotePathQuery(facts.proof.canonicalPathQuery);
    if (canonicalPathQuery !== facts.proof.canonicalPathQuery) {
      throw new RemoteRequestProofError("invalid");
    }
    if (!SAFE_METHODS.has(facts.proof.method) && facts.proof.csrfDigest === undefined) {
      throw new RemoteRequestProofError("invalid");
    }

    const session = this.#connection
      .prepare(
        `SELECT s.*, d.device_public_key, d.state AS device_state,
                d.origin AS device_origin, d.credential_generation AS device_credential_generation
         FROM remote_session_store s
         LEFT JOIN remote_device_projection d ON d.device_id = s.device_id
         WHERE s.session_id_digest = ?`,
      )
      .get(digest(facts.sessionId)) as SessionRow | undefined;
    if (
      session === undefined ||
      session.state !== "active" ||
      session.device_state !== "active" ||
      session.host_id !== facts.hostId ||
      session.device_id !== facts.deviceId ||
      session.credential_generation !== facts.credentialGeneration ||
      session.device_credential_generation !== session.credential_generation ||
      session.device_credential_generation !== facts.credentialGeneration ||
      session.origin !== facts.origin ||
      session.protocol_version !== facts.protocolVersion ||
      session.device_origin !== facts.origin ||
      (facts.proof.csrfDigest !== undefined && facts.proof.csrfDigest !== session.csrf_digest)
    ) {
      throw new RemoteRequestProofError("invalid");
    }

    const freshness = evaluateRemoteRequestFreshness({
      nowMs: this.#now(),
      proofTimestamp: facts.proof.timestamp,
      session: {
        issuedAt: toUtc(session.issued_at),
        idleExpiresAt: toUtc(session.idle_expires_at),
        absoluteExpiresAt: toUtc(session.absolute_expires_at),
      },
    });
    if (freshness.kind === "rejected") {
      if (freshness.reason === "idle-expiry" || freshness.reason === "absolute-expiry") {
        this.#connection
          .prepare("UPDATE remote_session_store SET state = 'expired' WHERE session_id_digest = ?")
          .run(session.session_id_digest);
        throw new RemoteRequestProofError("expired");
      }
      throw new RemoteRequestProofError("invalid");
    }
    if (
      !this.#verifySignature({
        publicKey: session.device_public_key,
        payload: buildRemoteRequestProofPayload({ sessionId: facts.sessionId, proof: facts.proof }),
        signature: facts.proof.signature,
      })
    ) {
      throw new RemoteRequestProofError("invalid");
    }

    const now = this.#now();
    try {
      this.#connection.transaction(() => {
        this.#connection
          .prepare("DELETE FROM remote_request_nonce_store WHERE expires_at <= ?")
          .run(now);
        const nonceCount = this.#connection
          .prepare(
            "SELECT COUNT(*) AS count FROM remote_request_nonce_store WHERE session_id_digest = ?",
          )
          .get(session.session_id_digest) as { count: number };
        if (nonceCount.count >= MAX_NONCES_PER_SESSION) {
          throw new RemoteRequestProofError("capacity");
        }
        const inserted = this.#connection
          .prepare(
            "INSERT INTO remote_request_nonce_store (session_id_digest, nonce_digest, expires_at) VALUES (?, ?, ?) ON CONFLICT(session_id_digest, nonce_digest) DO NOTHING",
          )
          .run(
            session.session_id_digest,
            digest(facts.proof.nonce),
            now + REMOTE_REQUEST_NONCE_RETENTION_MS,
          ).changes;
        if (inserted !== 1) throw new RemoteRequestProofError("replayed");
        const idleExpiresAt = Math.min(now + SESSION_IDLE_TTL_MS, session.absolute_expires_at);
        const updated = this.#connection
          .prepare(
            `UPDATE remote_session_store
             SET last_seen_at = ?, idle_expires_at = ?
             WHERE session_id_digest = ?
               AND state = 'active'
               AND credential_generation = ?
               AND EXISTS (
                 SELECT 1
                 FROM remote_device_projection d
                 WHERE d.device_id = remote_session_store.device_id
                   AND d.state = 'active'
                   AND d.credential_generation = remote_session_store.credential_generation
               )`,
          )
          .run(
            now,
            idleExpiresAt,
            session.session_id_digest,
            session.credential_generation,
          ).changes;
        if (updated !== 1) throw new RemoteRequestProofError("invalid");
      })();
    } catch (error) {
      if (error instanceof RemoteRequestProofError) throw error;
      throw new RemoteRequestProofError("unavailable");
    }

    return decodeRemoteAuthenticatedRequestResultV1({
      hostId: facts.hostId,
      deviceId: facts.deviceId,
      sessionId: facts.sessionId,
      credentialGeneration: facts.credentialGeneration,
      protocolVersion: facts.protocolVersion,
      origin: facts.origin,
      freshness: freshness.rotate ? "rotation-due" : "current",
    });
  }

  #consumeChallenge(challengeIdDigest: string): void {
    this.#connection
      .prepare("UPDATE remote_auth_challenge_store SET consumed = 1 WHERE challenge_id_digest = ?")
      .run(challengeIdDigest);
  }

  #uniqueToken(column: "challenge_id_digest" | "session_id_digest"): {
    readonly raw: string;
    readonly digest: string;
  } {
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      const raw = this.#randomUUID();
      const value = { raw, digest: digest(raw) };
      const found = this.#connection
        .prepare(
          `SELECT 1 FROM ${column === "challenge_id_digest" ? "remote_auth_challenge_store" : "remote_session_store"} WHERE ${column} = ?`,
        )
        .get(value.digest);
      if (found === undefined) return value;
    }
    throw new RemoteRequestProofError("capacity");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function toUtc(value: number): string {
  return new Date(value).toISOString();
}

function verifyP256Signature(input: {
  readonly publicKey: string;
  readonly payload: string;
  readonly signature: string;
}): boolean {
  try {
    return verify(
      "sha256",
      Buffer.from(input.payload, "utf8"),
      { key: input.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return false;
  }
}
