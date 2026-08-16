import { describe, expect, it, vi } from "vitest";
import {
  classifyRemoteAdmissionPath,
  createRemoteAdmissionPolicy,
  createRemoteBoundaryFetch,
  DEFAULT_REMOTE_ADMISSION_LIMITS,
  withAdmissionRelease,
  type RemoteAdmissionAcquireInput,
} from "./remoteAdmissionPolicy";
import type { RequestTransportFacts } from "../server";

const sourceKey = (n: number): string => `src-${n}`;
const deviceKey = (n: number): string => `dev-${n}`;

function acquire(
  policy: ReturnType<typeof createRemoteAdmissionPolicy>,
  input: Omit<RemoteAdmissionAcquireInput, "now">,
): ReturnType<RemoteAdmissionPolicy_acquire> {
  return policy.acquire(input);
}

type RemoteAdmissionPolicy_acquire = ReturnType<typeof createRemoteAdmissionPolicy>["acquire"];

describe("remoteAdmissionPolicy surface classification", () => {
  it("classifies pre-auth, remote pairing, remote auth, product, and static-asset paths", () => {
    expect(classifyRemoteAdmissionPath("/health")).toBe("pre-auth");
    expect(classifyRemoteAdmissionPath("/api/hosts")).toBe("pre-auth");
    // Actual Phase 14B endpoints are under /api/remote/pairing and /api/remote/auth.
    expect(classifyRemoteAdmissionPath("/api/remote/pairing")).toBe("pairing");
    expect(classifyRemoteAdmissionPath("/api/remote/pairing/hello")).toBe("pairing");
    expect(classifyRemoteAdmissionPath("/api/remote/auth")).toBe("auth");
    expect(classifyRemoteAdmissionPath("/api/remote/auth/session")).toBe("auth");
    // Legacy /api/pairing and /api/auth are product, not pairing/auth surfaces.
    expect(classifyRemoteAdmissionPath("/api/pairing")).toBe("product");
    expect(classifyRemoteAdmissionPath("/api/pairing/hello")).toBe("product");
    expect(classifyRemoteAdmissionPath("/api/auth")).toBe("product");
    expect(classifyRemoteAdmissionPath("/api/auth/session")).toBe("product");
    expect(classifyRemoteAdmissionPath("/api/chat/threads")).toBe("product");
    expect(classifyRemoteAdmissionPath("/api/code/files/content")).toBe("product");
    expect(classifyRemoteAdmissionPath("/")).toBe("static-asset");
    expect(classifyRemoteAdmissionPath("/assets/main.js")).toBe("static-asset");
    expect(classifyRemoteAdmissionPath("/index.html")).toBe("static-asset");
  });

  it("classifies exact prefix boundaries correctly", () => {
    // /api/remote is product (not pairing or auth)
    expect(classifyRemoteAdmissionPath("/api/remote")).toBe("product");
    // /api/remote/ is product (not pairing or auth)
    expect(classifyRemoteAdmissionPath("/api/remote/")).toBe("product");
    // /api/remote/pairing is pairing (exact)
    expect(classifyRemoteAdmissionPath("/api/remote/pairing")).toBe("pairing");
    // /api/remote/pairing/ is pairing (prefix)
    expect(classifyRemoteAdmissionPath("/api/remote/pairing/")).toBe("pairing");
    // /api/remote/pairingx is product (not a prefix match)
    expect(classifyRemoteAdmissionPath("/api/remote/pairingx")).toBe("product");
    // /api/remote/auth is auth (exact)
    expect(classifyRemoteAdmissionPath("/api/remote/auth")).toBe("auth");
    // /api/remote/auth/ is auth (prefix)
    expect(classifyRemoteAdmissionPath("/api/remote/auth/")).toBe("auth");
    // /api/remote/authx is product (not a prefix match)
    expect(classifyRemoteAdmissionPath("/api/remote/authx")).toBe("product");
  });

  it("classifies /api/remote/hello as pairing for bounded nonce-issuance admission", () => {
    // The hello endpoint is the pre-auth pairing handshake: it issues nonces
    // and must share the 10/source + 60/host pairing budget so it cannot be
    // used to fill the product map or bypass source/host admission.
    expect(classifyRemoteAdmissionPath("/api/remote/hello")).toBe("pairing");
    // Exact path only — lookalikes stay product.
    expect(classifyRemoteAdmissionPath("/api/remote/hello/")).toBe("product");
    expect(classifyRemoteAdmissionPath("/api/remote/hellox")).toBe("product");
    expect(classifyRemoteAdmissionPath("/api/remote/hello/world")).toBe("product");
  });
});

