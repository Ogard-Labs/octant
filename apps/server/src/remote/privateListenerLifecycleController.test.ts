import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrivateListenerConfig } from "../privateListener";
import {
  createPrivateListenerLifecycleController,
  privateListenerCertificateFingerprint,
  PrivateListenerLifecycleError,
  type PrivateListenerGatewayLifecycle,
} from "./privateListenerLifecycleController";

const CERT = "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----";
const KEY = "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----";

function lanConfig(overrides: Partial<PrivateListenerConfig> = {}): PrivateListenerConfig {
  return {
    hostname: "192.168.1.20",
    port: 9443,
    origin: "https://192.168.1.20:9443",
    tls: { cert: CERT, key: KEY },
    ...overrides,
  };
}

/**
 * A deterministic gateway lifecycle fake. It records every lifecycle call and
 * projects facts from the last config it was constructed/restarted with.
 */
function fakeGateway(overrides: Partial<PrivateListenerGatewayLifecycle> = {}) {
  let facts = { state: "disabled" as const, origin: "https://192.168.1.20:9443" };
  const calls: string[] = [];
  const gateway: PrivateListenerGatewayLifecycle = {
    facts: () => facts,
    start: vi.fn(async () => {
      calls.push("start");
      facts = { ...facts, state: "ready" as never };
    }),
    stop: vi.fn(async () => {
      calls.push("stop");
      facts = { ...facts, state: "disabled" as never };
    }),
    restart: vi.fn(async (config) => {
      calls.push(`restart:${config.listener.hostname}`);
      facts = {
        state: "ready" as never,
        origin: config.listener.origin ?? `https://${config.listener.hostname}`,
      };
    }),
    ...overrides,
  };
  return { gateway, calls, setFacts: (next: typeof facts) => (facts = next) };
}

