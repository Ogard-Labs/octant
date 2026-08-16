import type { WindowId } from "@octant/contracts";
import { isCanonicalLaunchSessionToken } from "@octant/contracts/launch-session";
import { randomBytes as defaultRandomBytes, type randomUUID } from "node:crypto";

// Long enough for a user to copy a terminal URL into a browser, while keeping
// the browser launch authority short-lived and single-use.
export const LAUNCH_SESSION_DEFAULT_TTL_MS = 5 * 60_000;

export type RandomBytes = (size: number) => Uint8Array;

export class LaunchSessionError extends Error {
  readonly category: "invalid" | "unauthorized" | "unavailable";

  constructor(category: LaunchSessionError["category"], message: string) {
    super(message);
    this.name = "LaunchSessionError";
    this.category = category;
  }
}

interface LaunchSessionRecord {
  readonly windowId: WindowId;
  readonly capability: string;
  readonly expiresAt: number;
  consumed: boolean;
}

export interface LaunchSessionStoreOptions {
  readonly now?: () => number;
  readonly randomBytes?: RandomBytes;
  readonly uuid?: typeof randomUUID;
  /**
   * Clamp every wall-clock reading (this store's own internal
   * `now()` and any caller-supplied `exchange`/`now` value) against a shared,
   * server-owned monotonic bound (see `LocalAuthorityClock`) before it is used
   * for expiry math, so a host wall-clock rollback cannot revive an expired
   * launch session. Defaults to the identity function.
   */
  readonly clampNow?: (wallClockMs: number) => number;
  /**
   * When the shared clock posture is `recovery-required` (the
   * wall clock is unsafe — a large rollback, malformed reading, or an
   * implausible forward jump), refuse to mint a new launch session rather
   * than issuing trust against an unsafe clock. Existing tokens continue to
   * be checked via the monotonic clamp regardless of posture.
   */
  readonly clockPosture?: () => "ok" | "recovery-required";
}

export interface CreateLaunchSessionInput {
  readonly windowId: WindowId;
  readonly capability: string;
  readonly ttlMs?: number;
}

export interface LaunchSessionReceipt {
  readonly launchToken: string;
  readonly expiresAt: number;
}

export interface ExchangeLaunchSessionInput {
  readonly launchToken: string;
  readonly now: number;
}

export interface LaunchSessionExchange {
  readonly windowId: WindowId;
  readonly capability: string;
}

export class LaunchSessionStore {
  readonly #sessions = new Map<string, LaunchSessionRecord>();
  readonly #now: () => number;
  readonly #randomBytes: RandomBytes;
  readonly #clampNow: (wallClockMs: number) => number;
  readonly #clockPosture: () => "ok" | "recovery-required";

  constructor(options: LaunchSessionStoreOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#clampNow = options.clampNow ?? ((wallClockMs) => wallClockMs);
    this.#clockPosture = options.clockPosture ?? (() => "ok");
  }

  create(input: CreateLaunchSessionInput): LaunchSessionReceipt {
    if (!isCanonicalLaunchSessionToken(input.capability)) {
      throw new LaunchSessionError("invalid", "Launch session capability is invalid.");
    }
    const now = this.#clampNow(this.#now());
    if (this.#clockPosture() === "recovery-required") {
      throw new LaunchSessionError(
        "unavailable",
        "Launch session issuance is unavailable while host time recovery is required.",
      );
    }
    const ttlMs = input.ttlMs ?? LAUNCH_SESSION_DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new LaunchSessionError("invalid", "Launch session TTL is invalid.");
    }
    this.#purgeExpired(now);
    const launchToken = this.#generateToken();
    this.#sessions.set(launchToken, {
      windowId: input.windowId,
      capability: input.capability,
      expiresAt: now + ttlMs,
      consumed: false,
    });
    return { launchToken, expiresAt: now + ttlMs };
  }

  exchange(input: ExchangeLaunchSessionInput): LaunchSessionExchange {
    return this.exchangeAtomically(input, () => undefined);
  }

  /**
   * Exchange a single-use launch token only after a synchronous downstream
   * authority registration succeeds. A failure leaves the still-valid token
   * retryable, avoiding a check/use gap between expiry validation and window
   * authority issuance.
   */
  exchangeAtomically(
    input: ExchangeLaunchSessionInput,
    register: (exchange: LaunchSessionExchange) => void,
  ): LaunchSessionExchange {
    if (!isCanonicalLaunchSessionToken(input.launchToken)) {
      throw new LaunchSessionError("invalid", "Launch session token is invalid.");
    }
    const record = this.#sessions.get(input.launchToken);
    if (record === undefined) {
      throw new LaunchSessionError("invalid", "Launch session token is invalid.");
    }
    const now = this.#clampNow(input.now);
    if (now >= record.expiresAt) {
      this.#sessions.delete(input.launchToken);
      throw new LaunchSessionError("invalid", "Launch session token is invalid.");
    }
    if (record.consumed) {
      throw new LaunchSessionError("invalid", "Launch session token is invalid.");
    }
    const exchange = { windowId: record.windowId, capability: record.capability };
    record.consumed = true;
    try {
      register(exchange);
    } catch (error) {
      // No asynchronous work occurs between reservation and this rollback, so
      // an unsuccessful downstream registration cannot consume the token.
      record.consumed = false;
      throw error;
    }
    this.#sessions.delete(input.launchToken);
    return exchange;
  }

  purgeExpired(): void {
    this.#purgeExpired(this.#clampNow(this.#now()));
  }

  #purgeExpired(now: number): void {
    for (const [token, record] of this.#sessions) {
      if (now >= record.expiresAt) this.#sessions.delete(token);
    }
  }

  #generateToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = Buffer.from(this.#randomBytes(32)).toString("base64url");
      if (isCanonicalLaunchSessionToken(token) && !this.#sessions.has(token)) {
        return token;
      }
    }
    throw new LaunchSessionError("unavailable", "Launch session token generation failed.");
  }
}
