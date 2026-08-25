// Single-host remote connection state machine and
// origin-scoped device-key possession.
//
// This module owns the client-runtime connection lifecycle:
// connecting -> negotiating -> authenticating -> ready, with stale,
// reconnecting, incompatible, unauthorized, and unavailable terminal/recovery
// states. It proves possession of a non-exportable browser device key by
// signing v1 challenge and per-request proofs, renews short sessions, and
// stops (clearing authority) on host identity/key mismatch.
//
// Boundaries:
// - The client NEVER grants authority. It only states identity claims that the
//   server verifies before deriving the principal. The durable credential is
//   the non-exportable device key plus the host's device record, never a bearer
//   token. There is no localStorage fallback and no exportable secret.
// - Replay/cursor resume and command correlation/receipt lookup are separate
//   concerns. This module generates a per-mutation command ID header so
//   the server can record idempotent identity, but it does not reissue
//   ambiguous mutations or query results.

import {
  REMOTE_SECURITY_FLOOR,
  decodeHostHelloV1,
  decodeNegotiatedProtocolV1,
  decodePairingStatusResultV1,
  decodeRemoteAuthChallengeV1,
  decodeRemoteSessionResponseV1,
  type HostHelloV1,
  type NegotiatedProtocolV1,
  type RemoteAuthChallengeV1,
} from "@octant/contracts";
import {
  buildRemoteChallengeProofPayload,
  buildRemoteRequestProofPayload,
  canonicalizeRemotePathQuery,
  negotiateRemoteProtocol,
  sessionExpiry,
  shouldRotateSession,
} from "@octant/domain";
import { bindFetchPort } from "./bindFetchPort";

const SESSION_COOKIE_NAME = "__Secure-octant-remote-session";
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const CLIENT_PROTOCOL_RANGE = { min: 1, max: 1 } as const;
const CLIENT_BROWSER_CAPABILITIES = ["webcrypto"] as const;

/**
 * Header names owned by the connection. Caller-supplied values for these are
 * always overwritten with the authoritative value — a caller must never be able
 * to override the session cookie, device proof, CSRF token, command id, origin,
 * sec-fetch-site, or content-type.
 */
const RESERVED_HEADERS = new Set([
  "origin",
  "sec-fetch-site",
  "cookie",
  "x-octant-device-proof",
  "x-octant-csrf",
  "x-octant-command-id",
  "content-type",
]);

// ── State machine ───────────────────────────────────────────────────────────

export type RemoteConnectionState =
  | "disconnected"
  | "connecting"
  | "negotiating"
  | "authenticating"
  | "ready"
  | "stale"
  | "reconnecting"
  | "incompatible"
  | "unauthorized"
  | "unavailable";

// ── Device key possession ───────────────────────────────────────────────────

export interface DevicePublicKey {
  /** SPKI PEM envelope for an EC P-256 key. Never includes private key material. */
  readonly publicKeyPem: string;
  /** SHA-256 of the canonical SPKI DER, lowercase hex. */
  readonly fingerprint: string;
}

/**
 * Origin-scoped non-exportable device key. The private key never leaves the
 * underlying WebCrypto/IndexedDB store; callers only receive the public key and
 * a signing port that returns base64url ieee-p1363 signatures.
 */
export interface DeviceKeyStore {
  /** Load the existing non-exportable key, or create a new one for pairing. */
  loadOrCreate(): Promise<DevicePublicKey>;
  /** Returns the current public key if a key exists. */
  current(): Promise<DevicePublicKey | undefined>;
  /** Sign a payload with the non-exportable private key (base64url ieee-p1363). */
  sign(payload: string): Promise<string>;
  /** Clear the stored key. Browser storage loss requires re-pairing. */
  clear(): Promise<void>;
}

// ── Device identity (non-secret, origin-scoped metadata) ────────────────────

export interface DeviceIdentity {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  /** Trust-on-first-use anchor for reconnect host identity verification. */
  readonly hostKeyFingerprint: string;
}

// ── Session facts (in-memory only; never persisted to localStorage) ─────────

