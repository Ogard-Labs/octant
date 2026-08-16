import { describe, expect, it, vi } from "vitest";
import {
  createPrivateListener,
  validatePrivateListenerTls,
  type PrivateListenerConfig,
} from "./privateListener";
import {
  PRIVATE_LISTENER_TEST_CERT,
  PRIVATE_LISTENER_TEST_KEY,
} from "./privateListener.test-certs";
import type { OctantServer, RequestTransportFacts } from "./server";

const validConfig = (overrides: Partial<PrivateListenerConfig> = {}): PrivateListenerConfig => ({
  hostname: "192.168.1.20",
  port: 9443,
  origin: "https://192.168.1.20:9443",
  tls: { cert: "certificate", key: "key" },
  ...overrides,
});

describe("private listener lifecycle", () => {
  it.each([
    ["wrong host", "192.168.1.21", new Date("2026-08-01T00:00:00Z")],
    ["expired", "192.168.1.20", new Date("2028-01-01T00:00:00Z")],
    ["not yet valid", "192.168.1.20", new Date("2026-01-01T00:00:00Z")],
  ] as const)("rejects a configured certificate that is %s", (_case, hostname, now) => {
    expect(() =>
      validatePrivateListenerTls(
        { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
        { hostname, now: () => now },
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-tls" }));
  });

  it("accepts a matching certificate for the configured private origin", () => {
    expect(() =>
      validatePrivateListenerTls(
        { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
        {
          hostname: "192.168.1.20",
          origin: "https://192.168.1.20:9443",
          now: () => new Date("2026-08-01T00:00:00Z"),
        },
      ),
    ).not.toThrow();
  });

  it.each([
    ["0.0.0.0", "invalid-bind"],
    ["8.8.8.8", "invalid-bind"],
    ["127.0.0.1", "invalid-bind"],
  ] as const)("rejects unsafe remote bind %s before serving", (hostname, code) => {
    const serve = vi.fn();

    expect(() =>
      createPrivateListener({
        config: validConfig({ hostname }),
        fetch: () => new Response("ok"),
        serve,
        validateTls: () => undefined,
      }),
    ).toThrow(expect.objectContaining({ code }));
    expect(serve).not.toHaveBeenCalled();
  });

  it.each([
    ["http://192.168.1.20:9443", "invalid-origin"],
    ["https://192.168.1.21:9443", "invalid-origin"],
    ["https://192.168.1.20:9444", "invalid-origin"],
  ] as const)("rejects non-exact origin %s before serving", (origin, code) => {
    expect(() =>
      createPrivateListener({
        config: validConfig({ origin }),
        fetch: () => new Response("ok"),
        serve: vi.fn(),
        validateTls: () => undefined,
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it("rejects an invalid configured certificate before serving", () => {
    const serve = vi.fn();

    expect(() =>
      createPrivateListener({
        config: validConfig(),
        fetch: () => new Response("ok"),
        serve,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-tls" }));
    expect(serve).not.toHaveBeenCalled();
  });

  it("starts with HTTPS transport facts and stops deterministically", async () => {
    const events: string[] = [];
    const serve = vi.fn((options) => {
      events.push(`${options.hostname}:${options.port}`);
      return {
        url: new URL("https://192.168.1.20:9443"),
        stop: vi.fn(() => {
          events.push("stop");
        }),
      };
    });
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: () => new Response("ok"),
      serve,
      validateTls: () => events.push("tls-ready"),
    });

    expect(listener.facts()).toMatchObject({
      state: "disabled",
      addressClass: "lan-private",
      origin: "https://192.168.1.20:9443",
      tls: "ready",
    });
    await listener.start();
    expect(events).toEqual(["tls-ready", "192.168.1.20:9443"]);
    expect(listener.facts()).toMatchObject({ state: "ready", port: 9443 });
    await listener.stop();
    expect(events).toEqual(["tls-ready", "192.168.1.20:9443", "stop"]);
    expect(listener.facts()).toMatchObject({ state: "disabled" });
  });

  it("retains a failed shutdown handle so a later stop can retry", async () => {
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("shutdown failed"))
      .mockResolvedValueOnce(undefined);
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => ({ url: new URL("https://192.168.1.20:9443"), stop })),
      validateTls: () => undefined,
    });

    await listener.start();
    await expect(listener.stop()).rejects.toMatchObject({ code: "shutdown-failed" });
    expect(listener.facts()).toMatchObject({ state: "failed", errorCode: "shutdown-failed" });
    await listener.stop();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(listener.facts()).toMatchObject({ state: "disabled" });
  });

  it("contains an abort-triggered shutdown rejection and permits retry", async () => {
    const controller = new AbortController();
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("shutdown failed"))
      .mockResolvedValueOnce(undefined);
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => ({ url: new URL("https://192.168.1.20:9443"), stop })),
      signal: controller.signal,
      validateTls: () => undefined,
    });

    await listener.start();
    controller.abort();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(true));
    expect(listener.facts()).toMatchObject({ state: "failed", errorCode: "shutdown-failed" });
    await listener.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("restarts on an explicit interface change without exposing raw errors", async () => {
    const serve = vi.fn((options) => ({
      url: new URL(`https://${options.hostname}:9443`),
      stop: vi.fn(),
    }));
    const listener = createPrivateListener({
      config: validConfig({
        hostname: "100.100.10.2",
        origin: "https://100.100.10.2:9443",
      }),
      fetch: () => new Response("ok"),
      serve,
      validateTls: () => undefined,
    });

    await listener.start();
    await listener.restart(
      validConfig({
        hostname: "100.100.10.3",
        origin: "https://100.100.10.3:9443",
      }),
    );

    expect(serve).toHaveBeenCalledTimes(2);
    expect(listener.facts()).toMatchObject({
      state: "ready",
      addressClass: "tailscale",
      origin: "https://100.100.10.3:9443",
    });
  });

  it("reports occupied ports as a bounded failure and aborts cleanly", async () => {
    const controller = new AbortController();
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => {
        const error = Object.assign(new Error("address /private/path unavailable"), {
          code: "EADDRINUSE",
        });
        throw error;
      }),
      validateTls: () => undefined,
      signal: controller.signal,
    });

    await expect(listener.start()).rejects.toMatchObject({ code: "occupied-port" });
    expect(listener.facts()).toMatchObject({ state: "failed", errorCode: "occupied-port" });
    controller.abort();
    await listener.stop();
    expect(listener.facts()).toMatchObject({ state: "disabled" });
  });

  it("fails closed when the serve runtime does not return the exact HTTPS port", async () => {
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => ({
        url: new URL("http://192.168.1.20:9444"),
        stop: vi.fn(),
      })),
      validateTls: () => undefined,
    });

    await expect(listener.start()).rejects.toMatchObject({ code: "invalid-origin" });
    expect(listener.facts()).toMatchObject({ state: "failed", errorCode: "invalid-origin" });
  });

  it("derives the exact origin port for an ephemeral smoke bind", async () => {
    const listener = createPrivateListener({
      config: validConfig({ port: 0, allowEphemeralPort: true, origin: "https://192.168.1.20" }),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => ({ url: new URL("https://192.168.1.20:12345"), stop: vi.fn() })),
      validateTls: () => undefined,
    });

    await listener.start();
    expect(listener.facts()).toMatchObject({
      state: "ready",
      origin: "https://192.168.1.20:12345",
      port: 12345,
    });
    await listener.stop();
  });

  it("rejects an ephemeral port unless the explicit test seam is enabled", () => {
    expect(() =>
      createPrivateListener({
        config: validConfig({ port: 0, origin: "https://192.168.1.20" }),
        fetch: () => new Response("ok"),
        serve: vi.fn(),
        validateTls: () => undefined,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-bind" }));
  });

  it("rejects a DNS listener when the runtime reports an unrelated public address", async () => {
    const listener = createPrivateListener({
      config: validConfig({
        hostname: "host.example.ts.net",
        origin: "https://host.example.ts.net:9443",
      }),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => ({
        url: new URL("https://203.0.113.10:9443"),
        stop: vi.fn(),
      })),
      validateTls: () => undefined,
    });

    await expect(listener.start()).rejects.toMatchObject({ code: "invalid-origin" });
  });

  it("rejects a DNS listener when the runtime reports a different Tailscale hostname", async () => {
    const listener = createPrivateListener({
      config: validConfig({
        hostname: "host-a.example.ts.net",
        origin: "https://host-a.example.ts.net:9443",
      }),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => ({
        url: new URL("https://host-b.example.ts.net:9443"),
        stop: vi.fn(),
      })),
      validateTls: () => undefined,
    });

    await expect(listener.start()).rejects.toMatchObject({ code: "invalid-origin" });
  });

  it("rejects a runtime that reports a different literal bind address", async () => {
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: () => new Response("ok"),
      serve: vi.fn(() => ({
        url: new URL("https://192.168.1.21:9443"),
        stop: vi.fn(),
      })),
      validateTls: () => undefined,
    });

    await expect(listener.start()).rejects.toMatchObject({ code: "invalid-origin" });
  });

  it("cancels a pending bind and closes a late server resolution", async () => {
    const controller = new AbortController();
    let resolveServe: ((server: OctantServer) => void) | undefined;
    const stop = vi.fn();
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: () => new Response("ok"),
      serve: vi.fn(
        () =>
          new Promise<OctantServer>((resolve) => {
            resolveServe = resolve;
          }),
      ),
      validateTls: () => undefined,
      signal: controller.signal,
    });

    const starting = listener.start();
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: "cancelled" });
    resolveServe?.({ url: new URL("https://192.168.1.20:9443"), stop });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(true));
    expect(listener.facts()).toMatchObject({ state: "failed", errorCode: "cancelled" });
    await listener.stop();
  });

  it("wires the trusted-facts boundary into the remote serve callback", async () => {
    const served: Array<{ readonly listenerTrust: string; readonly fetchArgs: number }> = [];
    let boundaryFetch:
      | ((request: Request, facts: RequestTransportFacts) => Promise<Response>)
      | undefined;
    const serve = vi.fn((options) => {
      served.push({
        listenerTrust: options.listenerTrust ?? "loopback",
        fetchArgs: options.fetch.length,
      });
      boundaryFetch = options.fetch;
      return { url: new URL("https://192.168.1.20:9443"), stop: vi.fn() };
    });
    const inner = vi.fn(() => new Response("remote handler"));
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: inner,
      serve,
      validateTls: () => undefined,
    });

    await listener.start();
    expect(served[0]).toEqual({ listenerTrust: "remote", fetchArgs: 2 });
    expect(boundaryFetch).toBeDefined();
    if (boundaryFetch === undefined) return;

    // Unclassifiable API traffic is rejected before the inner handler.
    const rejected = await boundaryFetch(
      new Request("https://192.168.1.20:9443/api/chat/threads"),
      { listenerTrust: "remote", sourceClass: "unknown", sourceKey: "" },
    );
    expect(rejected.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();

    // Classifiable API traffic reaches the inner handler with facts.
    const admitted = await boundaryFetch(
      new Request("https://192.168.1.20:9443/api/chat/threads"),
      { listenerTrust: "remote", sourceClass: "lan-private", sourceKey: "lan-key" },
    );
    expect(admitted.status).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
    await listener.stop();
  });

  it("passes deviceKeyResolver through to the boundary so per-device buckets activate", async () => {
    let boundaryFetch:
      | ((request: Request, facts: RequestTransportFacts) => Promise<Response>)
      | undefined;
    const serve = vi.fn((options) => {
      boundaryFetch = options.fetch;
      return { url: new URL("https://192.168.1.20:9443"), stop: vi.fn() };
    });
    const inner = vi.fn(() => new Response("ok"));
    // Resolver returns a fixed device key for authenticated requests.
    const deviceKeyResolver = vi.fn(() => "device-abc");
    const listener = createPrivateListener({
      config: validConfig(),
      fetch: inner,
      serve,
      validateTls: () => undefined,
      admissionLimits: {
        authPerDevicePerMinute: 2,
        productConcurrentPerDevice: 1,
      },
      deviceKeyResolver,
    });

    await listener.start();
    expect(boundaryFetch).toBeDefined();
    if (boundaryFetch === undefined) return;

    const lanFacts: RequestTransportFacts = {
      listenerTrust: "remote",
      sourceClass: "lan-private",
      sourceKey: "lan-key",
    };

    // Auth: first two requests from device-abc are admitted, third is 429.
    const authUrl = "https://192.168.1.20:9443/api/remote/auth/session";
    const r1 = await boundaryFetch(new Request(authUrl, { method: "POST" }), lanFacts);
    expect(r1.status).toBe(200);
    const r2 = await boundaryFetch(new Request(authUrl, { method: "POST" }), lanFacts);
    expect(r2.status).toBe(200);
    const r3 = await boundaryFetch(new Request(authUrl, { method: "POST" }), lanFacts);
    expect(r3.status).toBe(429);
    expect(deviceKeyResolver).toHaveBeenCalledTimes(3);

    // Product: one concurrent slot for device-abc; second concurrent is 429
    // until the first releases. Use a streaming body so the slot is held.
    const productUrl = "https://192.168.1.20:9443/api/chat/threads";
    let productController: ReadableStreamController<Uint8Array> | undefined;
    const streamingResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          productController = controller;
        },
      }),
      { status: 200 },
    );
    inner.mockReturnValueOnce(streamingResponse);
    const p1 = await boundaryFetch(new Request(productUrl, { method: "GET" }), lanFacts);
    expect(p1.status).toBe(200);
    // While p1's body is open, a second product request from the same device
    // must be rejected (productConcurrentPerDevice: 1).
    inner.mockReturnValueOnce(new Response("second"));
    const p2 = await boundaryFetch(new Request(productUrl, { method: "GET" }), lanFacts);
    expect(p2.status).toBe(429);
    // Close p1's body to release the slot.
    productController?.close();
    await p1.body?.cancel().catch(() => undefined);
    // Now a third product request from the same device is admitted again.
    inner.mockReturnValueOnce(new Response("third"));
    const p3 = await boundaryFetch(new Request(productUrl, { method: "GET" }), lanFacts);
    expect(p3.status).toBe(200);

    await listener.stop();
  });
});
