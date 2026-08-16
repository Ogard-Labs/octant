import { describe, expect, it, vi } from "vitest";
import {
  MAX_LOCAL_SERVER_LISTENERS,
  type CodeThreadId,
  type LocalServerCommand,
  type LocalServerListenerId,
  type LocalServerRequestId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { ObservedLocalListener } from "./localListenerPort";
import { createLiveLocalServerHealthProbe } from "./localServerHostPorts";
import type { LocalServerActor } from "@octant/domain";
import {
  deriveListenerId,
  LISTENER_HEALTH_PHASE_DEADLINE_MS,
  LISTENER_HEALTH_PROBE_CONCURRENCY,
  LocalServerService,
  type LocalServerHealthProbe,
  type LocalServerScopeBinding,
} from "./localServerService";

const windowId = "44444444-4444-4444-8444-444444444444" as WindowId;
const threadId = "11111111-1111-4111-8111-111111111111" as CodeThreadId;
const projectId = "22222222-2222-4222-8222-222222222222" as ProjectId;
const requestId = "33333333-3333-4333-8333-333333333333" as LocalServerRequestId;
const checkoutRoot = "/Users/example/code/octant";

const viteListener: ObservedLocalListener = {
  pid: 4213,
  port: 5173,
  processName: "node",
  commandName: "vite",
  ownership: "current-user",
  workingDirectory: `${checkoutRoot}/apps/web`,
  bindAddress: "127.0.0.1",
};

const leftoverListener: ObservedLocalListener = {
  pid: 9001,
  port: 3000,
  processName: "node",
  ownership: "current-user",
  workingDirectory: "/Users/example/code/other-app",
  lineage: ["Visual Studio Code"],
  bindAddress: "0.0.0.0",
};

const systemListener: ObservedLocalListener = {
  pid: 91,
  port: 22,
  processName: "sshd",
  ownership: "root",
  bindAddress: "*",
};

/** A dev server bound only to the IPv6 loopback, as `lsof` reports `[::1]:5174`. */
const ipv6Listener: ObservedLocalListener = {
  pid: 4214,
  port: 5174,
  processName: "node",
  commandName: "vite",
  ownership: "current-user",
  workingDirectory: `${checkoutRoot}/apps/web`,
  bindAddress: "::1",
};

const postgresListener: ObservedLocalListener = {
  pid: 777,
  port: 5432,
  processName: "postgres",
  ownership: "current-user",
  bindAddress: "127.0.0.1",
};

/** `count` distinct listeners in this checkout, each classified as a dev server. */
function manyListeners(count: number): ReadonlyArray<ObservedLocalListener> {
  return Array.from({ length: count }, (_, index) => ({
    pid: 20_000 + index,
    port: 6000 + index,
    processName: "node",
    commandName: "vite",
    ownership: "current-user" as const,
    workingDirectory: `${checkoutRoot}/apps/web`,
    bindAddress: "127.0.0.1",
  }));
}

const listening = { scheme: "http", host: "127.0.0.1", health: "listening" } as const;

function scope(overrides: Partial<LocalServerScopeBinding> = {}): LocalServerScopeBinding {
  return {
    threadId,
    projectId,
    currentCheckoutRoot: checkoutRoot,
    userProjectRoots: [checkoutRoot, "/Users/example/code/other-app"],
    posture: "full-access",
    ownedPids: new Set<number>(),
    ...overrides,
  };
}

/** The actor is per request, so every command names the principal asking. */
function execute(
  service: LocalServerService,
  value: LocalServerCommand,
  options: { readonly actor?: LocalServerActor; readonly signal?: AbortSignal } = {},
) {
  return service.execute(windowId, value, {
    actor: options.actor ?? "local-user",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function build(input: {
  readonly observed: ReadonlyArray<ObservedLocalListener>;
  readonly scope?: LocalServerScopeBinding | undefined;
  readonly stop?: () => Promise<"stopped" | "failed">;
  readonly health?: "listening" | "unresponsive";
  readonly probe?: LocalServerHealthProbe;
  readonly observeSpy?: () => void;
}) {
  const stop = vi.fn(input.stop ?? (async () => "stopped" as const));
  const service = new LocalServerService({
    listeners: {
      observe: async () => {
        input.observeSpy?.();
        return { status: "observed", listeners: input.observed };
      },
    },
    scopes: { resolve: async () => input.scope ?? scope() },
    health: input.probe ?? {
      probe: async () => ({
        scheme: "http",
        host: "127.0.0.1",
        health: input.health ?? "listening",
      }),
    },
    stopPort: { stop },
    clock: () => "2026-08-14T08:00:00.000Z",
  });
  return { service, stop };
}

function command(overrides: Partial<LocalServerCommand> = {}): LocalServerCommand {
  return {
    kind: "list-local-servers",
    requestId,
    threadId,
    projectId,
    ...overrides,
  } as LocalServerCommand;
}

describe("LocalServerService list", () => {
  it("lists classified user/dev servers with this checkout first", async () => {
    const { service } = build({ observed: [leftoverListener, viteListener] });
    const result = await execute(service, command());

    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    expect(result.snapshot.currentCheckout.map((row) => row.port)).toEqual([5173]);
    expect(result.snapshot.other.map((row) => row.port)).toEqual([3000]);
    expect(result.snapshot.currentCheckout[0]?.framework).toBe("vite");
    expect(result.snapshot.other[0]?.startSource).toBe("vscode");
  });

  it("hides system, root, and unclassified listeners entirely", async () => {
    const { service } = build({ observed: [systemListener, postgresListener, viteListener] });
    const result = await execute(service, command());

    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    const ports = [...result.snapshot.currentCheckout, ...result.snapshot.other].map(
      (row) => row.port,
    );
    expect(ports).toEqual([5173]);
    expect(JSON.stringify(result.snapshot)).not.toContain("sshd");
  });

  it("distinguishes a wedged listener and withholds Open from it", async () => {
    // The probe answered inside the deadline: the host did establish that this
    // listener holds the port without responding, so it keeps `unresponsive`
    // rather than the value reserved for a health nobody determined.
    const { service } = build({ observed: [viteListener], health: "unresponsive" });
    const result = await execute(service, command());

    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    expect(result.snapshot.currentCheckout[0]?.health).toBe("unresponsive");
    expect(result.snapshot.currentCheckout[0]?.openAvailable).toBe(false);
  });

  it("reports LAN bind scope separately from loopback", async () => {
    const { service } = build({ observed: [viteListener, leftoverListener] });
    const result = await execute(service, command());

    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    expect(result.snapshot.currentCheckout[0]?.bindScope).toBe("loopback");
    expect(result.snapshot.other[0]?.bindScope).toBe("lan");
  });

  it("never publishes a PID or a raw command line", async () => {
    const { service } = build({ observed: [viteListener] });
    const result = await execute(service, command());
    expect(JSON.stringify(result)).not.toContain("4213");
  });

  it("stops probing remaining listeners once the caller aborts the scan", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const observed = manyListeners(LISTENER_HEALTH_PROBE_CONCURRENCY * 4);
      const probe = vi.fn(async () => {
        // The caller abandons the scan while the first wave is being probed.
        controller.abort();
        return listening;
      });
      const { service } = build({ observed, probe: { probe } });

      const result = await execute(service, command(), { signal: controller.signal });
      expect(result.kind).toBe("local-servers-listed");
      if (result.kind !== "local-servers-listed") return;
      // A wave already in flight finishes, but no further wave starts.
      expect(probe.mock.calls.length).toBeLessThanOrEqual(LISTENER_HEALTH_PROBE_CONCURRENCY);
      // Nobody is reading this scan, so a listener it never asked about is left
      // out rather than published with a health the host never established.
      expect(result.snapshot.currentCheckout.length).toBeLessThanOrEqual(
        LISTENER_HEALTH_PROBE_CONCURRENCY,
      );
      // The abort itself ends the phase: no deadline timer and no listener left.
      expect(vi.getTimerCount()).toBe(0);
      expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlaps health probes across listeners without exceeding the concurrency cap", async () => {
    const observed = manyListeners(LISTENER_HEALTH_PROBE_CONCURRENCY * 3);
    let inFlight = 0;
    let peakInFlight = 0;
    const probe = vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return listening;
    });
    const { service } = build({ observed, probe: { probe } });

    const result = await execute(service, command());
    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    expect(result.snapshot.currentCheckout).toHaveLength(observed.length);
    expect(probe).toHaveBeenCalledTimes(observed.length);
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(LISTENER_HEALTH_PROBE_CONCURRENCY);
  });

  it("lists a listener whose probe never answers instead of stalling on it", async () => {
    vi.useFakeTimers();
    try {
      const probe: LocalServerHealthProbe = {
        probe: async (input) =>
          input.port === leftoverListener.port ? listening : new Promise<never>(() => {}),
      };
      const { service } = build({
        observed: [viteListener, ipv6Listener, leftoverListener],
        probe,
      });

      const pending = execute(service, command());
      await vi.advanceTimersByTimeAsync(LISTENER_HEALTH_PHASE_DEADLINE_MS);
      const result = await pending;

      // Still a listing, not the `unavailable` refusal a failed discovery gets:
      // the host did observe this computer, it only ran out of probe budget.
      expect(result.kind).toBe("local-servers-listed");
      if (result.kind !== "local-servers-listed") return;
      // The unanswered listener is still listed as one the host never found out
      // about — not as one that answered, and not as one proven silent — and
      // Open is withheld from it.
      expect(result.snapshot.currentCheckout[0]?.port).toBe(5173);
      expect(result.snapshot.currentCheckout[0]?.health).toBe("unknown");
      expect(result.snapshot.currentCheckout[0]?.openAvailable).toBe(false);
      // ...at the loopback family the socket was observed on, never a presumed
      // 127.0.0.1 nothing was ever asked at.
      expect(String(result.snapshot.currentCheckout[1]?.url)).toBe("http://[::1]:5174/");
      expect(result.snapshot.currentCheckout[1]?.health).toBe("unknown");
      // The listener that did answer keeps its real result.
      expect(result.snapshot.other[0]?.health).toBe("listening");
      expect(result.snapshot.other[0]?.openAvailable).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses Open for a listener it never determined, without calling it silent", async () => {
    vi.useFakeTimers();
    try {
      const probe: LocalServerHealthProbe = { probe: async () => new Promise<never>(() => {}) };
      const { service } = build({ observed: [viteListener], probe });

      const pending = execute(
        service,
        command({
          kind: "open-local-server",
          listenerId: deriveListenerId(threadId, viteListener),
        } as Partial<LocalServerCommand>),
      );
      await vi.advanceTimersByTimeAsync(LISTENER_HEALTH_PHASE_DEADLINE_MS);
      const result = await pending;

      expect(result.kind).toBe("local-server-rejected");
      if (result.kind !== "local-server-rejected") return;
      expect(result.failure.category).toBe("unavailable");
      // "not answering" is a fact the host never established for this row.
      expect(result.failure.message).not.toContain("not answering");
      expect(result.failure.message).toBe(
        "Octant could not check that local server, so it has nothing to open.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every probe result on a fast listing and leaves no deadline timer running", async () => {
    vi.useFakeTimers();
    try {
      const { service } = build({ observed: [viteListener, leftoverListener] });
      const result = await execute(service, command());

      expect(result.kind).toBe("local-servers-listed");
      if (result.kind !== "local-servers-listed") return;
      expect(result.snapshot.currentCheckout[0]?.health).toBe("listening");
      expect(result.snapshot.currentCheckout[0]?.openAvailable).toBe(true);
      expect(result.snapshot.other[0]?.health).toBe("listening");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never publishes more listeners than the budget, however many the host reports", async () => {
    const observed = manyListeners(MAX_LOCAL_SERVER_LISTENERS + 20);
    const probe = vi.fn(async () => listening);
    const { service } = build({ observed, probe: { probe } });

    const result = await execute(service, command());
    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    expect(result.snapshot.currentCheckout).toHaveLength(MAX_LOCAL_SERVER_LISTENERS);
    // A row past the budget is never probed either; it is dropped before asking.
    expect(probe).toHaveBeenCalledTimes(MAX_LOCAL_SERVER_LISTENERS);
  });

  it("lists an empty snapshot when the host observed a genuinely quiet computer", async () => {
    const { service } = build({ observed: [] });
    const result = await execute(service, command());

    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    expect(result.snapshot.currentCheckout).toEqual([]);
    expect(result.snapshot.other).toEqual([]);
  });

  it("refuses to list anything when the host could not observe at all", async () => {
    const service = new LocalServerService({
      listeners: { observe: async () => ({ status: "unavailable" }) },
      scopes: { resolve: async () => scope() },
      health: { probe: async () => ({ scheme: "http", host: "127.0.0.1", health: "listening" }) },
      stopPort: { stop: async () => "stopped" },
    });
    const result = await execute(service, command());

    // A failed discovery must never be answered as a successful empty scan.
    expect(result.kind).toBe("local-server-rejected");
    expect(result).toMatchObject({ failure: { category: "unavailable" } });
  });

  it("treats a thrown observation as unavailable rather than as no servers", async () => {
    const service = new LocalServerService({
      listeners: {
        observe: async () => {
          throw new Error("lsof: command not found");
        },
      },
      scopes: { resolve: async () => scope() },
      health: { probe: async () => ({ scheme: "http", host: "127.0.0.1", health: "listening" }) },
      stopPort: { stop: async () => "stopped" },
    });
    const result = await execute(service, command());
    expect(result).toMatchObject({
      kind: "local-server-rejected",
      failure: { category: "unavailable" },
    });
  });

  it("hides Stop from a Plan thread and says why", async () => {
    const { service } = build({
      observed: [viteListener],
      scope: scope({ posture: "plan" }),
    });
    const result = await execute(service, command());

    expect(result.kind).toBe("local-servers-listed");
    if (result.kind !== "local-servers-listed") return;
    expect(result.snapshot.currentCheckout[0]?.stop).toEqual({
      status: "unavailable",
      reason: "Plan threads can list and open local servers but never stop them.",
    });
  });
});

describe("LocalServerService open", () => {
  it("prepares exactly one origin for a new Browser tab", async () => {
    const { service } = build({ observed: [viteListener] });
    const listenerId = deriveListenerId(threadId, viteListener);
    const result = await execute(
      service,
      command({ kind: "open-local-server", listenerId } as Partial<LocalServerCommand>),
    );

    expect(result.kind).toBe("local-server-open-prepared");
    if (result.kind !== "local-server-open-prepared") return;
    expect(result.target).toEqual({
      url: "http://127.0.0.1:5173/",
      allowedOrigin: "http://127.0.0.1:5173",
      acceptsLocalCertificate: false,
    });
  });

  it("opens an IPv6-only listener at its bracketed loopback URL", async () => {
    // A dev server bound to `::1` answers on the IPv6 loopback and nowhere
    // else; probing it at 127.0.0.1 would report a healthy server as wedged
    // and withhold Open from it.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url !== "http://[::1]:5174/") throw new Error("ECONNREFUSED");
      return new Response("ok");
    });
    const { service } = build({
      observed: [ipv6Listener],
      probe: createLiveLocalServerHealthProbe({
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    });

    const listed = await execute(service, command());
    expect(listed.kind).toBe("local-servers-listed");
    if (listed.kind !== "local-servers-listed") return;
    expect(listed.snapshot.currentCheckout[0]?.health).toBe("listening");
    expect(listed.snapshot.currentCheckout[0]?.openAvailable).toBe(true);
    expect(String(listed.snapshot.currentCheckout[0]?.url)).toBe("http://[::1]:5174/");

    const opened = await execute(
      service,
      command({
        kind: "open-local-server",
        listenerId: deriveListenerId(threadId, ipv6Listener),
      } as Partial<LocalServerCommand>),
    );
    expect(opened.kind).toBe("local-server-open-prepared");
    if (opened.kind !== "local-server-open-prepared") return;
    expect(opened.target).toEqual({
      url: "http://[::1]:5174/",
      allowedOrigin: "http://[::1]:5174",
      acceptsLocalCertificate: false,
    });
  });

  it("refuses to open a listener the current observation does not classify", async () => {
    const { service } = build({ observed: [viteListener] });
    const result = await execute(
      service,
      command({
        kind: "open-local-server",
        listenerId: "lsn_ffffffffffffffffffffffffffffffff" as LocalServerListenerId,
      } as Partial<LocalServerCommand>),
    );
    expect(result).toMatchObject({
      kind: "local-server-rejected",
      failure: { category: "not-found" },
    });
  });
});

describe("LocalServerService stop", () => {
  it("stops an Octant-owned server without leftover confirmation", async () => {
    const { service, stop } = build({
      observed: [viteListener],
      scope: scope({ ownedPids: new Set([viteListener.pid]) }),
    });
    const result = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId: deriveListenerId(threadId, viteListener),
      } as Partial<LocalServerCommand>),
    );

    expect(result.kind).toBe("local-server-stopped");
    expect(stop).toHaveBeenCalledWith({ pid: 4213 });
  });

  it("requires confirmation naming process, cwd, and port for a leftover", async () => {
    const { service, stop } = build({ observed: [leftoverListener] });
    const listenerId = deriveListenerId(threadId, leftoverListener);
    const unconfirmed = await execute(
      service,
      command({ kind: "stop-local-server", listenerId } as Partial<LocalServerCommand>),
    );
    expect(unconfirmed).toMatchObject({
      kind: "local-server-rejected",
      failure: { category: "confirmation-required" },
    });
    expect(stop).not.toHaveBeenCalled();

    const wrong = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId,
        confirmation: { acknowledgedProcessName: "node", acknowledgedPort: 9999 },
      } as Partial<LocalServerCommand>),
    );
    expect(wrong).toMatchObject({ failure: { category: "confirmation-required" } });
    expect(stop).not.toHaveBeenCalled();

    const confirmed = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId,
        confirmation: {
          acknowledgedProcessName: "node",
          acknowledgedPort: 3000,
          acknowledgedWorkingDirectory: "/Users/example/code/other-app",
        },
      } as Partial<LocalServerCommand>),
    );
    expect(confirmed.kind).toBe("local-server-stopped");
    expect(stop).toHaveBeenCalledWith({ pid: 9001 });
  });

  it("needs a fresh approval for an agent leftover stop even under full access", async () => {
    const { service, stop } = build({ observed: [leftoverListener] });
    const result = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId: deriveListenerId(threadId, leftoverListener),
        confirmation: { acknowledgedProcessName: "node", acknowledgedPort: 3000 },
      } as Partial<LocalServerCommand>),
      { actor: "agent" },
    );
    expect(result).toMatchObject({ failure: { category: "confirmation-required" } });
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects a remote leftover stop before any process lookup", async () => {
    const { service, stop } = build({ observed: [leftoverListener] });
    const result = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId: deriveListenerId(threadId, leftoverListener),
      } as Partial<LocalServerCommand>),
      { actor: "remote-client" },
    );
    expect(result).toMatchObject({ failure: { category: "local-host-required" } });
    expect(stop).not.toHaveBeenCalled();
  });

  it("denies every stop from a Plan thread", async () => {
    const { service, stop } = build({
      observed: [viteListener],
      scope: scope({ posture: "plan", ownedPids: new Set([viteListener.pid]) }),
    });
    const result = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId: deriveListenerId(threadId, viteListener),
      } as Partial<LocalServerCommand>),
    );
    expect(result).toMatchObject({ failure: { category: "unauthorized" } });
    expect(stop).not.toHaveBeenCalled();
  });

  it("re-observes before signalling and refuses when the port changed hands", async () => {
    let call = 0;
    const stop = vi.fn(async () => "stopped" as const);
    const service = new LocalServerService({
      listeners: {
        observe: async () => {
          call += 1;
          return { status: "observed", listeners: call === 1 ? [viteListener] : [] };
        },
      },
      scopes: { resolve: async () => scope({ ownedPids: new Set([viteListener.pid]) }) },
      health: { probe: async () => ({ scheme: "http", host: "127.0.0.1", health: "listening" }) },
      stopPort: { stop },
      clock: () => "2026-08-14T08:00:00.000Z",
    });
    const result = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId: deriveListenerId(threadId, viteListener),
      } as Partial<LocalServerCommand>),
    );
    expect(result).toMatchObject({ failure: { category: "not-found" } });
    expect(stop).not.toHaveBeenCalled();
  });

  it("signals nothing when the host cannot re-observe before stopping", async () => {
    let call = 0;
    const stop = vi.fn(async () => "stopped" as const);
    const service = new LocalServerService({
      listeners: {
        observe: async () => {
          call += 1;
          return call === 1
            ? { status: "observed" as const, listeners: [viteListener] }
            : { status: "unavailable" as const };
        },
      },
      scopes: { resolve: async () => scope({ ownedPids: new Set([viteListener.pid]) }) },
      health: { probe: async () => ({ scheme: "http", host: "127.0.0.1", health: "listening" }) },
      stopPort: { stop },
      clock: () => "2026-08-14T08:00:00.000Z",
    });
    const result = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId: deriveListenerId(threadId, viteListener),
      } as Partial<LocalServerCommand>),
    );
    expect(result).toMatchObject({ failure: { category: "unavailable" } });
    expect(stop).not.toHaveBeenCalled();
  });

  it("reports a failed stop explicitly instead of retrying destructively", async () => {
    const { service, stop } = build({
      observed: [viteListener],
      scope: scope({ ownedPids: new Set([viteListener.pid]) }),
      stop: async () => "failed" as const,
    });
    const result = await execute(
      service,
      command({
        kind: "stop-local-server",
        listenerId: deriveListenerId(threadId, viteListener),
      } as Partial<LocalServerCommand>),
    );
    expect(result).toMatchObject({ failure: { category: "unavailable" } });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("rejects every command when the thread is not a bound Code thread", async () => {
    const service = new LocalServerService({
      listeners: { observe: async () => ({ status: "observed", listeners: [] }) },
      scopes: { resolve: async () => undefined },
      health: { probe: async () => ({ scheme: "http", host: "127.0.0.1", health: "listening" }) },
      stopPort: { stop: async () => "stopped" },
    });
    const result = await execute(service, command());
    expect(result).toMatchObject({
      kind: "local-server-rejected",
      failure: { category: "not-found" },
    });
  });
});
