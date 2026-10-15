import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RemoteServerGrantCloseReason } from "@octant/contracts";
import {
  decodeRemoteAuthenticatedRequestResultV1,
  decodeRemoteRequestFactsV1,
  type RemoteAuthChallengeV1,
  type RemoteAuthenticatedRequestResultV1,
  type RemoteRequestFactsV1,
} from "@octant/contracts/remote-request-proof";
import {
  REMOTE_REQUEST_NONCE_RETENTION_MS,
  SESSION_IDLE_TTL_MS,
  canonicalizeRemotePathQuery,
  evaluateRemoteRequestFreshness,
} from "@octant/domain";
import {
  RemoteRequestProofError,
  type RemoteRequestProofService,
  type RemoteServerProxySessionFacts,
} from "../remoteRequestProofService";

/**
 * The cookie a proxy session travels in. It is scoped to the proxy route's path
 * and named apart from the product session cookie, so a browser never sends it
 * to a product route and a product route never reads it.
 */
export const REMOTE_SERVER_PROXY_SESSION_COOKIE = "__Secure-octant-server-proxy-session";
export const REMOTE_SERVER_PROXY_PATH = "/api/server-proxy/";

/**
 * Budgets the proxy session keeps apart from the product session's. A cold dev
 * page is hundreds of requests, so it gets its own nonce store and concurrency,
 * sized for that, and can exhaust only these.
 */
export interface RemoteServerProxyLimits {
  /** Nonces one proxy session holds inside the replay retention window. */
  readonly noncesPerSession: number;
  readonly concurrentPerDevice: number;
  readonly concurrentPerHost: number;
  /** A device minting one more than this ends its oldest proxy session. */
  readonly sessionsPerDevice: number;
  /** Past this the host mints no further proxy session until one ends. */
  readonly sessionsPerHost: number;
}

export const DEFAULT_REMOTE_SERVER_PROXY_LIMITS: RemoteServerProxyLimits = {
  noncesPerSession: 16_384,
  concurrentPerDevice: 32,
  concurrentPerHost: 64,
  sessionsPerDevice: 4,
  sessionsPerHost: 64,
};

/** The ways a proxy session ends, each of which closes the grants bound to it. */
export type RemoteServerProxySessionEndReason = Extract<
  RemoteServerGrantCloseReason,
  | "device-revoked"
  | "device-credential-rotated"
  | "device-credential-expired"
  | "device-signed-out"
  | "listener-disabled"
  | "proxy-session-ended"
>;

export interface RemoteServerProxySessionEnded {
  readonly sessionIdDigest: string;
  readonly deviceId: string;
  readonly reason: RemoteServerProxySessionEndReason;
}

export type RemoteServerProxyProofPort = Pick<
  RemoteRequestProofService,
  "issueServerProxySessionFacts" | "deviceStanding" | "verifyDeviceRequestSignature"
>;

export interface RemoteServerProxySessionIssued {
  readonly facts: RemoteServerProxySessionFacts;
  readonly sessionId: string;
  readonly csrfToken: string;
}

