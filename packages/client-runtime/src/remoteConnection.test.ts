import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildRemoteChallengeProofPayload,
  buildRemoteRequestProofPayload,
  canonicalizeRemotePathQuery,
  sessionExpiry,
} from "@octant/domain";
import {
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_AUTHENTICATION_PROTOCOL_VERSION,
  REMOTE_SECURITY_FLOOR,
  decodeRemoteRequestProofV1,
} from "@octant/contracts";
import {
  createRemoteConnection,
  RemoteConnectionError,
  type AuthenticatedRequestInput,
  type DeviceKeyStore,
  type RemoteConnectionState,
} from "./remoteConnection";

const ORIGIN = "https://mac.example.test";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const HOST_KEY_FINGERPRINT = "a".repeat(64);
const DEVICE_LABEL = "Ada's Safari";
const TICKET_ID = "44444444-4444-4444-8444-444444444444";
const TICKET_PROOF = "ticket_proof_1234567890";
const SERVER_BUILD_VERSION = "0.1.0";
const WEB_BUILD_VERSION = "0.1.0";
const CAPABILITY_DIGEST = createHash("sha256")
  .update("remote-authentication-only:v1", "utf8")
  .digest("hex");

// ── Test device key store (real P-256, ieee-p1363 signatures) ───────────────

function p256KeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

function publicKeyPem(pair: ReturnType<typeof p256KeyPair>): string {
  return pair.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
}

function fingerprintFromPem(pem: string): string {
  const der = Buffer.from(
    pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, ""),
    "base64",
  );
  return createHash("sha256").update(der).digest("hex");
}