describe("remoteAdmissionPolicy pairing buckets", () => {
  it("admits up to ten pairing requests per source per minute then rejects", () => {
    const now = vi.fn(() => 1_000);
    const policy = createRemoteAdmissionPolicy({ now });

    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.pairingPerSourcePerMinute; i += 1) {
      const decision = acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      });
      expect(decision.kind).toBe("admitted");
      decision.kind === "admitted" && decision.release();
    }
    const rejected = acquire(policy, {
      surface: "pairing",
      identity: { sourceKey: sourceKey(1) },
      method: "POST",
    });
    expect(rejected).toMatchObject({
      kind: "rejected",
      retryAfterMs: DEFAULT_REMOTE_ADMISSION_LIMITS.retryAfterMs,
    });
  });

  it("bounds host-wide pairing traffic under hostile source-key churn", () => {
    const now = vi.fn(() => 5_000);
    const policy = createRemoteAdmissionPolicy({ now });
    let admitted = 0;
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.pairingPerHostPerMinute + 20; i += 1) {
      const decision = acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(i) },
        method: "POST",
      });
      if (decision.kind === "admitted") {
        admitted += 1;
        decision.release();
      }
    }
    expect(admitted).toBe(DEFAULT_REMOTE_ADMISSION_LIMITS.pairingPerHostPerMinute);
  });

  it("refills the pairing source bucket after the sixty-second window", () => {
    let time = 0;
    const now = vi.fn(() => time);
    const policy = createRemoteAdmissionPolicy({ now });
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.pairingPerSourcePerMinute; i += 1) {
      const decision = acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      });
      expect(decision.kind).toBe("admitted");
      decision.kind === "admitted" && decision.release();
    }
    expect(
      acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      }).kind,
    ).toBe("rejected");
    time = 61_000;
    expect(
      acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      }).kind,
    ).toBe("admitted");
  });
});

describe("remoteAdmissionPolicy auth buckets", () => {
  it("admits up to thirty auth requests per source per minute", () => {
    const now = vi.fn(() => 1_000);
    const policy = createRemoteAdmissionPolicy({ now });
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.authPerSourcePerMinute; i += 1) {
      const decision = acquire(policy, {
        surface: "auth",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      });
      expect(decision.kind).toBe("admitted");
      decision.kind === "admitted" && decision.release();
    }
    expect(
      acquire(policy, {
        surface: "auth",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      }).kind,
    ).toBe("rejected");
  });

  it("bounds auth traffic per device when a device key is present", () => {
    const now = vi.fn(() => 1_000);
    const policy = createRemoteAdmissionPolicy({ now });
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.authPerDevicePerMinute; i += 1) {
      const decision = acquire(policy, {
        surface: "auth",
        identity: { sourceKey: sourceKey(1), deviceKey: deviceKey(1) },
        method: "POST",
      });
      expect(decision.kind).toBe("admitted");
      decision.kind === "admitted" && decision.release();
    }
    // A different source under the same device is still bounded by the device bucket.
    expect(
      acquire(policy, {
        surface: "auth",
        identity: { sourceKey: sourceKey(2), deviceKey: deviceKey(1) },
        method: "POST",
      }).kind,
    ).toBe("rejected");
  });
});

