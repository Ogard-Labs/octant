import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteChallengeProofPayload,
  buildRemoteRequestProofPayload,
  canonicalizeRemotePathQuery,
  sessionExpiry,
} from "@octant/domain";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { RemoteRequestProofError, RemoteRequestProofService } from "./remoteRequestProofService";

const hostId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-07-29T09:00:00.000Z");
const origin = "https://mac.example.test";
const capabilityDigest = "c".repeat(64);
const directories: string[] = [];

const negotiation = {
  origin,
  protocolVersion: 1,
  authenticationVersion: 1,
  capabilityDigest,
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(): {
  readonly connection: SqliteConnection;
  readonly service: RemoteRequestProofService;
  readonly privateKey: string;
  readonly setClock: (value: number) => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "octant-request-proof-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => new Date(now).toISOString());
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  connection
    .prepare(
      `INSERT INTO remote_device_projection (
        device_id, host_id, device_key_fingerprint, device_public_key, device_label,
        origin, protocol_floor, credential_generation, created_at, expires_at, last_seen_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      deviceId,
      hostId,
      "b".repeat(64),
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "Browser",
      origin,
      1,
      1,
      new Date(now).toISOString(),
      new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      new Date(now).toISOString(),
    );
  let clock = now;
  return {
    connection,
    service: new RemoteRequestProofService(connection, {
      now: () => clock,
      resolveNegotiation: () => negotiation,
    }),
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    setClock: (value: number) => {
      clock = value;
    },
  };
}

function makeSignature(privateKey: string, payload: string): string {
  return sign("sha256", Buffer.from(payload), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

function issueSession(service: RemoteRequestProofService, privateKey: string) {
  const challenge = service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 });
  const sessionFacts = { ...negotiation, ...sessionExpiry(Date.parse(challenge.issuedAt)) };
  return service.issueSession({
    ...challenge,
    signature: makeSignature(
      privateKey,
      buildRemoteChallengeProofPayload({ challenge, sessionFacts }),
    ),
  });
}

function makeFacts(
  session: ReturnType<typeof issueSession>,
  privateKey: string,
  overrides: Record<string, unknown> = {},
) {
  const { proof: proofOverrides, ...factOverrides } = overrides;
  const proof = {
    method: "POST" as const,
    canonicalPathQuery: canonicalizeRemotePathQuery("/api/chat/threads?b=2&a=1")!,
    bodyDigest: "a".repeat(64),
    csrfDigest: createHash("sha256").update(session.csrfToken, "utf8").digest("hex"),
    timestamp: new Date(now).toISOString(),
    nonce: "request_nonce_1234567890",
    ...(proofOverrides as Record<string, unknown> | undefined),
  };
  return {
    hostId,
    deviceId,
    sessionId: session.sessionId,
    credentialGeneration: 1,
    origin,
    protocolVersion: 1,
    proof: {
      ...proof,
      signature:
        typeof (proofOverrides as Record<string, unknown> | undefined)?.signature === "string"
          ? (proofOverrides as Record<string, string>).signature
          : makeSignature(
              privateKey,
              buildRemoteRequestProofPayload({ sessionId: session.sessionId, proof }),
            ),
    },
    ...factOverrides,
  };
}

describe("RemoteRequestProofService", () => {
  it("issues a short session and authenticates only a matching signed request", () => {
    const { connection, service, privateKey } = setup();
    const session = issueSession(service, privateKey);
    const result = service.verifyRequest(makeFacts(session, privateKey));
    expect(result).toMatchObject({
      hostId,
      deviceId,
      sessionId: session.sessionId,
      freshness: "current",
    });
    expect(session.idleExpiresAt).toBe("2026-07-29T09:15:00.000Z");
    expect(session.authenticationVersion).toBe(1);
    connection.close();
  });

  it.each(["expired", "revoked"] as const)(
    "preserves the %s device lifecycle reason when issuing a challenge",
    (state) => {
      const { connection, service } = setup();
      connection
        .prepare("UPDATE remote_device_projection SET state = ? WHERE device_id = ?")
        .run(state, deviceId);

      try {
        service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 });
        throw new Error("expected challenge rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteRequestProofError);
        expect(error).toMatchObject({ category: "invalid", reasonCode: state });
      }
      connection.close();
    },
  );

  it("preserves revoked when production revocation advances the device generation", () => {
    const { connection, service } = setup();
    connection
      .prepare(
        "UPDATE remote_device_projection SET state = 'revoked', credential_generation = 2 WHERE device_id = ?",
      )
      .run(deviceId);

    expect(() =>
      service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 }),
    ).toThrowError(expect.objectContaining({ category: "invalid", reasonCode: "revoked" }));
    connection.close();
  });

  it("rejects cookie-only theft, proof replay, and every signed-fact mutation", () => {
    const { connection, service, privateKey } = setup();
    const session = issueSession(service, privateKey);
    expect(() =>
      service.verifyRequest(
        makeFacts(session, privateKey, { proof: { signature: "cookie-only" } }),
      ),
    ).toThrow(RemoteRequestProofError);
    const valid = makeFacts(session, privateKey);
    expect(() => service.verifyRequest(valid)).not.toThrow();
    expect(() => service.verifyRequest(valid)).toThrow(RemoteRequestProofError);
    for (const [index, proof] of [
      { method: "GET" },
      { bodyDigest: "e".repeat(64) },
      { canonicalPathQuery: "/api/other" },
      { csrfDigest: "f".repeat(64) },
      { timestamp: "2026-07-29T09:02:00.000Z" },
      { nonce: "other_nonce_1234567890" },
    ].entries()) {
      const candidate = makeFacts(session, privateKey, {
        proof: { nonce: `mutation_nonce_${index}_1234567890` },
      });
      candidate.proof = { ...candidate.proof, ...(proof as Partial<typeof candidate.proof>) };
      expect(() => service.verifyRequest(candidate)).toThrow(RemoteRequestProofError);
    }
    connection.close();
  });

  it("rejects session facts that are changed after the challenge signature", () => {
    const { connection, service, privateKey } = setup();
    for (const mutation of [
      { origin: "https://evil.example.test" },
      { protocolVersion: 2 },
      { capabilityDigest: "d".repeat(64) },
    ]) {
      const challenge = service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 });
      const sessionFacts = {
        ...negotiation,
        ...sessionExpiry(Date.parse(challenge.issuedAt)),
        ...mutation,
      };
      const signature = makeSignature(
        privateKey,
        buildRemoteChallengeProofPayload({ challenge, sessionFacts }),
      );
      expect(() =>
        service.issueSession({
          ...challenge,
          signature,
        }),
      ).toThrow(RemoteRequestProofError);
    }
    connection.close();
  });

  it("rejects challenge timestamp mutations and exact outer request identity mutations", () => {
    const { connection, service, privateKey } = setup();
    for (const field of ["issuedAt", "expiresAt"] as const) {
      const challenge = service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 });
      const sessionFacts = { ...negotiation, ...sessionExpiry(Date.parse(challenge.issuedAt)) };
      const signature = makeSignature(
        privateKey,
        buildRemoteChallengeProofPayload({ challenge, sessionFacts }),
      );
      expect(() =>
        service.issueSession({
          ...challenge,
          [field]: field === "issuedAt" ? "2026-07-29T08:59:59.000Z" : "2026-07-29T09:01:01.000Z",
          signature,
        }),
      ).toThrow(RemoteRequestProofError);
    }

    const session = issueSession(service, privateKey);
    for (const mutation of [
      { hostId: "33333333-3333-4333-8333-333333333333" },
      { deviceId: "44444444-4444-4444-8444-444444444444" },
      { sessionId: "55555555-5555-4555-8555-555555555555" },
      { credentialGeneration: 2 },
      { origin: "https://evil.example.test" },
      { protocolVersion: 2 },
    ]) {
      expect(() => service.verifyRequest(makeFacts(session, privateKey, mutation))).toThrow(
        RemoteRequestProofError,
      );
    }
    connection.close();
  });

  it("does not issue a stale session when lifecycle state changes before session commit", () => {
    const { connection, service, privateKey } = setup();
    const challenge = service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 });
    const sessionFacts = { ...negotiation, ...sessionExpiry(Date.parse(challenge.issuedAt)) };
    connection
      .prepare("UPDATE remote_device_projection SET credential_generation = 2 WHERE device_id = ?")
      .run(deviceId);

    expect(() =>
      service.issueSession({
        ...challenge,
        signature: makeSignature(
          privateKey,
          buildRemoteChallengeProofPayload({ challenge, sessionFacts }),
        ),
      }),
    ).toThrow(RemoteRequestProofError);
    expect(connection.prepare("SELECT COUNT(*) AS count FROM remote_session_store").get()).toEqual({
      count: 0,
    });
    connection.close();
  });

  it("rejects an active old session after durable device generation or state changes", () => {
    for (const devicePatch of [
      "UPDATE remote_device_projection SET credential_generation = 2 WHERE device_id = ?",
      "UPDATE remote_device_projection SET state = 'revoked' WHERE device_id = ?",
      "UPDATE remote_device_projection SET state = 'expired' WHERE device_id = ?",
    ]) {
      const { connection, service, privateKey } = setup();
      const session = issueSession(service, privateKey);
      const facts = makeFacts(session, privateKey, {
        proof: { nonce: `device-state-${devicePatch.length}-1234567890` },
      });
      const databasePath = connection
        .prepare("PRAGMA database_list")
        .all()
        .find((row) => (row as { name: string }).name === "main") as { file: string };
      const before = connection
        .prepare("SELECT last_seen_at FROM remote_session_store WHERE session_id_digest = ?")
        .get(createHash("sha256").update(session.sessionId, "utf8").digest("hex")) as {
        last_seen_at: number;
      };
      connection.prepare(devicePatch).run(deviceId);
      connection.close();

      const reopened = openSqlite(databasePath.file);
      applyMigrations(reopened, MIGRATIONS, () => new Date(now).toISOString());
      const reopenedService = new RemoteRequestProofService(reopened, {
        now: () => now,
        resolveNegotiation: () => negotiation,
      });
      expect(() => reopenedService.verifyRequest(facts)).toThrow(RemoteRequestProofError);
      expect(
        reopened
          .prepare("SELECT last_seen_at FROM remote_session_store WHERE session_id_digest = ?")
          .get(createHash("sha256").update(session.sessionId, "utf8").digest("hex")),
      ).toEqual(before);
      expect(
        reopened.prepare("SELECT COUNT(*) AS count FROM remote_request_nonce_store").get(),
      ).toEqual({ count: 0 });
      reopened.close();
    }
  });

  it("fails closed when revocation or generation changes race nonce commit", () => {
    for (const patch of [
      "UPDATE remote_session_store SET state = 'revoked' WHERE session_id_digest = ?",
      "UPDATE remote_device_projection SET credential_generation = 2 WHERE device_id = ?",
    ]) {
      const { connection, service, privateKey } = setup();
      const session = issueSession(service, privateKey);
      const facts = makeFacts(session, privateKey, {
        proof: { nonce: `race-${patch.length}-1234567890` },
      });
      const sessionDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");
      const before = connection
        .prepare("SELECT last_seen_at FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionDigest) as { last_seen_at: number };
      let callbackCalls = 0;
      const racingService = new RemoteRequestProofService(connection, {
        now: () => now,
        resolveNegotiation: () => negotiation,
        verifySignature: () => {
          callbackCalls += 1;
          connection.prepare(patch).run(patch.includes("session_store") ? sessionDigest : deviceId);
          return true;
        },
      });

      expect(() => racingService.verifyRequest(facts)).toThrow(RemoteRequestProofError);
      expect(callbackCalls).toBe(1);
      expect(
        connection.prepare("SELECT COUNT(*) AS count FROM remote_request_nonce_store").get(),
      ).toEqual({ count: 0 });
      expect(
        connection
          .prepare("SELECT last_seen_at FROM remote_session_store WHERE session_id_digest = ?")
          .get(sessionDigest),
      ).toEqual(before);
      connection.close();
    }
  });

  it("wins exactly once across two connections and classifies duplicate nonce as replay", () => {
    const first = setup();
    const session = issueSession(first.service, first.privateKey);
    const facts = makeFacts(session, first.privateKey);
    const databasePath = first.connection
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => (row as { name: string }).name === "main") as { file: string };
    const secondConnection = openSqlite(databasePath.file);
    const secondService = new RemoteRequestProofService(secondConnection, {
      now: () => now,
      resolveNegotiation: () => negotiation,
    });
    expect(() => first.service.verifyRequest(facts)).not.toThrow();
    expect(() => secondService.verifyRequest(facts)).toThrowError(
      expect.objectContaining({ category: "replayed" }),
    );
    first.connection.close();
    secondConnection.close();
    const restarted = openSqlite(databasePath.file);
    applyMigrations(restarted, MIGRATIONS, () => new Date(now).toISOString());
    const restartedService = new RemoteRequestProofService(restarted, {
      now: () => now,
      resolveNegotiation: () => negotiation,
    });
    expect(() => restartedService.verifyRequest(facts)).toThrowError(
      expect.objectContaining({ category: "replayed" }),
    );
    const nextSession = issueSession(restartedService, first.privateKey);
    const nextFacts = makeFacts(nextSession, first.privateKey, {
      proof: { nonce: "restart_nonce_1234567890" },
    });
    expect(() => restartedService.verifyRequest(nextFacts)).not.toThrow();
    const persisted = JSON.stringify({
      challenges: restarted.prepare("SELECT * FROM remote_auth_challenge_store").all(),
      sessions: restarted.prepare("SELECT * FROM remote_session_store").all(),
      nonces: restarted.prepare("SELECT * FROM remote_request_nonce_store").all(),
    });
    expect(persisted).not.toContain(nextSession.sessionId);
    expect(persisted).not.toContain(nextSession.csrfToken);
    expect(persisted).not.toContain(nextFacts.proof.nonce);
    restarted.close();
  });

  it("fails closed when the token entropy source repeatedly collides", () => {
    const { connection, service } = setup();
    const challenge = service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 });
    const collisionService = new RemoteRequestProofService(connection, {
      now: () => now,
      randomUUID: () => challenge.challengeId,
      resolveNegotiation: () => negotiation,
    });
    expect(() =>
      collisionService.issueChallenge({ hostId, deviceId, credentialGeneration: 1 }),
    ).toThrowError(expect.objectContaining({ category: "capacity" }));
    connection.close();
  });

  it("describes cookie-backed session rows from stored facts only", () => {
    const { connection, service, privateKey } = setup();
    expect(service.describeSession("55555555-5555-4555-8555-555555555555")).toBeUndefined();
    expect(service.describeSession("not-a-session")).toBeUndefined();
    const session = issueSession(service, privateKey);
    const facts = service.describeSession(session.sessionId);
    expect(facts).toEqual({
      hostId,
      deviceId,
      credentialGeneration: 1,
      origin,
      protocolVersion: 1,
      capabilityDigest,
      idleExpiresAt: "2026-07-29T09:15:00.000Z",
      absoluteExpiresAt: "2026-07-29T21:00:00.000Z",
    });
    expect(JSON.stringify(facts)).not.toContain(session.csrfToken);
    connection.close();
  });

  it("describeSession returns undefined for revoked device, generation drift, origin drift, inactive session, and time-expired session", () => {
    // Revoked device
    {
      const { connection, service, privateKey, setClock } = setup();
      const session = issueSession(service, privateKey);
      setClock(now + 60_000);
      connection
        .prepare("UPDATE remote_device_projection SET state = 'revoked' WHERE device_id = ?")
        .run(deviceId);
      expect(service.describeSession(session.sessionId)).toBeUndefined();
      connection.close();
    }
    // Generation drift (device credential_generation no longer matches session)
    {
      const { connection, service, privateKey, setClock } = setup();
      const session = issueSession(service, privateKey);
      setClock(now + 60_000);
      connection
        .prepare(
          "UPDATE remote_device_projection SET credential_generation = 2 WHERE device_id = ?",
        )
        .run(deviceId);
      expect(service.describeSession(session.sessionId)).toBeUndefined();
      connection.close();
    }
    // Origin drift (device origin no longer matches session origin)
    {
      const { connection, service, privateKey, setClock } = setup();
      const session = issueSession(service, privateKey);
      setClock(now + 60_000);
      connection
        .prepare(
          "UPDATE remote_device_projection SET origin = 'https://other.example.test' WHERE device_id = ?",
        )
        .run(deviceId);
      expect(service.describeSession(session.sessionId)).toBeUndefined();
      connection.close();
    }
    // Inactive (revoked) session state
    {
      const { connection, service, privateKey, setClock } = setup();
      const session = issueSession(service, privateKey);
      setClock(now + 60_000);
      const sessionDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");
      connection
        .prepare("UPDATE remote_session_store SET state = 'revoked' WHERE session_id_digest = ?")
        .run(sessionDigest);
      expect(service.describeSession(session.sessionId)).toBeUndefined();
      connection.close();
    }
    // Idle-expired session (past idle TTL, before absolute TTL)
    {
      const { connection, service, privateKey, setClock } = setup();
      const session = issueSession(service, privateKey);
      // idleExpiresAt = now + 15min; advance past it
      setClock(now + 16 * 60 * 1_000);
      expect(service.describeSession(session.sessionId)).toBeUndefined();
      connection.close();
    }
    // Absolute-expired session (past absolute TTL)
    {
      const { connection, service, privateKey, setClock } = setup();
      const session = issueSession(service, privateKey);
      // absoluteExpiresAt = now + 12h; advance past it
      setClock(now + 12 * 60 * 60 * 1_000 + 1_000);
      expect(service.describeSession(session.sessionId)).toBeUndefined();
      connection.close();
    }
  });
});