describe("private listener lifecycle controller", () => {
  it("starts disabled with no endpoint facts and no secrets", () => {
    const controller = createPrivateListenerLifecycleController({
      createGateway: () => fakeGateway().gateway,
    });
    const status = controller.status();
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
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(status)).not.toContain("BEGIN CERTIFICATE");
  });

  it("enables the real gateway and projects authoritative status only", async () => {
    const { gateway, calls } = fakeGateway();
    const createGateway = vi.fn(() => gateway);
    const controller = createPrivateListenerLifecycleController({ createGateway });

    const status = await controller.enable(lanConfig());
    expect(createGateway).toHaveBeenCalledWith({ listener: lanConfig() });
    expect(calls).toEqual(["start"]);
    expect(status).toEqual({
      enabled: true,
      state: "ready",
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      exposureClass: "lan-private",
      certificateFingerprint: createHash("sha256")
        .update(CERT.replaceAll(/\s+/g, ""))
        .digest("hex"),
      certificateReady: true,
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("classifies a Tailscale bind and derives its exposure class", async () => {
    const { gateway } = fakeGateway({
      restart: vi.fn(),
      start: vi.fn(async () => undefined),
      facts: () => ({ state: "ready", origin: "https://100.64.1.2:9443" }),
    });
    const controller = createPrivateListenerLifecycleController({
      createGateway: () => gateway,
    });
    const status = await controller.enable(
      lanConfig({ hostname: "100.64.1.2", origin: "https://100.64.1.2:9443" }),
    );
    expect(status.exposureClass).toBe("tailscale");
  });

  it("fails closed and stays disabled when gateway construction rejects TLS", async () => {
    const createGateway = vi.fn(() => {
      throw Object.assign(new Error("bad tls path=/tmp/secret"), { code: "invalid-tls" });
    });
    const controller = createPrivateListenerLifecycleController({ createGateway });

    await expect(controller.enable(lanConfig())).rejects.toMatchObject({ code: "invalid-tls" });
    const status = controller.status();
    expect(status).toMatchObject({ enabled: false, state: "failed", errorCode: "invalid-tls" });
    expect(status.hostname).toBeNull();
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("maps an occupied port on start to a bounded retryable failure", async () => {
    const start = vi.fn(async () => {
      throw Object.assign(new Error("EADDRINUSE /private/path"), { code: "occupied-port" });
    });
    const createGateway = vi.fn(() => fakeGateway({ start }).gateway);
    const controller = createPrivateListenerLifecycleController({ createGateway });

    await expect(controller.enable(lanConfig())).rejects.toBeInstanceOf(
      PrivateListenerLifecycleError,
    );
    expect(controller.status()).toMatchObject({ state: "failed", errorCode: "occupied-port" });
    // A retry re-creates a fresh gateway generation (the failed one was dropped).
    const okGateway = fakeGateway();
    createGateway.mockReturnValueOnce(okGateway.gateway);
    const status = await controller.enable(lanConfig());
    expect(status.state).toBe("ready");
    expect(createGateway).toHaveBeenCalledTimes(2);
  });

  it("maps an unavailable interface on start to interface-unavailable", async () => {
    const start = vi.fn(async () => {
      throw Object.assign(new Error("EADDRNOTAVAIL"), { code: "interface-unavailable" });
    });
    const controller = createPrivateListenerLifecycleController({
      createGateway: () => fakeGateway({ start }).gateway,
    });
    await expect(controller.enable(lanConfig())).rejects.toMatchObject({
      code: "interface-unavailable",
    });
    expect(controller.status()).toMatchObject({
      state: "failed",
      errorCode: "interface-unavailable",
    });
  });

  it("restarts an enabled listener onto a new interface without recreating the gateway", async () => {
    const { gateway, calls } = fakeGateway();
    const createGateway = vi.fn(() => gateway);
    const controller = createPrivateListenerLifecycleController({ createGateway });

    await controller.enable(
      lanConfig({ hostname: "100.100.10.2", origin: "https://100.100.10.2:9443" }),
    );
    const status = await controller.restart(
      lanConfig({ hostname: "100.100.10.3", origin: "https://100.100.10.3:9443" }),
    );
    expect(createGateway).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["start", "restart:100.100.10.3"]);
    expect(status).toMatchObject({
      state: "ready",
      hostname: "100.100.10.3",
      origin: "https://100.100.10.3:9443",
      exposureClass: "tailscale",
    });
  });

  it("projects interface loss as a failed status when a restart rejects", async () => {
    const restart = vi.fn(async () => {
      throw Object.assign(new Error("EADDRNOTAVAIL"), { code: "interface-unavailable" });
    });
    const { gateway } = fakeGateway({ restart });
    const controller = createPrivateListenerLifecycleController({
      createGateway: () => gateway,
    });
    await controller.enable(lanConfig());
    await expect(controller.restart(lanConfig({ hostname: "192.168.1.30" }))).rejects.toMatchObject(
      { code: "interface-unavailable" },
    );
    expect(controller.status()).toMatchObject({
      state: "failed",
      errorCode: "interface-unavailable",
    });
  });

  it("retains the gateway handle when a restart shutdown fails so a later disable can unbind", async () => {
    const restart = vi
      .fn<(config: { readonly listener: PrivateListenerConfig }) => Promise<void>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("shutdown failed during restart"), { code: "shutdown-failed" }),
      );
    const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { gateway } = fakeGateway({ restart, stop });
    const createGateway = vi.fn(() => gateway);
    const controller = createPrivateListenerLifecycleController({ createGateway });

    await controller.enable(lanConfig());
    await expect(controller.restart(lanConfig({ hostname: "192.168.1.30" }))).rejects.toMatchObject(
      { code: "shutdown-failed" },
    );
    expect(controller.status()).toMatchObject({ state: "failed", errorCode: "shutdown-failed" });

    // The retained handle must still be reachable: disable finishes the unbind
    // against the same gateway rather than reporting disabled without stop().
    const status = await controller.disable();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(createGateway).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("disabled");
  });

  it("serializes concurrent enable calls so only one gateway generation starts", async () => {
    let releaseStart: (() => void) | undefined;
    const calls: string[] = [];
    const gateway: PrivateListenerGatewayLifecycle = {
      facts: () => ({ state: "ready", origin: "https://192.168.1.20:9443" }),
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            calls.push("start");
            releaseStart = resolve;
          }),
      ),
      stop: vi.fn(async () => {
        calls.push("stop");
      }),
      restart: vi.fn(async () => {
        calls.push("restart");
      }),
    };
    const createGateway = vi.fn(() => gateway);
    const controller = createPrivateListenerLifecycleController({ createGateway });

    const first = controller.enable(lanConfig());
    const second = controller.enable(
      lanConfig({ hostname: "192.168.1.30", origin: "https://192.168.1.30:9443" }),
    );
    // Let the first mutation reach its blocking start() before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createGateway).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["start"]);
    releaseStart?.();
    await Promise.all([first, second]);

    // The second enable ran only after the first committed, observed the owned
    // gateway, and restarted it — no orphaned second generation was created.
    expect(createGateway).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["start", "restart"]);
  });

  it("serializes a disable issued while an enable is still in flight", async () => {
    let releaseStart: (() => void) | undefined;
    const calls: string[] = [];
    const gateway: PrivateListenerGatewayLifecycle = {
      facts: () => ({ state: "ready", origin: "https://192.168.1.20:9443" }),
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            calls.push("start");
            releaseStart = resolve;
          }),
      ),
      stop: vi.fn(async () => {
        calls.push("stop");
      }),
      restart: vi.fn(async () => {
        calls.push("restart");
      }),
    };
    const controller = createPrivateListenerLifecycleController({
      createGateway: () => gateway,
    });

    const enabling = controller.enable(lanConfig());
    const disabling = controller.disable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Disable must not run until enable commits; the listener is still starting.
    expect(calls).toEqual(["start"]);
    releaseStart?.();
    const [, disabledStatus] = await Promise.all([enabling, disabling]);

    expect(calls).toEqual(["start", "stop"]);
    expect(disabledStatus.state).toBe("disabled");
  });

  it("disables an enabled listener and clears endpoint facts", async () => {
    const { gateway, calls } = fakeGateway();
    const controller = createPrivateListenerLifecycleController({
      createGateway: () => gateway,
    });
    await controller.enable(lanConfig());
    const status = await controller.disable();
    expect(calls).toEqual(["start", "stop"]);
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
  });

  it("retains the gateway on a failed shutdown so a later disable can retry", async () => {
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("shutdown failed"), { code: "shutdown-failed" }),
      )
      .mockResolvedValueOnce(undefined);
    const { gateway } = fakeGateway({ stop });
    const createGateway = vi.fn(() => gateway);
    const controller = createPrivateListenerLifecycleController({ createGateway });

    await controller.enable(lanConfig());
    await expect(controller.disable()).rejects.toMatchObject({ code: "shutdown-failed" });
    expect(controller.status()).toMatchObject({ state: "failed", errorCode: "shutdown-failed" });
    // Retry the disable — the retained gateway handle is reused, not recreated.
    const status = await controller.disable();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(createGateway).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("disabled");
  });

  it("classifies a cancelled start as a bounded failure", async () => {
    const start = vi.fn(async () => {
      throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    });
    const controller = createPrivateListenerLifecycleController({
      createGateway: () => fakeGateway({ start }).gateway,
    });
    await expect(controller.enable(lanConfig())).rejects.toMatchObject({ code: "cancelled" });
    expect(controller.status()).toMatchObject({ state: "failed", errorCode: "cancelled" });
  });

  it("treats disable on an already-disabled controller as a no-op", async () => {
    const createGateway = vi.fn(() => fakeGateway().gateway);
    const controller = createPrivateListenerLifecycleController({ createGateway });
    const status = await controller.disable();
    expect(status.state).toBe("disabled");
    expect(createGateway).not.toHaveBeenCalled();
  });

  it("computes a stable certificate fingerprint without returning the PEM", () => {
    const fingerprint = privateListenerCertificateFingerprint(CERT);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(
      createHash("sha256").update(CERT.replaceAll(/\s+/g, "")).digest("hex"),
    );
  });
});
