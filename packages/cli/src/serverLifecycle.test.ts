import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicePolicyStore } from "@octant/host-runtime";
import {
  formatServerLifecycleReport,
  runServerLifecycleCommand,
  type HostLifecycleControl,
  type UserServiceManager,
} from "./serverLifecycle";
import { ServiceManagerError } from "./serviceManager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manager(): UserServiceManager {
  return {
    kind: "systemd",
    install: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    status: vi.fn(async () => ({
      kind: "systemd" as const,
      installed: true,
      enabled: true,
      active: true,
      session: "active" as const,
      lingering: "enabled" as const,
    })),
    logs: vi.fn(async () => ({ entries: [], follow: false })),
  };
}

function control(overrides: Partial<HostLifecycleControl> = {}): HostLifecycleControl {
  return {
    request: vi.fn(async (request) => {
      if (request.type === "status") {
        return {
          ok: true,
          owner: {
            schemaVersion: 1 as const,
            hostId: "11111111-1111-4111-8111-111111111111",
            instanceId: "22222222-2222-4222-8222-222222222222",
            endpoint: "/tmp/octant.sock",
            pid: 42,
            processStart: "linux:42:1",
            serverVersion: "1.0.0",
            wireVersion: "1",
            serviceMode: "service" as const,
            nonceDigest: "a".repeat(64),
            createdAt: "2026-08-10T10:00:00.000Z",
          },
        };
      }
      if (request.type === "diagnostics") {
        return {
          ok: true,
          diagnostics: {
            identity: {
              hostId: "11111111-1111-4111-8111-111111111111",
              instanceId: "22222222-2222-4222-8222-222222222222",
              endpoint: "/tmp/octant.sock",
              serviceMode: "service",
            },
            version: { server: "1.0.0", wire: "1" },
            store: { state: "current", integrity: "ok" },
            replay: { journalHead: 4, projections: 4 },
            clients: { connected: 0 },
            capabilities: ["diagnostics"],
            work: { active: 0, attentionRequired: false },
          },
        };
      }
      return { ok: true };
    }),
    ...overrides,
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "octant-server-lifecycle-"));
  roots.push(root);
  return {
    policyStore: new ServicePolicyStore({ path: join(root, "config", "service-policy.json") }),
    serviceManager: manager(),
    control: control(),
    stdout: { write: vi.fn(() => true) },
  };
}