describe("remoteAdmissionPolicy product buckets", () => {
  it("releases product concurrency on completion", () => {
    const policy = createRemoteAdmissionPolicy({ now: () => 1_000 });
    const first = acquire(policy, {
      surface: "product",
      identity: { sourceKey: sourceKey(1) },
      method: "GET",
    });
    expect(first).toMatchObject({ kind: "admitted" });
    expect(policy.counts().productConcurrentListener).toBe(1);
    if (first.kind === "admitted") first.release();
    expect(policy.counts().productConcurrentListener).toBe(0);
  });

  it("bounds listener-wide product concurrency at thirty-two", () => {
    const policy = createRemoteAdmissionPolicy({ now: () => 1_000 });
    const releases: Array<() => void> = [];
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.productConcurrentPerListener; i += 1) {
      const decision = acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(i) },
        method: "GET",
      });
      expect(decision.kind).toBe("admitted");
      if (decision.kind === "admitted") releases.push(decision.release);
    }
    expect(policy.counts().productConcurrentListener).toBe(
      DEFAULT_REMOTE_ADMISSION_LIMITS.productConcurrentPerListener,
    );
    expect(
      acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(99) },
        method: "GET",
      }).kind,
    ).toBe("rejected");
    for (const release of releases) release();
    expect(policy.counts().productConcurrentListener).toBe(0);
  });

  it("bounds per-device product concurrency when a device key is present", () => {
    const policy = createRemoteAdmissionPolicy({ now: () => 1_000 });
    const releases: Array<() => void> = [];
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.productConcurrentPerDevice; i += 1) {
      const decision = acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(i), deviceKey: deviceKey(1) },
        method: "GET",
      });
      expect(decision.kind).toBe("admitted");
      if (decision.kind === "admitted") releases.push(decision.release);
    }
    expect(
      acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(99), deviceKey: deviceKey(1) },
        method: "GET",
      }).kind,
    ).toBe("rejected");
    for (const release of releases) release();
  });

  it("bounds state-changing product requests per device per minute", () => {
    const now = vi.fn(() => 1_000);
    const policy = createRemoteAdmissionPolicy({ now });
    for (
      let i = 0;
      i < DEFAULT_REMOTE_ADMISSION_LIMITS.productStateChangingPerDevicePerMinute;
      i += 1
    ) {
      const decision = acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(1), deviceKey: deviceKey(1) },
        method: "POST",
      });
      expect(decision.kind).toBe("admitted");
      decision.kind === "admitted" && decision.release();
    }
    expect(
      acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(1), deviceKey: deviceKey(1) },
        method: "POST",
      }).kind,
    ).toBe("rejected");
    // Read requests are not counted by the state-changing bucket.
    expect(
      acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(1), deviceKey: deviceKey(1) },
        method: "GET",
      }).kind,
    ).toBe("admitted");
  });

  it("rejects with a coarse sixty-second retry-after", () => {
    const policy = createRemoteAdmissionPolicy({ now: () => 1_000 });
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.productConcurrentPerListener; i += 1) {
      const decision = acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(i) },
        method: "GET",
      });
      if (decision.kind === "admitted") decision.release();
    }
    // Re-acquire without releasing to saturate the listener bucket.
    const held: Array<() => void> = [];
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.productConcurrentPerListener; i += 1) {
      const decision = acquire(policy, {
        surface: "product",
        identity: { sourceKey: sourceKey(i + 100) },
        method: "GET",
      });
      if (decision.kind === "admitted") held.push(decision.release);
    }
    const rejected = acquire(policy, {
      surface: "product",
      identity: { sourceKey: sourceKey(999) },
      method: "GET",
    });
    expect(rejected).toMatchObject({
      kind: "rejected",
      retryAfterMs: 60_000,
    });
    for (const release of held) release();
  });
});

