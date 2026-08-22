import { describe, expect, it, vi } from "vitest";
import {
  decodeHostBackupOutcome,
  decodeHostControlStatus,
  decodeHostLifecycleOutcome,
  decodeHostRestoreOutcome,
} from "@octant/contracts/host-control";
import type { HostRuntimeDiagnostics } from "@octant/host-runtime";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import {
  createHostControlRouteHandler,
  type HostControlRouteDependencies,
} from "./hostControlRoutes";

const nowMs = new Date("2026-08-11T12:00:00.000Z").getTime();
const windowId = "70000000-0000-4000-8000-000000000002";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const CONTROL_SOCKET = "/private/tmp/octant-501/abc123.sock";

function makeDiagnostics(serviceMode = "web"): HostRuntimeDiagnostics {
  return {
    identity: {
      hostId: "host-under-test",
      instanceId: "instance-7",
      endpoint: CONTROL_SOCKET,
      serviceMode,
    },
    version: { server: "0.4.0", wire: "1" },
    store: { state: "current", integrity: "ok" },
    replay: { journalHead: 21, projections: 4 },
    clients: { connected: 2 },
    capabilities: ["local-loopback", "provider:ollama"],
    work: { active: 1, attentionRequired: false },
    uptimeSeconds: 120,
  };
}

function setup(overrides: Partial<HostControlRouteDependencies> = {}) {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
  const requestOwnerStop = vi.fn();
  const setEnabled = vi.fn(async (enabled: boolean) => ({
    enabled,
    updatedAt: "2026-08-11T12:00:01.000Z",
  }));
  const read = vi.fn(async () => ({
    enabled: true,
    updatedAt: "2026-08-11T11:59:00.000Z",
  }));
  const backup = vi.fn((label: string) => ({
    label,
    migrationVersion: 6,
    journalHead: 21,
    byteLength: 8_192,
  }));
  const handler = createHostControlRouteHandler({
    windowAuthorityStore,
    diagnostics: () => makeDiagnostics(),
    servicePolicy: { read, setEnabled },
    requestOwnerStop,
    backup,
    now: () => nowMs,
    scheduleStop: (callback) => callback(),
    ...overrides,
  });
  return { handler, requestOwnerStop, setEnabled, read, backup };
}