/** A live proxy session as the HTTP boundary needs it. */
export interface RemoteServerProxySessionView {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly origin: string;
  readonly protocolVersion: number;
  readonly capabilityDigest: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface RemoteServerProxySessionsOptions {
  readonly proofs: RemoteServerProxyProofPort;
  /** Told once per session that ends, before the call that ended it returns. */
  readonly onSessionEnded: (ended: RemoteServerProxySessionEnded) => void;
  /**
   * Whether a session has a relayed WebSocket open. Its messages carry no
   * proof, so an open socket counts as use and keeps the session from idling
   * out; the absolute expiry still ends it.
   */
  readonly holdsOpenSockets?: (sessionIdDigest: string) => boolean;
  readonly now?: () => number;
  readonly uuid?: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly limits?: Partial<RemoteServerProxyLimits>;
}

interface LiveSession {
  readonly sessionIdDigest: string;
  readonly facts: RemoteServerProxySessionFacts;
  readonly issuedAtMs: number;
  readonly absoluteExpiresAtMs: number;
  idleExpiresAtMs: number;
  readonly csrfDigest: string;
  /** Nonce digest to the time it may be forgotten. */
  readonly nonces: Map<string, number>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Proxy sessions, held in this host's memory only.
 *
 * A device mints one with the same device-key challenge a product session
 * takes, signed over the proxy transcript, and it reaches only the proxy route.
 * Nothing here is written to the product session store, so no product route can
 * find a proxy session, and the proxy route reads only this store, so no
 * product session reaches it. A host restart ends every proxy session, and
 * every grant bound to one with it.
 *
 * Every request re-reads the device, so a revoke or rotation refuses the next
 * request even before the credential hooks end the session.
 */
export class RemoteServerProxySessions {
  readonly #proofs: RemoteServerProxyProofPort;
  readonly #onSessionEnded: (ended: RemoteServerProxySessionEnded) => void;
  readonly #holdsOpenSockets: (sessionIdDigest: string) => boolean;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #limits: RemoteServerProxyLimits;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #concurrentByDevice = new Map<string, number>();
  readonly #grantRequests = new Set<string>();
  #concurrent = 0;

  constructor(options: RemoteServerProxySessionsOptions) {
    this.#proofs = options.proofs;
    this.#onSessionEnded = options.onSessionEnded;
    this.#holdsOpenSockets = options.holdsOpenSockets ?? (() => false);
    this.#now = options.now ?? (() => Date.now());
    this.#uuid = options.uuid ?? randomUUID;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#limits = { ...DEFAULT_REMOTE_SERVER_PROXY_LIMITS, ...options.limits };
  }