export interface RemoteSessionFacts {
  readonly hostId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly credentialGeneration: number;
  readonly origin: string;
  readonly protocolVersion: number;
  readonly authenticationVersion: number;
  readonly capabilityDigest: string;
  readonly csrfToken: string;
  readonly issuedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface PairingCredentials {
  readonly ticketId: string;
  readonly ticketProof: string;
  readonly deviceLabel: string;
}

export interface KnownDevice {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly hostKeyFingerprint: string;
}

export interface RemoteConnectionConfig {
  /** Exact configured HTTPS origin. Never wildcarded or inferred. */
  readonly origin: string;
  readonly webBuildVersion: string;
  readonly fetch: typeof globalThis.fetch;
  readonly deviceKey: DeviceKeyStore;
  readonly browserCapabilities?: readonly string[];
  /** Pairing ticket for first-time enrollment. */
  readonly pairing?: PairingCredentials;
  /** Previously paired device identity for reconnect without re-pairing. */
  readonly knownDevice?: KnownDevice;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

export interface AuthenticatedRequestInput {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  /** JSON string or raw bytes (attachment upload). */
  readonly body?: string | Uint8Array;
  readonly headers?: Record<string, string>;
  /** Abort in-flight fetch (NDJSON subscribe / cancel). */
  readonly signal?: AbortSignal;
  /**
   * Authoritative content-type for mutating requests. Defaults to
   * application/json. Use image/* / application/pdf for chat attachments.
   */
  readonly contentType?: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type RemoteConnectionErrorCategory =
  | "incompatible"
  | "unauthorized"
  | "unavailable"
  | "invalid"
  | "host-changed";

export type RemoteReauthReason = "expired" | "revoked" | "lost-key";
export type RemoteConnectionReason = RemoteReauthReason | "host-changed";

export class RemoteConnectionError extends Error {
  readonly category: RemoteConnectionErrorCategory;
  readonly reasonCode: RemoteConnectionReason | undefined;

