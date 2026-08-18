import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_ABSOLUTE_TTL_MS,
  DEVICE_INACTIVITY_TTL_MS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_TICKET_TTL_MS,
} from "@octant/domain/remote-access-policy";
import {
  MAX_LIVE_PAIRING_TICKETS,
  MAX_UNDECIDED_PAIRING_CLAIMS,
} from "@octant/domain/remote-protocol-policy";
import { buildClientHelloTranscriptPayload } from "@octant/domain/remote-protocol-policy";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  readDeviceRegistrations,
  RemoteAccessProjection,
} from "../persistence/remoteAccessProjection";
import { rebuildProjection } from "../persistence/projection";
import {
  PairingDeviceLifecycleError,
  PairingDeviceLifecycleService,
} from "./pairingDeviceLifecycleService";
import { canonicalDeviceKeyFacts } from "./deviceKeyFacts";
import {
  derivePairingComparisonCode,
  sanitizeClaimRecord,
  sha256DigestHex,
} from "./pairingClaimRecord";

const directories: string[] = [];
const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const actorId = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";
const nowIso = "2026-07-29T09:00:00.000Z";
const nowMs = Date.parse(nowIso);

function testDeviceKey() {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
  return {
    publicPem,
    fingerprint: canonicalDeviceKeyFacts(publicPem)!.fingerprint,
  };
}

