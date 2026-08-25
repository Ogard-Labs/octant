import type { WindowId } from "@octant/contracts";

export const WINDOW_AUTHORITY_TTL_MS = 24 * 60 * 60 * 1_000;
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

interface AuthorityRecord {
  readonly windowId: WindowId;
  readonly expiresAt: number;
  readonly rendererIdentity?: string;
}

export interface WindowAuthorityStoreOptions {
  /**
   * Clamp every caller-supplied wall-clock reading against a
   * shared, server-owned monotonic bound (see `LocalAuthorityClock`) before
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
  readonly #byCapability = new Map<string, AuthorityRecord>();
  readonly #capabilityByWindow = new Map<WindowId, string>();
  readonly #clampNow: (wallClockMs: number) => number;
  readonly #clockPosture: () => "ok" | "recovery-required";

  constructor(
    private readonly onRevoked?: (windowId: WindowId) => void,
    options?: WindowAuthorityStoreOptions,
  ) {
    this.#clampNow = options?.clampNow ?? ((wallClockMs) => wallClockMs);
    this.#clockPosture = options?.clockPosture ?? (() => "ok");
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

  authenticate(capability: string, rawNow: number): WindowId {
    if (!isCanonical256BitToken(capability)) {
      throw new WindowAuthorityError("unauthorized", "Window authority is invalid.");
    }
    const now = this.#clampNow(rawNow);
    const record = this.#byCapability.get(capability);
    if (record === undefined || now >= record.expiresAt) {
      if (record !== undefined) this.#delete(capability, record.windowId);
      throw new WindowAuthorityError("unauthorized", "Window authority is invalid.");
    }
    return record.windowId;
  }

  authenticateRenderer(capability: string, rendererIdentity: string, rawNow: number): WindowId {
    if (!isCanonical256BitToken(rendererIdentity)) {
      throw new WindowAuthorityError("unauthorized", "Renderer identity is invalid.");
    }
    const windowId = this.authenticate(capability, rawNow);
    const record = this.#byCapability.get(capability);
    if (record?.rendererIdentity !== rendererIdentity) {
      throw new WindowAuthorityError("unauthorized", "Renderer identity is invalid.");
    }
    return windowId;
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
      if (now >= record.expiresAt) this.#delete(capability, record.windowId);
    }
  }

  #delete(capability: string, windowId: WindowId): void {
    this.#byCapability.delete(capability);
    this.#capabilityByWindow.delete(windowId);
    this.onRevoked?.(windowId);
  }
}

function validateRendererIdentity(rendererIdentity: string | undefined): void {
  if (rendererIdentity !== undefined && !isCanonical256BitToken(rendererIdentity)) {
    throw new WindowAuthorityError("invalid", "Window renderer identity is invalid.");
  }
}