describe("remoteAdmissionPolicy restart and release safety", () => {
  it("clears all buckets on reset", () => {
    let time = 0;
    const now = vi.fn(() => time);
    const policy = createRemoteAdmissionPolicy({ now });
    for (let i = 0; i < DEFAULT_REMOTE_ADMISSION_LIMITS.pairingPerSourcePerMinute; i += 1) {
      const decision = acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      });
      expect(decision.kind).toBe("admitted");
      decision.kind === "admitted" && decision.release();
    }
    expect(
      acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      }).kind,
    ).toBe("rejected");
    policy.reset();
    expect(
      acquire(policy, {
        surface: "pairing",
        identity: { sourceKey: sourceKey(1) },
        method: "POST",
      }).kind,
    ).toBe("admitted");
  });

  it("treats release as idempotent", () => {
    const policy = createRemoteAdmissionPolicy({ now: () => 1_000 });
    const decision = acquire(policy, {
      surface: "product",
      identity: { sourceKey: sourceKey(1) },
      method: "GET",
    });
    expect(decision.kind).toBe("admitted");
    if (decision.kind === "admitted") {
      decision.release();
      decision.release();
    }
    expect(policy.counts().productConcurrentListener).toBe(0);
  });

  it("admits pre-auth traffic without consuming product concurrency", () => {
    const policy = createRemoteAdmissionPolicy({ now: () => 1_000 });
    const decision = acquire(policy, {
      surface: "pre-auth",
      identity: { sourceKey: sourceKey(1) },
      method: "GET",
    });
    expect(decision.kind).toBe("admitted");
    expect(policy.counts().productConcurrentListener).toBe(0);
  });
});

const lanFacts = (overrides: Partial<RequestTransportFacts> = {}): RequestTransportFacts => ({
  listenerTrust: "remote",
  sourceClass: "lan-private",
  sourceKey: "lan-source-key",
  ...overrides,
});

