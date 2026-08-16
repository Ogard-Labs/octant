import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { vi } from "vitest";
import {
  buildRemoteChallengeProofPayload,
  buildRemoteKeyRotationProofPayload,
  buildRemoteRequestProofPayload,
  canonicalizeRemotePathQuery,
  sessionExpiry,
} from "@octant/domain";
import {
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_AUTHENTICATION_PROTOCOL_VERSION,
  REMOTE_SECURITY_FLOOR,
} from "@octant/contracts/remote-access";
import { decodeRemoteRequestProofV1 } from "@octant/contracts/remote-request-proof";
import type { DeviceKeyStore } from "./remoteConnection";

export const ORIGIN = "https://mac.example.test";
export const HOST_ID = "11111111-1111-4111-8111-111111111111";
export const HOST_KEY_FINGERPRINT = "a".repeat(64);
export const DEVICE_LABEL = "Ada's Safari";
export const TICKET_ID = "44444444-4444-4444-8444-444444444444";
export const TICKET_PROOF = "ticket_proof_1234567890";
export const SERVER_BUILD_VERSION = "0.1.0";
export const WEB_BUILD_VERSION = "0.1.0";
export const CAPABILITY_DIGEST = createHash("sha256")
  .update("remote-authentication-only:v1", "utf8")
  .digest("hex");

function p256KeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

export function publicKeyPem(pair: ReturnType<typeof p256KeyPair>): string {
  return pair.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
}

