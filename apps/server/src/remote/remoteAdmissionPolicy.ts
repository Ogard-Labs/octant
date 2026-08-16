// Bounded in-memory admission policy for the remote listener boundary.
//
// The policy keeps per-source, per-device, and listener-wide token buckets and
// concurrent counters that bound hostile traffic without trusting request
// headers. All state is process-scoped and in-memory: a restart clears every
// bucket. The policy never stores raw peer addresses or the HMAC salt; callers
// pass already-derived opaque source/device keys (see RequestTransportFacts).

import type { RequestTransportFacts } from "../server";

export type RemoteAdmissionSurface = "pairing" | "auth" | "product" | "pre-auth";

export type RemoteAdmissionPathSurface = RemoteAdmissionSurface | "static-asset";

export interface RemoteAdmissionLimits {
  /** Pairing token bucket per opaque source key per minute. */
  readonly pairingPerSourcePerMinute: number;
  /** Pairing token bucket for the whole host per minute. */
  readonly pairingPerHostPerMinute: number;
  /** Authentication token bucket per opaque source key per minute. */
  readonly authPerSourcePerMinute: number;
  /** Authentication token bucket per opaque device key per minute. */
  readonly authPerDevicePerMinute: number;
  /** Product concurrent requests per opaque device key. */
  readonly productConcurrentPerDevice: number;
  /** Product concurrent requests across the whole listener. */
  readonly productConcurrentPerListener: number;
  /** Product state-changing (POST/PUT/PATCH/DELETE) token bucket per device per minute. */
  readonly productStateChangingPerDevicePerMinute: number;
  /** Coarse retry-after advertised to rejected remote clients. */
  readonly retryAfterMs: number;
}

export const DEFAULT_REMOTE_ADMISSION_LIMITS: RemoteAdmissionLimits = {
  pairingPerSourcePerMinute: 10,
  pairingPerHostPerMinute: 60,
  authPerSourcePerMinute: 30,
  authPerDevicePerMinute: 12,
  productConcurrentPerDevice: 8,
  productConcurrentPerListener: 32,
  productStateChangingPerDevicePerMinute: 60,
  retryAfterMs: 60_000,
};

const WINDOW_MS = 60_000;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_MAX_MAP_ENTRIES = 4096;

export interface RemoteAdmissionIdentity {
  readonly sourceKey: string;
  readonly deviceKey?: string;
}

export interface RemoteAdmissionAcquireInput {
  readonly surface: RemoteAdmissionSurface;
  readonly identity: RemoteAdmissionIdentity;
  readonly method: string;
  readonly now?: number;
}

export type RemoteAdmissionDecision =
  | { readonly kind: "admitted"; readonly release: () => void }
  | { readonly kind: "rejected"; readonly retryAfterMs: number };

export interface RemoteAdmissionCounts {
  readonly productConcurrentListener: number;
}

export interface RemoteAdmissionDiagnostics {
  readonly pairingSourceMapSize: number;
  readonly authSourceMapSize: number;
  readonly authDeviceMapSize: number;
  readonly productDeviceConcurrentMapSize: number;
  readonly productDeviceStateChangingMapSize: number;
  readonly maxMapEntries: number;
}

export interface RemoteAdmissionPolicyOptions {
  readonly limits?: Partial<RemoteAdmissionLimits>;
  readonly now?: () => number;
  /** Hard cap on distinct keys per map. When saturated with live entries, new keys are rejected. */
  readonly maxMapEntries?: number;
}

export interface RemoteAdmissionPolicy {
  readonly acquire: (input: RemoteAdmissionAcquireInput) => RemoteAdmissionDecision;
  readonly reset: () => void;
  readonly counts: () => RemoteAdmissionCounts;
  readonly diagnostics: () => RemoteAdmissionDiagnostics;
}

const NOOP_RELEASE = () => {};

/**
 * Validate that a number is a finite positive integer. Throws if not.
 */
function assertFinitePositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `RemoteAdmissionPolicy: ${name} must be a finite positive integer, got ${value}`,
    );
  }
}