describe("createRemoteBoundaryFetch trusted-facts rejection", () => {
  it("rejects API traffic when peer identity is unclassifiable", async () => {
    const inner = vi.fn(() => new Response("inner"));
    const boundary = createRemoteBoundaryFetch({
      fetch: inner,
      admission: createRemoteAdmissionPolicy(),
    });
    const response = await boundary(
      new Request("https://host.example.ts.net:9443/api/chat/threads", { method: "GET" }),
      lanFacts({ sourceClass: "unknown", sourceKey: "" }),
    );
    expect(response.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
  });

  it("leaves static assets to the inner handler under unclassifiable peer identity", async () => {
    const inner = vi.fn(() => new Response("asset"));
    const boundary = createRemoteBoundaryFetch({
      fetch: inner,
      admission: createRemoteAdmissionPolicy(),
    });
    const response = await boundary(
      new Request("https://host.example.ts.net:9443/assets/main.js", { method: "GET" }),
      lanFacts({ sourceClass: "unknown", sourceKey: "" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("admits classifiable API traffic and forwards facts to the inner handler", async () => {
    const inner = vi.fn((_request: Request, facts?: RequestTransportFacts) =>
      Response.json({ sourceClass: facts?.sourceClass }),
    );
    const boundary = createRemoteBoundaryFetch({
      fetch: inner,
      admission: createRemoteAdmissionPolicy(),
    });
    const response = await boundary(
      new Request("https://host.example.ts.net:9443/api/chat/threads", { method: "GET" }),
      lanFacts(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sourceClass: "lan-private" });
    expect(inner).toHaveBeenCalledOnce();
  });
});

describe("createRemoteBoundaryFetch admission and release", () => {
  it("returns a coarse 429 with Retry-After when product concurrency is saturated", async () => {
    const inner = vi.fn(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull() {
              await new Promise(() => undefined);
            },
          }),
          { status: 200 },
        ),
    );
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 2 },
    });
    const boundary = createRemoteBoundaryFetch({ fetch: inner, admission });

    const held: Promise<Response>[] = [];
    held.push(boundary(new Request("https://h:9443/api/chat/1"), lanFacts({ sourceKey: "a" })));
    held.push(boundary(new Request("https://h:9443/api/chat/2"), lanFacts({ sourceKey: "b" })));
    await Promise.all(held);

    const rejected = await boundary(
      new Request("https://h:9443/api/chat/3"),
      lanFacts({ sourceKey: "c" }),
    );
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("60");
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("releases product concurrency on response completion", async () => {
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 1 },
    });
    const boundary = createRemoteBoundaryFetch({ fetch: () => new Response("ok"), admission });

    const first = await boundary(new Request("https://h:9443/api/chat/1"), lanFacts());
    await first.text();
    expect(admission.counts().productConcurrentListener).toBe(0);

    const second = await boundary(new Request("https://h:9443/api/chat/2"), lanFacts());
    expect(second.status).toBe(200);
  });

  it("releases product concurrency on response-stream cancellation", async () => {
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 1 },
    });
    const boundary = createRemoteBoundaryFetch({
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull() {
              await new Promise(() => undefined);
            },
          }),
          { status: 200 },
        ),
      admission,
    });

    const first = await boundary(new Request("https://h:9443/api/chat/1"), lanFacts());
    expect(admission.counts().productConcurrentListener).toBe(1);
    await first.body?.cancel();
    expect(admission.counts().productConcurrentListener).toBe(0);

    const second = await boundary(new Request("https://h:9443/api/chat/2"), lanFacts());
    expect(second.status).toBe(200);
  });

  it("releases product concurrency when the inner handler throws", async () => {
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 1 },
    });
    const boundary = createRemoteBoundaryFetch({
      fetch: () => Promise.reject(new Error("inner failed")),
      admission,
    });

    await expect(boundary(new Request("https://h:9443/api/chat/1"), lanFacts())).rejects.toThrow(
      "inner failed",
    );
    expect(admission.counts().productConcurrentListener).toBe(0);
  });

  it("does not admit pre-auth or static-asset traffic through product admission", async () => {
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 1 },
    });
    const boundary = createRemoteBoundaryFetch({ fetch: () => new Response("ok"), admission });

    const asset = await boundary(new Request("https://h:9443/assets/main.js"), lanFacts());
    expect(asset.status).toBe(200);
    const preAuth = await boundary(new Request("https://h:9443/health"), lanFacts());
    expect(preAuth.status).toBe(200);
    // Pre-auth and static-asset must not consume the product concurrency slot.
    expect(admission.counts().productConcurrentListener).toBe(0);
  });

  it("applies pairing admission to /api/remote/hello, not pre-auth bypass", async () => {
    // hello shares the 10/source + 60/host pairing budget; it must not bypass
    // admission like /health does, and must not fill the product map.
    const admission = createRemoteAdmissionPolicy({
      limits: { pairingPerSourcePerMinute: 2, pairingPerHostPerMinute: 100 },
    });
    const inner = vi.fn(() => new Response("hello-nonce"));
    const boundary = createRemoteBoundaryFetch({ fetch: inner, admission });

    // First two hello requests from the same source are admitted.
    const r1 = await boundary(new Request("https://h:9443/api/remote/hello"), lanFacts());
    expect(r1.status).toBe(200);
    const r2 = await boundary(new Request("https://h:9443/api/remote/hello"), lanFacts());
    expect(r2.status).toBe(200);
    // Third hello from the same source is rate-limited (429).
    const r3 = await boundary(new Request("https://h:9443/api/remote/hello"), lanFacts());
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBeTruthy();
    // Product concurrency must not be affected.
    expect(admission.counts().productConcurrentListener).toBe(0);
  });
});

