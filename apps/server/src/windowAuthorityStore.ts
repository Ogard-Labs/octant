import { createHash, timingSafeEqual } from "node:crypto";
import { uptime } from "node:os";
import type { WindowId } from "@octant/contracts";

export const WINDOW_AUTHORITY_TTL_MS = 24 * 60 * 60 * 1_000;
export const NATIVE_WINDOW_LEASE_MS = 15_000;
const MAX_NATIVE_WINDOWS = 128;
const OPAQUE_256_BIT_TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isCanonical256BitToken(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_256_BIT_TOKEN.test(value);
}

export class WindowAuthorityError extends Error {
  readonly category: "invalid" | "unauthorized" | "unavailable" | "conflict";

  constructor(category: WindowAuthorityError["category"], message: string) {
    super(message);
    this.name = "WindowAuthorityError";
    this.category = category;
  }
}

export interface NativeWindowSource {
  readonly kind: "native-nightly";
  readonly processRegistration: string;
  readonly incarnation: string;
  readonly generation: number;
}

interface NativeLease {
  readonly source: NativeWindowSource;
  readonly elapsedExpiry: number;
  readonly lifetime: AbortController;
  cancel: () => void;
}

interface AuthorityRecord {
  readonly windowId: WindowId;
  readonly expiresAt: number;
  readonly native?: NativeLease;
  readonly rendererIdentity?: string;
  /** Main-only token of a native window; never sent to or by its renderer. */
  readonly nativeMainToken?: string;
}

export interface WindowAuthorityStoreOptions {
  readonly elapsedNow?: () => number;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
  /**
   * Clamp every caller-supplied wall-clock reading against a
   * shared, server-owned process-monotonic bound (see `ProcessAuthorityClock`) before
   * it is used for expiry math. Every route that reaches this store still
   * passes its own raw `Date.now()`-derived value unchanged; the store itself
   * refuses to trust a reading that has moved backward past what has already
   * been observed, so a host wall-clock rollback cannot revive an expired
   * window-authority capability. Defaults to the identity function so
   * existing callers/tests that pass deterministic fake clocks are unaffected.
   */
  readonly clampNow?: (wallClockMs: number) => number;
  /**
   * When the shared clock posture is `recovery-required` (the
   * wall clock is unsafe — a large rollback, malformed reading, or an
   * implausible forward jump), refuse to mint or extend a window-authority
   * capability rather than granting trust against an unsafe clock. Without
   * this gate a rollback beyond tolerance clamps `now` to the frozen
   * high-water mark yet still mints a fresh 24-hour capability, which after a
   * day-long rollback lasts roughly two real days. Existing capabilities
   * continue to be checked via the monotonic clamp regardless of posture,
   * matching the fail-closed issuance policy used by Code approval
   * (`CodeOperationApprovalStore`) and launch sessions (`LaunchSessionStore`).
   * Defaults to a posture of `ok`.
   */
  readonly clockPosture?: () => "ok" | "recovery-required";
}

export class WindowAuthorityStore {
  #nativeClosed = false;
  readonly #byCapability = new Map<string, AuthorityRecord>();
  readonly #capabilityByWindow = new Map<WindowId, string>();
  readonly #clampNow: (wallClockMs: number) => number;
  readonly #clockPosture: () => "ok" | "recovery-required";
  readonly #elapsedNow: () => number;
  readonly #schedule: (delayMs: number, callback: () => void) => () => void;