export function createRemoteAdmissionPolicy(
  options: RemoteAdmissionPolicyOptions = {},
): RemoteAdmissionPolicy {
  const limits: RemoteAdmissionLimits = { ...DEFAULT_REMOTE_ADMISSION_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());
  const maxMapEntries = options.maxMapEntries ?? DEFAULT_MAX_MAP_ENTRIES;

  // Validate all admission limits as finite positive integers so a
  // misconfiguration cannot silently disable a bucket or produce NaN state.
  assertFinitePositiveInteger(limits.pairingPerSourcePerMinute, "pairingPerSourcePerMinute");
  assertFinitePositiveInteger(limits.pairingPerHostPerMinute, "pairingPerHostPerMinute");
  assertFinitePositiveInteger(limits.authPerSourcePerMinute, "authPerSourcePerMinute");
  assertFinitePositiveInteger(limits.authPerDevicePerMinute, "authPerDevicePerMinute");
  assertFinitePositiveInteger(limits.productConcurrentPerDevice, "productConcurrentPerDevice");
  assertFinitePositiveInteger(limits.productConcurrentPerListener, "productConcurrentPerListener");
  assertFinitePositiveInteger(
    limits.productStateChangingPerDevicePerMinute,
    "productStateChangingPerDevicePerMinute",
  );
  assertFinitePositiveInteger(limits.retryAfterMs, "retryAfterMs");
  assertFinitePositiveInteger(maxMapEntries, "maxMapEntries");

  const pairingSource = new Map<string, number[]>();
  let pairingHost: number[] = [];
  const authSource = new Map<string, number[]>();
  const authDevice = new Map<string, number[]>();
  const productDeviceConcurrent = new Map<string, number>();
  let productListenerConcurrent = 0;
  const productDeviceStateChanging = new Map<string, number[]>();

  /** Sweep expired entries from a token-bucket map. Mutates the map in place. */
  const sweepMap = (map: Map<string, number[]>, current: number): void => {
    const threshold = current - WINDOW_MS;
    for (const [key, bucket] of map) {
      let start = 0;
      while (start < bucket.length && (bucket[start] ?? Infinity) <= threshold) start += 1;
      if (start >= bucket.length) {
        map.delete(key);
      } else if (start > 0) {
        bucket.splice(0, start);
      }
    }
  };

  /** Sweep all token-bucket maps. Called on each acquire to bound cardinality. */
  const sweepAll = (current: number): void => {
    sweepMap(pairingSource, current);
    sweepMap(authSource, current);
    sweepMap(authDevice, current);
    sweepMap(productDeviceStateChanging, current);
    const hostThreshold = current - WINDOW_MS;
    let hostStart = 0;
    while (hostStart < pairingHost.length && (pairingHost[hostStart] ?? Infinity) <= hostThreshold)
      hostStart += 1;
    if (hostStart > 0) pairingHost = pairingHost.slice(hostStart);
  };

  const tryBucket = (
    map: Map<string, number[]>,
    key: string,
    limit: number,
    current: number,
  ): boolean => {
    const threshold = current - WINDOW_MS;
    const existing = map.get(key);
    let bucket = existing ?? [];
    let start = 0;
    while (start < bucket.length && (bucket[start] ?? Infinity) <= threshold) start += 1;
    if (start > 0) bucket = bucket.slice(start);
    if (bucket.length >= limit) {
      if (existing === undefined) {
        if (bucket.length > 0) map.set(key, bucket);
      } else if (start > 0) {
        existing.length = 0;
        for (const ts of bucket) existing.push(ts);
      }
      return false;
    }
    bucket.push(current);
    if (existing === undefined || start > 0) map.set(key, bucket);
    return true;
  };

  /**
   * Try to insert a new key into a map, respecting the hard cardinality cap.
   * Returns true if the key already exists or was inserted; false if the map
   * is at capacity with live entries and the key is new (fail-closed).
   */
  const canInsertKey = (map: Map<string, number[]>, key: string): boolean => {
    if (map.has(key)) return true;
    if (map.size >= maxMapEntries) return false;
    return true;
  };

  const tryHostBucket = (limit: number, current: number): boolean => {
    const threshold = current - WINDOW_MS;
    let start = 0;
    while (start < pairingHost.length && (pairingHost[start] ?? Infinity) <= threshold) start += 1;
    if (start > 0) pairingHost = pairingHost.slice(start);
    if (pairingHost.length >= limit) return false;
    pairingHost.push(current);
    return true;
  };

  const acquire = (input: RemoteAdmissionAcquireInput): RemoteAdmissionDecision => {
    const current = input.now ?? now();
    const method = input.method.toUpperCase();
    const { sourceKey, deviceKey } = input.identity;

    // Sweep expired entries on every acquire to bound cardinality under churn.
    sweepAll(current);

    if (input.surface === "pre-auth") {
      return { kind: "admitted", release: NOOP_RELEASE };
    }

    if (input.surface === "pairing") {
      if (!canInsertKey(pairingSource, sourceKey)) return reject(limits);
      if (!tryBucket(pairingSource, sourceKey, limits.pairingPerSourcePerMinute, current)) {
        return reject(limits);
      }
      if (!tryHostBucket(limits.pairingPerHostPerMinute, current)) return reject(limits);
      return { kind: "admitted", release: NOOP_RELEASE };
    }

    if (input.surface === "auth") {
      if (!canInsertKey(authSource, sourceKey)) return reject(limits);
      if (!tryBucket(authSource, sourceKey, limits.authPerSourcePerMinute, current)) {
        return reject(limits);
      }
      if (deviceKey !== undefined) {
        if (!canInsertKey(authDevice, deviceKey)) return reject(limits);
        if (!tryBucket(authDevice, deviceKey, limits.authPerDevicePerMinute, current)) {
          return reject(limits);
        }
      }
      return { kind: "admitted", release: NOOP_RELEASE };
    }

    // product
    if (productListenerConcurrent >= limits.productConcurrentPerListener) {
      return reject(limits);
    }
    if (deviceKey !== undefined) {
      const deviceConcurrent = productDeviceConcurrent.get(deviceKey) ?? 0;
      if (deviceConcurrent >= limits.productConcurrentPerDevice) return reject(limits);
      if (STATE_CHANGING_METHODS.has(method)) {
        if (!canInsertKey(productDeviceStateChanging, deviceKey)) return reject(limits);
        if (
          !tryBucket(
            productDeviceStateChanging,
            deviceKey,
            limits.productStateChangingPerDevicePerMinute,
            current,
          )
        ) {
          return reject(limits);
        }
      }
    }

    productListenerConcurrent += 1;
    if (deviceKey !== undefined) {
      productDeviceConcurrent.set(deviceKey, (productDeviceConcurrent.get(deviceKey) ?? 0) + 1);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      productListenerConcurrent = Math.max(0, productListenerConcurrent - 1);
      if (deviceKey !== undefined) {
        const next = Math.max(0, (productDeviceConcurrent.get(deviceKey) ?? 0) - 1);
        if (next === 0) productDeviceConcurrent.delete(deviceKey);
        else productDeviceConcurrent.set(deviceKey, next);
      }
    };
    return { kind: "admitted", release };
  };

  const reset = (): void => {
    pairingSource.clear();
    pairingHost = [];
    authSource.clear();
    authDevice.clear();
    productDeviceConcurrent.clear();
    productListenerConcurrent = 0;
    productDeviceStateChanging.clear();
  };

  const counts = (): RemoteAdmissionCounts => ({
    productConcurrentListener: productListenerConcurrent,
  });

  const diagnostics = (): RemoteAdmissionDiagnostics => ({
    pairingSourceMapSize: pairingSource.size,
    authSourceMapSize: authSource.size,
    authDeviceMapSize: authDevice.size,
    productDeviceConcurrentMapSize: productDeviceConcurrent.size,
    productDeviceStateChangingMapSize: productDeviceStateChanging.size,
    maxMapEntries,
  });

  return { acquire, reset, counts, diagnostics };
}