function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    capability?: string;
    hostname?: string;
    origin?: string;
  } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.capability !== undefined) {
    headers["x-octant-window-capability"] = options.capability;
  }
  if (options.origin !== undefined) headers.origin = options.origin;
  const host = options.hostname ?? "127.0.0.1";
  return new Request(`http://${host}:3100${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

describe("host control routes", () => {
  it("returns undefined for non-host-control paths", async () => {
    const { handler } = setup();
    expect(await handler(makeRequest("/api/hosts", { method: "GET" }))).toBeUndefined();
    expect(await handler(makeRequest("/api/other"))).toBeUndefined();
  });

  it("reports compact identity, policy, readiness, capabilities, and lifecycle to a local window", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/host-control/status", { method: "GET", capability }),
    );
    expect(response?.status).toBe(200);
    const text = await response!.text();
    // The control-socket path never leaves the host on this wire.
    expect(text).not.toContain(CONTROL_SOCKET);
    const status = decodeHostControlStatus(JSON.parse(text));
    expect(status.identity).toEqual({
      hostId: "host-under-test",
      instanceId: "instance-7",
      serviceMode: "web",
    });
    expect(status.versions).toEqual({ server: "0.4.0", wire: "1" });
    expect(status.policy).toEqual({
      kind: "known",
      enabled: true,
      updatedAt: "2026-08-11T11:59:00.000Z",
    });
    expect(status.readiness).toEqual({
      store: { state: "current", integrity: "ok" },
      replay: { journalHead: 21, projections: 4 },
      clientsConnected: 2,
      uptimeSeconds: 120,
    });
    expect(status.capabilities).toEqual(["local-loopback", "provider:ollama"]);
    expect(status.lifecycle.stop).toEqual({ kind: "available" });
    expect(status.lifecycle.restart.kind).toBe("unavailable");
  });

  it("reports an unwired service policy store as unavailable and withholds policy mutations", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
    const handler = createHostControlRouteHandler({
      windowAuthorityStore,
      diagnostics: () => makeDiagnostics(),
      now: () => nowMs,
      scheduleStop: (callback) => callback(),
    });
    const statusResponse = await handler(
      makeRequest("/api/host-control/status", { method: "GET", capability }),
    );
    const status = decodeHostControlStatus(await statusResponse!.json());
    expect(status.policy).toEqual({
      kind: "unavailable",
      reason: "The service policy store is not wired on this host.",
    });
    expect(status.lifecycle.enable).toEqual({
      kind: "unavailable",
      reason: "The service policy store is not wired on this host.",
    });
    expect(status.lifecycle.disable).toEqual({
      kind: "unavailable",
      reason: "The service policy store is not wired on this host.",
    });

    const enable = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "enable" } }),
    );
    expect(decodeHostLifecycleOutcome(await enable!.json())).toMatchObject({
      kind: "refused",
      code: "policy-unavailable",
    });
  });

  it("reports an unavailable policy honestly and withholds policy mutations", async () => {
    const { handler } = setup({
      servicePolicy: {
        read: async () => {
          throw new Error("unsafe-file");
        },
        setEnabled: async () => {
          throw new Error("unsafe-file");
        },
      },
    });
    const response = await handler(
      makeRequest("/api/host-control/status", { method: "GET", capability }),
    );
    const status = decodeHostControlStatus(await response!.json());
    expect(status.policy.kind).toBe("unavailable");
    expect(status.lifecycle.enable.kind).toBe("unavailable");
    expect(status.lifecycle.disable.kind).toBe("unavailable");
  });

  it("fails closed without a window capability, off loopback, or with a query string", async () => {
    const { handler, requestOwnerStop } = setup();
    const unauthenticated = await handler(
      makeRequest("/api/host-control/status", { method: "GET" }),
    );
    expect(unauthenticated?.status).toBe(401);

    const remote = await handler(
      makeRequest("/api/host-control/lifecycle", {
        capability,
        hostname: "192.168.1.20",
        body: { action: "stop" },
      }),
    );
    expect(remote?.status).toBe(400);

    const withQuery = await handler(
      makeRequest("/api/host-control/status?verbose=1", { method: "GET", capability }),
    );
    expect(withQuery?.status).toBe(400);
    expect(requestOwnerStop).not.toHaveBeenCalled();
  });

  it("rejects a disallowed renderer origin", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/host-control/status", {
        method: "GET",
        capability,
        origin: "https://evil.example",
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("accepts an authenticated stop and requests one graceful owner drain", async () => {
    const { handler, requestOwnerStop } = setup();
    const response = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "stop" } }),
    );
    expect(response?.status).toBe(200);
    const outcome = decodeHostLifecycleOutcome(await response!.json());
    expect(outcome).toMatchObject({ kind: "accepted", action: "stop" });
    expect(requestOwnerStop).toHaveBeenCalledTimes(1);
  });

  it("refuses restart without a service manager and never signals the owner", async () => {
    const { handler, requestOwnerStop } = setup();
    const response = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "restart" } }),
    );
    expect(response?.status).toBe(200);
    const outcome = decodeHostLifecycleOutcome(await response!.json());
    expect(outcome).toMatchObject({ kind: "refused", code: "restart-unavailable" });
    expect(requestOwnerStop).not.toHaveBeenCalled();
  });

  it("accepts restart for a managed service owner as one graceful drain", async () => {
    const { handler, requestOwnerStop } = setup({
      diagnostics: () => makeDiagnostics("service"),
    });
    const response = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "restart" } }),
    );
    const outcome = decodeHostLifecycleOutcome(await response!.json());
    expect(outcome).toMatchObject({ kind: "accepted", action: "restart" });
    expect(requestOwnerStop).toHaveBeenCalledTimes(1);
  });

  it("persists enable and disable through the service policy store", async () => {
    const { handler, setEnabled } = setup();
    const enable = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "enable" } }),
    );
    expect(decodeHostLifecycleOutcome(await enable!.json())).toMatchObject({
      kind: "accepted",
      action: "enable",
    });
    const disable = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "disable" } }),
    );
    expect(decodeHostLifecycleOutcome(await disable!.json())).toMatchObject({
      kind: "accepted",
      action: "disable",
    });
    expect(setEnabled.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
  });

  it("refuses policy mutations when the policy store fails", async () => {
    const { handler } = setup({
      servicePolicy: {
        read: async () => ({ enabled: true, updatedAt: "2026-08-11T11:59:00.000Z" }),
        setEnabled: async () => {
          throw new Error("write-failed");
        },
      },
    });
    const response = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "disable" } }),
    );
    const outcome = decodeHostLifecycleOutcome(await response!.json());
    expect(outcome).toMatchObject({ kind: "refused", code: "policy-unavailable" });
  });

  it("rejects unknown lifecycle actions and wrong methods without effects", async () => {
    const { handler, requestOwnerStop, setEnabled } = setup();
    const unknown = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, body: { action: "start" } }),
    );
    expect(unknown?.status).toBe(400);
    const wrongMethod = await handler(
      makeRequest("/api/host-control/lifecycle", { capability, method: "GET" }),
    );
    expect(wrongMethod?.status).toBe(405);
    expect(requestOwnerStop).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("creates a path-free verified backup receipt for a local window", async () => {
    const { handler, backup } = setup();
    const response = await handler(
      makeRequest("/api/host-control/backup", { capability, body: { label: "before-upgrade" } }),
    );
    expect(response?.status).toBe(200);
    const text = await response!.text();
    expect(text).not.toContain("/");
    const outcome = decodeHostBackupOutcome(JSON.parse(text));
    expect(outcome).toMatchObject({
      kind: "created",
      label: "before-upgrade",
      journalHead: 21,
    });
    expect(backup).toHaveBeenCalledWith("before-upgrade");
  });

  it("reports a failed backup with a typed code", async () => {
    const { handler } = setup({
      backup: () => {
        throw new Error("disk full at /var/data");
      },
    });
    const response = await handler(
      makeRequest("/api/host-control/backup", { capability, body: {} }),
    );
    expect(response?.status).toBe(503);
    const text = await response!.text();
    expect(text).not.toContain("/var/data");
    expect(decodeHostBackupOutcome(JSON.parse(text))).toEqual({
      kind: "failed",
      code: "backup-failed",
    });
  });

  it("refuses online restore with offline recovery guidance and no side effects", async () => {
    const { handler, requestOwnerStop, backup } = setup();
    const response = await handler(
      makeRequest("/api/host-control/restore", { capability, body: {} }),
    );
    expect(response?.status).toBe(200);
    const outcome = decodeHostRestoreOutcome(await response!.json());
    expect(outcome.kind).toBe("refused-online");
    expect(outcome.guidance).toContain("offline");
    expect(requestOwnerStop).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  it("reports unavailable when the owner diagnostics are not ready", async () => {
    const { handler } = setup({ diagnostics: () => undefined });
    const response = await handler(
      makeRequest("/api/host-control/status", { method: "GET", capability }),
    );
    expect(response?.status).toBe(503);
  });

  it("fails closed for thread purge without a window capability or confirmation", async () => {
    const { handler } = setup();
    const unauthenticated = await handler(
      makeRequest("/api/host-control/thread-purge", {
        body: {
          scope: { kind: "thread", mode: "chat", threadId: "c1000000-0000-4000-8000-000000000010" },
          confirm: true,
        },
      }),
    );
    expect(unauthenticated?.status).toBe(401);

    const unconfirmed = await handler(
      makeRequest("/api/host-control/thread-purge", {
        capability,
        body: {
          scope: { kind: "thread", mode: "chat", threadId: "c1000000-0000-4000-8000-000000000010" },
          confirm: false,
        },
      }),
    );
    expect(unconfirmed?.status).toBe(400);
  });

  it("answers OPTIONS preflight for the renderer", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/host-control/status", {
        method: "OPTIONS",
        origin: "http://127.0.0.1:5173",
      }),
    );
    expect(response?.status).toBe(204);
  });
});
