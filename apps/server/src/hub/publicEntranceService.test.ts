import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubMembershipChangedPayload } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHubStateStore, type HubStatePort } from "./hubStateStore";
import { PublicEntranceService } from "./publicEntranceService";
import type { TailscaleExec } from "./tailscaleCliDaemon";

const WINDOW = { kind: "local-window" } as const;
const services: PublicEntranceService[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(
  options: {
    readonly role?: "hub" | "member" | "none";
    readonly privateListenerPort?: number;
    readonly failFunnel?: boolean;
    readonly failFunnelOff?: () => boolean;
    /** A state another run of the service left, as after a restart. */
    readonly state?: HubStatePort;
    readonly paused?: boolean;
    readonly now?: () => number;
  } = {},
) {
  const folder = mkdtempSync(join(tmpdir(), "octant-public-entrance-"));
  folders.push(folder);
  const state: HubStatePort = options.state ?? createHubStateStore(folder);
  const calls: string[][] = [];
  const exec: TailscaleExec = async (_file, args) => {
    calls.push([...args]);
    if (args[0] === "funnel" && args[1] === "status") {
      return { exitCode: 0, stdout: "{}", stderr: "" };
    }
    if (args.at(-1) === "off" && options.failFunnelOff?.() === true) {
      return { exitCode: 1, stdout: "", stderr: "tailscaled is not running" };
    }
    return options.failFunnel === true
      ? { exitCode: 1, stdout: "", stderr: 'Funnel not available; "funnel" node attribute not set' }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
  const recorded: HubMembershipChangedPayload[] = [];
  let paused = options.paused ?? false;
  let role = options.role ?? "hub";
  const service = new PublicEntranceService({
    state,
    exec,
    platform: "linux",
    record: (change) => recorded.push(change),
    remoteAccessPaused: () => paused,
    privateListenerPort: () => options.privateListenerPort,
    role: () => role,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  services.push(service);
  return {
    service,
    state,
    calls,
    recorded,
    pause: async (value: boolean) => {
      paused = value;
      await service.reconcile();
    },
    setRole: async (value: "hub" | "member" | "none") => {
      role = value;
      await service.reconcile();
    },
  };
}

async function health(service: PublicEntranceService): Promise<number | "refused"> {
  const port = service.status().port;
  if (port === undefined) return "refused";
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
  } catch {
    return "refused";
  }
}

describe("the public entrance switch", () => {
  it("is off by default and opens nothing", async () => {
    const { service, calls } = setup();
    await service.reconcile();
    expect(service.status()).toMatchObject({ enabled: false, listening: false });
    expect(calls).toEqual([]);
  });

  it("opens on loopback when the person turns it on, and keeps its port", async () => {
    const { service, recorded, state } = setup();
    expect(await service.setEnabled(true, WINDOW)).toMatchObject({ status: "changed" });
    const port = service.status().port;
    expect(port).toBeGreaterThan(0);
    expect(service.status().address).toBe(`http://127.0.0.1:${port}`);
    expect(await health(service)).toBe(200);
    expect(state.load().publicEntrance).toMatchObject({ enabled: true, port });
    expect(recorded.map((entry) => entry.change)).toEqual(["public-entrance-switch-changed"]);
    await service.setEnabled(false, WINDOW);
    expect(await health(service)).toBe("refused");
    await service.setEnabled(true, WINDOW);
    expect(service.status().port).toBe(port);
  });

  it("is refused on a host that is neither hub nor member", async () => {
    const { service } = setup({ role: "none" });
    expect(await service.setEnabled(true, WINDOW)).toEqual({
      status: "refused",
      kind: "not-in-a-hub",
    });
  });

  it("closes when the hub role is turned off", async () => {
    const { service, setRole } = setup();
    await service.setEnabled(true, WINDOW);
    expect(await health(service)).toBe(200);
    await setRole("none");
    expect(service.status().listening).toBe(false);
  });
});

describe("the Funnel front", () => {
  it("Funnel is never started unless the person turned the switch on", async () => {
    const { service, calls, pause } = setup();
    await service.setEnabled(true, WINDOW);
    await service.reconcile();
    service.status();
    await pause(true);
    await pause(false);
    await service.setEnabled(false, WINDOW);
    await service.setEnabled(true, WINDOW);
    expect(calls).toEqual([]);

    expect(await service.setFunnel({ enabled: true }, WINDOW)).toMatchObject({
      status: "changed",
    });
    const port = service.status().port;
    expect(calls[0]).toEqual([
      "funnel",
      "--bg",
      "--yes",
      "--https=443",
      `http://127.0.0.1:${port}`,
    ]);
    expect(calls.every((args) => args[0] === "funnel")).toBe(true);
  });

  it("a standby that starts and stops standing in runs no Tailscale command, and serves only while it stands in", async () => {
    const { service, calls, setRole, state } = setup({ role: "member" });
    await service.setEnabled(true, WINDOW);
    expect(await service.setFunnel({ enabled: true }, WINDOW)).toMatchObject({
      status: "changed",
    });
    const before = calls.length;
    const port = service.status().port;
    const healthOf = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
    // Forwarding with nowhere to forward to answers 503; serving answers 200.
    expect(await healthOf()).toBe(503);
    await setRole("hub");
    expect(await healthOf()).toBe(200);
    await setRole("member");
    expect(await healthOf()).toBe(503);
    // The Funnel the person turned on stays on through both, and no command ran.
    expect(calls.length).toBe(before);
    expect(state.load().publicEntrance?.funnel).toEqual({ port: 443 });
  });

  it("refuses Funnel while the entrance is off", async () => {
    const { service, calls } = setup();
    expect(await service.setFunnel({ enabled: true }, WINDOW)).toEqual({
      status: "refused",
      kind: "entrance-off",
    });
    expect(calls).toEqual([]);
  });

  it("refuses 8443 when the private listener serves on it", async () => {
    const { service, calls } = setup({ privateListenerPort: 8443 });
    await service.setEnabled(true, WINDOW);
    expect(await service.setFunnel({ enabled: true, port: 8443 }, WINDOW)).toEqual({
      status: "refused",
      kind: "port-shadows-private-listener",
    });
    expect(calls).toEqual([]);
    expect(await service.setFunnel({ enabled: true, port: 10000 }, WINDOW)).toMatchObject({
      status: "changed",
    });
    expect(calls[0]?.[3]).toBe("--https=10000");
  });

  it("keeps Funnel off and says why when Tailscale refuses", async () => {
    const { service } = setup({ failFunnel: true });
    await service.setEnabled(true, WINDOW);
    expect(await service.setFunnel({ enabled: true }, WINDOW)).toEqual({
      status: "refused",
      kind: "funnel-not-allowed",
    });
    expect(service.status().funnel).toEqual({ enabled: false });
  });

  it("keeps the entrance on and says so when Tailscale refuses to turn Funnel off", async () => {
    let failOff = false;
    const { service } = setup({ failFunnelOff: () => failOff });
    await service.setEnabled(true, WINDOW);
    await service.setFunnel({ enabled: true }, WINDOW);
    failOff = true;
    expect(await service.setEnabled(false, WINDOW)).toEqual({
      status: "refused",
      kind: "funnel-off-failed",
    });
    expect(service.status()).toMatchObject({ enabled: true, funnel: { enabled: true } });
  });

  it("turns Funnel off with the same port it turned on", async () => {
    const { service, calls, recorded } = setup();
    await service.setEnabled(true, WINDOW);
    await service.setFunnel({ enabled: true, port: 10000 }, WINDOW);
    calls.length = 0;
    expect(await service.setFunnel({ enabled: false }, WINDOW)).toMatchObject({
      status: "changed",
    });
    expect(calls[0]).toEqual(["funnel", "--https=10000", "off"]);
    expect(recorded.filter((entry) => entry.change === "public-funnel-changed")).toHaveLength(2);
  });
});

describe("pausing remote access", () => {
  it("pausing remote access closes the public entrance", async () => {
    const { service, calls, pause } = setup();
    await service.setEnabled(true, WINDOW);
    await service.setFunnel({ enabled: true }, WINDOW);
    expect(await health(service)).toBe(200);
    const port = service.status().port;
    calls.length = 0;

    await pause(true);
    expect(service.status().listening).toBe(false);
    const answered = await fetch(`http://127.0.0.1:${port}/healthz`).then(
      () => true,
      () => false,
    );
    expect(answered).toBe(false);
    expect(calls[0]).toEqual(["funnel", "--https=443", "off"]);
    expect(service.status().funnel).toEqual({ enabled: false });

    // Resuming reopens the entrance but never turns Funnel back on by itself.
    calls.length = 0;
    await pause(false);
    expect(await health(service)).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe("what the person did not ask for", () => {
  it("refuses to turn the entrance on while remote access is paused, and resuming leaves it off", async () => {
    const { service, pause } = setup({ paused: true });
    expect(await service.setEnabled(true, WINDOW)).toEqual({
      status: "refused",
      kind: "remote-access-paused",
    });
    await pause(false);
    expect(service.status()).toMatchObject({ enabled: false, listening: false });
  });

  it("turns Funnel off before resuming when the pause could not, and stays closed until it goes", async () => {
    let failOff = false;
    let now = 1_000_000;
    const { service, calls, pause } = setup({ failFunnelOff: () => failOff, now: () => now });
    await service.setEnabled(true, WINDOW);
    await service.setFunnel({ enabled: true }, WINDOW);
    failOff = true;
    await pause(true);
    expect(service.status().funnel).toEqual({ enabled: true, port: 443 });

    await pause(false);
    expect(service.status().listening).toBe(false);
    expect(await health(service)).toBe("refused");

    failOff = false;
    calls.length = 0;
    now += 60_000;
    await pause(false);
    expect(calls).toContainEqual(["funnel", "--https=443", "off"]);
    expect(service.status()).toMatchObject({ listening: true, funnel: { enabled: false } });
    expect(await health(service)).toBe(200);
  });

  it("turns Funnel off rather than leave it aimed at a port another program took", async () => {
    const first = setup();
    await first.service.setEnabled(true, WINDOW);
    await first.service.setFunnel({ enabled: true }, WINDOW);
    const saved = first.service.status().port;
    await first.service.close();
    const squatter = createServer((_request, response) => response.end("someone else"));
    await new Promise<void>((resolve) => squatter.listen(saved, "127.0.0.1", () => resolve()));
    try {
      const restarted = setup({ state: first.state });
      await restarted.service.reconcile();
      expect(restarted.calls).toContainEqual(["funnel", "--https=443", "off"]);
      expect(restarted.service.status()).toMatchObject({
        listening: true,
        funnel: { enabled: false },
      });
      expect(restarted.service.status().port).not.toBe(saved);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("turns an owed Funnel off once when the same resume also finds its port taken", async () => {
    let failOff = false;
    let now = 1_000_000;
    const { service, calls, pause } = setup({ failFunnelOff: () => failOff, now: () => now });
    await service.setEnabled(true, WINDOW);
    await service.setFunnel({ enabled: true }, WINDOW);
    const saved = service.status().port;
    failOff = true;
    await pause(true);
    expect(service.status().funnel).toEqual({ enabled: true, port: 443 });
    const squatter = createServer((_request, response) => response.end("someone else"));
    await new Promise<void>((resolve) => squatter.listen(saved, "127.0.0.1", () => resolve()));
    try {
      failOff = false;
      calls.length = 0;
      now += 60_000;
      await pause(false);
      expect(calls.filter((args) => args.at(-1) === "off")).toEqual([
        ["funnel", "--https=443", "off"],
      ]);
      expect(service.status()).toMatchObject({ listening: true, funnel: { enabled: false } });
      expect(service.status().port).not.toBe(saved);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("stays closed once the host stops, whatever a later look finds", async () => {
    const { service } = setup();
    await service.setEnabled(true, WINDOW);
    const port = service.status().port;
    await service.close();
    await service.reconcile();
    expect(service.status().listening).toBe(false);
    const answered = await fetch(`http://127.0.0.1:${port}/healthz`).then(
      () => true,
      () => false,
    );
    expect(answered).toBe(false);
  });
});