function reject(limits: RemoteAdmissionLimits): RemoteAdmissionDecision {
  return { kind: "rejected", retryAfterMs: limits.retryAfterMs };
}

/**
 * Classify a request path into an admission surface. The classification is
 * path-based only and never inspects headers. The actual pairing
 * and auth endpoints live under `/api/remote/pairing/...` and
 * `/api/remote/auth/...`; the pre-auth hello handshake at
 * `/api/remote/hello` shares the pairing budget so nonce issuance cannot be
 * used to fill the product map or bypass source/host admission. Legacy
 * `/api/pairing` and `/api/auth` paths are treated as ordinary product routes.
 */
export function classifyRemoteAdmissionPath(pathname: string): RemoteAdmissionPathSurface {
  if (pathname === "/health" || pathname === "/api/hosts") return "pre-auth";
  if (pathname === "/api/remote/hello") return "pairing";
  if (matchPathPrefix(pathname, "/api/remote/pairing")) return "pairing";
  if (matchPathPrefix(pathname, "/api/remote/auth")) return "auth";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "product";
  return "static-asset";
}

/**
 * Match a pathname against an exact path or prefix boundary. `/api/remote/pairing`
 * matches itself and `/api/remote/pairing/...` but not `/api/remote/pairingx`.
 */
function matchPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Resolve an opaque device key for a request, when an authenticated session is
 * present. This module does not implement the credential/session lifecycle, so
 * the default resolver returns `undefined` and per-device caps are exercised
 * directly through the policy API until the session boundary supplies a real
 * resolver.
 */