function signIeeeP1363(pair: ReturnType<typeof p256KeyPair>, payload: string): string {
  return sign("sha256", Buffer.from(payload, "utf8"), {
    key: pair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

function verifyIeeeP1363(publicKeyPem: string, payload: string, signature: string): boolean {
  try {
    return verify(
      "sha256",
      Buffer.from(payload, "utf8"),
      {
        key: publicKeyPem,
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function createTestDeviceKeyStore(): {
  store: DeviceKeyStore;
  pair: ReturnType<typeof p256KeyPair>;
} {
  const pair = p256KeyPair();
  let cleared = false;
  const store: DeviceKeyStore = {
    async loadOrCreate() {
      if (cleared) throw new Error("device key was cleared");
      const pem = publicKeyPem(pair);
      return { publicKeyPem: pem, fingerprint: fingerprintFromPem(pem) };
    },
    async current() {
      if (cleared) return undefined;
      const pem = publicKeyPem(pair);
      return { publicKeyPem: pem, fingerprint: fingerprintFromPem(pem) };
    },
    async sign(payload) {
      if (cleared) throw new Error("device key was cleared");
      return signIeeeP1363(pair, payload);
    },
    async clear() {
      cleared = true;
    },
  };
  return { store, pair };
}

// ── Fake remote server implementing the v1 protocol ─────────────────────────

interface FakeServerConfig {
  readonly origin?: string;
  readonly hostId?: string;
  readonly hostKeyFingerprint?: string;
  readonly approve?: boolean;
  /** Override the remoteOrigin advertised in host hello (to simulate mismatch). */
  readonly advertisedRemoteOrigin?: string;
  /** Reject negotiate with incompatible protocol by advertising a non-overlapping range. */
  readonly incompatibleProtocol?: boolean;
  /** Simulate network failure for a given route id. */
  readonly failRoute?: "hello" | "challenge" | "negotiate" | "session";
  /** Revoke the device after approval (challenge/session return unauthorized). */
  readonly revoked?: boolean;
}

interface FakeServer {
  readonly fetch: typeof globalThis.fetch;
  readonly devicePublicKey: () => string;
  readonly issuedSessionId: () => string | undefined;
  readonly productProofVerified: () => boolean;
  readonly bodyDigest: () => string | undefined;
}

function createFakeServer(config: FakeServerConfig): FakeServer {
  const origin = config.origin ?? ORIGIN;
  const hostId = config.hostId ?? HOST_ID;
  const hostKeyFingerprint = config.hostKeyFingerprint ?? HOST_KEY_FINGERPRINT;
  const approve = config.approve ?? true;
  const now = () => Date.now();
  const nonces = new Map<string, number>(); // digest -> expiresAt
  let device:
    | { deviceId: string; credentialGeneration: number; publicKey: string; fingerprint: string }
    | undefined;
  const challenges = new Map<
    string,
    {
      nonce: string;
      expiresAt: number;
      consumed: boolean;
      deviceId: string;
      credentialGeneration: number;
    }
  >();
  const negotiations = new Map<
    string,
    {
      protocolVersion: number;
      authenticationVersion: number;
      capabilityDigest: string;
      expiresAt: number;
    }
  >();
  let issuedSessionId: string | undefined;
  let productProofVerified = false;
  let lastBodyDigest: string | undefined;

  const hello = () => {
    const nonce = randomBytes(32).toString("base64url");
    nonces.set(sha256(nonce), now() + 60_000);
    const range = config.incompatibleProtocol ? { min: 9, max: 9 } : { min: 1, max: 1 };
    return {
      productId: "octant",
      hostId,
      displayName: "This Mac",
      hostKeyFingerprint,
      serverBuildVersion: SERVER_BUILD_VERSION,
      supportedProtocolRange: range,
      authenticationProtocolVersions: [REMOTE_AUTHENTICATION_PROTOCOL_VERSION],
      securityFloor: REMOTE_SECURITY_FLOOR,
      remoteOrigin: config.advertisedRemoteOrigin ?? origin,
      nonce,
      expiresAt: new Date(now() + 60_000).toISOString(),
      signature: "host_sig",
    };
  };

  const consumeNonce = (nonce: string) => {
    const key = sha256(nonce);
    const exp = nonces.get(key);
    if (exp === undefined || now() >= exp) throw new Error("nonce-invalid");
    nonces.delete(key);
  };

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (path === "/api/remote/hello" && method === "GET") {
      if (config.failRoute === "hello") throw new Error("network");
      return Response.json(hello());
    }

    if (path === "/api/remote/pairing" && method === "POST") {
      const body = JSON.parse(init?.body as string);
      consumeNonce(body.hostHelloNonce);
      if (body.origin !== origin) return Response.json({ kind: "failed" }, { status: 401 });
      if (!approve) return Response.json({ kind: "failed" }, { status: 401 });
      device = {
        deviceId: randomUUID(),
        credentialGeneration: 1,
        publicKey: body.devicePublicKey,
        fingerprint: body.deviceKeyFingerprint,
      };
      return Response.json({
        kind: "claimed",
        ticketId: body.ticketId,
        hostId,
        deviceLabel: body.deviceLabel,
        deviceKeyFingerprint: body.deviceKeyFingerprint,
        origin,
        sourceClass: "lan-private",
        comparisonCode: "123456",
        claimedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 300_000).toISOString(),
      });
    }

    if (path === "/api/remote/pairing/status" && method === "POST") {
      const body = JSON.parse(init?.body as string);
      if (
        body.ticketId !== TICKET_ID ||
        body.ticketProof !== TICKET_PROOF ||
        device === undefined
      ) {
        return Response.json({ status: "failed" });
      }
      return Response.json({
        status: "approved",
        deviceId: device.deviceId,
        credentialGeneration: device.credentialGeneration,
      });
    }

    if (path === "/api/remote/auth/challenge" && method === "POST") {
      if (config.failRoute === "challenge") throw new Error("network");
      const body = JSON.parse(init?.body as string);
      if (config.revoked || device === undefined || device.deviceId !== body.deviceId) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const challengeId = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      challenges.set(sha256(challengeId), {
        nonce,
        expiresAt: now() + 60_000,
        consumed: false,
        deviceId: body.deviceId,
        credentialGeneration: body.credentialGeneration,
      });
      return Response.json({
        challengeId,
        hostId: body.hostId,
        deviceId: body.deviceId,
        credentialGeneration: body.credentialGeneration,
        nonce,
        issuedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 60_000).toISOString(),
      });
    }

    if (path === "/api/remote/negotiate" && method === "POST") {
      if (config.failRoute === "negotiate") throw new Error("network");
      const body = JSON.parse(init?.body as string);
      consumeNonce(body.hostHelloNonce);
      if (body.origin !== origin || device === undefined || device.deviceId !== body.deviceId) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const challenge = challenges.get(sha256(body.challengeId));
      if (challenge === undefined || challenge.consumed) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const protocolVersion = config.incompatibleProtocol ? 9 : REMOTE_ACCESS_PROTOCOL_VERSION;
      const record = {
        protocolVersion,
        authenticationVersion: REMOTE_AUTHENTICATION_PROTOCOL_VERSION,
        capabilityDigest: CAPABILITY_DIGEST,
        expiresAt: challenge.expiresAt,
      };
      negotiations.set(sha256(body.challengeId), record);
      return Response.json({
        hostId,
        deviceId: body.deviceId,
        challengeId: body.challengeId,
        protocolVersion: record.protocolVersion,
        authenticationVersion: record.authenticationVersion,
        credentialGeneration: challenge.credentialGeneration,
        origin,
        capabilityDigest: record.capabilityDigest,
        issuedAt: new Date(now()).toISOString(),
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        hostSignature: "negotiation_sig",
      });
    }

    if (path === "/api/remote/auth/session" && method === "POST") {
      if (config.failRoute === "session") throw new Error("network");
      const body = JSON.parse(init?.body as string);
      const challenge = challenges.get(sha256(body.challengeId));
      if (challenge === undefined || challenge.consumed || device === undefined) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      if (config.revoked) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const negotiation = negotiations.get(sha256(body.challengeId));
      if (negotiation === undefined)
        return Response.json({ category: "unauthorized" }, { status: 401 });
      const sessionFacts = {
        origin,
        protocolVersion: negotiation.protocolVersion,
        authenticationVersion: negotiation.authenticationVersion,
        capabilityDigest: negotiation.capabilityDigest,
        ...sessionExpiry(Date.parse(body.issuedAt)),
      };
      const payload = buildRemoteChallengeProofPayload({ challenge: body, sessionFacts });
      if (!verifyIeeeP1363(device.publicKey, payload, body.signature)) {
        challenge.consumed = true;
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      challenge.consumed = true;
      issuedSessionId = randomUUID();
      return new Response(
        JSON.stringify({
          hostId,
          deviceId: device.deviceId,
          sessionId: issuedSessionId,
          credentialGeneration: device.credentialGeneration,
          origin,
          protocolVersion: negotiation.protocolVersion,
          authenticationVersion: negotiation.authenticationVersion,
          capabilityDigest: negotiation.capabilityDigest,
          issuedAt: sessionFacts.issuedAt,
          idleExpiresAt: sessionFacts.idleExpiresAt,
          absoluteExpiresAt: sessionFacts.absoluteExpiresAt,
          csrfToken: "csrf_token_1234567890",
          negotiationSignature: "session_sig",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `__Secure-octant-remote-session=${issuedSessionId}; Secure; HttpOnly; SameSite=Strict; Path=/api/`,
          },
        },
      );
    }

    // Authenticated product route — verify per-request device proof.
    if (path.startsWith("/api/chat/") && (method === "POST" || method === "GET")) {
      const proofHeader =
        init?.headers && (init.headers as Record<string, string>)["x-octant-device-proof"];
      if (proofHeader === undefined)
        return Response.json({ category: "unauthorized" }, { status: 401 });
      const proof = decodeRemoteRequestProofV1(
        JSON.parse(Buffer.from(proofHeader, "base64url").toString("utf8")),
      );
      lastBodyDigest = proof.bodyDigest;
      const sessionId = issuedSessionId;
      if (sessionId === undefined || device === undefined) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const cookie = init?.headers && (init.headers as Record<string, string>)["cookie"];
      if (cookie === undefined || !cookie.includes(`__Secure-octant-remote-session=${sessionId}`)) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const canonical = canonicalizeRemotePathQuery(proof.canonicalPathQuery);
      if (canonical !== proof.canonicalPathQuery) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const payload = buildRemoteRequestProofPayload({ sessionId, proof });
      if (!verifyIeeeP1363(device.publicKey, payload, proof.signature)) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      productProofVerified = true;
      return Response.json({ ok: true });
    }

    return Response.json({ category: "unavailable" }, { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    devicePublicKey: () => device?.publicKey ?? "",
    issuedSessionId: () => issuedSessionId,
    productProofVerified: () => productProofVerified,
    bodyDigest: () => lastBodyDigest,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RemoteConnection state machine", () => {
  it("drives pairing through connecting -> negotiating -> authenticating -> ready", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    const states: RemoteConnectionState[] = [];
    connection.onStateChange((state) => states.push(state));

    await connection.connect();

    expect(connection.state()).toBe("ready");
    expect(states).toEqual(["connecting", "negotiating", "authenticating", "ready"]);
    const session = connection.session();
    expect(session).toBeDefined();
    expect(session!.hostId).toBe(HOST_ID);
    expect(session!.sessionId).toBe(server.issuedSessionId());
    expect(session!.csrfToken).toBe("csrf_token_1234567890");
  });

  it("establishes the session from the response body when Set-Cookie is not readable (browser fetch API)", async () => {
    // Browsers forbid reading `Set-Cookie` from the fetch API (forbidden
    // response header name), so a browser fetch exposes `null` there. The
    // session id must therefore also travel in the response body; the client
    // must not depend on reading the cookie header.
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const browserFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      const headers = new Headers(response.headers);
      headers.delete("set-cookie");
      return new Response(response.body, { status: response.status, headers });
    };
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: browserFetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await connection.connect();

    expect(connection.state()).toBe("ready");
    expect(connection.session()?.sessionId).toBe(server.issuedSessionId());
  });

  it("records the paired device identity for reconnect", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await connection.connect();
    const device = connection.deviceIdentity();
    expect(device).toBeDefined();
    expect(device!.hostId).toBe(HOST_ID);
    expect(device!.hostKeyFingerprint).toBe(HOST_KEY_FINGERPRINT);
    expect(device!.credentialGeneration).toBe(1);
  });

  it("reconnects an already-paired device without re-pairing", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await connection.connect();
    connection.disconnect();
    expect(connection.state()).toBe("stale");

    await connection.reconnect();
    expect(connection.state()).toBe("ready");
    expect(connection.session()?.sessionId).toBe(server.issuedSessionId());
  });

  it("reconnects from a known device identity supplied at construction", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    // First, pair to obtain the device id.
    const first = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await first.connect();
    const identity = first.deviceIdentity()!;

    // A fresh connection with only the known identity (no pairing ticket) reconnects.
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      knownDevice: {
        hostId: identity.hostId,
        deviceId: identity.deviceId,
        credentialGeneration: identity.credentialGeneration,
        hostKeyFingerprint: identity.hostKeyFingerprint,
      },
    });
    expect(connection.state()).toBe("disconnected");
    await connection.connect();
    expect(connection.state()).toBe("ready");
    expect(connection.session()).toBeDefined();
  });

  it("reports incompatible when protocol ranges do not overlap", async () => {
    const server = createFakeServer({ incompatibleProtocol: true });
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await expect(connection.connect()).rejects.toBeInstanceOf(RemoteConnectionError);
    expect(connection.state()).toBe("incompatible");
  });

  it("reports unavailable on network failure", async () => {
    const server = createFakeServer({ failRoute: "hello" });
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await expect(connection.connect()).rejects.toBeInstanceOf(RemoteConnectionError);
    expect(connection.state()).toBe("unavailable");
  });

  it("reports unauthorized when the device is revoked", async () => {
    const server = createFakeServer({ revoked: true });
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await expect(connection.connect()).rejects.toBeInstanceOf(RemoteConnectionError);
    expect(connection.state()).toBe("unauthorized");
  });
});