  constructor(
    private readonly onRevoked?: (windowId: WindowId) => void,
    options?: WindowAuthorityStoreOptions,
  ) {
    this.#clampNow = options?.clampNow ?? ((wallClockMs) => wallClockMs);
    this.#clockPosture = options?.clockPosture ?? (() => "ok");
    this.#elapsedNow = options?.elapsedNow ?? (() => uptime() * 1_000);
    this.#schedule =
      options?.schedule ??
      ((delay, callback) => {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  register(input: {
    readonly windowId: WindowId;
    readonly capability: string;
    readonly rendererIdentity?: string;
    readonly now: number;
  }) {
    const now = this.#clampNow(input.now);
    this.#requireIssuancePosture();
    this.#removeExpired(now);
    if (!isCanonical256BitToken(input.capability)) {
      throw new WindowAuthorityError("invalid", "Window authority registration is invalid.");
    }
    validateRendererIdentity(input.rendererIdentity);
    if (this.#byCapability.has(input.capability) || this.#capabilityByWindow.has(input.windowId)) {
      throw new WindowAuthorityError("conflict", "Window authority is already registered.");
    }
    this.#byCapability.set(input.capability, {
      windowId: input.windowId,
      expiresAt: now + WINDOW_AUTHORITY_TTL_MS,
      ...(input.rendererIdentity === undefined ? {} : { rendererIdentity: input.rendererIdentity }),
    });
    this.#capabilityByWindow.set(input.windowId, input.capability);
  }

  registerOrRefresh(input: {
    readonly windowId: WindowId;
    readonly capability: string;
    readonly rendererIdentity?: string;
    readonly now: number;
  }) {
    const now = this.#clampNow(input.now);
    this.#requireIssuancePosture();
    this.#removeExpired(now);
    if (!isCanonical256BitToken(input.capability)) {
      throw new WindowAuthorityError("invalid", "Window authority registration is invalid.");
    }
    validateRendererIdentity(input.rendererIdentity);
    const existingByCapability = this.#byCapability.get(input.capability);
    const existingByWindow = this.#capabilityByWindow.get(input.windowId);
    if (existingByCapability?.native !== undefined) {
      throw new WindowAuthorityError(
        "conflict",
        "Native window authority requires its current lease.",
      );
    }
    if (existingByCapability !== undefined && existingByCapability.windowId !== input.windowId) {
      throw new WindowAuthorityError("conflict", "Window authority is already registered.");
    }
    if (existingByWindow !== undefined && existingByWindow !== input.capability) {
      throw new WindowAuthorityError("conflict", "Window authority is already registered.");
    }
    const rendererIdentity = input.rendererIdentity ?? existingByCapability?.rendererIdentity;
    this.#byCapability.set(input.capability, {
      windowId: input.windowId,
      expiresAt: now + WINDOW_AUTHORITY_TTL_MS,
      ...(rendererIdentity === undefined ? {} : { rendererIdentity }),
    });
    this.#capabilityByWindow.set(input.windowId, input.capability);
  }

  registerNative(input: {
    readonly windowId: WindowId;
    readonly capability: string;
    readonly rendererIdentity: string;
    readonly nativeMainToken?: string;
    readonly source: NativeWindowSource;
    readonly now: number;
  }): { readonly expiresAt: number; readonly generation: number } {
    const now = this.#clampNow(input.now);
    if (this.#nativeClosed)
      throw new WindowAuthorityError("unavailable", "Native window authority is closed.");
    this.#requireIssuancePosture();
    this.#removeExpired(now);
    validateNativeSource(input.source);
    if (
      !isCanonical256BitToken(input.capability) ||
      !isCanonical256BitToken(input.rendererIdentity) ||
      (input.nativeMainToken !== undefined &&
        (!isCanonical256BitToken(input.nativeMainToken) ||
          input.nativeMainToken === input.capability ||
          input.nativeMainToken === input.rendererIdentity))
    ) {
      throw new WindowAuthorityError("invalid", "Native window authority is invalid.");
    }
    if (this.#byCapability.has(input.capability) || this.#capabilityByWindow.has(input.windowId)) {
      throw new WindowAuthorityError("conflict", "Window authority is already registered.");
    }
    if (
      [...this.#byCapability.values()].filter((record) => record.native !== undefined).length >=
      MAX_NATIVE_WINDOWS
    ) {
      throw new WindowAuthorityError("unavailable", "Native window authority is at capacity.");
    }
    const record = this.#nativeRecord(
      input.windowId,
      input.rendererIdentity,
      input.nativeMainToken,
      input.source,
      now,
    );
    this.#byCapability.set(input.capability, record);
    this.#capabilityByWindow.set(input.windowId, input.capability);
    this.#scheduleExpiry(input.capability, record);
    return { expiresAt: record.expiresAt, generation: input.source.generation };
  }

  renewNative(input: {
    readonly windowId: WindowId;
    readonly capability: string;
    readonly source: NativeWindowSource;
    readonly now: number;
  }): { readonly expiresAt: number; readonly generation: number } {
    const now = this.#clampNow(input.now);
    if (this.#nativeClosed)
      throw new WindowAuthorityError("unavailable", "Native window authority is closed.");
    this.#requireIssuancePosture();
    validateNativeSource(input.source);
    const existing = this.#authenticateRecord(input.capability, now);
    const source = existing.native?.source;
    if (
      existing.windowId !== input.windowId ||
      source === undefined ||
      source.processRegistration !== input.source.processRegistration ||
      source.incarnation !== input.source.incarnation ||
      source.generation !== input.source.generation ||
      existing.rendererIdentity === undefined
    ) {
      throw new WindowAuthorityError("unauthorized", "Native window lease is invalid.");
    }
    const replacement = this.#nativeRecord(
      existing.windowId,
      existing.rendererIdentity,
      existing.nativeMainToken,
      source,
      now,
      existing.native?.lifetime,
    );
    existing.native?.cancel();
    this.#byCapability.set(input.capability, replacement);
    this.#scheduleExpiry(input.capability, replacement);
    return { expiresAt: replacement.expiresAt, generation: source.generation };
  }

  revokeNative(input: {
    readonly windowId: WindowId;
    readonly capability: string;
    readonly source: NativeWindowSource;
  }): void {
    validateNativeSource(input.source);
    const record = this.#byCapability.get(input.capability);
    if (record === undefined) return;
    const source = record.native?.source;
    if (
      record.windowId !== input.windowId ||
      source === undefined ||
      source.processRegistration !== input.source.processRegistration ||
      source.incarnation !== input.source.incarnation ||
      source.generation !== input.source.generation
    ) {
      throw new WindowAuthorityError("unauthorized", "Native window lease is invalid.");
    }
    this.#delete(input.capability, input.windowId);
  }

  authenticate(capability: string, rawNow: number): WindowId {
    return this.#authenticateRecord(capability, this.#clampNow(rawNow)).windowId;
  }

  authenticateAuthority(
    capability: string,
    rawNow: number,
  ): {
    readonly windowId: WindowId;
    readonly generation?: number;
  } {
    const windowId = this.authenticate(capability, rawNow);
    const native = this.#byCapability.get(capability)?.native;
    return { windowId, ...(native === undefined ? {} : { generation: native.source.generation }) };
  }

  authenticateRenderer(capability: string, rendererIdentity: string, rawNow: number): WindowId {
    if (!isCanonical256BitToken(rendererIdentity)) {
      throw new WindowAuthorityError("unauthorized", "Renderer identity is invalid.");
    }
    const record = this.#authenticateRecord(capability, this.#clampNow(rawNow));
    if (record.rendererIdentity !== rendererIdentity) {
      throw new WindowAuthorityError("unauthorized", "Renderer identity is invalid.");
    }
    return record.windowId;
  }

  /**
   * Admit a native window's main process. The token is valid only with the
   * live native lease of exactly the window it was registered with: expiry,
   * revocation and lease loss delete that record and the token with it.
   */
  authenticateNativeMain(capability: string, nativeMainToken: string, rawNow: number): WindowId {
    if (!isCanonical256BitToken(nativeMainToken)) {
      throw new WindowAuthorityError("unauthorized", "Native main authority is invalid.");
    }
    const record = this.#authenticateRecord(capability, this.#clampNow(rawNow));
    if (
      record.native === undefined ||
      record.nativeMainToken === undefined ||
      !tokensEqual(record.nativeMainToken, nativeMainToken)
    ) {
      throw new WindowAuthorityError("unauthorized", "Native main authority is invalid.");
    }
    return record.windowId;
  }

  #authenticateRecord(capability: string, now: number): AuthorityRecord {
    if (!isCanonical256BitToken(capability)) {
      throw new WindowAuthorityError("unauthorized", "Window authority is invalid.");
    }
    const record = this.#byCapability.get(capability);
    if (record === undefined || this.#expired(record, now)) {
      if (record !== undefined) this.#delete(capability, record.windowId);
      throw new WindowAuthorityError("unauthorized", "Window authority is invalid.");
    }
    return record;
  }

  #nativeRecord(
    windowId: WindowId,
    rendererIdentity: string,
    nativeMainToken: string | undefined,
    source: NativeWindowSource,
    now: number,
    lifetime = new AbortController(),
  ): AuthorityRecord {
    const elapsed = this.#elapsedNow();
    if (!Number.isFinite(now) || !Number.isFinite(elapsed)) {
      throw new WindowAuthorityError("unavailable", "Native window time is unavailable.");
    }
    return {
      windowId,
      rendererIdentity,
      ...(nativeMainToken === undefined ? {} : { nativeMainToken }),
      expiresAt: now + NATIVE_WINDOW_LEASE_MS,
      native: {
        source: Object.freeze({ ...source }),
        elapsedExpiry: elapsed + NATIVE_WINDOW_LEASE_MS,
        lifetime,
        cancel: () => {},
      },
    };
  }

  #scheduleExpiry(capability: string, record: AuthorityRecord): void {
    const native = record.native;
    if (native === undefined) return;
    const expire = () => {
      if (this.#byCapability.get(capability) !== record) return;
      const remaining = native.elapsedExpiry - this.#elapsedNow();
      if (!Number.isFinite(remaining) || remaining <= 0) this.#delete(capability, record.windowId);
      else {
        try {
          native.cancel = this.#schedule(remaining, expire);
        } catch {
          this.#delete(capability, record.windowId);
          console.warn("Octant could not maintain native window expiry.");
        }
      }
    };
    try {
      native.cancel = this.#schedule(NATIVE_WINDOW_LEASE_MS, expire);
    } catch {
      this.#delete(capability, record.windowId);
      throw new WindowAuthorityError("unavailable", "Native window expiry is unavailable.");
    }
  }

  #expired(record: AuthorityRecord, now: number): boolean {
    if (now >= record.expiresAt) return true;
    if (record.native === undefined) return false;
    const elapsed = this.#elapsedNow();
    return (
      !Number.isFinite(now) || !Number.isFinite(elapsed) || elapsed >= record.native.elapsedExpiry
    );
  }

  revokeNativeLeases(): void {
    this.#nativeClosed = true;
    for (const [capability, record] of this.#byCapability) {
      if (record.native !== undefined) this.#delete(capability, record.windowId);
    }
  }

  nativePresentationAuthority(
    capability: string,
    rawNow: number,
  ):
    | {
        readonly windowId: WindowId;
        readonly source: NativeWindowSource;
        readonly signal: AbortSignal;
      }
    | undefined {
    const record = this.#authenticateRecord(capability, this.#clampNow(rawNow));
    if (record.native === undefined) return undefined;
    return {
      windowId: record.windowId,
      source: { ...record.native.source },
      signal: record.native.lifetime.signal,
    };
  }

  nativeRequestSignal(capability: string, rawNow: number): AbortSignal | undefined {
    const native = this.#byCapability.get(capability)?.native;
    if (native === undefined) return undefined;
    this.#authenticateRecord(capability, this.#clampNow(rawNow));
    return native.lifetime.signal;
  }

  revoke(windowId: WindowId): void {
    const capability = this.#capabilityByWindow.get(windowId);
    if (capability !== undefined) this.#delete(capability, windowId);
  }

  size(): number {
    return this.#byCapability.size;
  }

  /** Snapshot of currently registered (non-expired) local window ids. */
  listWindowIds(rawNow: number = Date.now()): ReadonlyArray<WindowId> {
    const now = this.#clampNow(rawNow);
    this.#removeExpired(now);
    return [...this.#capabilityByWindow.keys()];
  }

  /**
   * Fail closed on issuing or extending a window-authority capability while
   * the shared clock posture is `recovery-required`. Minting from a clamped
   * reading is the dangerous case: the clamp already froze `now` at the
   * high-water mark, so a fresh capability would inherit that frozen time and
   * live well past its nominal TTL once the wall clock is corrected.
   */
  #requireIssuancePosture(): void {
    if (this.#clockPosture() === "recovery-required") {
      throw new WindowAuthorityError(
        "unavailable",
        "Window authority is unavailable while host time recovery is required.",
      );
    }
  }

  #removeExpired(now: number): void {
    for (const [capability, record] of this.#byCapability) {
      if (this.#expired(record, now)) this.#delete(capability, record.windowId);
    }
  }

  #delete(capability: string, windowId: WindowId): void {
    const native = this.#byCapability.get(capability)?.native;
    this.#byCapability.delete(capability);
    this.#capabilityByWindow.delete(windowId);
    native?.lifetime.abort();
    native?.cancel();
    try {
      this.onRevoked?.(windowId);
    } catch (error) {
      if (native === undefined) throw error;
      // Expiry runs outside a request's catch boundary. State and streams are
      // already revoked; cleanup failure must not resurrect it or kill the host.
      console.warn("Octant could not finish cleaning up a revoked native window.");
    }
  }
}

function tokensEqual(expected: string, actual: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(expected, "utf8").digest(),
    createHash("sha256").update(actual, "utf8").digest(),
  );
}

function validateRendererIdentity(rendererIdentity: string | undefined): void {
  if (rendererIdentity !== undefined && !isCanonical256BitToken(rendererIdentity)) {
    throw new WindowAuthorityError("invalid", "Window renderer identity is invalid.");
  }
}

function validateNativeSource(source: NativeWindowSource): void {
  if (
    source.kind !== "native-nightly" ||
    !isCanonical256BitToken(source.processRegistration) ||
    !/^[0-9a-f]{64}$/.test(source.incarnation) ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 1
  ) {
    throw new WindowAuthorityError("invalid", "Native window source is invalid.");
  }
}
