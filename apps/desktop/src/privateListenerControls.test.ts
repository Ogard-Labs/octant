import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PrivateListenerControlFailure,
  certificateFingerprintFromPem,
  createPrivateListenerControlService,
  createPrivateListenerHostRuntime,
  type PrivateListenerEnableRequest,
  type PrivateListenerPublicStatus,
  type PrivateListenerRuntimePort,
} from "./privateListenerControls";

describe("private listener control service", () => {
  it("starts disabled by default with no secrets in status", () => {
    const service = createPrivateListenerControlService({
      runtime: idleRuntime(),
    });
    const status = service.getStatus();
    expect(status).toEqual({
      enabled: false,
      state: "disabled",
      hostname: null,
      port: null,
      origin: null,
      exposureClass: null,
      certificateFingerprint: null,
      certificateReady: false,
    });
    expect(JSON.stringify(status)).not.toMatch(
      /BEGIN (CERTIFICATE|PRIVATE KEY)|privateKey|secret/i,
    );
  });

  it("rejects enable without local confirmation", async () => {
    const service = createPrivateListenerControlService({ runtime: idleRuntime() });
    await expect(
      service.enable({
        ...enableRequest(),
        localConfirmation: false,
      }),
    ).rejects.toMatchObject({ code: "local-confirmation-required" });
  });

  it("rejects public or loopback bind targets before starting", async () => {
    const runtime = idleRuntime();
    const service = createPrivateListenerControlService({ runtime });
    for (const hostname of ["0.0.0.0", "8.8.8.8", "127.0.0.1"]) {
      await expect(
        service.enable(enableRequest({ hostname, origin: `https://${hostname}:9443` })),
      ).rejects.toMatchObject({ code: "invalid-bind" });
    }
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("rejects non-exact HTTPS origins before starting", async () => {
    const runtime = idleRuntime();
    const service = createPrivateListenerControlService({ runtime });
    await expect(
      service.enable(enableRequest({ origin: "http://192.168.1.20:9443" })),
    ).rejects.toMatchObject({ code: "invalid-origin" });
    await expect(
      service.enable(enableRequest({ origin: "https://192.168.1.21:9443" })),
    ).rejects.toMatchObject({ code: "invalid-origin" });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("enables after local confirmation and projects public status only", async () => {
    const fingerprint = "ab".repeat(32);
    const runtime: PrivateListenerRuntimePort = {
      start: vi.fn(async () => ({
        hostname: "192.168.1.20",
        port: 9443,
        origin: "https://192.168.1.20:9443",
        exposureClass: "lan-private" as const,
        certificateFingerprint: fingerprint,
        certificateReady: true,
      })),
      stop: vi.fn(async () => undefined),
    };
    const service = createPrivateListenerControlService({
      runtime,
      fingerprintFromPem: () => fingerprint,
    });

    await service.enable(enableRequest());
    expect(runtime.start).toHaveBeenCalledOnce();
    const started = vi.mocked(runtime.start).mock.calls[0]?.[0];
    expect(started).toMatchObject({
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
    });
    expect(started).toHaveProperty("certificatePem");
    expect(started).toHaveProperty("privateKeyPem");

    const status = service.getStatus();
    expect(status).toEqual({
      enabled: true,
      state: "ready",
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      exposureClass: "lan-private",
      certificateFingerprint: fingerprint,
      certificateReady: true,
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(status)).not.toContain("certificatePem");
  });

  it("disables an enabled listener and clears public endpoint facts", async () => {
    const runtime: PrivateListenerRuntimePort = {
      start: vi.fn(async () => ({
        hostname: "100.64.1.2",
        port: 9443,
        origin: "https://100.64.1.2:9443",
        exposureClass: "tailscale" as const,
        certificateFingerprint: "cd".repeat(32),
        certificateReady: true,
      })),
      stop: vi.fn(async () => undefined),
    };
    const service = createPrivateListenerControlService({
      runtime,
      fingerprintFromPem: () => "cd".repeat(32),
    });
    await service.enable(
      enableRequest({
        hostname: "100.64.1.2",
        origin: "https://100.64.1.2:9443",
      }),
    );
    await service.disable();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(service.getStatus()).toEqual({
      enabled: false,
      state: "disabled",
      hostname: null,
      port: null,
      origin: null,
      exposureClass: null,
      certificateFingerprint: null,
      certificateReady: false,
    });
  });

  it("maps occupied-port and interface failures without leaking diagnostics", async () => {
    const runtime: PrivateListenerRuntimePort = {
      start: vi.fn(async () => {
        throw Object.assign(new Error("EADDRINUSE private diagnostic path=/tmp/secret"), {
          code: "occupied-port",
        });
      }),
      stop: vi.fn(async () => undefined),
    };
    const service = createPrivateListenerControlService({
      runtime,
      fingerprintFromPem: () => "ef".repeat(32),
    });
    await expect(service.enable(enableRequest())).rejects.toBeInstanceOf(
      PrivateListenerControlFailure,
    );
    const status = service.getStatus();
    expect(status).toMatchObject({
      enabled: false,
      state: "failed",
      errorCode: "occupied-port",
      hostname: null,
      origin: null,
      certificateFingerprint: null,
    });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(JSON.stringify(status)).not.toContain("EADDRINUSE");
  });

  it("restarts an enabled listener onto a new interface and reports authoritative facts", async () => {
    const restart = vi.fn(async (input) => ({
      hostname: input.hostname,
      port: input.port,
      origin: input.origin,
      exposureClass: "tailscale" as const,
      certificateFingerprint: "ab".repeat(32),
      certificateReady: true,
    }));
    const service = createPrivateListenerControlService({
      runtime: { start: vi.fn(), stop: vi.fn(async () => undefined), restart },
      fingerprintFromPem: () => "ab".repeat(32),
    });
    const status = await service.restart(
      enableRequest({ hostname: "100.64.1.3", origin: "https://100.64.1.3:9443" }),
    );
    expect(restart).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      enabled: true,
      state: "ready",
      hostname: "100.64.1.3",
      origin: "https://100.64.1.3:9443",
      exposureClass: "tailscale",
    });
  });

  it("falls back to stop-then-start when the runtime lacks a dedicated restart", async () => {
    const events: string[] = [];
    const service = createPrivateListenerControlService({
      runtime: {
        start: vi.fn(async (input) => {
          events.push("start");
          return {
            hostname: input.hostname,
            port: input.port,
            origin: input.origin,
            exposureClass: "lan-private" as const,
            certificateFingerprint: "cd".repeat(32),
            certificateReady: true,
          };
        }),
        stop: vi.fn(async () => {
          events.push("stop");
        }),
      },
      fingerprintFromPem: () => "cd".repeat(32),
    });
    await service.restart(enableRequest());
    expect(events).toEqual(["stop", "start"]);
  });

  it("maps a failed restart to a retryable failure without loopback impact", async () => {
    const service = createPrivateListenerControlService({
      runtime: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        restart: vi.fn(async () => {
          throw Object.assign(new Error("EADDRNOTAVAIL"), { code: "interface-unavailable" });
        }),
      },
      fingerprintFromPem: () => "ef".repeat(32),
    });
    await expect(service.restart(enableRequest())).rejects.toMatchObject({
      code: "interface-unavailable",
    });
    expect(service.getStatus()).toMatchObject({
      state: "failed",
      errorCode: "interface-unavailable",
    });
  });

  it("reconciles status against the authoritative native projection", async () => {
    const nativeStatus: PrivateListenerPublicStatus = {
      enabled: true,
      state: "ready",
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      exposureClass: "lan-private",
      certificateFingerprint: "ab".repeat(32),
      certificateReady: true,
    };
    const service = createPrivateListenerControlService({
      runtime: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn(async () => nativeStatus),
      },
    });
    expect(service.getStatus().state).toBe("disabled");
    const synced = await service.syncStatus();
    expect(synced).toEqual(nativeStatus);
    expect(service.getStatus()).toEqual(nativeStatus);
  });

  it("fails closed to unavailable when the native projection cannot be read", async () => {
    const service = createPrivateListenerControlService({
      runtime: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn(async () => {
          throw new Error("bridge down");
        }),
      },
    });
    await expect(service.syncStatus()).rejects.toMatchObject({ code: "unavailable" });
    expect(service.getStatus()).toMatchObject({ state: "failed", errorCode: "unavailable" });
  });

  it("computes a stable certificate fingerprint from PEM without returning the PEM", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const fingerprint = certificateFingerprintFromPem(pem);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(createHash("sha256").update(pem.replaceAll(/\s+/g, "")).digest("hex"));
  });
});