describe("withAdmissionRelease", () => {
  it("releases immediately when the response has no body", () => {
    const release = vi.fn();
    const response = withAdmissionRelease(new Response(null, { status: 204 }), release);
    expect(response.body).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases when a streamed response completes", async () => {
    const release = vi.fn();
    const response = withAdmissionRelease(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
            controller.close();
          },
        }),
        { status: 200 },
      ),
      release,
    );
    await response.text();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases when a streamed response errors", async () => {
    const release = vi.fn();
    const response = withAdmissionRelease(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("stream broke"));
          },
        }),
        { status: 200 },
      ),
      release,
    );
    await expect(response.text()).rejects.toThrow("stream broke");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases when a streamed response is cancelled", async () => {
    const release = vi.fn();
    const response = withAdmissionRelease(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
          },
        }),
        { status: 200 },
      ),
      release,
    );
    await response.body?.cancel();
    expect(release).toHaveBeenCalledOnce();
  });

  it("release is idempotent across completion, cancel, and error", async () => {
    const release = vi.fn();
    const response = withAdmissionRelease(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
          },
        }),
        { status: 200 },
      ),
      release,
    );
    // Cancel the body — this triggers the internal finish() which calls release.
    await response.body?.cancel();
    // The internal finish() is idempotent: even if the stream is cancelled
    // again or errors, release must not be called a second time.
    await response.body?.cancel().catch(() => undefined);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases promptly even if the upstream cancel promise never resolves", async () => {
    // A hostile/misbehaving upstream whose cancel() never settles must not pin
    // the admission slot. finish() must run before awaiting the best-effort
    // upstream cancel, not after.
    const release = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
      },
      // cancel() never resolves — simulates a hostile upstream.
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const response = withAdmissionRelease(new Response(upstream, { status: 200 }), release);
    // Fire cancellation without awaiting it — the upstream cancel never
    // settles, so awaiting would hang. The release must fire synchronously
    // inside cancel(), not after the upstream settles.
    const cancelPromise = response.body?.cancel();
    // Await a bounded microtask tick so synchronous finish() has run.
    await new Promise<void>((resolve) => resolve());
    expect(release).toHaveBeenCalledOnce();
    // Void the intentionally-pending cancel promise so Vitest can finish
    // without an unhandled rejection or hang.
    void cancelPromise;
  });
});

describe("remoteAdmissionPolicy cardinality bounds", () => {
  it("bounds per-source map cardinality under hostile distinct-key churn", () => {
    const policy = createRemoteAdmissionPolicy({
      limits: { pairingPerSourcePerMinute: 1000, pairingPerHostPerMinute: 100000 },
      maxMapEntries: 256,
    });
    // Flood with distinct source keys — more than the cap.
    for (let i = 0; i < 5_000; i++) {
      policy.acquire({
        surface: "pairing",
        identity: { sourceKey: `hostile-${i}` },
        method: "POST",
        now: 1_000,
      });
    }
    const diag = policy.diagnostics();
    // Map must be bounded, not 5k entries.
    expect(diag.pairingSourceMapSize).toBeLessThanOrEqual(diag.maxMapEntries);
    expect(diag.maxMapEntries).toBeGreaterThan(0);
    expect(diag.maxMapEntries).toBeLessThan(10_000);
  });

  it("sweeps expired entries so cardinality stays bounded over time", () => {
    const policy = createRemoteAdmissionPolicy();
    // Fill with distinct source keys at t=0.
    for (let i = 0; i < 5000; i++) {
      policy.acquire({
        surface: "pairing",
        identity: { sourceKey: `src-${i}` },
        method: "POST",
        now: 0,
      });
    }
    // Advance past the window; new requests should sweep expired entries.
    for (let i = 0; i < 100; i++) {
      policy.acquire({
        surface: "pairing",
        identity: { sourceKey: `new-${i}` },
        method: "POST",
        now: 120_000,
      });
    }
    const diag = policy.diagnostics();
    expect(diag.pairingSourceMapSize).toBeLessThanOrEqual(diag.maxMapEntries);
  });

  it("fails closed when the source map is saturated with live entries", () => {
    const policy = createRemoteAdmissionPolicy({
      limits: { pairingPerSourcePerMinute: 1000, pairingPerHostPerMinute: 100000 },
      maxMapEntries: 128,
    });
    // Fill the map to capacity with live entries (all within the window).
    const maxMap = policy.diagnostics().maxMapEntries;
    for (let i = 0; i < maxMap; i++) {
      policy.acquire({
        surface: "pairing",
        identity: { sourceKey: `src-${i}` },
        method: "POST",
        now: 1_000,
      });
    }
    // A new distinct source key must be rejected (fail-closed), not admitted.
    const decision = policy.acquire({
      surface: "pairing",
      identity: { sourceKey: "new-attacker" },
      method: "POST",
      now: 1_000,
    });
    expect(decision.kind).toBe("rejected");
  });

  it("diagnostics does not expose raw keys", () => {
    const policy = createRemoteAdmissionPolicy();
    policy.acquire({
      surface: "pairing",
      identity: { sourceKey: "secret-key-123" },
      method: "POST",
      now: 1_000,
    });
    const diag = policy.diagnostics();
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain("secret-key-123");
  });

  it("bounds auth source and product device maps under churn", () => {
    const policy = createRemoteAdmissionPolicy({
      limits: {
        authPerSourcePerMinute: 100000,
        authPerDevicePerMinute: 100000,
        productConcurrentPerDevice: 100000,
        productConcurrentPerListener: 100000,
      },
      maxMapEntries: 256,
    });
    for (let i = 0; i < 5_000; i++) {
      policy.acquire({
        surface: "auth",
        identity: { sourceKey: `src-${i}`, deviceKey: `dev-${i}` },
        method: "POST",
        now: 1_000,
      });
    }
    const diag = policy.diagnostics();
    expect(diag.authSourceMapSize).toBeLessThanOrEqual(diag.maxMapEntries);
    expect(diag.authDeviceMapSize).toBeLessThanOrEqual(diag.maxMapEntries);
  });
});