const defaultDeviceKey = testDeviceKey();

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createService(options?: {
  readonly nowMs?: number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly connection?: ReturnType<typeof openSqlite>;
  readonly journal?: Journal;
  readonly projection?: RemoteAccessProjection;
  readonly initializeHost?: boolean;
  readonly uuidSeed?: number;
  readonly clock?: { nowMs: number };
}) {
  const clock = options?.clock ?? { nowMs: options?.nowMs ?? nowMs };
  let connection = options?.connection;
  let journal = options?.journal;
  let projection = options?.projection;
  if (connection === undefined || journal === undefined || projection === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "octant-pairing-lifecycle-"));
    directories.push(directory);
    connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => nowIso);
    const runtime = createPhase1RuntimeRegistries();
    journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => new Date(clock.nowMs).toISOString(),
    });
    projection = runtime.projections.get("remote-access") as RemoteAccessProjection;
    if (options?.initializeHost !== false) {
      journal.append({
        aggregate: { aggregateType: "remote-host", aggregateId: hostId },
        expectedVersion: 0,
        events: [
          {
            eventId: "55555555-5555-4555-8555-555555555555",
            eventName: "remote.host-identity-initialized@1",
            eventVersion: 1,
            correlationId,
            actor: { kind: "system", actorId },
            occurredAt: nowIso,
            payload: {
              hostId,
              displayName: "This Mac",
              hostKeyFingerprint: "a".repeat(64),
              keyGeneration: 1,
              createdAt: nowIso,
            },
          },
        ],
      });
    }
  }
  let n = options?.uuidSeed ?? 0;
  const service = new PairingDeviceLifecycleService({
    hostId,
    journal,
    connection,
    now: () => clock.nowMs,
    ...(options?.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    uuid: () => {
      n += 1;
      return `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
    },
    correlationId: () => correlationId,
    actorId: () => actorId,
  });
  return {
    service,
    connection,
    journal,
    projection,
    clock,
  };
}

function claimInput(ticketId: string, proof: string, overrides: Record<string, unknown> = {}) {
  return {
    ticketId,
    ticketProof: proof,
    hostHelloNonce: "nonce_1234567890",
    devicePublicKey: defaultDeviceKey.publicPem,
    deviceKeyFingerprint: defaultDeviceKey.fingerprint,
    deviceLabel: "Ada's Safari",
    origin: "https://mac.example.test",
    clientHello: {
      webBuildVersion: "0.1.0",
      supportedProtocolRange: { min: 1, max: 1 },
      browserCapabilities: ["webcrypto"],
    },
    ...overrides,
  };
}

/**
 * Every property name in a payload, however deep.
 *
 * Leak checks read names rather than the whole serialization: a payload
 * carries a freshly generated device key, and scanning its base64 for a short
 * word like "csrf" fails whenever those four characters happen to land in the
 * key. The rule being enforced is that no secret-bearing field is present, so
 * the names are what to look at; an actual secret is checked by its value.
 */
function propertyNames(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) return value.flatMap((entry) => propertyNames(entry));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, nested]) => [name, ...propertyNames(nested)]);
}

function fieldsMatching(payload: unknown, pattern: RegExp): ReadonlyArray<string> {
  return propertyNames(payload).filter((name) => pattern.test(name));
}

describe("PairingDeviceLifecycleService", () => {
  it("creates a single-use ticket and claims it once with comparison transcript facts", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    expect(ticket.expiresAt).toBe(nowMs + PAIRING_TICKET_TTL_MS);
    expect(ticket.ticketProof).toMatch(/^[A-Za-z0-9_-]+$/);
    // The proof belongs to the ticket that carries it; nothing else does.
    expect(fieldsMatching(ticket, /cookie|csrf|private ?key/i)).toEqual([]);

    const claim = service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    expect(claim.kind).toBe("pending");
    if (claim.kind !== "pending") throw new Error("expected pending");
    expect(claim.comparisonCode).toMatch(/^\d{6}$/);
    expect(claim.deviceLabel).toBe("Ada's Safari");
    expect(claim.deviceKeyFingerprint).toBe(defaultDeviceKey.fingerprint);
    expect(claim.origin).toBe("https://mac.example.test");
    expect(claim.sourceClass).toBe("lan-private");
    expect(JSON.stringify(claim)).not.toContain(ticket.ticketProof);

    expect(() => service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof))).toThrow(
      PairingDeviceLifecycleError,
    );
  });

  it("lists only bounded pending claim facts for local approval", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 2),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));

    expect(service.listPendingClaims()).toEqual([
      expect.objectContaining({
        ticketId: ticket.ticketId,
        deviceLabel: "Ada's Safari",
        origin: "https://mac.example.test",
        sourceClass: "lan-private",
        deviceKeyFingerprint: defaultDeviceKey.fingerprint,
        comparisonCode: expect.stringMatching(/^\d{6}$/),
      }),
    ]);
    expect(JSON.stringify(service.listPendingClaims())).not.toMatch(
      /ticketProof|private key|cookie|csrf|hostHelloNonce/i,
    );
  });

  it("fails closed for expired, brute-force, and mismatched proofs without leaking ticket state", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 9),
    });
    const ticket = service.createTicket({ sourceClass: "tailscale" });
    for (let attempt = 0; attempt < PAIRING_MAX_FAILED_ATTEMPTS; attempt += 1) {
      try {
        service.claimTicket(claimInput(ticket.ticketId, "wrong_proof"));
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(PairingDeviceLifecycleError);
        expect((error as PairingDeviceLifecycleError).category).toBe("unauthorized");
        expect(String(error)).not.toContain(ticket.ticketProof);
      }
    }
    try {
      service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PairingDeviceLifecycleError);
      expect((error as PairingDeviceLifecycleError).category).toBe("unauthorized");
    }

    const expired = createService({
      nowMs,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 3),
    });
    const timed = expired.service.createTicket({ sourceClass: "lan-private" });
    const later = createService({
      nowMs: nowMs + PAIRING_TICKET_TTL_MS + 1,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 4),
    });
    // recreate service state is independent; use the first service with advanced now
    const store = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 5),
    });
    const live = store.service.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      store.service.claimTicket(
        {
          ...claimInput(live.ticketId, live.ticketProof),
        },
        nowMs + PAIRING_TICKET_TTL_MS + 1,
      ),
    ).toThrow(PairingDeviceLifecycleError);
    void timed;
    void later;
  });

  it("approves a claimed ticket into a durable device registration and denies duplicates", () => {
    const { service, connection, journal, projection } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 11),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    const approved = service.approveTicket({ ticketId: ticket.ticketId });
    expect(approved.device.hostId).toBe(hostId);
    expect(approved.device.state).toBe("active");
    expect(approved.device.credentialGeneration).toBe(1);
    expect(approved.device.deviceLabel).toBe("Ada's Safari");
    expect(approved.device.expiresAt).toBe(
      new Date(
        Math.min(nowMs + DEVICE_ABSOLUTE_TTL_MS, nowMs + DEVICE_INACTIVITY_TTL_MS),
      ).toISOString(),
    );
    expect(fieldsMatching(approved, /ticketProof|cookie|csrf|private ?key/i)).toEqual([]);
    expect(JSON.stringify(approved)).not.toContain(ticket.ticketProof);

    const devices = readDeviceRegistrations(connection);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      device_label: "Ada's Safari",
      state: "active",
      origin: "https://mac.example.test",
    });

    const approvedAgain = service.approveTicket({ ticketId: ticket.ticketId });
    expect(approvedAgain.device.deviceId).toBe(approved.device.deviceId);
    expect(readDeviceRegistrations(connection)).toHaveLength(1);
    expect(
      connection
        .prepare(
          "SELECT count(*) AS count FROM event_journal WHERE event_name = 'remote.device-registered@1'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(() =>
      service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "user-denied" }),
    ).toThrow(PairingDeviceLifecycleError);

    rebuildProjection({
      connection,
      journal,
      projection,
      clock: () => nowIso,
    });
    expect(readDeviceRegistrations(connection)).toHaveLength(1);
  });

  it("denies a claimed ticket without creating a device and keeps denial idempotent", () => {
    const { service, connection } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 7),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    const denied = service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "user-denied" });
    expect(denied.decision).toBe("denied");
    expect(readDeviceRegistrations(connection)).toHaveLength(0);
    const deniedAgain = service.denyTicket({
      ticketId: ticket.ticketId,
      reasonCode: "user-denied",
    });
    expect(deniedAgain.decision).toBe("denied");
    expect(readDeviceRegistrations(connection)).toHaveLength(0);
    expect(
      connection
        .prepare(
          "SELECT count(*) AS count FROM event_journal WHERE event_name = 'remote.security-audit-recorded@1'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("renames an active device with a bounded label and rejects unsafe labels", () => {
    const { service, connection } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 21),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    const approved = service.approveTicket({ ticketId: ticket.ticketId });
    const renamed = service.renameDevice({
      deviceId: approved.device.deviceId,
      deviceLabel: "  Living Room iPad  ",
    });
    expect(renamed.deviceLabel).toBe("Living Room iPad");
    expect(readDeviceRegistrations(connection)[0]).toMatchObject({
      device_label: "Living Room iPad",
    });
    expect(() =>
      service.renameDevice({
        deviceId: approved.device.deviceId,
        deviceLabel: "bad\nlabel",
      }),
    ).toThrow(PairingDeviceLifecycleError);
  });

  it("rejects client-controlled sourceClass mismatch against the server-owned ticket", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 8),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      service.claimTicket(
        claimInput(ticket.ticketId, ticket.ticketProof, { sourceClass: "tailscale" }),
      ),
    ).toThrow(PairingDeviceLifecycleError);
    const claim = service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    expect(claim.sourceClass).toBe("lan-private");
  });

  it("uses authoritative aggregate heads after restart for rename and sequential denial audit", () => {
    const first = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 31),
    });
    const approvedTicket = first.service.createTicket({ sourceClass: "lan-private" });
    first.service.claimTicket(claimInput(approvedTicket.ticketId, approvedTicket.ticketProof));
    const approved = first.service.approveTicket({ ticketId: approvedTicket.ticketId });

    const deniedTicket = first.service.createTicket({ sourceClass: "lan-private" });
    first.service.claimTicket(claimInput(deniedTicket.ticketId, deniedTicket.ticketProof));
    first.service.denyTicket({ ticketId: deniedTicket.ticketId, reasonCode: "user-denied" });

    const restarted = createService({
      connection: first.connection,
      journal: first.journal,
      projection: first.projection,
      initializeHost: false,
      uuidSeed: 100,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 12),
    });
    const renamed = restarted.service.renameDevice({
      deviceId: approved.device.deviceId,
      deviceLabel: "Restarted Device",
    });
    expect(renamed.deviceLabel).toBe("Restarted Device");
    expect(readDeviceRegistrations(first.connection)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ device_label: "Restarted Device", state: "active" }),
      ]),
    );

    const another = restarted.service.createTicket({ sourceClass: "tailscale" });
    restarted.service.claimTicket(claimInput(another.ticketId, another.ticketProof));
    const denied = restarted.service.denyTicket({
      ticketId: another.ticketId,
      reasonCode: "user-denied",
    });
    expect(denied.decision).toBe("denied");
    expect(
      first.connection
        .prepare(
          "SELECT count(*) AS count FROM event_journal WHERE event_name = 'remote.security-audit-recorded@1'",
        )
        .get(),
    ).toEqual({ count: 3 });
  });

  it("forgets decided-ticket replay after absolute ticket expiry", () => {
    const clock = { nowMs };
    const { service, connection } = createService({
      clock,
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 41),
    });

    const approvedTicket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(approvedTicket.ticketId, approvedTicket.ticketProof));
    const approved = service.approveTicket({ ticketId: approvedTicket.ticketId });
    expect(service.approveTicket({ ticketId: approvedTicket.ticketId }).device.deviceId).toBe(
      approved.device.deviceId,
    );

    const deniedTicket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(deniedTicket.ticketId, deniedTicket.ticketProof));
    const denied = service.denyTicket({
      ticketId: deniedTicket.ticketId,
      reasonCode: "user-denied",
    });
    expect(
      service.denyTicket({ ticketId: deniedTicket.ticketId, reasonCode: "user-denied" }).decision,
    ).toBe(denied.decision);

    clock.nowMs = nowMs + PAIRING_TICKET_TTL_MS + 1;
    expect(() => service.approveTicket({ ticketId: approvedTicket.ticketId })).toThrow(
      PairingDeviceLifecycleError,
    );
    expect(() =>
      service.denyTicket({ ticketId: deniedTicket.ticketId, reasonCode: "user-denied" }),
    ).toThrow(PairingDeviceLifecycleError);
    expect(readDeviceRegistrations(connection)).toHaveLength(1);
  });

  it("requires exact normalized denial reason for same-decision replay", () => {
    const { service, connection } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 17),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    const denied = service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "user-denied" });
    expect(denied.reasonCode).toBe("user-denied");
    expect(
      service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "  USER-DENIED  " }).decision,
    ).toBe("denied");
    expect(() =>
      service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "other-reason" }),
    ).toThrow(PairingDeviceLifecycleError);
    expect(() => service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "!!" })).toThrow(
      PairingDeviceLifecycleError,
    );
    expect(
      connection
        .prepare(
          "SELECT count(*) AS count FROM event_journal WHERE event_name = 'remote.security-audit-recorded@1'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("keeps ticket TTL fixed at five minutes and drops pending tickets after host restart", () => {
    const clock = { nowMs };
    const first = createService({
      clock,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 15),
    });
    const ticket = first.service.createTicket({ sourceClass: "lan-private" });
    expect(ticket.expiresAt).toBe(nowMs + PAIRING_TICKET_TTL_MS);
    expect(() =>
      // @ts-expect-error ttl override is intentionally unsupported in production
      first.service.createTicket({ sourceClass: "lan-private", ttlMs: 60_000 }),
    ).toThrow(PairingDeviceLifecycleError);

    const restarted = createService({
      connection: first.connection,
      journal: first.journal,
      projection: first.projection,
      initializeHost: false,
      clock,
      uuidSeed: 200,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 16),
    });
    expect(() =>
      restarted.service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof)),
    ).toThrow(PairingDeviceLifecycleError);
    expect(JSON.stringify(readDeviceRegistrations(first.connection))).not.toMatch(
      /ticketProof|proofDigest|private key/i,
    );
  });

  it("reports generic pending/approved/failed status for body-carried ticket id and proof", () => {
    const clock = { nowMs };
    const { service } = createService({
      clock,
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 51),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });

    expect(
      service.ticketStatus({ ticketId: ticket.ticketId, ticketProof: ticket.ticketProof }),
    ).toEqual({ status: "pending" });
    expect(
      service.ticketStatus({ ticketId: ticket.ticketId, ticketProof: "wrong_proof" }).status,
    ).toBe("failed");

    service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    expect(
      service.ticketStatus({ ticketId: ticket.ticketId, ticketProof: ticket.ticketProof }),
    ).toEqual({ status: "pending" });

    const approved = service.approveTicket({ ticketId: ticket.ticketId });
    const status = service.ticketStatus({
      ticketId: ticket.ticketId,
      ticketProof: ticket.ticketProof,
    });
    expect(status).toEqual({
      status: "approved",
      deviceId: approved.device.deviceId,
      credentialGeneration: approved.device.credentialGeneration,
    });
    expect(JSON.stringify(status)).not.toContain(ticket.ticketProof);
    expect(fieldsMatching(status, /comparisonCode|devicePublicKey|private ?key/i)).toEqual([]);
  });

  it("returns generic failure for unknown, denied, and expired tickets without state leaks", () => {
    const clock = { nowMs };
    const { service } = createService({
      clock,
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 61),
    });
    expect(
      service.ticketStatus({
        ticketId: "99999999-9999-4999-8999-999999999999",
        ticketProof: "unknown_proof",
      }),
    ).toEqual({ status: "failed" });

    const deniedTicket = service.createTicket({ sourceClass: "tailscale" });
    service.claimTicket(claimInput(deniedTicket.ticketId, deniedTicket.ticketProof));
    service.denyTicket({ ticketId: deniedTicket.ticketId, reasonCode: "user-denied" });
    expect(
      service.ticketStatus({
        ticketId: deniedTicket.ticketId,
        ticketProof: deniedTicket.ticketProof,
      }),
    ).toEqual({ status: "failed" });

    const expiring = service.createTicket({ sourceClass: "lan-private" });
    clock.nowMs = nowMs + PAIRING_TICKET_TTL_MS + 1;
    expect(
      service.ticketStatus({ ticketId: expiring.ticketId, ticketProof: expiring.ticketProof }),
    ).toEqual({ status: "failed" });
  });

  it("counts wrong-proof status polls against the shared brute-force budget", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 71),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    for (let attempt = 0; attempt < PAIRING_MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect(
        service.ticketStatus({ ticketId: ticket.ticketId, ticketProof: "wrong_proof" }),
      ).toEqual({ status: "failed" });
    }
    expect(
      service.ticketStatus({ ticketId: ticket.ticketId, ticketProof: ticket.ticketProof }),
    ).toEqual({ status: "failed" });
    expect(() => service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof))).toThrow(
      PairingDeviceLifecycleError,
    );
  });

  it("caps live tickets and claimed undecided pairings with generic failures", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 81),
    });
    const tickets = [];
    for (let index = 0; index < MAX_LIVE_PAIRING_TICKETS; index += 1) {
      tickets.push(service.createTicket({ sourceClass: "lan-private" }));
    }
    try {
      service.createTicket({ sourceClass: "lan-private" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PairingDeviceLifecycleError);
      expect((error as PairingDeviceLifecycleError).category).toBe("unavailable");
    }

    for (let index = 0; index < MAX_UNDECIDED_PAIRING_CLAIMS; index += 1) {
      const ticket = tickets[index]!;
      service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    }
    const next = tickets[MAX_UNDECIDED_PAIRING_CLAIMS]!;
    try {
      service.claimTicket(claimInput(next.ticketId, next.ticketProof));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PairingDeviceLifecycleError);
      expect((error as PairingDeviceLifecycleError).category).toBe("unauthorized");
      expect(String(error)).not.toContain(next.ticketProof);
    }
  });

  it("rejects malformed, non-P256, private, and fingerprint-mismatched device keys generically", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 91),
    });

    const malformed = service.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      service.claimTicket(
        claimInput(malformed.ticketId, malformed.ticketProof, {
          devicePublicKey: "not-a-public-key",
        }),
      ),
    ).toThrow(PairingDeviceLifecycleError);

    const nonP256 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const nonP256Pem = nonP256.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
    const nonP256Ticket = service.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      service.claimTicket(
        claimInput(nonP256Ticket.ticketId, nonP256Ticket.ticketProof, {
          devicePublicKey: nonP256Pem,
          deviceKeyFingerprint: canonicalDeviceKeyFacts(nonP256Pem)?.fingerprint ?? "0".repeat(64),
        }),
      ),
    ).toThrow(PairingDeviceLifecycleError);

    const privatePem = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    const privateTicket = service.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      service.claimTicket(
        claimInput(privateTicket.ticketId, privateTicket.ticketProof, {
          devicePublicKey: privatePem,
        }),
      ),
    ).toThrow(PairingDeviceLifecycleError);

    const mismatched = service.createTicket({ sourceClass: "lan-private" });
    const otherKey = testDeviceKey();
    try {
      service.claimTicket(
        claimInput(mismatched.ticketId, mismatched.ticketProof, {
          devicePublicKey: otherKey.publicPem,
        }),
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PairingDeviceLifecycleError);
      expect((error as PairingDeviceLifecycleError).category).toBe("unauthorized");
      expect(String(error)).not.toContain(mismatched.ticketProof);
    }

    // Failed key validation does not consume the ticket's proof-attempt budget.
    const claim = service.claimTicket(claimInput(mismatched.ticketId, mismatched.ticketProof));
    expect(claim.kind).toBe("pending");
  });

  it("persists the canonical SPKI key and DER fingerprint on approval", () => {
    const { service, connection } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 95),
    });
    const spacedPem = `-----BEGIN PUBLIC KEY-----\n${defaultDeviceKey.publicPem.replace(
      /-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g,
      "",
    )}\n-----END PUBLIC KEY-----`;
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(
      claimInput(ticket.ticketId, ticket.ticketProof, { devicePublicKey: spacedPem }),
    );
    const approved = service.approveTicket({ ticketId: ticket.ticketId });
    expect(approved.device.devicePublicKey).toBe(defaultDeviceKey.publicPem);
    expect(approved.device.deviceKeyFingerprint).toBe(defaultDeviceKey.fingerprint);
    const row = readDeviceRegistrations(connection)[0];
    expect(row?.device_public_key).toBe(defaultDeviceKey.publicPem);
    expect(row?.device_key_fingerprint).toBe(defaultDeviceKey.fingerprint);
  });

  it("re-derives the comparison code for host approval from retained digests only", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 97),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    expect(service.deriveComparisonCode(ticket.ticketId)).toBeUndefined();
    const claim = service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    const derived = service.deriveComparisonCode(ticket.ticketId);
    expect(derived).toBe(claim.comparisonCode);
    expect(service.deriveComparisonCode(ticket.ticketId)).toBe(derived);
    expect(service.deriveComparisonCode("99999999-9999-4999-8999-999999999999")).toBeUndefined();
  });

  it("clears ephemeral pairing state on listener disable while durable devices survive", () => {
    const { service, connection } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 101),
    });
    const approvedTicket = service.createTicket({ sourceClass: "lan-private" });
    service.claimTicket(claimInput(approvedTicket.ticketId, approvedTicket.ticketProof));
    const approved = service.approveTicket({ ticketId: approvedTicket.ticketId });

    const live = service.createTicket({ sourceClass: "tailscale" });
    service.claimTicket(claimInput(live.ticketId, live.ticketProof));

    service.clearEphemeralState();

    expect(
      service.ticketStatus({ ticketId: live.ticketId, ticketProof: live.ticketProof }),
    ).toEqual({ status: "failed" });
    expect(
      service.ticketStatus({
        ticketId: approvedTicket.ticketId,
        ticketProof: approvedTicket.ticketProof,
      }),
    ).toEqual({ status: "failed" });
    expect(service.deriveComparisonCode(live.ticketId)).toBeUndefined();
    expect(() => service.approveTicket({ ticketId: live.ticketId })).toThrow(
      PairingDeviceLifecycleError,
    );
    expect(() =>
      service.denyTicket({ ticketId: live.ticketId, reasonCode: "user-denied" }),
    ).toThrow(PairingDeviceLifecycleError);
    expect(() => service.claimTicket(claimInput(live.ticketId, live.ticketProof))).toThrow(
      PairingDeviceLifecycleError,
    );

    expect(service.listDevices().map((device) => device.deviceId)).toEqual([
      approved.device.deviceId,
    ]);
    const renamed = service.renameDevice({
      deviceId: approved.device.deviceId,
      deviceLabel: "Surviving Device",
    });
    expect(renamed.deviceLabel).toBe("Surviving Device");
    expect(readDeviceRegistrations(connection)).toHaveLength(1);
  });

  it("binds the comparison transcript to canonical client hello facts", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 99),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    const clientHello = {
      webBuildVersion: "0.1.0",
      supportedProtocolRange: { min: 1, max: 2 },
      browserCapabilities: ["indexeddb", "webcrypto"],
    };
    const claim = service.claimTicket(
      claimInput(ticket.ticketId, ticket.ticketProof, { clientHello }),
    );
    const expected = derivePairingComparisonCode({
      hostId,
      ticketId: ticket.ticketId,
      sourceClass: "lan-private",
      ticketProofDigest: sha256DigestHex(ticket.ticketProof),
      claim: sanitizeClaimRecord({
        devicePublicKey: defaultDeviceKey.publicPem,
        deviceKeyFingerprint: defaultDeviceKey.fingerprint,
        deviceLabel: "Ada's Safari",
        origin: "https://mac.example.test",
        clientHelloDigest: sha256DigestHex(buildClientHelloTranscriptPayload(clientHello)),
        hostHelloNonceDigest: sha256DigestHex("nonce_1234567890"),
        claimedAt: nowMs,
      }),
    });
    expect(claim.comparisonCode).toBe(expected);
    expect(service.deriveComparisonCode(ticket.ticketId)).toBe(expected);
  });

  it("clears the retained claim after approval so deriveComparisonCode is undefined while idempotency survives", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 103),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    const claim = service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    expect(claim.comparisonCode).toMatch(/^\d{6}$/);
    expect(service.deriveComparisonCode(ticket.ticketId)).toBe(claim.comparisonCode);

    const approved = service.approveTicket({ ticketId: ticket.ticketId });
    expect(approved.device.deviceId).toBeDefined();
    // The comparison code is no longer derivable after approval.
    expect(service.deriveComparisonCode(ticket.ticketId)).toBeUndefined();
    // Same-decision idempotency survives from decision/deviceId, not claim.
    const reapproved = service.approveTicket({ ticketId: ticket.ticketId });
    expect(reapproved.device.deviceId).toBe(approved.device.deviceId);
    // Status still resolves to approved from durable device state.
    expect(
      service.ticketStatus({ ticketId: ticket.ticketId, ticketProof: ticket.ticketProof }),
    ).toEqual({
      status: "approved",
      deviceId: approved.device.deviceId,
      credentialGeneration: approved.device.credentialGeneration,
    });
  });

  it("clears the retained claim after denial so deriveComparisonCode is undefined while idempotency survives", () => {
    const { service } = createService({
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 107),
    });
    const ticket = service.createTicket({ sourceClass: "lan-private" });
    const claim = service.claimTicket(claimInput(ticket.ticketId, ticket.ticketProof));
    expect(service.deriveComparisonCode(ticket.ticketId)).toBe(claim.comparisonCode);

    const denied = service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "user-denied" });
    expect(denied.decision).toBe("denied");
    expect(service.deriveComparisonCode(ticket.ticketId)).toBeUndefined();
    // Same-decision idempotency survives from decision.
    expect(
      service.denyTicket({ ticketId: ticket.ticketId, reasonCode: "user-denied" }).decision,
    ).toBe("denied");
    // A conflicting decision is rejected.
    expect(() => service.approveTicket({ ticketId: ticket.ticketId })).toThrow(
      PairingDeviceLifecycleError,
    );
  });

  it("freezes the sanitized retained claim so it cannot be mutated after claim", () => {
    const claim = sanitizeClaimRecord({
      devicePublicKey: defaultDeviceKey.publicPem,
      deviceKeyFingerprint: defaultDeviceKey.fingerprint,
      deviceLabel: "Ada's Safari",
      origin: "https://mac.example.test",
      clientHelloDigest: sha256DigestHex("client-hello"),
      hostHelloNonceDigest: sha256DigestHex("nonce"),
      claimedAt: nowMs,
    });
    expect(Object.isFrozen(claim)).toBe(true);
    expect(() => {
      (claim as { deviceLabel: string }).deviceLabel = "Tampered";
    }).toThrow();
  });
});