  /** Throws {@link RemoteRequestProofError} for every refusal, as product issuance does. */
  issue(
    input: RemoteAuthChallengeV1 & { readonly signature: string },
  ): RemoteServerProxySessionIssued {
    this.sweepExpired();
    const facts = this.#proofs.issueServerProxySessionFacts(input);
    // The device's own oldest session goes first, so a device at its cap that
    // lost its cookie replaces a session even while the host is full.
    const own = [...this.#sessions.values()]
      .filter((session) => session.facts.deviceId === facts.deviceId)
      .sort((a, b) => a.issuedAtMs - b.issuedAtMs);
    for (const oldest of own.slice(
      0,
      Math.max(0, own.length - this.#limits.sessionsPerDevice + 1),
    )) {
      this.#end(oldest, "proxy-session-ended");
    }
    if (this.#sessions.size >= this.#limits.sessionsPerHost) {
      throw new RemoteRequestProofError("capacity");
    }

    const sessionId = this.#uuid();
    const sessionIdDigest = digest(sessionId);
    if (this.#sessions.has(sessionIdDigest)) throw new RemoteRequestProofError("capacity");
    const csrfToken = Buffer.from(this.#randomBytes(32)).toString("base64url");
    this.#sessions.set(sessionIdDigest, {
      sessionIdDigest,
      facts,
      issuedAtMs: Date.parse(facts.issuedAt),
      idleExpiresAtMs: Date.parse(facts.idleExpiresAt),
      absoluteExpiresAtMs: Date.parse(facts.absoluteExpiresAt),
      csrfDigest: digest(csrfToken),
      nonces: new Map(),
    });
    return { facts, sessionId, csrfToken };
  }

  /** The session a cookie names, while it and its device still stand. */
  describe(sessionId: string): RemoteServerProxySessionView | undefined {
    const session = this.#sessions.get(digest(sessionId));
    if (session === undefined) return undefined;
    const now = this.#now();
    this.#keepAliveWhileSocketsOpen(session, now);
    if (now >= session.idleExpiresAtMs || now >= session.absoluteExpiresAtMs) {
      this.#end(session, "proxy-session-ended");
      return undefined;
    }
    if (!this.#stillStands(session)) return undefined;
    return view(session);
  }

  /**
   * Verify one request's proof against its proxy session, with the product
   * verifier's contract: the facts decode strictly, the session and its device
   * still stand at the facts' generation and origin, the CSRF digest is the
   * session's, the proof is fresh and signed by the device's current key, and
   * its nonce is new to this session.
   */
  verifyRequest(input: unknown): RemoteAuthenticatedRequestResultV1 {
    let facts: RemoteRequestFactsV1;
    try {
      facts = decodeRemoteRequestFactsV1(input);
    } catch {
      throw new RemoteRequestProofError("invalid");
    }
    const { proof } = facts;
    if (canonicalizeRemotePathQuery(proof.canonicalPathQuery) !== proof.canonicalPathQuery) {
      throw new RemoteRequestProofError("invalid");
    }
    const session = this.#sessions.get(digest(facts.sessionId));
    if (
      session === undefined ||
      session.facts.hostId !== facts.hostId ||
      session.facts.deviceId !== facts.deviceId ||
      session.facts.credentialGeneration !== facts.credentialGeneration ||
      session.facts.origin !== facts.origin ||
      session.facts.protocolVersion !== facts.protocolVersion ||
      !this.#stillStands(session)
    ) {
      throw new RemoteRequestProofError("invalid");
    }
    if (!SAFE_METHODS.has(proof.method) && proof.csrfDigest === undefined) {
      throw new RemoteRequestProofError("invalid");
    }
    if (proof.csrfDigest !== undefined && proof.csrfDigest !== session.csrfDigest) {
      throw new RemoteRequestProofError("invalid");
    }
    const now = this.#now();
    const freshness = evaluateRemoteRequestFreshness({
      nowMs: now,
      proofTimestamp: proof.timestamp,
      session: {
        issuedAt: new Date(session.issuedAtMs).toISOString(),
        idleExpiresAt: new Date(session.idleExpiresAtMs).toISOString(),
        absoluteExpiresAt: new Date(session.absoluteExpiresAtMs).toISOString(),
      },
    });
    if (freshness.kind === "rejected") {
      if (freshness.reason === "idle-expiry" || freshness.reason === "absolute-expiry") {
        this.#end(session, "proxy-session-ended");
        throw new RemoteRequestProofError("expired");
      }
      throw new RemoteRequestProofError("invalid");
    }
    if (
      !this.#proofs.verifyDeviceRequestSignature({
        hostId: session.facts.hostId,
        deviceId: session.facts.deviceId,
        credentialGeneration: session.facts.credentialGeneration,
        origin: session.facts.origin,
        sessionId: facts.sessionId,
        proof,
      })
    ) {
      throw new RemoteRequestProofError("invalid");
    }

    // Every nonce is kept for the same retention from a monotonic clock, so
    // the map's insertion order is expiry order: prune from the front and stop
    // at the first nonce still held, rather than walking the whole store.
    for (const [nonce, expiresAt] of session.nonces) {
      if (expiresAt > now) break;
      session.nonces.delete(nonce);
    }
    const nonceDigest = digest(proof.nonce);
    if (session.nonces.has(nonceDigest)) throw new RemoteRequestProofError("replayed");
    if (session.nonces.size >= this.#limits.noncesPerSession) {
      throw new RemoteRequestProofError("capacity");
    }
    session.nonces.set(nonceDigest, now + REMOTE_REQUEST_NONCE_RETENTION_MS);
    session.idleExpiresAtMs = Math.min(now + SESSION_IDLE_TTL_MS, session.absoluteExpiresAtMs);
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

  /**
   * Hold one of the proxy's concurrent request slots for a device. `undefined`
   * means the device or the host is at its proxy budget; the product budget is
   * a different counter and is never consulted.
   */
  acquire(deviceId: string): (() => void) | undefined {
    const held = this.#concurrentByDevice.get(deviceId) ?? 0;
    if (held >= this.#limits.concurrentPerDevice) return undefined;
    if (this.#concurrent >= this.#limits.concurrentPerHost) return undefined;
    this.#concurrentByDevice.set(deviceId, held + 1);
    this.#concurrent += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#concurrent -= 1;
      const next = (this.#concurrentByDevice.get(deviceId) ?? 1) - 1;
      if (next <= 0) this.#concurrentByDevice.delete(deviceId);
      else this.#concurrentByDevice.set(deviceId, next);
    };
  }

  /**
   * Hold the device's one grant request slot. Each grant request re-observes the
   * host's listeners, so a device asks for one grant at a time; `undefined`
   * means one is already being decided.
   */
  beginGrantRequest(deviceId: string): (() => void) | undefined {
    if (this.#grantRequests.has(deviceId)) return undefined;
    this.#grantRequests.add(deviceId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#grantRequests.delete(deviceId);
    };
  }

  /** End every proxy session a device holds. */
  endDevice(deviceId: string, reason: RemoteServerProxySessionEndReason): void {
    for (const session of this.#sessions.values()) {
      if (session.facts.deviceId === deviceId) this.#end(session, reason);
    }
  }

  endAll(reason: RemoteServerProxySessionEndReason): void {
    for (const session of this.#sessions.values()) this.#end(session, reason);
  }

  /**
   * End every session past its idle or absolute expiry, or whose device no
   * longer stands, so its grants close too. The credential hooks end a device's
   * sessions as it changes; this catches one they missed.
   */
  sweepExpired(): void {
    const now = this.#now();
    for (const session of this.#sessions.values()) {
      this.#keepAliveWhileSocketsOpen(session, now);
      if (now >= session.idleExpiresAtMs || now >= session.absoluteExpiresAtMs) {
        this.#end(session, "proxy-session-ended");
      } else {
        this.#stillStands(session);
      }
    }
  }

  size(): number {
    return this.#sessions.size;
  }

  #keepAliveWhileSocketsOpen(session: LiveSession, now: number): void {
    if (now >= session.absoluteExpiresAtMs || !this.#holdsOpenSockets(session.sessionIdDigest)) {
      return;
    }
    session.idleExpiresAtMs = Math.min(now + SESSION_IDLE_TTL_MS, session.absoluteExpiresAtMs);
  }

  /** Whether the session's device still stands; ends the session, with why, when not. */
  #stillStands(session: LiveSession): boolean {
    const standing = this.#proofs.deviceStanding(session.facts);
    if (standing === "current") return true;
    this.#end(
      session,
      standing === "credential-expired"
        ? "device-credential-expired"
        : standing === "credential-rotated"
          ? "device-credential-rotated"
          : "device-revoked",
    );
    return false;
  }

  #end(session: LiveSession, reason: RemoteServerProxySessionEndReason): void {
    if (!this.#sessions.delete(session.sessionIdDigest)) return;
    try {
      this.#onSessionEnded({
        sessionIdDigest: session.sessionIdDigest,
        deviceId: session.facts.deviceId,
        reason,
      });
    } catch {
      // The session is gone whatever the listener does; its grants are refused
      // on their next request because the session cannot be found.
    }
  }
}

function view(session: LiveSession): RemoteServerProxySessionView {
  return {
    hostId: session.facts.hostId,
    deviceId: session.facts.deviceId,
    credentialGeneration: session.facts.credentialGeneration,
    origin: session.facts.origin,
    protocolVersion: session.facts.protocolVersion,
    capabilityDigest: session.facts.capabilityDigest,
    idleExpiresAt: new Date(session.idleExpiresAtMs).toISOString(),
    absoluteExpiresAt: new Date(session.absoluteExpiresAtMs).toISOString(),
  };
}

export function digestRemoteServerProxySessionId(sessionId: string): string {
  return digest(sessionId);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Which grant close reason a credential change ends a device's proxy sessions
 * with. The codes are the ones the credential lifecycle journals; one it does
 * not name is a loss of standing and ends as a revoke.
 */
export function proxySessionEndReasonForCredentialChange(
  reasonCode: string,
): RemoteServerProxySessionEndReason {
  switch (reasonCode) {
    case "signed-out":
      return "device-signed-out";
    case "credential-rotated":
    case "credentials-rotated-all":
      return "device-credential-rotated";
    case "credential-expired":
      return "device-credential-expired";
    case "listener-disabled":
      return "listener-disabled";
    // A self-revoke, a local revoke of one device or all, and a host key
    // recovery (which revokes every device the old key paired) all end the
    // device's standing as a revoke does, and are journaled with their own
    // reason on the device's record.
    default:
      return "device-revoked";
  }
}
