import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDesktopHostLaunch, startDesktopHostServer } from "./desktopHostLaunch";
import { shutdownManagedServer } from "./serverProcess";

function child() {
  return { exitCode: null, signalCode: null, kill: vi.fn(() => true) };
}

describe("desktop-owned launch cleanup", () => {
  it("sanitizes credential acquisition and synchronous spawn failures at the registered launch boundary", async () => {
    for (const brokerFails of [true, false]) {
      const launch = createDesktopHostLaunch({ shutdownServer: async () => undefined });
      const broker = { close: vi.fn(async () => undefined) };
      const startServer = vi.fn(() => {
        throw new Error("spawn command leaked a private path");
      });
      const failure = await startDesktopHostServer(launch, {
        startBroker: async () => {
          if (brokerFails) throw new Error("listen EADDRINUSE with private runtime path");
          return broker;
        },
        startServer,
      }).catch((error: unknown) => error);
      expect(String(failure)).toBe("Error: Octant could not start its managed server resources.");
      expect(startServer).toHaveBeenCalledTimes(brokerFails ? 0 : 1);
      await expect(launch.close()).resolves.toEqual({ status: "closed" });
      expect(broker.close).toHaveBeenCalledTimes(brokerFails ? 0 : 1);
    }
  });

  it("retains tracked tools for the quit deadline after successful API cleanup", async () => {
    const tools = { close: vi.fn(async () => undefined), terminateTrackedProcesses: vi.fn() };
    const launch = createDesktopHostLaunch({ shutdownServer: async () => undefined });
    launch.acquired({ managedTools: tools });
    await expect(launch.close()).resolves.toEqual({ status: "closed" });
    launch.forceStop();
    expect(tools.terminateTrackedProcesses).toHaveBeenCalledOnce();
  });

  it("attempts every acquired stage once after server and credential cleanup fail, retaining emergency handles", async () => {
    const order: string[] = [];
    const server = child();
    const close =
      (name: string, fails = false) =>
      async () => {
        order.push(name);
        if (fails) throw new Error("private details");
      };
    const tools = { close: close("tools"), terminateTrackedProcesses: vi.fn() };
    const launch = createDesktopHostLaunch({ shutdownServer: close("server", true) });
    launch.acquired({
      server,
      credentialBroker: { close: close("credentials", true) },
      browserBroker: { close: close("browser") },
      computerBroker: { close: close("computer") },
      simulatorBroker: { close: close("simulator") },
      avdBroker: { close: close("avd") },
      managedTools: tools,
    });
    const stopped = launch.close();
    expect(launch.close()).toBe(stopped);
    await expect(stopped).resolves.toEqual({ status: "failed", stages: ["server", "credentials"] });
    expect(order).toEqual([
      "server",
      "credentials",
      "browser",
      "computer",
      "simulator",
      "avd",
      "tools",
    ]);
    expect(launch.server).toBe(server);
    expect(launch.managedTools).toBe(tools);
    expect(launch.state).toBe("failed");
    launch.forceStop();
    expect(server.kill).toHaveBeenCalledWith("SIGKILL");
    expect(tools.terminateTrackedProcesses).toHaveBeenCalledOnce();
  });

  it("closes constructed services when their broker was never acquired, transferring close responsibility once a broker exists", async () => {
    for (const returnedBroker of [false, true]) {
      const service = { close: vi.fn(async () => undefined) };
      const helpers = { dispose: vi.fn(async () => ({ status: "stopped" as const })) };
      const computer = {
        close: vi.fn(async () => {
          await service.close();
        }),
      };
      const simulator = {
        close: vi.fn(async () => {
          await helpers.dispose();
        }),
      };
      const launch = createDesktopHostLaunch({ shutdownServer: async () => undefined });
      launch.acquired({ computerService: service, simulatorHelpers: helpers });
      if (returnedBroker) launch.acquired({ computerBroker: computer, simulatorBroker: simulator });
      await expect(launch.close()).resolves.toEqual({ status: "closed" });
      expect(service.close).toHaveBeenCalledOnce();
      expect(helpers.dispose).toHaveBeenCalledOnce();
      expect(computer.close).toHaveBeenCalledTimes(returnedBroker ? 1 : 0);
      expect(simulator.close).toHaveBeenCalledTimes(returnedBroker ? 1 : 0);
    }
  });

  it("uses the latest acquired child and tools for emergency shutdown", () => {
    const launch = createDesktopHostLaunch({ shutdownServer: async () => undefined });
    const server = child();
    const tools = { close: async () => undefined, terminateTrackedProcesses: vi.fn() };
    const forceAtDeadline = () => launch.forceStop();
    launch.acquired({ server, managedTools: tools });
    forceAtDeadline();
    forceAtDeadline();
    expect(server.kill).toHaveBeenCalledOnce();
    expect(tools.terminateTrackedProcesses).toHaveBeenCalledOnce();
  });

  it("reports an unconfirmed native helper exit when its broker never finished starting", async () => {
    const launch = createDesktopHostLaunch({ shutdownServer: async () => undefined });
    launch.acquired({
      simulatorHelpers: {
        dispose: async () => ({ status: "failed", reason: "exit-not-confirmed" }),
      },
    });
    await expect(launch.close()).resolves.toEqual({ status: "failed", stages: ["simulator"] });
    expect(launch.state).toBe("failed");
  });

  it("forces a late child acquired after the deadline and keeps it owned for rollback", async () => {
    const launch = createDesktopHostLaunch({ shutdownServer: async () => undefined });
    launch.forceStop();
    const server = child();
    expect(() => launch.acquired({ server })).toThrow("closing");
    expect(launch.server).toBe(server);
    expect(server.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(launch.close()).resolves.toEqual({ status: "closed" });
  });

  it("confirms a real stubborn owned child exits and closes every listener despite a sibling cleanup failure", async () => {
    const listener = createServer();
    let server: ChildProcess | undefined;
    try {
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const launched = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      server = launched;
      if (launched.stdout === null) throw new Error("Fixture child has no readiness channel.");
      const readiness = new AbortController();
      const timer = setTimeout(() => readiness.abort(), 1_000);
      try {
        await Promise.race([
          once(launched.stdout, "data", { signal: readiness.signal }),
          once(launched, "exit", { signal: readiness.signal }).then(() => {
            throw new Error("Fixture exited before readiness.");
          }),
        ]);
      } finally {
        clearTimeout(timer);
        readiness.abort();
      }
      const launch = createDesktopHostLaunch({
        shutdownServer: (owned) =>
          shutdownManagedServer(owned, { gracePeriodMs: 20, forceKillWaitMs: 1000 }),
      });
      launch.acquired({
        server: launched,
        credentialBroker: {
          close: async () => {
            throw new Error("fixture failure");
          },
        },
        browserBroker: {
          close: () =>
            new Promise<void>((resolve, reject) =>
              listener.close((error) => (error === undefined ? resolve() : reject(error))),
            ),
        },
      });
      await expect(launch.close()).resolves.toEqual({ status: "failed", stages: ["credentials"] });
      expect(launched.signalCode).toBe("SIGKILL");
      expect(listener.listening).toBe(false);
    } finally {
      if (server !== undefined && server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await once(server, "exit", { signal: AbortSignal.timeout(1_000) });
      }
      if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
