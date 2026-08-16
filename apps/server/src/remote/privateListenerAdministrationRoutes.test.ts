import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  PrivateListenerLifecycleError,
  type PrivateListenerHostStatus,
  type PrivateListenerLifecycleController,
} from "./privateListenerLifecycleController";
import { createPrivateListenerAdministrationRouteHandler } from "./privateListenerAdministrationRoutes";

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";

const CERT = "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----";
const KEY = "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----";

function readyStatus(): PrivateListenerHostStatus {
  return {
    enabled: true,
    state: "ready",
    hostname: "192.168.1.20",
    port: 9443,
    origin: "https://192.168.1.20:9443",
    exposureClass: "lan-private",
    certificateFingerprint: "a".repeat(64),
    certificateReady: true,
  };
}

function disabledStatus(): PrivateListenerHostStatus {
  return {
    enabled: false,
    state: "disabled",
    hostname: null,
    port: null,
    origin: null,
    exposureClass: null,
    certificateFingerprint: null,
    certificateReady: false,
  };
}

function setup(overrides: Partial<PrivateListenerLifecycleController> = {}) {
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const control: PrivateListenerLifecycleController = {
    status: vi.fn(() => disabledStatus()),
    enable: vi.fn(async () => readyStatus()),
    disable: vi.fn(async () => disabledStatus()),
    restart: vi.fn(async () => readyStatus()),
    ...overrides,
  };
  return {
    control,
    handle: createPrivateListenerAdministrationRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: authority,
      hostIdentityFingerprint: () => "b".repeat(64),
      control,
      now: () => Date.parse("2026-08-01T10:00:00.000Z"),
    }),
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: {
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      ...init.headers,
    },
  });
}

function enableBody() {
  return JSON.stringify({
    hostname: "192.168.1.20",
    port: 9443,
    origin: "https://192.168.1.20:9443",
    certificatePem: CERT,
    privateKeyPem: KEY,
  });
}

describe("private listener administration routes", () => {
  it("returns the authoritative persisted host-key fingerprint without exposing SQLite", async () => {
    const { handle, control } = setup();
    const response = await handle(
      request("/api/desktop/private-listener/host-identity-fingerprint"),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ fingerprint: "b".repeat(64) });
    expect(control.status).not.toHaveBeenCalled();
  });

  it("returns the authoritative status to the owned loopback window", async () => {
    const { handle, control } = setup({ status: vi.fn(() => readyStatus()) });
    const response = await handle(request("/api/desktop/private-listener/status"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ status: readyStatus() });
    expect(control.status).toHaveBeenCalledOnce();
  });

  it("enables the private listener from a validated config and never echoes the key", async () => {
    const { handle, control } = setup();
    const response = await handle(
      request("/api/desktop/private-listener/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: enableBody(),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ status: readyStatus() });
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(control.enable).toHaveBeenCalledWith({
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      tls: { cert: CERT, key: KEY },
    });
  });

  it("restarts and disables the private listener", async () => {
    const { handle, control } = setup();
    const restart = await handle(
      request("/api/desktop/private-listener/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: enableBody(),
      }),
    );
    expect(restart?.status).toBe(200);
    expect(control.restart).toHaveBeenCalledOnce();

    const disable = await handle(
      request("/api/desktop/private-listener/disable", { method: "POST" }),
    );
    expect(disable?.status).toBe(200);
    expect(await disable?.json()).toEqual({ status: disabledStatus() });
    expect(control.disable).toHaveBeenCalledOnce();
  });

  it("maps a listener lifecycle failure to a typed retryable error", async () => {
    const { handle } = setup({
      enable: vi.fn(async () => {
        throw new PrivateListenerLifecycleError("occupied-port");
      }),
    });
    const response = await handle(
      request("/api/desktop/private-listener/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: enableBody(),
      }),
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      category: "unavailable",
      errorCode: "occupied-port",
    });
  });

  it("maps an invalid bind failure to a 400", async () => {
    const { handle } = setup({
      enable: vi.fn(async () => {
        throw new PrivateListenerLifecycleError("invalid-bind");
      }),
    });
    const response = await handle(
      request("/api/desktop/private-listener/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: enableBody(),
      }),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ errorCode: "invalid-bind" });
  });

  it("rejects a request that carries an Origin header", async () => {
    const { handle, control } = setup();
    const response = await handle(
      request("/api/desktop/private-listener/status", { headers: { origin: "https://evil.test" } }),
    );
    expect(response?.status).toBe(401);
    expect(control.status).not.toHaveBeenCalled();
  });

  it("rejects a mismatched desktop bridge secret", async () => {
    const { handle, control } = setup();
    const response = await handle(
      new Request("http://127.0.0.1/api/desktop/private-listener/status", {
        headers: {
          "x-octant-desktop-secret": "wrong",
          "x-octant-window-capability": capability,
        },
      }),
    );
    expect(response?.status).toBe(401);
    expect(control.status).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated window capability", async () => {
    const { handle } = setup();
    const response = await handle(
      new Request("http://127.0.0.1/api/desktop/private-listener/status", {
        headers: {
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": "B".repeat(43),
        },
      }),
    );
    expect(response?.status).toBe(401);
  });

  it("rejects a non-loopback hostname", async () => {
    const { handle, control } = setup();
    const response = await handle(
      new Request("http://192.168.1.50/api/desktop/private-listener/status", {
        headers: {
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
      }),
    );
    expect(response?.status).toBe(401);
    expect(control.status).not.toHaveBeenCalled();
  });

  it("reports unavailable when the controller is not composed", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, now: Date.now() });
    const handle = createPrivateListenerAdministrationRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: authority,
      control: () => undefined,
    });
    const response = await handle(request("/api/desktop/private-listener/status"));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ category: "unavailable" });
  });

  it("rejects a malformed enable body", async () => {
    const { handle } = setup();
    const response = await handle(
      request("/api/desktop/private-listener/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: "192.168.1.20", port: 9443 }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("ignores unrelated paths", async () => {
    const { handle } = setup();
    expect(await handle(request("/api/desktop/remote/devices"))).toBeUndefined();
  });
});