describe("RemoteConnection host identity / origin fail-closed", () => {
  it("stops and requires re-pairing when the host key fingerprint changes", async () => {
    const serverA = createFakeServer({ hostKeyFingerprint: "a".repeat(64) });
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: serverA.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();
    const originalDevice = connection.deviceIdentity()!;

    // The same endpoint now presents a different host key (clone/compromise).
    const serverB = createFakeServer({ hostKeyFingerprint: "b".repeat(64) });
    connection.updateFetch(serverB.fetch);
    connection.disconnect();

    await expect(connection.reconnect()).rejects.toBeInstanceOf(RemoteConnectionError);
    expect(connection.state()).toBe("unauthorized");
    // Authority is cleared; re-pairing is required.
    expect(connection.deviceIdentity()).toBeUndefined();
    expect(connection.session()).toBeUndefined();
    // The original device identity must not be reusable after a host-key mismatch.
    expect(originalDevice.hostKeyFingerprint).toBe("a".repeat(64));
  });

  it("stops when the host id changes at the same endpoint", async () => {
    const serverA = createFakeServer({ hostId: HOST_ID });
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: serverA.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();

    const serverB = createFakeServer({ hostId: "99999999-9999-4999-8999-999999999999" });
    connection.updateFetch(serverB.fetch);
    connection.disconnect();

    await expect(connection.reconnect()).rejects.toBeInstanceOf(RemoteConnectionError);
    expect(connection.state()).toBe("unauthorized");
    expect(connection.deviceIdentity()).toBeUndefined();
  });

  it("rejects a host hello whose advertised remote origin does not match the configured origin", async () => {
    const server = createFakeServer({ advertisedRemoteOrigin: "https://attacker.example.test" });
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await expect(connection.connect()).rejects.toBeInstanceOf(RemoteConnectionError);
    expect(connection.state()).toBe("incompatible");
    expect(connection.deviceIdentity()).toBeUndefined();
  });

  it("refuses to reconnect when the device key has been cleared (lost credential)", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();
    await store.clear();
    connection.disconnect();

    await expect(connection.reconnect()).rejects.toBeInstanceOf(RemoteConnectionError);
    expect(connection.state()).toBe("unauthorized");
  });
});

