import { describe, expect, it, vi } from "vitest";
import {
  createLiveLocalServerHealthProbe,
  createLiveLocalServerStopPort,
} from "./localServerHostPorts";

describe("local server health probe", () => {
  it("reports HTTP as listening when the port answers at all", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const probe = createLiveLocalServerHealthProbe({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(await probe.probe({ port: 5173 })).toEqual({
      scheme: "http",
      host: "127.0.0.1",
      health: "listening",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("probes the loopback family the host observed for the listener", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url !== "http://[::1]:5174/") throw new Error("ECONNREFUSED");
      return new Response("ok");
    });
    const probe = createLiveLocalServerHealthProbe({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(await probe.probe({ port: 5174, bindAddress: "::1" })).toEqual({
      scheme: "http",
      host: "::1",
      health: "listening",
    });
    // The observed family is the only one worth asking; IPv4 is never tried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://[::1]:5174/", expect.anything());
  });

  it("tries both loopback families only when the observation names neither", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url !== "http://[::1]:3000/") throw new Error("ECONNREFUSED");
      return new Response("ok");
    });
    const probe = createLiveLocalServerHealthProbe({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(await probe.probe({ port: 3000, bindAddress: "*" })).toEqual({
      scheme: "http",
      host: "::1",
      health: "listening",
    });
  });

  it("falls forward to HTTPS for an HTTPS-only listener", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("http://")) throw new Error("ECONNRESET");
      return new Response("ok");
    });
    const probe = createLiveLocalServerHealthProbe({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(await probe.probe({ port: 8443 })).toEqual({
      scheme: "https",
      host: "127.0.0.1",
      health: "listening",
    });
  });

  it("classifies an HTTPS listener with a self-signed localhost certificate as listening", async () => {
    // The ordinary shape of a `vite --https` dev server: HTTP is refused and
    // HTTPS completes a handshake the default trust store will not verify.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("http://")) throw new Error("ECONNREFUSED");
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("self-signed certificate"), {
          code: "DEPTH_ZERO_SELF_SIGNED_CERT",
        }),
      });
    });
    const probe = createLiveLocalServerHealthProbe({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(await probe.probe({ port: 8443, bindAddress: "127.0.0.1" })).toEqual({
      scheme: "https",
      host: "127.0.0.1",
      health: "listening",
    });
  });

  it("still classifies a wedged HTTPS listener as unresponsive", async () => {
    // A socket that accepts and then stalls proves nothing answered; only a
    // certificate the client refused proves a TLS server replied.
    const probe = createLiveLocalServerHealthProbe({
      fetch: (async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("handshake timed out"), {
            code: "ERR_TLS_HANDSHAKE_TIMEOUT",
          }),
        });
      }) as unknown as typeof globalThis.fetch,
    });

    expect(await probe.probe({ port: 8443, bindAddress: "127.0.0.1" })).toEqual({
      scheme: "http",
      host: "127.0.0.1",
      health: "unresponsive",
    });
  });

  it("classifies a port nobody answers as unresponsive", async () => {
    const probe = createLiveLocalServerHealthProbe({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await probe.probe({ port: 5173 })).toEqual({
      scheme: "http",
      host: "127.0.0.1",
      health: "unresponsive",
    });
  });

  it("stops probing promptly when the caller aborts the scan, and says it never found out", async () => {
    const controller = new AbortController();
    // A fetch that answers only to its abort signal — like a real socket that
    // would otherwise sit open until the probe timeout.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const probe = createLiveLocalServerHealthProbe({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      timeoutMs: 2_000,
    });
    const pending = probe.probe({ port: 5173, signal: controller.signal });
    controller.abort();
    // An abandoned probe asked HTTP on one family and nothing else, so it never
    // established that this listener is silent — only that it did not find out.
    expect(await pending).toEqual({ scheme: "http", host: "127.0.0.1", health: "unknown" });
    // The HTTPS fallback is never attempted for an abandoned scan.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("local server stop port", () => {
  /** `process.kill` reports a vanished target by errno, not by message. */
  function noSuchProcess(): Error {
    return Object.assign(new Error("no such process"), { code: "ESRCH" });
  }

  /**
   * A real process group: `kill(-pgid, …)` reaches every member, and the group
   * outlives its leader for as long as one member is still running.
   */
  function groupStopPort(options: {
    readonly leader: number;
    readonly members: ReadonlySet<number>;
    /** Members that ignore SIGTERM and keep holding the port. */
    readonly ignoresTerm?: ReadonlySet<number>;
    /** An unkillable member, so escalation cannot be assumed to have worked. */
    readonly survivesKill?: boolean;
  }) {
    const alive = new Set(options.members);
    const signals: Array<{ readonly pid: number; readonly signal: string }> = [];
    let clock = 0;
    const targetsOf = (pid: number): ReadonlyArray<number> =>
      pid < 0 ? (-pid === options.leader ? [...alive] : []) : alive.has(pid) ? [pid] : [];
    const port = createLiveLocalServerStopPort({
      kill: (pid, signal) => {
        signals.push({ pid, signal: String(signal) });
        const targets = targetsOf(pid);
        if (targets.length === 0) throw noSuchProcess();
        if (signal === 0) return;
        for (const target of targets) {
          if (signal === "SIGTERM" && options.ignoresTerm?.has(target) === true) continue;
          if (signal === "SIGKILL" && options.survivesKill === true) continue;
          alive.delete(target);
        }
      },
      now: () => {
        clock += 500;
        return clock;
      },
      sleep: async () => undefined,
      graceMs: 3_000,
    });
    return { port, signals, alive };
  }

  function stopPort(alive: Set<number>, options: { readonly ignoreKill?: boolean } = {}) {
    const signals: Array<{ readonly pid: number; readonly signal: string }> = [];
    let clock = 0;
    const port = createLiveLocalServerStopPort({
      kill: (pid, signal) => {
        signals.push({ pid, signal: String(signal) });
        if (signal === 0) {
          if (!alive.has(Math.abs(pid))) throw noSuchProcess();
          return;
        }
        if (signal === "SIGTERM" && !options.ignoreKill) alive.delete(Math.abs(pid));
        if (signal === "SIGKILL") alive.delete(Math.abs(pid));
      },
      now: () => {
        clock += 500;
        return clock;
      },
      sleep: async () => undefined,
      graceMs: 3_000,
    });
    return { port, signals };
  }

  it("stops a process group gracefully with SIGTERM", async () => {
    const { port, signals } = stopPort(new Set([4213]));
    expect(await port.stop({ pid: 4213 })).toBe("stopped");
    expect(signals[0]).toEqual({ pid: -4213, signal: "SIGTERM" });
    expect(signals.some((entry) => entry.signal === "SIGKILL")).toBe(false);
  });

  it("escalates to SIGKILL only after the grace window", async () => {
    const { port, signals } = stopPort(new Set([4213]), { ignoreKill: true });
    expect(await port.stop({ pid: 4213 })).toBe("stopped");
    expect(signals.some((entry) => entry.signal === "SIGKILL")).toBe(true);
  });

  it("escalates against the group when a member outlives the leader", async () => {
    // The leader exits on SIGTERM while its worker keeps the port bound, which
    // is the ordinary shape of a dev server that spawned children.
    const { port, signals, alive } = groupStopPort({
      leader: 4213,
      members: new Set([4213, 4299]),
      ignoresTerm: new Set([4299]),
    });
    expect(await port.stop({ pid: 4213 })).toBe("stopped");
    expect(signals).toContainEqual({ pid: -4213, signal: "SIGKILL" });
    expect(alive.size).toBe(0);
  });

  it("reports a failure when the group still holds the port after SIGKILL", async () => {
    const { port, signals } = groupStopPort({
      leader: 4213,
      members: new Set([4213, 4299]),
      ignoresTerm: new Set([4299]),
      survivesKill: true,
    });
    expect(await port.stop({ pid: 4213 })).toBe("failed");
    expect(signals).toContainEqual({ pid: -4213, signal: "SIGKILL" });
  });

  it("never reads a refused probe as a stop", async () => {
    // EPERM means the target is alive and merely not ours to signal.
    const signals: Array<{ readonly pid: number; readonly signal: string }> = [];
    let clock = 0;
    const port = createLiveLocalServerStopPort({
      kill: (pid, signal) => {
        signals.push({ pid, signal: String(signal) });
        if (signal === 0) {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        }
      },
      now: () => {
        clock += 500;
        return clock;
      },
      sleep: async () => undefined,
      graceMs: 3_000,
    });
    expect(await port.stop({ pid: 4213 })).toBe("failed");
    expect(signals).toContainEqual({ pid: -4213, signal: "SIGKILL" });
  });

  it("probes the single pid when the pid leads no group", async () => {
    const { port, signals } = groupStopPort({ leader: 9999, members: new Set([4213]) });
    expect(await port.stop({ pid: 4213 })).toBe("stopped");
    expect(signals[0]).toEqual({ pid: -4213, signal: "SIGTERM" });
    expect(signals[1]).toEqual({ pid: 4213, signal: "SIGTERM" });
    // The refused group target is never probed or escalated against.
    expect(signals.filter((entry) => entry.pid === -4213)).toHaveLength(1);
  });

  it("refuses an implausible pid rather than signalling init", async () => {
    const { port, signals } = stopPort(new Set([1]));
    expect(await port.stop({ pid: 1 })).toBe("failed");
    expect(await port.stop({ pid: -5 })).toBe("failed");
    expect(signals).toHaveLength(0);
  });
});