describe("remoteAdmissionPolicy input validation", () => {
  it("throws on non-positive maxMapEntries", () => {
    expect(() => createRemoteAdmissionPolicy({ maxMapEntries: 0 })).toThrow();
    expect(() => createRemoteAdmissionPolicy({ maxMapEntries: -1 })).toThrow();
  });

  it("throws on non-finite maxMapEntries", () => {
    expect(() => createRemoteAdmissionPolicy({ maxMapEntries: Infinity })).toThrow();
    expect(() => createRemoteAdmissionPolicy({ maxMapEntries: NaN })).toThrow();
  });

  it("throws on non-positive admission limits", () => {
    expect(() =>
      createRemoteAdmissionPolicy({ limits: { pairingPerSourcePerMinute: 0 } }),
    ).toThrow();
    expect(() =>
      createRemoteAdmissionPolicy({ limits: { productConcurrentPerListener: -5 } }),
    ).toThrow();
  });

  it("throws on non-finite admission limits", () => {
    expect(() =>
      createRemoteAdmissionPolicy({ limits: { authPerDevicePerMinute: Infinity } }),
    ).toThrow();
    expect(() => createRemoteAdmissionPolicy({ limits: { retryAfterMs: NaN } })).toThrow();
  });

  it("accepts valid finite positive limits and maxMapEntries", () => {
    expect(() =>
      createRemoteAdmissionPolicy({ maxMapEntries: 128, limits: { pairingPerSourcePerMinute: 5 } }),
    ).not.toThrow();
  });
});