  constructor(
    category: RemoteConnectionErrorCategory,
    message: string,
    reasonCode?: RemoteConnectionReason,
  ) {
    super(message);
    this.name = "RemoteConnectionError";
    this.category = category;
    this.reasonCode = reasonCode;
  }
}

// ── Connection ──────────────────────────────────────────────────────────────

export interface RemoteConnection {
  readonly state: () => RemoteConnectionState;
  readonly onStateChange: (listener: (state: RemoteConnectionState) => void) => () => void;
  /** Pair (if ticket supplied) or reconnect a known device to ready. */
  readonly connect: () => Promise<void>;
  /** Re-establish a session from stale/disconnected after network loss. */
  readonly reconnect: () => Promise<void>;
  /** Mark stale and clear the in-memory session; retain device identity. */
  readonly disconnect: () => void;
  /** Renew the short-lived session without re-pairing. */
  readonly refresh: () => Promise<void>;
  readonly session: () => RemoteSessionFacts | undefined;
  readonly deviceIdentity: () => DeviceIdentity | undefined;
  /** Swap the fetch port (used for tests and listener retargeting). */
  readonly updateFetch: (fetch: typeof globalThis.fetch) => void;
  /** Send an authenticated product request with a per-request device proof. */
  readonly authenticatedFetch: (input: AuthenticatedRequestInput) => Promise<Response>;
}

export function createRemoteConnection(config: RemoteConnectionConfig): RemoteConnection {
  const now = config.now ?? (() => Date.now());
  const randomUuid = config.randomUuid ?? (() => globalThis.crypto.randomUUID());
  let fetch = bindFetchPort(config.fetch);
  let state: RemoteConnectionState = "disconnected";
  let session: RemoteSessionFacts | undefined;
  let deviceIdentity: DeviceIdentity | undefined = config.knownDevice;
  let renewal: Promise<void> | undefined;
  const listeners = new Set<(state: RemoteConnectionState) => void>();

  const setState = (next: RemoteConnectionState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const onStateChange = (listener: (state: RemoteConnectionState) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const updateFetch = (next: typeof globalThis.fetch): void => {
    fetch = bindFetchPort(next);
  };

  const clearAuthority = (): void => {
    session = undefined;
    deviceIdentity = undefined;
  };

  const fetchHello = async (): Promise<HostHelloV1> => {
    const response = await fetch(new URL("/api/remote/hello", config.origin).toString(), {
      method: "GET",
    });
    if (!response.ok) throw await protocolStatusError(response);
    return decodeHostHelloV1(await response.json());
  };

  const verifyHelloIdentity = (hello: HostHelloV1, known: DeviceIdentity | undefined): void => {
    if (hello.remoteOrigin !== config.origin) {
      throw new RemoteConnectionError(
        "incompatible",
        "Host hello advertised an unexpected remote origin.",
      );
    }
    const negotiation = negotiateRemoteProtocol({
      server: { ...hello.supportedProtocolRange, securityFloor: hello.securityFloor },
      client: { ...CLIENT_PROTOCOL_RANGE, securityFloor: REMOTE_SECURITY_FLOOR },
    });
    if (negotiation.kind === "rejected") {
      throw new RemoteConnectionError("incompatible", "Remote protocol versions are incompatible.");
    }
    if (known !== undefined) {
      if (hello.hostId !== known.hostId || hello.hostKeyFingerprint !== known.hostKeyFingerprint) {
        throw new RemoteConnectionError(
          "host-changed",
          "Host identity or key fingerprint changed at the same endpoint.",
        );
      }
    }
  };

  const requestChallenge = async (known: DeviceIdentity): Promise<RemoteAuthChallengeV1> => {
    const body = {
      hostId: known.hostId,
      deviceId: known.deviceId,
      credentialGeneration: known.credentialGeneration,
    };
    const response = await fetch(new URL("/api/remote/auth/challenge", config.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await protocolStatusError(response);
    return decodeRemoteAuthChallengeV1(await response.json());
  };

  const negotiate = async (
    known: DeviceIdentity,
    challenge: RemoteAuthChallengeV1,
    helloNonce: string,
  ): Promise<NegotiatedProtocolV1> => {
    const body = {
      hostHelloNonce: helloNonce,
      challengeId: challenge.challengeId,
      deviceId: known.deviceId,
      origin: config.origin,
      clientHello: {
        webBuildVersion: config.webBuildVersion,
        supportedProtocolRange: CLIENT_PROTOCOL_RANGE,
        browserCapabilities: [...(config.browserCapabilities ?? CLIENT_BROWSER_CAPABILITIES)],
      },
    };
    const response = await fetch(new URL("/api/remote/negotiate", config.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await protocolStatusError(response);
    return decodeNegotiatedProtocolV1(await response.json());
  };

  const issueSession = async (
    known: DeviceIdentity,
    challenge: RemoteAuthChallengeV1,
    negotiated: NegotiatedProtocolV1,
  ): Promise<RemoteSessionFacts> => {
    const sessionFacts = {
      origin: config.origin,
      protocolVersion: negotiated.protocolVersion,
      authenticationVersion: negotiated.authenticationVersion,
      capabilityDigest: negotiated.capabilityDigest,
      ...sessionExpiry(Date.parse(challenge.issuedAt)),
    };
    const payload = buildRemoteChallengeProofPayload({ challenge, sessionFacts });
    const signature = await config.deviceKey.sign(payload);
    const body = {
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      deviceId: challenge.deviceId,
      credentialGeneration: challenge.credentialGeneration,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      signature,
    };
    const response = await fetch(new URL("/api/remote/auth/session", config.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await protocolStatusError(response);
    const issued = decodeRemoteSessionResponseV1(await response.json());
    return {
      hostId: issued.hostId,
      deviceId: issued.deviceId,
      sessionId: issued.sessionId,
      credentialGeneration: issued.credentialGeneration,
      origin: issued.origin,
      protocolVersion: issued.protocolVersion,
      authenticationVersion: issued.authenticationVersion,
      capabilityDigest: issued.capabilityDigest,
      csrfToken: issued.csrfToken,
      issuedAt: issued.issuedAt,
      idleExpiresAt: issued.idleExpiresAt,
      absoluteExpiresAt: issued.absoluteExpiresAt,
    };
  };

  /**
   * Authenticate an already-known device: hello (verify identity) -> challenge
   * -> hello (fresh nonce) -> negotiate -> prove possession -> session.
   */
  const authenticate = async (known: DeviceIdentity): Promise<RemoteSessionFacts> => {
    const hello = await fetchHello();
    verifyHelloIdentity(hello, known);
    const challenge = await requestChallenge(known);
    const helloForNegotiate = await fetchHello();
    verifyHelloIdentity(helloForNegotiate, known);
    const negotiated = await negotiate(known, challenge, helloForNegotiate.nonce);
    setState("authenticating");
    return issueSession(known, challenge, negotiated);
  };

  const pair = async (): Promise<DeviceIdentity> => {
    if (config.pairing === undefined) {
      throw new RemoteConnectionError("invalid", "No pairing ticket or known device was supplied.");
    }
    const hello = await fetchHello();
    verifyHelloIdentity(hello, undefined);
    const deviceKey = await config.deviceKey.loadOrCreate();
    setState("negotiating");
    const claimBody = {
      ticketId: config.pairing.ticketId,
      ticketProof: config.pairing.ticketProof,
      hostHelloNonce: hello.nonce,
      devicePublicKey: deviceKey.publicKeyPem,
      deviceKeyFingerprint: deviceKey.fingerprint,
      deviceLabel: config.pairing.deviceLabel,
      origin: config.origin,
      clientHello: {
        webBuildVersion: config.webBuildVersion,
        supportedProtocolRange: CLIENT_PROTOCOL_RANGE,
        browserCapabilities: [...(config.browserCapabilities ?? CLIENT_BROWSER_CAPABILITIES)],
      },
    };
    const claimResponse = await fetch(new URL("/api/remote/pairing", config.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claimBody),
    });
    if (!claimResponse.ok) {
      throw new RemoteConnectionError("unauthorized", "Pairing claim was rejected.");
    }
    const status = await pollPairingStatus(config.pairing);
    if (
      status.status !== "approved" ||
      status.deviceId === undefined ||
      status.credentialGeneration === undefined
    ) {
      throw new RemoteConnectionError("unauthorized", "Pairing was not approved.");
    }
    return {
      hostId: hello.hostId,
      deviceId: status.deviceId,
      credentialGeneration: status.credentialGeneration,
      hostKeyFingerprint: hello.hostKeyFingerprint,
    };
  };

  const pollPairingStatus = async (
    credentials: PairingCredentials,
  ): Promise<{ status: string; deviceId?: string; credentialGeneration?: number }> => {
    const body = { ticketId: credentials.ticketId, ticketProof: credentials.ticketProof };
    const response = await fetch(new URL("/api/remote/pairing/status", config.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { status: "failed" };
    const result = decodePairingStatusResultV1(await response.json());
    if (result.status === "approved") {
      return {
        status: "approved",
        deviceId: result.deviceId,
        credentialGeneration: result.credentialGeneration,
      };
    }
    return { status: result.status };
  };

  const failConnection = (error: unknown): RemoteConnectionError => {
    const mapped = mapConnectionError(error, clearAuthority);
    setState(
      mapped.category === "incompatible"
        ? "incompatible"
        : mapped.category === "unavailable"
          ? "unavailable"
          : "unauthorized",
    );
    return mapped;
  };

  const connect = async (): Promise<void> => {
    try {
      setState("connecting");
      let known = deviceIdentity;
      if (known === undefined) {
        if (config.pairing === undefined && config.knownDevice === undefined) {
          throw new RemoteConnectionError(
            "invalid",
            "No pairing ticket or known device was supplied.",
          );
        }
        known = await pair();
        deviceIdentity = known;
      }
      const established = await authenticate(known);
      session = established;
      setState("ready");
    } catch (error) {
      throw failConnection(error);
    }
  };

  const reconnect = async (): Promise<void> => {
    try {
      const known = deviceIdentity;
      if (known === undefined) {
        throw new RemoteConnectionError("unauthorized", "No device identity to reconnect.");
      }
      const currentKey = await config.deviceKey.current();
      if (currentKey === undefined) {
        clearAuthority();
        throw new RemoteConnectionError(
          "unauthorized",
          "Device key is missing; re-pairing is required.",
          "lost-key",
        );
      }
      setState("reconnecting");
      const established = await authenticate(known);
      session = established;
      setState("ready");
    } catch (error) {
      throw failConnection(error);
    }
  };

  const disconnect = (): void => {
    session = undefined;
    setState("stale");
  };

  const refresh = async (): Promise<void> => {
    const known = deviceIdentity;
    if (known === undefined || session === undefined) {
      throw new RemoteConnectionError("unauthorized", "No session to refresh.");
    }
    try {
      setState("authenticating");
      const established = await authenticate(known);
      session = established;
      setState("ready");
    } catch (error) {
      throw failConnection(error);
    }
  };

  /**
   * Renew the session before it is used, when its own clock says it is spent.
   *
   * A machine that sleeps past the idle window wakes holding a session the host
   * will refuse. Without this, every request after waking is rejected and the
   * client sits at "unavailable" until the user reloads — which is exactly how
   * a paired browser silently stops receiving a thread's events. Renewal proves
   * possession of the same non-exportable device key that paired it, so it
   * grants nothing a fresh sign-in would not.
   *
   * Concurrent requests share one renewal; the first to notice renews and the
   * rest wait for it, so waking up does not re-authenticate once per pending
   * request.
   */
  const renewIfSpent = async (): Promise<void> => {
    if (session === undefined || !sessionNeedsRenewal(session, now())) return;
    renewal ??= refresh().finally(() => {
      renewal = undefined;
    });
    await renewal;
  };

  const authenticatedFetch = async (input: AuthenticatedRequestInput): Promise<Response> => {
    await renewIfSpent();
    if (session === undefined || deviceIdentity === undefined) {
      throw new RemoteConnectionError("unauthorized", "No authenticated session is available.");
    }
    const method = input.method.toUpperCase();
    if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(method)) {
      throw new RemoteConnectionError("invalid", "Request method is invalid.");
    }
    const pathQuery = `${input.path}${input.query ?? ""}`;
    const canonical = canonicalizeRemotePathQuery(pathQuery);
    if (canonical === undefined) {
      throw new RemoteConnectionError("invalid", "Request path is invalid.");
    }
    const safe = SAFE_METHODS.has(method);
    const bodyBytes =
      input.body instanceof Uint8Array ? input.body : new TextEncoder().encode(input.body ?? "");
    if (safe && bodyBytes.byteLength > 0) {
      throw new RemoteConnectionError("invalid", "Safe methods cannot carry a body.");
    }
    const bodyDigest = toHex(await cryptoSubtleDigest(bodyBytes));
    const csrfDigest = safe
      ? undefined
      : toHex(await cryptoSubtleDigest(new TextEncoder().encode(session.csrfToken)));
    const timestamp = new Date(now()).toISOString();
    const nonce = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const proofPayload = buildRemoteRequestProofPayload({
      sessionId: session.sessionId,
      proof: { method, canonicalPathQuery: canonical, bodyDigest, csrfDigest, timestamp, nonce },
    });
    const signature = await config.deviceKey.sign(proofPayload);
    const proof = {
      method,
      canonicalPathQuery: canonical,
      bodyDigest,
      csrfDigest,
      timestamp,
      nonce,
      signature,
    };
    // Apply caller headers first (filtered to exclude reserved names), then
    // apply the connection's authoritative reserved headers after so a caller
    // can never override the session cookie, device proof, CSRF token, command
    // id, origin, sec-fetch-site, or content-type.
    const callerHeaders: Record<string, string> = {};
    if (input.headers !== undefined) {
      for (const [name, value] of Object.entries(input.headers)) {
        if (!RESERVED_HEADERS.has(name.toLowerCase())) {
          callerHeaders[name] = value;
        }
      }
    }
    const headers: Record<string, string> = {
      ...callerHeaders,
      origin: config.origin,
      "sec-fetch-site": "same-origin",
      "x-octant-device-proof": toBase64Url(new TextEncoder().encode(JSON.stringify(proof))),
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}`,
    };
    if (!safe) {
      headers["content-type"] = input.contentType ?? "application/json";
      headers["x-octant-csrf"] = session.csrfToken;
      headers["x-octant-command-id"] = randomUuid();
    }
    return fetch(new URL(pathQuery, config.origin).toString(), {
      method,
      headers,
      body: safe ? null : bodyBytes.byteLength === 0 ? null : (bodyBytes as unknown as BodyInit),
      credentials: "include",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  };

  return {
    state: () => state,
    onStateChange,
    connect,
    reconnect,
    disconnect,
    refresh,
    session: () => session,
    deviceIdentity: () => deviceIdentity,
    updateFetch,
    authenticatedFetch,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Whether this session must be replaced before it is used again: either window
 * it was issued with has closed, or it has been alive long enough that the
 * proof policy wants it rotated.
 */
function sessionNeedsRenewal(session: RemoteSessionFacts, nowMs: number): boolean {
  const idleExpiresAt = Date.parse(session.idleExpiresAt);
  const absoluteExpiresAt = Date.parse(session.absoluteExpiresAt);
  if (Number.isFinite(idleExpiresAt) && idleExpiresAt <= nowMs) return true;
  if (Number.isFinite(absoluteExpiresAt) && absoluteExpiresAt <= nowMs) return true;
  return shouldRotateSession(session.issuedAt, nowMs);
}

class RemoteProtocolStatusError extends Error {
  readonly status: number;
  readonly reasonCode: RemoteReauthReason | undefined;

  constructor(status: number, reasonCode?: RemoteReauthReason) {
    super(`Remote protocol request failed with status ${status}.`);
    this.name = "RemoteProtocolStatusError";
    this.status = status;
    this.reasonCode = reasonCode;
  }
}

function mapConnectionError(error: unknown, clearAuthority: () => void): RemoteConnectionError {
  if (error instanceof RemoteConnectionError) {
    if (error.category === "host-changed") {
      clearAuthority();
      return new RemoteConnectionError("host-changed", error.message, "host-changed");
    }
    if (error.category === "unauthorized") {
      clearAuthority();
      return new RemoteConnectionError("unauthorized", error.message, error.reasonCode);
    }
    return error;
  }
  if (error instanceof RemoteProtocolStatusError) {
    if (error.status === 401) {
      clearAuthority();
      return new RemoteConnectionError(
        "unauthorized",
        error.reasonCode === "expired"
          ? "This remote device credential expired; pair this browser again."
          : error.reasonCode === "revoked"
            ? "This remote device was revoked; pair this browser again."
            : "Remote authentication was rejected.",
        error.reasonCode,
      );
    }
    return new RemoteConnectionError("unavailable", "Remote protocol request failed.");
  }
  // Network failure (fetch threw) or unexpected error. A host that could not be
  // reached has said nothing about this device's credential, so the pairing is
  // kept and the connection can simply be retried. Dropping it here would turn
  // one unreachable moment — waking from sleep before the network is back —
  // into a demand to pair the device again.
  return new RemoteConnectionError("unavailable", "Remote host is unavailable.");
}

async function protocolStatusError(response: Response): Promise<RemoteProtocolStatusError> {
  let reasonCode: RemoteReauthReason | undefined;
  try {
    const body = (await response.clone().json()) as { reasonCode?: unknown };
    if (body.reasonCode === "expired" || body.reasonCode === "revoked") {
      reasonCode = body.reasonCode;
    }
  } catch {
    // Hosts may intentionally omit a failure body; preserve a generic rejection.
  }
  return new RemoteProtocolStatusError(response.status, reasonCode);
}

function readSessionIdFromSetCookie(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
  return match?.[1];
}
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function cryptoSubtleDigest(data: Uint8Array): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest("SHA-256", data.slice().buffer);
}