describe("server lifecycle commands", () => {
  it("starts through the injected per-user manager and then reads owner status", async () => {
    const deps = await setup();
    const report = await runServerLifecycleCommand({ action: "start", ...deps });

    expect(report.state).toBe("ready");
    expect(deps.serviceManager.start).toHaveBeenCalledOnce();
    expect(deps.control.request).toHaveBeenCalledWith({ type: "status", principal: "local" });
  });

  it("waits for diagnostics and persistence readiness after owner publication", async () => {
    const deps = await setup();
    const baseControl = control();
    let diagnosticsRequests = 0;
    deps.control = {
      request: vi.fn(async (request) => {
        if (request.type === "diagnostics") {
          diagnosticsRequests += 1;
          if (diagnosticsRequests === 1) return { ok: true };
        }
        return baseControl.request(request);
      }),
    };
    const sleep = vi.fn(async () => undefined);

    const report = await runServerLifecycleCommand({ action: "start", ...deps, sleep });

    expect(report.state).toBe("ready");
    expect(diagnosticsRequests).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(report.diagnostics?.store).toEqual({ state: "current", integrity: "ok" });
  });

  it("stops through the authenticated owner protocol before asking the manager to stop", async () => {
    const deps = await setup();
    const report = await runServerLifecycleCommand({ action: "stop", ...deps });

    expect(report.state).toBe("stopped");
    expect(deps.control.request).toHaveBeenCalledWith({ type: "stop", principal: "local" });
    expect(deps.serviceManager.stop).toHaveBeenCalledOnce();
  });

  it.each(["stop", "disable", "restart"] as const)(
    "does not administer the manager when %s lacks an acknowledged stop",
    async (action) => {
      const deps = await setup();
      const baseControl = control();
      deps.control = {
        request: vi.fn(async (request) =>
          request.type === "stop"
            ? { ok: false, error: "stop-unavailable" }
            : baseControl.request(request),
        ),
      };

      const report = await runServerLifecycleCommand({ action, ...deps });

      expect(report.state).toBe("unauthorized");
      expect(deps.serviceManager.stop).not.toHaveBeenCalled();
      expect(deps.serviceManager.start).not.toHaveBeenCalled();
      if (action === "disable") {
        expect(deps.serviceManager.disable).not.toHaveBeenCalled();
        expect((await deps.policyStore.read()).enabled).toBe(true);
      }
    },
  );

  it("accepts a stop only when the manager is inactive and a second status proves no owner", async () => {
    const deps = await setup();
    deps.serviceManager.status = vi.fn(async () => ({
      kind: "systemd" as const,
      installed: true,
      enabled: true,
      active: false,
      session: "active" as const,
      lingering: "enabled" as const,
    }));
    deps.control = {
      request: vi.fn(async (request) =>
        request.type === "stop" ? undefined : request.type === "status" ? undefined : { ok: true },
      ),
      proveNoOwner: vi.fn(async () => true),
    };

    const report = await runServerLifecycleCommand({ action: "stop", ...deps });

    expect(report.state).toBe("stopped");
    expect(deps.serviceManager.stop).not.toHaveBeenCalled();
  });

  it("waits for graceful owner release when the stop response is lost with the socket", async () => {
    const deps = await setup();
    deps.serviceManager.status = vi.fn(async () => ({
      kind: "launchd" as const,
      installed: false,
      enabled: false,
      active: false,
      session: "active" as const,
      lingering: "unknown" as const,
    }));
    let releaseChecks = 0;
    deps.control = {
      request: vi.fn(async () => undefined),
      proveNoOwner: vi.fn(async () => {
        releaseChecks += 1;
        return releaseChecks >= 2;
      }),
    };
    const sleep = vi.fn(async () => undefined);

    const report = await runServerLifecycleCommand({ action: "stop", ...deps, sleep });

    expect(report.state).toBe("stopped");
    expect(sleep).toHaveBeenCalledOnce();
    expect(deps.serviceManager.stop).not.toHaveBeenCalled();
  });

  it("does not treat an unavailable status response as proof that no owner exists", async () => {
    const deps = await setup();
    deps.serviceManager.status = vi.fn(async () => ({
      kind: "systemd" as const,
      installed: true,
      enabled: true,
      active: false,
      session: "active" as const,
      lingering: "enabled" as const,
    }));
    deps.control = {
      request: vi.fn(async () => undefined),
    };

    const report = await runServerLifecycleCommand({ action: "stop", ...deps });

    expect(report.state).toBe("unauthorized");
    expect(deps.serviceManager.stop).not.toHaveBeenCalled();
  });

  it.each(["start", "stop", "restart"] as const)(
    "keeps explicit %s available while automatic startup is disabled",
    async (action) => {
      const deps = await setup();
      await deps.policyStore.setEnabled(false);

      const report = await runServerLifecycleCommand({ action, ...deps });

      expect(report.policy.enabled).toBe(false);
      expect(deps.serviceManager.start).toHaveBeenCalledTimes(action === "stop" ? 0 : 1);
      expect(deps.serviceManager.stop).toHaveBeenCalledTimes(action === "start" ? 0 : 1);
    },
  );

  it("persists disable policy, disables the manager, and keeps foreground run available", async () => {
    const deps = await setup();
    const report = await runServerLifecycleCommand({ action: "disable", ...deps });

    expect(report.state).toBe("disabled");
    expect((await deps.policyStore.read()).enabled).toBe(false);
    expect(deps.serviceManager.disable).toHaveBeenCalledOnce();
    expect(deps.control.request).toHaveBeenCalledWith({ type: "stop", principal: "local" });
  });

  it.each(["install", "enable"] as const)(
    "does not persist enable policy when manager %s fails",
    async (operation) => {
      const deps = await setup();
      await deps.policyStore.setEnabled(false);
      deps.serviceManager[operation] = vi.fn(async () => {
        throw new ServiceManagerError("manager-failed", `manager ${operation} failed`);
      });

      const report = await runServerLifecycleCommand({ action: "enable", ...deps });

      expect(report.state).toBe("manager-unavailable");
      expect((await deps.policyStore.read()).enabled).toBe(false);
    },
  );

  it("never shells out or administers a remote principal", async () => {
    const deps = await setup();
    const report = await runServerLifecycleCommand({ action: "status", ...deps });

    expect(report.diagnostics?.identity.hostId).toBe("11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(report)).not.toContain("principal");
  });

  it("prints the complete bounded diagnostics promised by status", async () => {
    const deps = await setup();
    const report = await runServerLifecycleCommand({ action: "status", ...deps });
    const output = formatServerLifecycleReport({
      ...report,
      diagnostics: {
        ...report.diagnostics!,
        uptimeSeconds: 125,
      },
    });

    expect(output).toContain("Store: current (integrity ok)");
    expect(output).toContain("Replay: journal=4 projections=4");
    expect(output).toContain("Clients: 0");
    expect(output).toContain("Capabilities: diagnostics");
    expect(output).toContain("Active work: 0 (attention=false)");
    expect(output).toContain("Service mode: service");
    expect(output).toContain("Endpoint: /tmp/octant.sock");
    expect(output).toContain("Wire version: 1");
    expect(output).toContain("Uptime: 125s");
  });

  it("follows bounded log batches until interrupted", async () => {
    const deps = await setup();
    const baseControl = control();
    const firstTimestamp = "2026-08-10T10:00:01.000Z";
    const secondTimestamp = "2026-08-10T10:00:02.000Z";
    let logReads = 0;
    const logRequests: Array<Record<string, unknown>> = [];
    deps.control = {
      request: vi.fn(async (request) => {
        if (request.type === "logs") {
          logReads += 1;
          logRequests.push(request);
          return {
            ok: true,
            logs:
              logReads === 1
                ? {
                    entries: [
                      {
                        timestamp: firstTimestamp,
                        level: "info" as const,
                        event: "first",
                        message: "first bounded entry",
                      },
                    ],
                    follow: true,
                    nextSince: firstTimestamp,
                  }
                : {
                    entries: [
                      {
                        timestamp: secondTimestamp,
                        level: "info" as const,
                        event: "second",
                        message: "second bounded entry",
                      },
                    ],
                    follow: true,
                    nextSince: secondTimestamp,
                  },
          };
        }
        return baseControl.request(request);
      }),
    };
    const abortController = new AbortController();
    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps += 1;
      if (sleeps === 2) abortController.abort();
    });

    const report = await runServerLifecycleCommand({
      action: "logs",
      ...deps,
      logs: { follow: true, limit: 1 },
      signal: abortController.signal,
      sleep,
    });

    expect(logReads).toBe(2);
    expect(logRequests[0]).toMatchObject({
      type: "logs",
      principal: "local",
      follow: true,
      limit: 1,
    });
    expect(logRequests[1]).toMatchObject({
      type: "logs",
      principal: "local",
      follow: true,
      limit: 1,
      since: firstTimestamp,
    });
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining("first bounded entry"));
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining("second bounded entry"));
    expect(report.logs?.nextSince).toBe(secondTimestamp);
  });
});