describe("RemoteConnection device-key possession", () => {
  it("proves possession by signing the challenge with the non-exportable device key", async () => {
    const server = createFakeServer({});
    const { store, pair } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });

    await connection.connect();
    // The server only issues a session when the challenge proof signature verifies
    // against the registered device public key.
    expect(connection.state()).toBe("ready");
    expect(server.issuedSessionId()).toBeDefined();
    expect(server.devicePublicKey()).toBe(publicKeyPem(pair));
  });

  it("builds a verifiable per-request proof for authenticated product routes", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();

    const request: AuthenticatedRequestInput = {
      method: "POST",
      path: "/api/chat/threads",
      body: JSON.stringify({ kind: "send-turn", text: "hello" }),
    };
    const response = await connection.authenticatedFetch(request);
    expect(response.ok).toBe(true);
    expect(server.productProofVerified()).toBe(true);
  });

  it("digests only the visible bytes of a typed-array request body", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();

    const body = new Uint8Array([0, 1, 2, 3]).subarray(1, 3);
    await connection.authenticatedFetch({
      method: "POST",
      path: "/api/chat/threads",
      body,
    });

    expect(server.bodyDigest()).toBe(createHash("sha256").update(Buffer.from(body)).digest("hex"));
  });

  it("sends the csrf header on state-changing requests and not on safe methods", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();

    let capturedInit: RequestInit | undefined;
    const wrappingFetch: typeof globalThis.fetch = async (input, init) => {
      capturedInit = init;
      return server.fetch(input as string, init);
    };
    connection.updateFetch(wrappingFetch);

    await connection.authenticatedFetch({
      method: "POST",
      path: "/api/chat/threads",
      body: JSON.stringify({ kind: "send-turn" }),
    });
    const postHeaders = capturedInit!.headers as Record<string, string>;
    expect(postHeaders["x-octant-csrf"]).toBeDefined();
    expect(postHeaders["x-octant-device-proof"]).toBeDefined();
    expect(postHeaders["x-octant-command-id"]).toBeDefined();

    capturedInit = undefined;
    await connection.authenticatedFetch({ method: "GET", path: "/api/chat/threads" });
    const getHeaders = capturedInit!.headers as Record<string, string>;
    expect(getHeaders["x-octant-csrf"]).toBeUndefined();
    expect(getHeaders["x-octant-device-proof"]).toBeDefined();
  });

  it("fails closed when no session is established (no bearer fallback)", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    expect(connection.state()).toBe("disconnected");
    await expect(
      connection.authenticatedFetch({ method: "GET", path: "/api/chat/threads" }),
    ).rejects.toBeInstanceOf(RemoteConnectionError);
  });

  it("ignores caller-supplied values for reserved security headers (no override)", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();

    let capturedInit: RequestInit | undefined;
    const wrappingFetch: typeof globalThis.fetch = async (input, init) => {
      capturedInit = init;
      return server.fetch(input as string, init);
    };
    connection.updateFetch(wrappingFetch);

    // A malicious or buggy caller tries to override every reserved header.
    await connection.authenticatedFetch({
      method: "POST",
      path: "/api/chat/threads",
      body: JSON.stringify({ kind: "send-turn" }),
      headers: {
        origin: "https://attacker.example.test",
        "sec-fetch-site": "cross-site",
        cookie: "__Secure-octant-remote-session=stolen-session-id",
        "x-octant-device-proof": "forged-proof",
        "x-octant-csrf": "forged-csrf",
        "x-octant-command-id": "forged-command-id",
        "content-type": "text/plain",
      },
    });

    const headers = capturedInit!.headers as Record<string, string>;
    // Reserved security headers must retain the connection's authoritative values.
    expect(headers["origin"]).toBe(ORIGIN);
    expect(headers["sec-fetch-site"]).toBe("same-origin");
    expect(headers["cookie"]).toBe(`__Secure-octant-remote-session=${server.issuedSessionId()}`);
    expect(headers["x-octant-device-proof"]).not.toBe("forged-proof");
    expect(headers["x-octant-csrf"]).not.toBe("forged-csrf");
    expect(headers["x-octant-command-id"]).not.toBe("forged-command-id");
    expect(headers["content-type"]).toBe("application/json");
    // The request must succeed — the server verifies the real proof, not the forged one.
    expect(server.productProofVerified()).toBe(true);
  });

  it("allows authoritative contentType and AbortSignal on authenticatedFetch", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();

    let capturedInit: RequestInit | undefined;
    const wrappingFetch: typeof fetch = async (input, init) => {
      capturedInit = init;
      return server.fetch(input as string, init);
    };
    connection.updateFetch(wrappingFetch);

    const controller = new AbortController();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await connection.authenticatedFetch({
      method: "POST",
      path: "/api/chat/attachments",
      body: bytes,
      contentType: "image/png",
      signal: controller.signal,
      headers: {
        "x-octant-chat-thread-id": "00000000-0000-4000-8000-000000000001",
      },
    });

    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("image/png");
    expect(headers["x-octant-chat-thread-id"]).toBe("00000000-0000-4000-8000-000000000001");
    expect(capturedInit!.signal).toBe(controller.signal);
    expect(capturedInit!.body).toBeTruthy();
  });

  it("renews the session on refresh without re-pairing", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();
    const firstSession = connection.session()!;

    await connection.refresh();
    expect(connection.state()).toBe("ready");
    const renewed = connection.session()!;
    // Session id rotates on renewal; device identity stays the same.
    expect(renewed.deviceId).toBe(firstSession.deviceId);
  });

  it("renews a session the machine slept through instead of failing every request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T08:00:00.000Z"));
    try {
      const server = createFakeServer({});
      const { store } = createTestDeviceKeyStore();
      const connection = createRemoteConnection({
        origin: ORIGIN,
        webBuildVersion: WEB_BUILD_VERSION,
        fetch: server.fetch,
        deviceKey: store,
        pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
      });
      await connection.connect();
      const spentSessionId = connection.session()!.sessionId;

      // Longer than the idle window: the session the client is holding is one
      // the host will no longer accept.
      vi.setSystemTime(new Date("2026-08-16T08:20:00.000Z"));
      const response = await connection.authenticatedFetch({
        method: "GET",
        path: "/api/chat/threads",
      });

      expect(response.ok).toBe(true);
      expect(connection.session()!.sessionId).not.toBe(spentSessionId);
      expect(connection.state()).toBe("ready");
      expect(connection.deviceIdentity()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the pairing when the host is merely unreachable", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();
    const paired = connection.deviceIdentity()!;

    connection.updateFetch(async () => {
      throw new Error("network");
    });
    await expect(connection.reconnect()).rejects.toBeInstanceOf(RemoteConnectionError);

    // An unreachable host said nothing about this credential, so the device
    // stays paired and the next attempt can simply succeed.
    expect(connection.state()).toBe("unavailable");
    expect(connection.deviceIdentity()).toEqual(paired);
  });
});

