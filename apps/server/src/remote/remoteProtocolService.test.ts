import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeStableHostId,
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR,
  type DeviceRegistrationV1,
  type HostHelloV1,
} from "@octant/contracts/remote-access";
import { buildRemoteChallengeProofPayload, sessionExpiry } from "@octant/domain";
import {
  buildHostHelloSignaturePayload,
  buildNegotiatedProtocolPayload,
  HOST_HELLO_NONCE_TTL_MS,
  MAX_HOST_HELLO_NONCES,
  MAX_PENDING_NEGOTIATIONS,
} from "@octant/domain/remote-protocol-policy";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { PairingDeviceLifecycleService } from "./pairingDeviceLifecycleService";
import { RemoteRequestProofService } from "../remoteRequestProofService";
import {
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST,
  RemoteProtocolError,
  RemoteProtocolService,
  type HostSigningPort,
} from "./remoteProtocolService";

const directories: string[] = [];
const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const actorId = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";
const nowIso = "2026-07-29T09:00:00.000Z";
const nowMs = Date.parse(nowIso);
const ORIGIN = "https://mac.example.test";
const CLIENT_HELLO = {
  webBuildVersion: "0.1.0",
  supportedProtocolRange: { min: 1, max: 1 },
  browserCapabilities: ["webcrypto"],
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(options?: {
  readonly clock?: { nowMs: number };
  readonly securityFloor?: number;
  readonly supportedProtocolRange?: { readonly min: number; readonly max: number };
  readonly authenticationProtocolVersions?: ReadonlyArray<number>;
}) {
  const clock = options?.clock ?? { nowMs };
  const directory = mkdtempSync(join(tmpdir(), "octant-remote-protocol-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => nowIso);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date(clock.nowMs).toISOString(),
  });
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
  let n = 0;
  const uuid = () => {
    n += 1;
    return `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
  };
  const lifecycle = new PairingDeviceLifecycleService({
    hostId,
    journal,
    connection,
    now: () => clock.nowMs,
    uuid,
    correlationId: () => correlationId,
    actorId: () => actorId,
  });
  const hostKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const hostPublicDer = hostKeys.publicKey.export({ format: "der", type: "spki" });
  const hostPublicPem = hostKeys.publicKey.export({ format: "pem", type: "spki" });
  const signCalls: string[] = [];
  const signing: HostSigningPort = {
    hostKeyFingerprint: createHash("sha256").update(hostPublicDer).digest("hex"),
    signHostPayload: (payload) => {
      signCalls.push(payload);
      return sign("sha256", Buffer.from(payload, "utf8"), {
        key: hostKeys.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
    },
  };
  const service = new RemoteProtocolService({
    hostId,
    displayName: "This Mac",
    serverBuildVersion: "0.1.0",
    remoteOrigin: ORIGIN,
    supportedProtocolRange: options?.supportedProtocolRange ?? { min: 1, max: 1 },
    securityFloor: options?.securityFloor ?? 1,
    ...(options?.authenticationProtocolVersions === undefined
      ? {}
      : { authenticationProtocolVersions: options.authenticationProtocolVersions }),
    signing,
    lifecycle,
    journal,
    connection,
    now: () => clock.nowMs,
    uuid,
    correlationId: () => correlationId,
    actorId: () => actorId,
  });
  const proofService = new RemoteRequestProofService(connection, {
    now: () => clock.nowMs,
    randomUUID: uuid,
    resolveNegotiation: (input) => service.resolveNegotiation(input),
  });
  return {
    service,
    lifecycle,
    proofService,
    connection,
    journal,
    clock,
    signing,
    signCalls,
    hostPublicDer,
    hostPublicPem,
  };
}

type Fixture = ReturnType<typeof createFixture>;

function deviceKeypair() {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  return {
    keys,
    publicPem: keys.publicKey.export({ format: "pem", type: "spki" }).trim(),
    fingerprint: createHash("sha256").update(publicDer).digest("hex"),
  };
}

function claimRequest(
  ticket: { readonly ticketId: string; readonly ticketProof: string },
  nonce: string,
  device: ReturnType<typeof deviceKeypair>,
  overrides: Record<string, unknown> = {},
) {
  return {
    ticketId: ticket.ticketId,
    ticketProof: ticket.ticketProof,
    hostHelloNonce: nonce,
    devicePublicKey: device.publicPem,
    deviceKeyFingerprint: device.fingerprint,
    deviceLabel: "Ada's Safari",
    origin: ORIGIN,
    clientHello: CLIENT_HELLO,
    ...overrides,
  };
}

function pairDevice(fx: Fixture, device: ReturnType<typeof deviceKeypair>) {
  const ticket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
  const hello = fx.service.issueHostHello();
  fx.service.claimPairing({
    sourceClass: "lan-private",
    request: claimRequest(ticket, hello.nonce, device),
  });
  const approved = fx.lifecycle.approveTicket({ ticketId: ticket.ticketId });
  return { ticket, hello, device: approved.device };
}

function negotiateRequest(
  challengeId: string,
  deviceId: string,
  nonce: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    hostHelloNonce: nonce,
    challengeId,
    deviceId,
    origin: ORIGIN,
    clientHello: CLIENT_HELLO,
    ...overrides,
  };
}

function negotiateDevice(
  fx: Fixture,
  device: DeviceRegistrationV1,
  requestOverrides: Record<string, unknown> = {},
) {
  const challenge = fx.proofService.issueChallenge({
    hostId,
    deviceId: device.deviceId,
    credentialGeneration: device.credentialGeneration,
  });
  const hello = fx.service.issueHostHello();
  const negotiated = fx.service.negotiate({
    sourceClass: "lan-private",
    request: negotiateRequest(
      challenge.challengeId,
      device.deviceId,
      hello.nonce,
      requestOverrides,
    ),
  });
  return { challenge, negotiated };
}

function verifyHostHello(fx: Fixture, hello: HostHelloV1): boolean {
  const { signature, ...sans } = hello;
  return verify(
    "sha256",
    Buffer.from(buildHostHelloSignaturePayload(sans), "utf8"),
    { key: fx.hostPublicPem, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

describe("RemoteProtocolService constructor validation", () => {
  function baseOptions(overrides: Record<string, unknown> = {}) {
    const fx = createFixture();
    return {
      hostId,
      displayName: "This Mac",
      serverBuildVersion: "0.1.0",
      remoteOrigin: ORIGIN,
      supportedProtocolRange: { min: 1, max: 1 },
      securityFloor: 1,
      signing: fx.signing,
      lifecycle: fx.lifecycle,
      journal: fx.journal,
      connection: fx.connection,
      now: () => fx.clock.nowMs,
      ...overrides,
    };
  }

  it("rejects non-https, userinfo, path, query, fragment, trailing slash, default-port, and case-alias origins", () => {
    for (const origin of [
      "http://mac.example.test",
      "https://user@mac.example.test",
      "https://user:pass@mac.example.test",
      "https://mac.example.test/",
      "https://mac.example.test/path",
      "https://mac.example.test?q=1",
      "https://mac.example.test#frag",
      "https://mac.example.test:443",
      "https://MAC.EXAMPLE.TEST",
      "HTTPS://mac.example.test",
      "ftp://mac.example.test",
      "not-a-url",
      "",
    ]) {
      expect(() => new RemoteProtocolService(baseOptions({ remoteOrigin: origin }))).toThrow(
        RemoteProtocolError,
      );
    }
  });

  it("accepts an exact canonical https origin without trailing slash, and a canonical non-default port", () => {
    expect(
      () => new RemoteProtocolService(baseOptions({ remoteOrigin: "https://mac.example.test" })),
    ).not.toThrow();
    expect(
      () =>
        new RemoteProtocolService(baseOptions({ remoteOrigin: "https://mac.example.test:8443" })),
    ).not.toThrow();
  });

  it("rejects incoherent supported protocol range (min>max, non-integer, non-positive)", () => {
    for (const range of [
      { min: 2, max: 1 },
      { min: 0, max: 1 },
      { min: 1, max: 0 },
      { min: -1, max: 1 },
      { min: 1.5, max: 2 },
      { min: 1, max: 2.5 },
      { min: NaN, max: 1 },
      { min: 1, max: NaN },
      { min: Infinity, max: 1 },
    ]) {
      expect(
        () => new RemoteProtocolService(baseOptions({ supportedProtocolRange: range })),
      ).toThrow(RemoteProtocolError);
    }
  });

  it("rejects security floor outside the supported range", () => {
    expect(() => new RemoteProtocolService(baseOptions({ securityFloor: 0 }))).toThrow(
      RemoteProtocolError,
    );
    expect(() => new RemoteProtocolService(baseOptions({ securityFloor: 2 }))).toThrow(
      RemoteProtocolError,
    );
    expect(
      () =>
        new RemoteProtocolService(
          baseOptions({ supportedProtocolRange: { min: 1, max: 3 }, securityFloor: 4 }),
        ),
    ).toThrow(RemoteProtocolError);
  });

  it("rejects empty or incoherent authentication protocol versions", () => {
    expect(
      () => new RemoteProtocolService(baseOptions({ authenticationProtocolVersions: [] })),
    ).toThrow(RemoteProtocolError);
    expect(
      () => new RemoteProtocolService(baseOptions({ authenticationProtocolVersions: [0] })),
    ).toThrow(RemoteProtocolError);
    expect(
      () => new RemoteProtocolService(baseOptions({ authenticationProtocolVersions: [-1] })),
    ).toThrow(RemoteProtocolError);
    expect(
      () => new RemoteProtocolService(baseOptions({ authenticationProtocolVersions: [1.5] })),
    ).toThrow(RemoteProtocolError);
    expect(
      () =>
        new RemoteProtocolService(
          baseOptions({ authenticationProtocolVersions: [Number.MAX_SAFE_INTEGER + 1] }),
        ),
    ).toThrow(RemoteProtocolError);
  });

  it("rejects NaN or fractional security floor", () => {
    expect(() => new RemoteProtocolService(baseOptions({ securityFloor: NaN }))).toThrow(
      RemoteProtocolError,
    );
    expect(() => new RemoteProtocolService(baseOptions({ securityFloor: 1.5 }))).toThrow(
      RemoteProtocolError,
    );
    expect(() => new RemoteProtocolService(baseOptions({ securityFloor: Infinity }))).toThrow(
      RemoteProtocolError,
    );
  });
});

describe("RemoteProtocolService host hello", () => {
  it("issues a signed bounded host hello through the injected port only", () => {
    const fx = createFixture();
    const hello = fx.service.issueHostHello();
    expect(Object.keys(hello).sort()).toEqual(
      [
        "productId",
        "hostId",
        "displayName",
        "hostKeyFingerprint",
        "serverBuildVersion",
        "supportedProtocolRange",
        "authenticationProtocolVersions",
        "securityFloor",
        "remoteOrigin",
        "nonce",
        "expiresAt",
        "signature",
      ].sort(),
    );
    expect(JSON.stringify(hello)).not.toMatch(
      /projects|threads|providers|models|roots|worktree|devices|username/i,
    );
    expect(hello.hostKeyFingerprint).toBe(fx.signing.hostKeyFingerprint);
    expect(hello.expiresAt).toBe(new Date(nowMs + HOST_HELLO_NONCE_TTL_MS).toISOString());
    expect(fx.signCalls).toHaveLength(1);
    expect(verifyHostHello(fx, hello)).toBe(true);
  });

  it("produces WebCrypto-compatible P-256 signatures and the identity-only digest", async () => {
    const fx = createFixture();
    const hello = fx.service.issueHostHello();
    const subtle = globalThis.crypto?.subtle;
    expect(subtle).toBeDefined();
    const key = await subtle.importKey(
      "spki",
      new Uint8Array(fx.hostPublicDer),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const { signature, ...sans } = hello;
    const payload = new TextEncoder().encode(buildHostHelloSignaturePayload(sans));
    const signatureBytes = new Uint8Array(Buffer.from(signature, "base64url"));
    await expect(
      subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes, payload),
    ).resolves.toBe(true);
    await expect(
      subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signatureBytes,
        new TextEncoder().encode("tampered"),
      ),
    ).resolves.toBe(false);
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR),
    );
    expect(Buffer.from(digest).toString("hex")).toBe(REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST);
    expect(REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST).toBe(
      createHash("sha256").update("remote-authentication-only:v1", "utf8").digest("hex"),
    );
  });

  it("caps live hello nonces and clears them deterministically", { timeout: 20_000 }, () => {
    const clock = { nowMs };
    const fx = createFixture({ clock });
    for (let index = 0; index < MAX_HOST_HELLO_NONCES; index += 1) {
      fx.service.issueHostHello();
    }
    expect(() => fx.service.issueHostHello()).toThrow(RemoteProtocolError);
    try {
      fx.service.issueHostHello();
    } catch (error) {
      expect((error as RemoteProtocolError).category).toBe("unavailable");
    }

    clock.nowMs = nowMs + HOST_HELLO_NONCE_TTL_MS + 1;
    expect(fx.service.issueHostHello().nonce).toMatch(/^[A-Za-z0-9_-]+$/);

    const stale = fx.service.issueHostHello();
    fx.service.clearEphemeralState();
    const device = deviceKeypair();
    const ticket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(ticket, stale.nonce, device),
      }),
    ).toThrow(RemoteProtocolError);
  });

  it("clears tickets, claims, and negotiations on listener disable while devices survive", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { ticket, device: registered } = pairDevice(fx, device);
    const { challenge } = negotiateDevice(fx, registered);

    fx.service.clearEphemeralState();

    expect(
      fx.service.pairingStatus({ ticketId: ticket.ticketId, ticketProof: ticket.ticketProof }),
    ).toEqual({ status: "failed" });
    expect(
      fx.service.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: registered.credentialGeneration,
      }),
    ).toBeUndefined();
    expect(() => fx.lifecycle.approveTicket({ ticketId: ticket.ticketId })).toThrow();
    const freshTicket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    const freshHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(freshTicket, freshHello.nonce, device, {
          ticketId: ticket.ticketId,
          ticketProof: ticket.ticketProof,
        }),
      }),
    ).toThrow(RemoteProtocolError);
    expect(fx.lifecycle.listDevices().map((row) => row.deviceId)).toEqual([registered.deviceId]);
  });
});

describe("RemoteProtocolService pairing claim and status", () => {
  it("binds claims to host, configured origin, source class, key facts, and an issued nonce", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const ticket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    const hello = fx.service.issueHostHello();
    const claim = fx.service.claimPairing({
      sourceClass: "lan-private",
      request: claimRequest(ticket, hello.nonce, device),
    });
    expect(claim.kind).toBe("pending");
    expect(claim.comparisonCode).toMatch(/^\d{6}$/);
    expect(JSON.stringify(claim)).not.toContain(ticket.ticketProof);
    expect(JSON.stringify(claim)).not.toContain(hello.nonce);

    const secondTicket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(secondTicket, hello.nonce, device),
      }),
    ).toThrow(RemoteProtocolError);
  });

  it("rejects fabricated, expired, and restarted nonces plus wrong origin and source class", () => {
    const clock = { nowMs };
    const fx = createFixture({ clock });
    const device = deviceKeypair();

    const fabricated = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(fabricated, "fabricated_nonce", device),
      }),
    ).toThrow(RemoteProtocolError);

    const wrongOriginTicket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    const wrongOriginHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(wrongOriginTicket, wrongOriginHello.nonce, device, {
          origin: "https://other.example.test",
        }),
      }),
    ).toThrow(RemoteProtocolError);

    const unknownClassTicket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    const unknownClassHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "unknown",
        request: claimRequest(unknownClassTicket, unknownClassHello.nonce, device),
      }),
    ).toThrow(RemoteProtocolError);

    const expiredTicket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    const expiredHello = fx.service.issueHostHello();
    clock.nowMs = nowMs + HOST_HELLO_NONCE_TTL_MS + 1;
    try {
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(expiredTicket, expiredHello.nonce, device),
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProtocolError);
      expect((error as RemoteProtocolError).category).toBe("unauthorized");
      expect(String(error)).not.toContain(expiredHello.nonce);
      expect(String(error)).not.toContain(expiredTicket.ticketProof);
    }

    const restartedTicket = fx.lifecycle.createTicket({ sourceClass: "lan-private" });
    const restartedHello = fx.service.issueHostHello();
    const restarted = new RemoteProtocolService({
      hostId,
      displayName: "This Mac",
      serverBuildVersion: "0.1.0",
      remoteOrigin: ORIGIN,
      supportedProtocolRange: { min: 1, max: 1 },
      securityFloor: 1,
      signing: fx.signing,
      lifecycle: fx.lifecycle,
      journal: fx.journal,
      connection: fx.connection,
      now: () => clock.nowMs,
    });
    expect(() =>
      restarted.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(restartedTicket, restartedHello.nonce, device),
      }),
    ).toThrow(RemoteProtocolError);
  });

  it("polls pairing status from a bounded body with generic outcomes", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { ticket, device: registered } = pairDevice(fx, device);
    const approved = fx.service.pairingStatus({
      ticketId: ticket.ticketId,
      ticketProof: ticket.ticketProof,
    });
    expect(approved).toEqual({
      status: "approved",
      deviceId: registered.deviceId,
      credentialGeneration: registered.credentialGeneration,
    });
    expect(JSON.stringify(approved)).not.toContain(ticket.ticketProof);

    expect(fx.service.pairingStatus({ ticketId: ticket.ticketId, ticketProof: "wrong" })).toEqual({
      status: "failed",
    });
    expect(fx.service.pairingStatus({ ticketId: "not-a-uuid" })).toEqual({ status: "failed" });
    expect(fx.service.pairingStatus("garbage")).toEqual({ status: "failed" });
    expect(
      fx.service.pairingStatus({
        ticketId: "99999999-9999-4999-8999-999999999999",
        ticketProof: "unknown_proof",
      }),
    ).toEqual({ status: "failed" });
  });

  it("never lets used, copied, or brute-forced claims create a second device", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { ticket } = pairDevice(fx, device);

    const copiedHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(ticket, copiedHello.nonce, device),
      }),
    ).toThrow(RemoteProtocolError);
    expect(() => fx.lifecycle.approveTicket({ ticketId: ticket.ticketId })).not.toThrow();

    const thief = deviceKeypair();
    const thiefHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.claimPairing({
        sourceClass: "lan-private",
        request: claimRequest(ticket, thiefHello.nonce, thief),
      }),
    ).toThrow(RemoteProtocolError);

    const devices = fx.lifecycle.listDevices();
    expect(devices).toHaveLength(1);
    expect(
      fx.connection
        .prepare(
          "SELECT count(*) AS count FROM event_journal WHERE event_name = 'remote.device-registered@1'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });
});

describe("RemoteProtocolService negotiation", () => {
  it("negotiates the highest mutual version and records challenge-bound signed facts", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { ticket, device: registered } = pairDevice(fx, device);
    const { challenge, negotiated } = negotiateDevice(fx, registered);

    expect(negotiated.hostId).toBe(hostId);
    expect(negotiated.deviceId).toBe(registered.deviceId);
    expect(negotiated.challengeId).toBe(challenge.challengeId);
    expect(negotiated.protocolVersion).toBe(1);
    expect(negotiated.authenticationVersion).toBe(1);
    expect(negotiated.credentialGeneration).toBe(registered.credentialGeneration);
    expect(negotiated.origin).toBe(ORIGIN);
    expect(negotiated.capabilityDigest).toBe(REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST);
    expect(negotiated.expiresAt).toBe(challenge.expiresAt);
    expect(JSON.stringify(negotiated)).not.toMatch(/nonce|proof|secret|cookie|csrf|private/i);

    const { hostSignature, ...sans } = negotiated;
    expect(
      verify(
        "sha256",
        Buffer.from(buildNegotiatedProtocolPayload(sans), "utf8"),
        { key: fx.hostPublicPem, dsaEncoding: "ieee-p1363" },
        Buffer.from(hostSignature, "base64url"),
      ),
    ).toBe(true);

    expect(
      fx.service.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: registered.credentialGeneration,
      }),
    ).toEqual({
      origin: ORIGIN,
      protocolVersion: 1,
      authenticationVersion: 1,
      capabilityDigest: REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST,
    });
    expect(
      fx.service.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 99,
      }),
    ).toBeUndefined();

    const audits = fx.connection
      .prepare(
        "SELECT payload_json FROM event_journal WHERE event_name = 'remote.security-audit-recorded@1'",
      )
      .all() as ReadonlyArray<{ readonly payload_json: string }>;
    expect(audits.some((row) => row.payload_json.includes("session-negotiated"))).toBe(true);
    for (const row of audits) {
      expect(row.payload_json).not.toContain(challenge.challengeId);
      expect(row.payload_json).not.toContain(challenge.nonce);
      expect(row.payload_json).not.toContain(ticket.ticketProof);
      expect(row.payload_json).not.toMatch(/signature|csrf|cookie/i);
    }
  });

  it("installs no resolvable negotiation when the audit append fails", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);
    const brokenJournal = {
      append: () => {
        throw new Error("simulated journal failure");
      },
    };
    const broken = new RemoteProtocolService({
      hostId,
      displayName: "This Mac",
      serverBuildVersion: "0.1.0",
      remoteOrigin: ORIGIN,
      supportedProtocolRange: { min: 1, max: 1 },
      securityFloor: 1,
      signing: fx.signing,
      lifecycle: fx.lifecycle,
      journal: brokenJournal as unknown as ConstructorParameters<
        typeof RemoteProtocolService
      >[0]["journal"],
      connection: fx.connection,
      now: () => fx.clock.nowMs,
    });
    const challenge = fx.proofService.issueChallenge({
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: 1,
    });
    const hello = broken.issueHostHello();
    try {
      broken.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(challenge.challengeId, registered.deviceId, hello.nonce),
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProtocolError);
      expect((error as RemoteProtocolError).category).toBe("unavailable");
    }
    expect(
      fx.service.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 1,
      }),
    ).toBeUndefined();
    expect(
      broken.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 1,
      }),
    ).toBeUndefined();
  });

  it("installs no resolvable negotiation when the host signer throws", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);
    const brokenSigning: HostSigningPort = {
      hostKeyFingerprint: fx.signing.hostKeyFingerprint,
      signHostPayload: (payload) => {
        // Only the negotiated-protocol signature fails; host hello signing works.
        if (payload.startsWith("octant.negotiated-protocol.v1\n")) {
          throw new Error("simulated signer failure");
        }
        return fx.signing.signHostPayload(payload);
      },
    };
    const broken = new RemoteProtocolService({
      hostId,
      displayName: "This Mac",
      serverBuildVersion: "0.1.0",
      remoteOrigin: ORIGIN,
      supportedProtocolRange: { min: 1, max: 1 },
      securityFloor: 1,
      signing: brokenSigning,
      lifecycle: fx.lifecycle,
      journal: fx.journal,
      connection: fx.connection,
      now: () => fx.clock.nowMs,
    });
    const challenge = fx.proofService.issueChallenge({
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: 1,
    });
    const hello = broken.issueHostHello();
    try {
      broken.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(challenge.challengeId, registered.deviceId, hello.nonce),
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProtocolError);
      expect((error as RemoteProtocolError).category).toBe("unavailable");
    }
    expect(
      fx.service.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 1,
      }),
    ).toBeUndefined();
    expect(
      broken.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 1,
      }),
    ).toBeUndefined();
    // No audit was recorded because signing failed before the journal append.
    const audits = fx.connection
      .prepare(
        "SELECT payload_json FROM event_journal WHERE event_name = 'remote.security-audit-recorded@1'",
      )
      .all() as ReadonlyArray<{ readonly payload_json: string }>;
    expect(audits.some((row) => row.payload_json.includes("session-negotiated"))).toBe(false);
  });

  it("rejects re-negotiation of an installed challenge and burns every presented nonce", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);
    const { challenge, negotiated } = negotiateDevice(fx, registered);

    const secondHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(challenge.challengeId, registered.deviceId, secondHello.nonce),
      }),
    ).toThrow(RemoteProtocolError);

    const thirdHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(challenge.challengeId, registered.deviceId, thirdHello.nonce, {
          clientHello: { ...CLIENT_HELLO, supportedProtocolRange: { min: 1, max: 9 } },
        }),
      }),
    ).toThrow(RemoteProtocolError);

    // The first installed record is unchanged and cannot be downgraded or replaced.
    expect(
      fx.service.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 1,
      }),
    ).toEqual({
      origin: ORIGIN,
      protocolVersion: negotiated.protocolVersion,
      authenticationVersion: negotiated.authenticationVersion,
      capabilityDigest: REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST,
    });

    // The nonce burned by the failed re-negotiation cannot be reused elsewhere.
    const freshChallenge = fx.proofService.issueChallenge({
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: 1,
    });
    expect(() =>
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(
          freshChallenge.challengeId,
          registered.deviceId,
          secondHello.nonce,
        ),
      }),
    ).toThrow(RemoteProtocolError);
  });

  it("issues a session through the landed proof service from the recorded negotiation", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);
    const { challenge, negotiated } = negotiateDevice(fx, registered);

    const payload = buildRemoteChallengeProofPayload({
      challenge,
      sessionFacts: {
        origin: negotiated.origin,
        protocolVersion: negotiated.protocolVersion,
        authenticationVersion: negotiated.authenticationVersion,
        capabilityDigest: negotiated.capabilityDigest,
        ...sessionExpiry(Date.parse(challenge.issuedAt)),
      },
    });
    const signature = sign("sha256", Buffer.from(payload, "utf8"), {
      key: device.keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const session = fx.proofService.issueSession({ ...challenge, signature });
    expect(session.origin).toBe(ORIGIN);
    expect(session.protocolVersion).toBe(negotiated.protocolVersion);
    expect(session.authenticationVersion).toBe(negotiated.authenticationVersion);
    expect(session.capabilityDigest).toBe(REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST);

    const consumedHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(challenge.challengeId, registered.deviceId, consumedHello.nonce),
      }),
    ).toThrow(RemoteProtocolError);
  });

  it("binds authenticationVersion through resolveNegotiation into the challenge-session proof", () => {
    const fx = createFixture({
      authenticationProtocolVersions: [1, 2],
      supportedProtocolRange: { min: 1, max: 2 },
    });
    const device = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);
    const { challenge, negotiated } = negotiateDevice(fx, registered, {
      clientHello: { ...CLIENT_HELLO, supportedProtocolRange: { min: 1, max: 2 } },
    });
    expect(negotiated.authenticationVersion).toBe(2);

    const resolved = fx.service.resolveNegotiation({
      challengeId: challenge.challengeId,
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: registered.credentialGeneration,
    });
    expect(resolved?.authenticationVersion).toBe(2);

    const payload = buildRemoteChallengeProofPayload({
      challenge,
      sessionFacts: {
        origin: resolved!.origin,
        protocolVersion: resolved!.protocolVersion,
        authenticationVersion: resolved!.authenticationVersion,
        capabilityDigest: resolved!.capabilityDigest,
        ...sessionExpiry(Date.parse(challenge.issuedAt)),
      },
    });
    const signature = sign("sha256", Buffer.from(payload, "utf8"), {
      key: device.keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const session = fx.proofService.issueSession({ ...challenge, signature });
    expect(session.authenticationVersion).toBe(2);
  });

  it("rejects no-overlap, unsafe downgrade, and below-floor negotiation", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);

    const noOverlap = fx.proofService.issueChallenge({
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: 1,
    });
    const noOverlapHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(
          noOverlap.challengeId,
          registered.deviceId,
          noOverlapHello.nonce,
          {
            clientHello: { ...CLIENT_HELLO, supportedProtocolRange: { min: 2, max: 3 } },
          },
        ),
      }),
    ).toThrow(RemoteProtocolError);

    const floorFixture = createFixture({
      supportedProtocolRange: { min: 2, max: 2 },
      securityFloor: 2,
    });
    const floorDevice = deviceKeypair();
    const { device: floorRegistered } = pairDevice(floorFixture, floorDevice);
    const floorChallenge = floorFixture.proofService.issueChallenge({
      hostId,
      deviceId: floorRegistered.deviceId,
      credentialGeneration: 1,
    });
    const floorHello = floorFixture.service.issueHostHello();
    expect(() =>
      floorFixture.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(
          floorChallenge.challengeId,
          floorRegistered.deviceId,
          floorHello.nonce,
          {
            clientHello: { ...CLIENT_HELLO, supportedProtocolRange: { min: 1, max: 1 } },
          },
        ),
      }),
    ).toThrow(RemoteProtocolError);

    const highFixture = createFixture({
      supportedProtocolRange: { min: 2, max: 3 },
      securityFloor: 2,
    });
    const highDevice = deviceKeypair();
    const { device: highRegistered } = pairDevice(highFixture, highDevice);
    const high = negotiateDevice(highFixture, highRegistered, {
      clientHello: { ...CLIENT_HELLO, supportedProtocolRange: { min: 1, max: 2 } },
    });
    expect(high.negotiated.protocolVersion).toBe(2);
  });

  it("rejects negotiation against a device protocol floor mismatch", () => {
    const fx = createFixture();
    const floorDeviceId = "77777777-7777-4777-8777-777777777777";
    const device = deviceKeypair();
    fx.journal.append({
      aggregate: { aggregateType: "remote-device", aggregateId: floorDeviceId },
      expectedVersion: 0,
      events: [
        {
          eventId: "88888888-8888-4888-8888-888888888888",
          eventName: "remote.device-registered@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: nowIso,
          payload: {
            device: {
              hostId,
              deviceId: floorDeviceId,
              deviceKeyFingerprint: device.fingerprint,
              devicePublicKey: device.publicPem,
              deviceLabel: "Floor Device",
              origin: ORIGIN,
              protocolFloor: 2,
              credentialGeneration: 1,
              createdAt: nowIso,
              expiresAt: "2027-07-29T09:00:00.000Z",
              lastSeenAt: nowIso,
              state: "active",
            },
          },
        },
      ],
    });
    const challenge = fx.proofService.issueChallenge({
      hostId,
      deviceId: floorDeviceId,
      credentialGeneration: 1,
    });
    const hello = fx.service.issueHostHello();
    expect(() =>
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(challenge.challengeId, floorDeviceId, hello.nonce),
      }),
    ).toThrow(RemoteProtocolError);
  });

  it("rejects unknown, mismatched, and cross-device challenges with generic failures", () => {
    const fx = createFixture();
    const device = deviceKeypair();
    const other = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);
    const { device: otherRegistered } = pairDevice(fx, other);

    const unknownHello = fx.service.issueHostHello();
    try {
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(
          "99999999-9999-4999-8999-999999999999",
          registered.deviceId,
          unknownHello.nonce,
        ),
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProtocolError);
      expect((error as RemoteProtocolError).reasonCode).toBeUndefined();
    }

    const expiredChallenge = fx.proofService.issueChallenge({
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: 1,
    });
    fx.connection
      .prepare("UPDATE remote_device_projection SET state = 'expired' WHERE device_id = ?")
      .run(registered.deviceId);
    const expiredHello = fx.service.issueHostHello();
    try {
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(
          expiredChallenge.challengeId,
          registered.deviceId,
          expiredHello.nonce,
        ),
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProtocolError);
      expect((error as RemoteProtocolError).reasonCode).toBe("expired");
    }
    fx.connection
      .prepare("UPDATE remote_device_projection SET state = 'active' WHERE device_id = ?")
      .run(registered.deviceId);

    const challenge = fx.proofService.issueChallenge({
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: 1,
    });
    const wrongDeviceHello = fx.service.issueHostHello();
    expect(() =>
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(
          challenge.challengeId,
          otherRegistered.deviceId,
          wrongDeviceHello.nonce,
        ),
      }),
    ).toThrow(RemoteProtocolError);

    const wrongOriginHello = fx.service.issueHostHello();
    const wrongOriginChallenge = fx.proofService.issueChallenge({
      hostId,
      deviceId: registered.deviceId,
      credentialGeneration: 1,
    });
    try {
      fx.service.negotiate({
        sourceClass: "lan-private",
        request: negotiateRequest(
          wrongOriginChallenge.challengeId,
          registered.deviceId,
          wrongOriginHello.nonce,
          { origin: "https://other.example.test" },
        ),
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProtocolError);
      expect((error as RemoteProtocolError).category).toBe("unauthorized");
      expect(String(error)).not.toContain(wrongOriginHello.nonce);
    }
  });

  it(
    "caps pending negotiations and fails closed with a generic unavailable",
    { timeout: 30_000 },
    () => {
      const fx = createFixture();
      const device = deviceKeypair();
      const { device: registered } = pairDevice(fx, device);
      for (let index = 0; index < MAX_PENDING_NEGOTIATIONS; index += 1) {
        negotiateDevice(fx, registered);
      }
      const challenge = fx.proofService.issueChallenge({
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 1,
      });
      const hello = fx.service.issueHostHello();
      try {
        fx.service.negotiate({
          sourceClass: "lan-private",
          request: negotiateRequest(challenge.challengeId, registered.deviceId, hello.nonce),
        });
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteProtocolError);
        expect((error as RemoteProtocolError).category).toBe("unavailable");
      }
    },
  );

  it("expires recorded negotiations with their challenge", () => {
    const clock = { nowMs };
    const fx = createFixture({ clock });
    const device = deviceKeypair();
    const { device: registered } = pairDevice(fx, device);
    const { challenge } = negotiateDevice(fx, registered);
    clock.nowMs = nowMs + 61_000;
    expect(
      fx.service.resolveNegotiation({
        challengeId: challenge.challengeId,
        hostId,
        deviceId: registered.deviceId,
        credentialGeneration: 1,
      }),
    ).toBeUndefined();
  });
});