describe("private listener host runtime (loopback bridge)", () => {
  const serverUrl = "http://127.0.0.1:8123/";
  const secret = "desktop-secret";
  const capability = "cap-token";

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function readyStatus(): PrivateListenerPublicStatus {
    return {
      enabled: true,
      state: "ready",
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      exposureClass: "lan-private",
      certificateFingerprint: "ab".repeat(32),
      certificateReady: true,
    };
  }

  function runtime(fetchImpl: typeof globalThis.fetch) {
    return createPrivateListenerHostRuntime({
      serverUrl,
      desktopBridgeSecret: secret,
      windowCapability: capability,
      fetch: fetchImpl,
    });
  }

  it("posts an enable request with the bridge secret and window capability", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse({ status: readyStatus() }),
    );
    const started = await runtime(fetchImpl as unknown as typeof globalThis.fetch).start({
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      certificatePem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----",
      certificateFingerprint: "ab".repeat(32),
      exposureClass: "lan-private",
    });
    expect(started).toEqual({
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      exposureClass: "lan-private",
      certificateFingerprint: "ab".repeat(32),
      certificateReady: true,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8123/api/desktop/private-listener/enable");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-octant-desktop-secret"]).toBe(secret);
    expect(headers["x-octant-window-capability"]).toBe(capability);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      certificatePem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----",
    });
  });

  it("throws the server-reported error code when enable fails closed", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ category: "unavailable", errorCode: "occupied-port" }, 503),
    );
    await expect(
      runtime(fetchImpl as unknown as typeof globalThis.fetch).start({
        hostname: "192.168.1.20",
        port: 9443,
        origin: "https://192.168.1.20:9443",
        certificatePem: "cert",
        privateKeyPem: "key",
        certificateFingerprint: "ab".repeat(32),
        exposureClass: "lan-private",
      }),
    ).rejects.toMatchObject({ code: "occupied-port" });
  });

  it("treats a network failure as unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      runtime(fetchImpl as unknown as typeof globalThis.fetch).getStatus!(),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("decodes the authoritative status projection", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: readyStatus() }));
    const status = await runtime(fetchImpl as unknown as typeof globalThis.fetch).getStatus!();
    expect(status).toEqual(readyStatus());
  });
});

function enableRequest(
  overrides: Partial<PrivateListenerEnableRequest> = {},
): PrivateListenerEnableRequest {
  return {
    hostname: "192.168.1.20",
    port: 9443,
    origin: "https://192.168.1.20:9443",
    certificatePem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----",
    localConfirmation: true,
    ...overrides,
  };
}

function idleRuntime(): PrivateListenerRuntimePort & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => {
      throw new Error("runtime should not start");
    }),
    stop: vi.fn(async () => undefined),
  };
}