describe("RemoteConnection secret leakage", () => {
  it("never exposes the device private key, session cookie, or csrf token through state", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const connection = createRemoteConnection({
      origin: ORIGIN,
      webBuildVersion: WEB_BUILD_VERSION,
      fetch: server.fetch,
      deviceKey: store,
      pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
    });
    await connection.connect();

    const dump = JSON.stringify({
      state: connection.state(),
      session: connection.session(),
      device: connection.deviceIdentity(),
    });
    // No private key material, bearer tokens, or raw pairing secrets leak through state.
    expect(dump).not.toMatch(/PRIVATE KEY|privateKey|bearer|ticketProof|ticket_proof/i);
    // The csrf token is operational state, not a persisted bearer; it must not appear
    // in the device identity snapshot.
    const deviceDump = JSON.stringify(connection.deviceIdentity());
    expect(deviceDump).not.toMatch(/csrf|cookie|sessionId/i);
  });

  it("does not store the session id or device key in localStorage", async () => {
    const server = createFakeServer({});
    const { store } = createTestDeviceKeyStore();
    const localStorageSet = vi.fn();
    const fakeStorage = {
      setItem: localStorageSet,
      getItem: () => null,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const previous = (globalThis as { localStorage?: Storage }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage,
      configurable: true,
      writable: true,
    });

    try {
      const connection = createRemoteConnection({
        origin: ORIGIN,
        webBuildVersion: WEB_BUILD_VERSION,
        fetch: server.fetch,
        deviceKey: store,
        pairing: { ticketId: TICKET_ID, ticketProof: TICKET_PROOF, deviceLabel: DEVICE_LABEL },
      });
      await connection.connect();
      await connection
        .authenticatedFetch({ method: "GET", path: "/api/chat/threads" })
        .catch(() => undefined);

      expect(localStorageSet).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        (globalThis as { localStorage?: Storage }).localStorage = previous;
      }
    }
  });
});