describe("remoteAdmissionPolicy state-changing methods", () => {
  it("counts PUT as state changing", () => {
    const policy = createRemoteAdmissionPolicy({
      limits: {
        productConcurrentPerListener: 100,
        productConcurrentPerDevice: 100,
        productStateChangingPerDevicePerMinute: 1,
      },
    });
    // First PUT admitted.
    const first = policy.acquire({
      surface: "product",
      identity: { sourceKey: "s1", deviceKey: "d1" },
      method: "PUT",
      now: 1_000,
    });
    expect(first.kind).toBe("admitted");
    if (first.kind === "admitted") first.release();
    // Second PUT in the same window rejected (rate limit: 1/min).
    const second = policy.acquire({
      surface: "product",
      identity: { sourceKey: "s1", deviceKey: "d1" },
      method: "PUT",
      now: 1_000,
    });
    expect(second.kind).toBe("rejected");
  });

  it("counts DELETE and PATCH as state changing", () => {
    const policy = createRemoteAdmissionPolicy({
      limits: {
        productConcurrentPerListener: 100,
        productConcurrentPerDevice: 100,
        productStateChangingPerDevicePerMinute: 1,
      },
    });
    const first = policy.acquire({
      surface: "product",
      identity: { sourceKey: "s1", deviceKey: "d1" },
      method: "DELETE",
      now: 1_000,
    });
    expect(first.kind).toBe("admitted");
    if (first.kind === "admitted") first.release();
    const second = policy.acquire({
      surface: "product",
      identity: { sourceKey: "s1", deviceKey: "d1" },
      method: "PATCH",
      now: 1_000,
    });
    expect(second.kind).toBe("rejected");
  });

  it("does not count GET or HEAD as state changing", () => {
    const policy = createRemoteAdmissionPolicy({
      limits: {
        productConcurrentPerListener: 100,
        productConcurrentPerDevice: 100,
        productStateChangingPerDevicePerMinute: 1,
      },
    });
    // Two GETs in the same window should both be admitted (no state-changing limit).
    const first = policy.acquire({
      surface: "product",
      identity: { sourceKey: "s1", deviceKey: "d1" },
      method: "GET",
      now: 1_000,
    });
    expect(first.kind).toBe("admitted");
    if (first.kind === "admitted") first.release();
    const second = policy.acquire({
      surface: "product",
      identity: { sourceKey: "s1", deviceKey: "d1" },
      method: "HEAD",
      now: 1_000,
    });
    expect(second.kind).toBe("admitted");
    if (second.kind === "admitted") second.release();
  });
});

describe("remoteAdmissionPolicy abort-to-release", () => {
  function lanFacts(): RequestTransportFacts {
    return {
      listenerTrust: "remote",
      sourceClass: "lan-private",
      sourceKey: "src-1",
    };
  }

  it("releases admission when request.signal aborts before the handler responds", async () => {
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 1 },
    });
    const controller = new AbortController();
    const boundary = createRemoteBoundaryFetch({
      fetch: async (request) => {
        // Simulate a handler that ignores cancellation and hangs.
        await new Promise<void>(() => {});
        return new Response("ok");
      },
      admission,
    });

    const request = new Request("https://h:9443/api/chat/1", { signal: controller.signal });
    const promise = boundary(request, lanFacts());
    // Abort before the handler responds.
    controller.abort();
    // The boundary should release the admission slot on abort.
    // Give the abort handler a tick to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(admission.counts().productConcurrentListener).toBe(0);
    // Clean up the hanging promise.
    promise.catch(() => {});
  });

  it("releases admission when request.signal aborts during response streaming", async () => {
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 1 },
    });
    const controller = new AbortController();
    const boundary = createRemoteBoundaryFetch({
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("chunk1"));
            },
          }),
          { status: 200 },
        ),
      admission,
    });

    const request = new Request("https://h:9443/api/chat/1", { signal: controller.signal });
    const response = await boundary(request, lanFacts());
    expect(admission.counts().productConcurrentListener).toBe(1);
    // Abort during streaming.
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(admission.counts().productConcurrentListener).toBe(0);
    await response.body?.cancel().catch(() => undefined);
  });

  it("releases admission on stream completion even if signal was aborted after response", async () => {
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 1 },
    });
    const controller = new AbortController();
    const boundary = createRemoteBoundaryFetch({
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("done"));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      admission,
    });

    const request = new Request("https://h:9443/api/chat/1", { signal: controller.signal });
    const response = await boundary(request, lanFacts());
    // Abort after response but before consuming body.
    controller.abort();
    await response.text().catch(() => undefined);
    expect(admission.counts().productConcurrentListener).toBe(0);
  });
});