export type RemoteAdmissionDeviceKeyResolver = (
  request: Request,
  facts: RequestTransportFacts,
) => string | undefined;

export interface RemoteBoundaryFetchOptions {
  readonly fetch: (request: Request, facts?: RequestTransportFacts) => Response | Promise<Response>;
  readonly admission: RemoteAdmissionPolicy;
  readonly deviceKeyResolver?: RemoteAdmissionDeviceKeyResolver;
}

/**
 * Wrap a remote fetch handler with the trusted-facts rejection and bounded
 * admission boundary. The boundary:
 *
 * - rejects API traffic whose peer identity is missing or unclassifiable,
 *   while leaving static assets to the inner handler's exact Host/origin
 *   policy;
 * - acquires admission for pairing/auth/product surfaces and returns a coarse
 *   `Retry-After` 429 when a bucket is exhausted;
 * - releases product concurrency on response completion, failure, abort, and
 *   response-stream cancellation.
 *
 * It never inspects forwarded identity headers; facts are derived from the
 * accepted socket by the transport adapter.
 */
export function createRemoteBoundaryFetch(
  options: RemoteBoundaryFetchOptions,
): (request: Request, facts?: RequestTransportFacts) => Promise<Response> {
  const resolveDeviceKey = options.deviceKeyResolver ?? (() => undefined);
  return async (request, facts) => {
    if (facts === undefined) {
      return remoteBoundaryRejection(403);
    }
    const pathSurface = classifyRemoteAdmissionPath(new URL(request.url).pathname);
    const unclassifiable = facts.sourceClass === "unknown" || facts.sourceKey === "";

    if (unclassifiable && pathSurface !== "static-asset") {
      return remoteBoundaryRejection(403);
    }

    if (pathSurface === "static-asset" || pathSurface === "pre-auth") {
      return options.fetch(request, facts);
    }

    const deviceKey = resolveDeviceKey(request, facts);
    const decision = options.admission.acquire({
      surface: pathSurface,
      identity: {
        sourceKey: facts.sourceKey,
        ...(deviceKey === undefined ? {} : { deviceKey }),
      },
      method: request.method,
    });
    if (decision.kind === "rejected") {
      return remoteBoundaryRejection(429, {
        "retry-after": String(Math.ceil(decision.retryAfterMs / 1000)),
      });
    }

    // Tie admission release to request.signal abort so that a handler which
    // ignores cancellation cannot hold a concurrency slot forever. The abort
    // listener is removed on release so normal completion does not retain the
    // request/decision closures on the signal.
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      request.signal.removeEventListener("abort", onAbort);
      decision.release();
    };
    const onAbort = () => releaseOnce();
    if (request.signal.aborted) {
      releaseOnce();
      return remoteBoundaryRejection(499);
    }
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await options.fetch(request, facts);
      // If the request was aborted during the handler, release immediately and
      // discard the response body to avoid leaking a reader.
      if (request.signal.aborted) {
        releaseOnce();
        response.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 499 });
      }
      // withAdmissionRelease calls releaseOnce on body completion, error, or
      // cancel, which also removes the abort listener.
      return withAdmissionRelease(response, releaseOnce);
    } catch (error) {
      releaseOnce();
      throw error;
    }
  };
}

function remoteBoundaryRejection(
  status: number,
  extra: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(
    {
      product: "Octant",
      status: "rejected",
      category: "unavailable",
      message: "Remote request rejected.",
    },
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        vary: "Origin",
        "x-content-type-options": "nosniff",
        ...extra,
      },
    },
  );
}

/**
 * Tie an admission release to a response body's lifecycle. The release runs on
 * stream completion, stream error, and stream cancellation; responses without
 * a body release immediately. The release is idempotent.
 */
export function withAdmissionRelease(response: Response, release: () => void): Response {
  if (response.body === null) {
    release();
    return response;
  }
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done || next.value === undefined) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel() {
      // Release admission synchronously, then fire the upstream cancel as a
      // best-effort background operation. A hostile upstream whose cancel()
      // never settles must not pin the admission slot or block the wrapped
      // stream's cancel promise.
      finish();
      reader.cancel().catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