export function fingerprintFromPem(pem: string): string {
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

export function createTestDeviceKeyStore(): {
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

export interface FakeRemoteServerConfig {
  readonly origin?: string;
  readonly hostId?: string;
  readonly hostKeyFingerprint?: string;
  readonly approve?: boolean;
  readonly advertisedRemoteOrigin?: string;
  readonly incompatibleProtocol?: boolean;
  readonly failRoute?: "hello" | "challenge" | "negotiate" | "session";
  readonly revoked?: boolean;
  readonly credentialFailure?: "expired" | "revoked";
  /** Reject `/api/remote/auth/rotate-key` with this status instead of rotating. */
  readonly rotateKeyStatus?: number;
  readonly handleProductRequest?: (input: {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
  }) => Response | Promise<Response>;
}

export interface FakeRemoteServer {
  readonly fetch: typeof globalThis.fetch;
  readonly devicePublicKey: () => string;
  readonly credentialGeneration: () => number | undefined;
  readonly issuedSessionId: () => string | undefined;
  readonly productProofVerified: () => boolean;
  readonly deviceId: () => string | undefined;
  readonly registerDevice: (input: {
    readonly deviceId: string;
    readonly publicKeyPem: string;
    readonly fingerprint: string;
    readonly credentialGeneration?: number;
  }) => void;
}

export function createFakeRemoteServer(config: FakeRemoteServerConfig): FakeRemoteServer {
  const origin = config.origin ?? ORIGIN;
  const hostId = config.hostId ?? HOST_ID;
  const hostKeyFingerprint = config.hostKeyFingerprint ?? HOST_KEY_FINGERPRINT;
  const approve = config.approve ?? true;
  const now = () => Date.now();
  const nonces = new Map<string, number>();
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

  const verifyProductProof = (init?: RequestInit): boolean => {
    const proofHeader =
      init?.headers && (init.headers as Record<string, string>)["x-octant-device-proof"];
    if (proofHeader === undefined) return false;
    const proof = decodeRemoteRequestProofV1(
      JSON.parse(Buffer.from(proofHeader, "base64url").toString("utf8")),
    );
    const sessionId = issuedSessionId;
    if (sessionId === undefined || device === undefined) return false;
    const cookie = init?.headers && (init.headers as Record<string, string>)["cookie"];
    if (cookie === undefined || !cookie.includes(`__Secure-octant-remote-session=${sessionId}`)) {
      return false;
    }
    const canonical = canonicalizeRemotePathQuery(proof.canonicalPathQuery);
    if (canonical !== proof.canonicalPathQuery) return false;
    const payload = buildRemoteRequestProofPayload({ sessionId, proof });
    if (!verifyIeeeP1363(device.publicKey, payload, proof.signature)) return false;
    productProofVerified = true;
    return true;
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
      if (
        config.revoked ||
        config.credentialFailure !== undefined ||
        device === undefined ||
        device.deviceId !== body.deviceId
      ) {
        // A revoked or expired registration is deliberately reported as a
        // generic unauthorized rejection, mirroring the production gateway:
        // lifecycle reasons are reserved for the authenticated local panel.
        return Response.json(
          {
            category: "unauthorized",
            ...(config.credentialFailure === undefined
              ? {}
              : { reasonCode: config.credentialFailure }),
          },
          { status: 401 },
        );
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
        return Response.json(
          {
            category: "unauthorized",
            ...(config.credentialFailure === undefined
              ? {}
              : { reasonCode: config.credentialFailure }),
          },
          { status: 401 },
        );
      }
      const challenge = challenges.get(sha256(body.challengeId));
      if (challenge === undefined || challenge.consumed) {
        return Response.json(
          {
            category: "unauthorized",
            ...(config.credentialFailure === undefined
              ? {}
              : { reasonCode: config.credentialFailure }),
          },
          { status: 401 },
        );
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
      if (config.revoked || config.credentialFailure !== undefined) {
        return Response.json(
          {
            category: "unauthorized",
            ...(config.credentialFailure === undefined
              ? {}
              : { reasonCode: config.credentialFailure }),
          },
          { status: 401 },
        );
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

    if (path === "/api/remote/auth/device" && method === "GET") {
      if (!verifyProductProof(init) || device === undefined) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      const sessionFacts = sessionExpiry(now());
      return Response.json({
        deviceId: device.deviceId,
        deviceLabel: "Remote browser",
        origin,
        credentialGeneration: device.credentialGeneration,
        createdAt: new Date(now() - 86_400_000).toISOString(),
        expiresAt: new Date(now() + 30 * 86_400_000).toISOString(),
        lastSeenAt: new Date(now() - 3_600_000).toISOString(),
        state: "active",
        sessionIdleExpiresAt: sessionFacts.idleExpiresAt,
        sessionAbsoluteExpiresAt: sessionFacts.absoluteExpiresAt,
      });
    }

    if (path === "/api/remote/auth/rotate-key" && method === "POST") {
      // The request proof already established old-key possession; the body must
      // additionally prove the new key signed the canonical rotation
      // transcript, exactly as the host verifies it.
      if (!verifyProductProof(init) || device === undefined) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      if (config.rotateKeyStatus !== undefined) {
        return Response.json({ category: "rejected" }, { status: config.rotateKeyStatus });
      }
      const body = parseRequestBody(init?.body) as {
        newDeviceKeyFingerprint: string;
        newDevicePublicKey: string;
        newKeyProof: string;
      };
      const payload = buildRemoteKeyRotationProofPayload({
        hostId,
        deviceId: device.deviceId,
        credentialGeneration: device.credentialGeneration,
        newDeviceKeyFingerprint: body.newDeviceKeyFingerprint,
        newDevicePublicKey: body.newDevicePublicKey,
      });
      if (
        fingerprintFromPem(body.newDevicePublicKey) !== body.newDeviceKeyFingerprint ||
        !verifyIeeeP1363(body.newDevicePublicKey, payload, body.newKeyProof)
      ) {
        return Response.json({ category: "invalid" }, { status: 403 });
      }
      device = {
        deviceId: device.deviceId,
        credentialGeneration: device.credentialGeneration + 1,
        publicKey: body.newDevicePublicKey,
        fingerprint: body.newDeviceKeyFingerprint,
      };
      issuedSessionId = undefined;
      return Response.json({
        commandId: randomUUID(),
        result: "applied",
        occurredAt: new Date(now()).toISOString(),
      });
    }

    if (
      (path === "/api/remote/auth/sign-out" || path === "/api/remote/auth/revoke-self") &&
      method === "POST"
    ) {
      if (!verifyProductProof(init)) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      if (path === "/api/remote/auth/revoke-self") {
        device = undefined;
      }
      issuedSessionId = undefined;
      return Response.json({
        commandId: randomUUID(),
        result: "applied",
        occurredAt: new Date(now()).toISOString(),
      });
    }

    if (
      (path.startsWith("/api/chat/") ||
        path.startsWith("/api/work/") ||
        path.startsWith("/api/code/") ||
        path.startsWith("/api/preview/") ||
        path === "/api/providers/bootstrap" ||
        path === "/api/projects/bootstrap" ||
        path.startsWith("/api/agent-profiles")) &&
      (method === "POST" || method === "GET")
    ) {
      if (!verifyProductProof(init)) {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      if (config.handleProductRequest !== undefined) {
        let body: unknown;
        try {
          body = parseRequestBody(init?.body);
        } catch {
          return Response.json({ category: "invalid" }, { status: 400 });
        }
        return config.handleProductRequest({ method, path, body });
      }
      return Response.json({ ok: true });
    }

    return Response.json({ category: "unavailable" }, { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    devicePublicKey: () => device?.publicKey ?? "",
    credentialGeneration: () => device?.credentialGeneration,
    issuedSessionId: () => issuedSessionId,
    productProofVerified: () => productProofVerified,
    deviceId: () => device?.deviceId,
    registerDevice: (input) => {
      device = {
        deviceId: input.deviceId,
        credentialGeneration: input.credentialGeneration ?? 1,
        publicKey: input.publicKeyPem,
        fingerprint: input.fingerprint,
      };
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Decode JSON request bodies whether callers pass a string or byte array. */
function parseRequestBody(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    return raw.length === 0 ? undefined : JSON.parse(raw);
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength === 0) return undefined;
    return JSON.parse(new TextDecoder().decode(raw));
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    if (view.byteLength === 0) return undefined;
    return JSON.parse(
      new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    );
  }
  if (raw instanceof ArrayBuffer) {
    if (raw.byteLength === 0) return undefined;
    return JSON.parse(new TextDecoder().decode(new Uint8Array(raw)));
  }
  return undefined;
}
