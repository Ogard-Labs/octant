import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { decodeWindowId, ToolEgressRuleId, type AggregateId } from "@octant/contracts";
import {
  RUNTIME_NETWORK_AGGREGATE,
  type RuntimeNetworkRuntime,
  RUNTIME_NETWORK_EVENT_NAMES,
  SAFE_NETWORKS_AGGREGATE,
  SAFE_NETWORKS_EVENT_NAMES,
} from "@octant/contracts/safe-networks";
import type { ToolEgressRule } from "@octant/domain/tool-egress-policy";
import {
  basicAuthorization,
  openTunnel,
  roundTrip,
  tcpFixture,
  waitFor,
} from "../harness/nativeHarnessEgressProxy.test-support";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { makeProcessConfinementLive } from "../process/seatbeltProfile";
import type { EgressProxyEndpoint } from "../process/threadEgressPolicy";
import { prepareCodexLaunch } from "../providers/codexProcess";
import { resolveRuntimeProject } from "../wiring/runtimeNetwork";
import {
  ProviderRuntimeNetwork,
  type ProviderRuntimeNetworkStart,
  type RuntimeNetworkReviewer,
} from "./providerRuntimeNetwork";
import { createSafeNetworkRouteHandler } from "./safeNetworkRoutes";
import { SafeNetworkStore } from "./safeNetworkStore";

/*
 * Hostile cases for a provider runtime's network: what its own egress proxy
 * lets through and refuses, what a person's safe networks change, and what
 * the journal keeps. Nothing leaves this machine: names resolve through an
 * injected resolver to public addresses (93.184.216.0/24) that an injected
 * dialer routes to loopback fixtures, and loopback places reach loopback
 * fixtures directly.
 */

const directories: string[] = [];
const releases: Array<() => Promise<void>> = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(releases.splice(0).map((release) => release()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const projectId = "8a3f6d4e-1c2b-4a5d-9e8f-7a6b5c4d3e2f";
const otherProjectId = "9b4f6d4e-1c2b-4a5d-9e8f-7a6b5c4d3e2f";
const decodeRuleId = Schema.decodeUnknownSync(ToolEgressRuleId);

function openJournal(directory: string) {
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-31T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date().toISOString(),
  });
}

interface HostOptions {
  readonly reviewer?: RuntimeNetworkReviewer;
  readonly enforced?: boolean;
  /** The Network limits switch: on unless a test says otherwise; `"store"` reads the journaled switch. */
  readonly limitsOn?: boolean | "store";
  readonly projectRules?: ReadonlyArray<ToolEgressRule>;
  readonly routes?: ReadonlyMap<string, number>;
  readonly resolve?: (host: string) => ReadonlyArray<string>;
  readonly directory?: string;
  readonly socketDirectory?: string;
  readonly openRuntimes?: ReadonlySet<RuntimeNetworkRuntime>;
}

function runtimeHost(options: HostOptions = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "octant-runtime-network-"));
  if (options.directory === undefined) directories.push(directory);
  const journal = openJournal(directory);
  const store = new SafeNetworkStore({
    journal,
    projectExists: (id) => id === projectId || id === otherProjectId,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  store.load();
  const rechecks = new Set<{ recheck(): void }>();
  const dialed: Array<{ address: string; port: number }> = [];
  const routes = options.routes ?? new Map<string, number>();
  const network = new ProviderRuntimeNetwork({
    journal,
    safeNetworks:
      options.limitsOn === "store"
        ? store
        : {
            placesFor: (project) => store.placesFor(project),
            onChanged: (listener) => store.onChanged(listener),
            limitsOn: () => options.limitsOn !== false,
          },
    projectRules: () => options.projectRules ?? [],
    joinRecheck: (proxy) => {
      rechecks.add(proxy);
      return () => rechecks.delete(proxy);
    },
    resolveProject: (root) =>
      root === "/projects/app"
        ? projectId
        : root === "/projects/other"
          ? otherProjectId
          : undefined,
    enforced: options.enforced ?? true,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    ...(options.socketDirectory === undefined ? {} : { socketDirectory: options.socketDirectory }),
    ...(options.openRuntimes === undefined ? {} : { openRuntimes: options.openRuntimes }),
    // An address resolves to itself, as the system lookup answers it.
    resolveAll: async (host) =>
      isIP(host) !== 0
        ? [host]
        : (options.resolve?.(host) ?? (host === "localhost" ? ["127.0.0.1"] : ["93.184.216.10"])),
    connect: ({ address, port }) => {
      dialed.push({ address, port });
      const routed = routes.get(address);
      if (routed !== undefined)
        return netConnect({ host: "127.0.0.1", port: routed, allowHalfOpen: true });
      if (address === "127.0.0.1")
        return netConnect({ host: "127.0.0.1", port, allowHalfOpen: true });
      throw new Error(`no fixture routed for ${address}`);
    },
    hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  network.load();
  const events = (aggregateType: string) =>
    journal.replayAggregateType({ aggregateType, afterSequence: 0, limit: 1_000 });
  return { directory, journal, store, network, dialed, events };
}

async function started(
  start: Promise<ProviderRuntimeNetworkStart>,
): Promise<Extract<ProviderRuntimeNetworkStart, { readonly status: "proxied" }>> {
  const result = await start;
  if (result.status !== "proxied")
    throw new Error(`expected a proxied launch, got ${result.status}`);
  releases.push(result.release);
  return result;
}

function tokenOf(environment: Readonly<Record<string, string>>): string {
  const url = new URL(environment.HTTPS_PROXY ?? "");
  return url.password;
}

function proxyOf(endpoint: EgressProxyEndpoint) {
  if (endpoint.kind !== "loopback") throw new Error("Expected a loopback listener.");
  return {
    endpoint: { kind: "loopback" as const, host: "127.0.0.1" as const, port: endpoint.port },
  };
}

describe("provider runtime network", () => {
  it("lets a runtime reach its provider's own endpoint and refuses an unlisted host with the host named, journaling both", async () => {
    const origin = await tcpFixture();
    const host = runtimeHost({ routes: new Map([["93.184.216.10", origin.port]]) });
    const launch = await started(
      host.network.start({
        runtime: "codex",
        root: "/projects/app",
        executionPolicy: "approval-gated",
      }),
    );
    const authorization = basicAuthorization(tokenOf(launch.environment));
    const allowed = await openTunnel(proxyOf(launch.endpoint), "api.openai.com:443", authorization);
    expect(allowed.status).toBe(200);
    expect(await roundTrip(allowed.socket, "ping", 4)).toBe("ping");
    allowed.socket.end();
    const refused = await openTunnel(
      proxyOf(launch.endpoint),
      "registry.npmjs.org:443",
      authorization,
    );
    expect(refused.status).toBe(403);
    expect(refused.answer).toContain("octant-egress-refused: no-rule registry.npmjs.org:443");
    await launch.release();

    const names = host.events(RUNTIME_NETWORK_AGGREGATE).map((event) => event.eventName);
    expect(names[0]).toBe(RUNTIME_NETWORK_EVENT_NAMES.launchStarted);
    expect(names.at(-1)).toBe(RUNTIME_NETWORK_EVENT_NAMES.launchSummarized);
    const [startedEvent] = host.events(RUNTIME_NETWORK_AGGREGATE);
    expect(startedEvent?.payload).toMatchObject({
      launch: { runtime: "codex", projectId, executionPolicy: "approval-gated" },
    });
    const summary = host
      .events(RUNTIME_NETWORK_AGGREGATE)
      .find((event) => event.eventName === RUNTIME_NETWORK_EVENT_NAMES.launchSummarized);
    expect(summary?.payload).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ host: "api.openai.com", decision: "allowed" }),
        expect.objectContaining({
          host: "registry.npmjs.org",
          decision: "refused",
          reason: "no-rule",
        }),
      ]),
    });
    expect(host.network.refusals(projectId)).toEqual([
      expect.objectContaining({
        host: "registry.npmjs.org",
        port: 443,
        runtime: "codex",
        requests: 1,
      }),
    ]);
  });

  it("leaves every runtime on open network while Network limits are off, the default", async () => {
    const host = runtimeHost({ limitsOn: "store" });
    expect(host.store.limitsOn()).toBe(false);
    for (const runtime of ["codex", "opencode", "acp", "pi", "claude-sandbox"] as const) {
      expect(
        await host.network.start({
          runtime,
          root: "/projects/app",
          executionPolicy: "approval-gated",
        }),
      ).toEqual({ status: "open" });
    }
    expect(host.events(RUNTIME_NETWORK_AGGREGATE)).toEqual([]);
  });

  it("puts runtimes launched after Network limits are turned on behind the proxy, and journals the switch", async () => {
    const host = runtimeHost({ limitsOn: "store" });
    expect(host.store.setLimits({ enabled: true, principal: "remote-device" })).toEqual({
      kind: "refused",
      reason: "needs-local-window",
    });
    expect(host.store.limitsOn()).toBe(false);
    expect(host.store.setLimits({ enabled: true, principal: "local-window" })).toEqual({
      kind: "changed",
    });
    const launch = await started(
      host.network.start({
        runtime: "codex",
        root: "/projects/app",
        executionPolicy: "approval-gated",
      }),
    );
    expect(launch.status).toBe("proxied");
    expect(host.events(SAFE_NETWORKS_AGGREGATE).map((event) => event.eventName)).toEqual([
      "safe-networks.limits-set@1",
    ]);
  });

  it("replays the Network limits switch at startup", async () => {
    const first = runtimeHost({ limitsOn: "store" });
    first.store.setLimits({ enabled: true, principal: "local-window" });
    const restarted = runtimeHost({ directory: first.directory, limitsOn: "store" });
    expect(restarted.store.limitsOn()).toBe(true);
    restarted.store.setLimits({ enabled: false, principal: "local-window" });
    const again = runtimeHost({ directory: first.directory, limitsOn: "store" });
    expect(again.store.limitsOn()).toBe(false);
  });

  it("refuses a request without the launch token, and names no host for it", async () => {
    const host = runtimeHost();
    const launch = await started(
      host.network.start({
        runtime: "pi",
        root: "/projects/app",
        executionPolicy: "auto-accept-edits",
      }),
    );
    const refused = await openTunnel(proxyOf(launch.endpoint), "api.openai.com:443", undefined);
    expect(refused.status).toBe(407);
    const stolen = await openTunnel(
      proxyOf(launch.endpoint),
      "api.openai.com:443",
      basicAuthorization("0".repeat(64)),
    );
    expect(stolen.status).toBe(407);
  });

  it("leaves Full access, and a host that does not route runtimes, on open network", async () => {
    const host = runtimeHost();
    expect(
      await host.network.start({
        runtime: "codex",
        root: "/projects/app",
        executionPolicy: "full-access",
      }),
    ).toEqual({ status: "open" });
    const unrouted = runtimeHost({ enforced: false });
    expect(
      await unrouted.network.start({
        runtime: "acp",
        profileId: "gemini",
        root: "/projects/app",
        executionPolicy: "plan",
      }),
    ).toEqual({ status: "open" });
    expect(host.events(RUNTIME_NETWORK_AGGREGATE)).toEqual([]);
  });

  it("gives a Linux capsule launch a socket of its own, a loopback launch a port, and leaves an open runtime alone", async () => {
    // A Unix socket path has a short limit, and macOS's own temporary folder is long.
    const sockets = mkdtempSync("/tmp/octant-runtime-sockets-");
    directories.push(sockets);
    const host = runtimeHost({ socketDirectory: sockets, openRuntimes: new Set(["opencode"]) });
    const capsule = await started(
      host.network.start({ runtime: "codex", root: "/projects/app", executionPolicy: "plan" }),
    );
    expect(capsule.endpoint).toMatchObject({ kind: "unix-socket" });
    expect(capsule.endpoint.kind === "unix-socket" && capsule.endpoint.path).toMatch(
      new RegExp(`^${sockets}/egress-[^/]+/proxy\\.sock$`),
    );
    // The capsule's forwarder listens on its fixed port; the variables name it.
    expect(new URL(capsule.environment.HTTPS_PROXY ?? "").port).toBe("3128");
    const loopback = await started(
      host.network.start({
        runtime: "claude",
        root: "/projects/app",
        executionPolicy: "approval-gated",
        listener: "loopback",
      }),
    );
    expect(loopback.endpoint).toMatchObject({ kind: "loopback", port: expect.any(Number) });
    expect(
      await host.network.start({
        runtime: "opencode",
        root: "/projects/app",
        executionPolicy: "approval-gated",
      }),
    ).toEqual({ status: "open" });
  });

  it("lets a host the Project's egress rules allow through, and only for that Project's runtimes", async () => {
    const origin = await tcpFixture();
    const projectRules: ReadonlyArray<ToolEgressRule> = [
      {
        id: decodeRuleId("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"),
        scope: { kind: "project", projectId: projectId as AggregateId },
        host: "registry.npmjs.org",
        port: 443,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ];
    const host = runtimeHost({ projectRules, routes: new Map([["93.184.216.10", origin.port]]) });
    const inProject = await started(
      host.network.start({
        runtime: "opencode",
        root: "/projects/app",
        executionPolicy: "approval-gated",
      }),
    );
    const passed = await openTunnel(
      proxyOf(inProject.endpoint),
      "registry.npmjs.org:443",
      basicAuthorization(tokenOf(inProject.environment)),
    );
    expect(passed.status).toBe(200);
    passed.socket.end();
    const elsewhere = await started(
      host.network.start({
        runtime: "opencode",
        root: "/projects/other",
        executionPolicy: "approval-gated",
      }),
    );
    const refused = await openTunnel(
      proxyOf(elsewhere.endpoint),
      "registry.npmjs.org:443",
      basicAuthorization(tokenOf(elsewhere.environment)),
    );
    expect(refused.status).toBe(403);
  });

  it("lets a trusted place through by rule, uses a Project's own list over the default, and closes an open tunnel when the place is taken away", async () => {
    const origin = await tcpFixture();
    const host = runtimeHost({ routes: new Map([["93.184.216.10", origin.port]]) });
    expect(
      host.store.set({
        scope: { kind: "account" },
        places: [{ kind: "domain", domain: "corp.example" }],
        principal: "local-window",
      }),
    ).toEqual({ kind: "changed" });
    const launch = await started(
      host.network.start({
        runtime: "acp",
        profileId: "mistral-vibe",
        root: "/projects/app",
        executionPolicy: "approval-gated",
      }),
    );
    const authorization = basicAuthorization(tokenOf(launch.environment));
    const tunnel = await openTunnel(
      proxyOf(launch.endpoint),
      "git.corp.example:443",
      authorization,
    );
    expect(tunnel.status).toBe(200);
    expect(await roundTrip(tunnel.socket, "ping", 4)).toBe("ping");

    // The Project's own list replaces the default: the open tunnel closes at once.
    expect(
      host.store.set({
        scope: { kind: "project", projectId: projectId as AggregateId },
        places: [{ kind: "host", host: "wiki.example.org" }],
        principal: "local-window",
      }),
    ).toEqual({ kind: "changed" });
    await waitFor(() => tunnel.socket.destroyed || tunnel.socket.readableEnded);
    const now = await openTunnel(proxyOf(launch.endpoint), "git.corp.example:443", authorization);
    expect(now.status).toBe(403);
    const project = await openTunnel(
      proxyOf(launch.endpoint),
      "wiki.example.org:443",
      authorization,
    );
    expect(project.status).toBe(200);
    project.socket.end();

    expect(host.store.clearProject({ projectId, principal: "local-window" })).toEqual({
      kind: "changed",
    });
    const back = await openTunnel(proxyOf(launch.endpoint), "git.corp.example:443", authorization);
    expect(back.status).toBe(200);
    back.socket.end();
  });

  it("reaches a loopback service only at a trusted this-mac port, never a private answer for an untrusted name, and never link-local", async () => {
    const trusted = await tcpFixture();
    const untrusted = await tcpFixture();
    const host = runtimeHost({
      resolve: (name) =>
        name === "metadata.provider.example" ? ["169.254.169.254"] : ["10.0.0.9"],
    });
    host.store.set({
      scope: { kind: "account" },
      places: [{ kind: "private-network", tag: "this-mac", port: trusted.port }],
      principal: "local-window",
    });
    const launch = await started(
      host.network.start({ runtime: "pi", root: "/elsewhere", executionPolicy: "approval-gated" }),
    );
    const authorization = basicAuthorization(tokenOf(launch.environment));
    const allowed = await openTunnel(
      proxyOf(launch.endpoint),
      `127.0.0.1:${String(trusted.port)}`,
      authorization,
    );
    expect(allowed.status).toBe(200);
    expect(await roundTrip(allowed.socket, "ping", 4)).toBe("ping");
    allowed.socket.end();
    for (const [target, reason] of [
      [`127.0.0.1:${String(untrusted.port)}`, "ip-literal"],
      ["169.254.169.254:80", "ip-literal"],
      // A provider name that resolves privately is not a trusted place.
      ["api.openai.com:443", "private-destination"],
      ["metadata.provider.example:443", "no-rule"],
    ] as const) {
      const refused = await openTunnel(proxyOf(launch.endpoint), target, authorization);
      expect(refused.status).toBe(403);
      expect(refused.answer).toContain(`octant-egress-refused: ${reason}`);
    }
    expect(untrusted.connections()).toBe(0);
  });

  it("closes an open tunnel to a private address once the person stops trusting that network", async () => {
    const origin = await tcpFixture();
    const host = runtimeHost({
      resolve: () => ["10.0.0.9"],
      routes: new Map([["10.0.0.9", origin.port]]),
    });
    host.store.set({
      scope: { kind: "account" },
      places: [{ kind: "private-network", tag: "local-network" }],
      principal: "local-window",
    });
    const launch = await started(
      host.network.start({
        runtime: "codex",
        root: "/projects/app",
        executionPolicy: "approval-gated",
      }),
    );
    const authorization = basicAuthorization(tokenOf(launch.environment));
    // The provider's own name, answered by an address on the trusted local network.
    const tunnel = await openTunnel(proxyOf(launch.endpoint), "api.openai.com:443", authorization);
    expect(tunnel.status).toBe(200);
    expect(await roundTrip(tunnel.socket, "ping", 4)).toBe("ping");

    expect(
      host.store.set({ scope: { kind: "account" }, places: [], principal: "local-window" }),
    ).toEqual({ kind: "changed" });
    await waitFor(() => tunnel.socket.destroyed || tunnel.socket.readableEnded);
    const again = await openTunnel(proxyOf(launch.endpoint), "api.openai.com:443", authorization);
    expect(again.status).toBe(403);
    expect(again.answer).toContain("octant-egress-refused: private-destination");
    await launch.release();
    const summary = host
      .events(RUNTIME_NETWORK_AGGREGATE)
      .find((event) => event.eventName === RUNTIME_NETWORK_EVENT_NAMES.launchSummarized);
    expect(summary?.payload).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          host: "api.openai.com",
          decision: "refused",
          reason: "private-destination",
        }),
      ]),
    });
  });

  it("lets the launch's own tool bridge port through on loopback and no other", async () => {
    const bridge = await tcpFixture();
    const other = await tcpFixture();
    const host = runtimeHost();
    const launch = await started(
      host.network.start({
        runtime: "acp",
        profileId: "gemini",
        root: "/projects/app",
        executionPolicy: "approval-gated",
        loopbackPorts: [bridge.port],
      }),
    );
    const authorization = basicAuthorization(tokenOf(launch.environment));
    const passed = await openTunnel(
      proxyOf(launch.endpoint),
      `127.0.0.1:${String(bridge.port)}`,
      authorization,
    );
    expect(passed.status).toBe(200);
    passed.socket.end();
    const refused = await openTunnel(
      proxyOf(launch.endpoint),
      `127.0.0.1:${String(other.port)}`,
      authorization,
    );
    expect(refused.status).toBe(403);
    expect(other.connections()).toBe(0);
  });

  it("asks the reviewer about an unlisted host only at Auto, journals its allowance, and keeps the refusal when it asks", async () => {
    const origin = await tcpFixture();
    const asked: string[] = [];
    const reviewer: RuntimeNetworkReviewer = {
      review: async (request) => {
        asked.push(request.host);
        return request.host === "pypi.org"
          ? {
              answer: "allow",
              reviewer: "octant-shield",
              reason: "Package index for the install the person asked for.",
            }
          : { answer: "ask" };
      },
    };
    const host = runtimeHost({ reviewer, routes: new Map([["93.184.216.10", origin.port]]) });
    const askFirst = await started(
      host.network.start({
        runtime: "claude-sandbox",
        root: "/projects/app",
        executionPolicy: "approval-gated",
        authentication: "none",
      }),
    );
    expect(askFirst.environment).toEqual({});
    expect((await openTunnel(proxyOf(askFirst.endpoint), "pypi.org:443", undefined)).status).toBe(
      403,
    );
    expect(asked).toEqual([]);

    const auto = await started(
      host.network.start({
        runtime: "claude-sandbox",
        root: "/projects/app",
        executionPolicy: "approval-gated",
        autoReview: true,
        authentication: "none",
      }),
    );
    const passed = await openTunnel(proxyOf(auto.endpoint), "pypi.org:443", undefined);
    expect(passed.status).toBe(200);
    passed.socket.end();
    const refused = await openTunnel(proxyOf(auto.endpoint), "evil.example:443", undefined);
    expect(refused.status).toBe(403);
    expect(asked).toEqual(["pypi.org", "evil.example"]);
    expect(
      host
        .events(RUNTIME_NETWORK_AGGREGATE)
        .filter((event) => event.eventName === RUNTIME_NETWORK_EVENT_NAMES.reviewerAllowed)
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ host: "pypi.org", port: 443, reviewer: "octant-shield" }),
    ]);
    // The allowance is the launch's own: another launch is asked afresh.
    const another = await started(
      host.network.start({
        runtime: "claude-sandbox",
        root: "/projects/app",
        executionPolicy: "approval-gated",
        autoReview: true,
        authentication: "none",
      }),
    );
    expect((await openTunnel(proxyOf(another.endpoint), "pypi.org:443", undefined)).status).toBe(
      200,
    );
    expect(asked).toEqual(["pypi.org", "evil.example", "pypi.org"]);
  });

  it("rebuilds the safe networks and the recent refusals from the journal after a restart", async () => {
    const first = runtimeHost();
    first.store.set({
      scope: { kind: "account" },
      places: [{ kind: "range", range: "192.168.1.77/24" }],
      principal: "local-window",
    });
    first.store.set({
      scope: { kind: "project", projectId: projectId as AggregateId },
      places: [{ kind: "host", host: "NAS.Example.com" }],
      principal: "local-window",
    });
    const launch = await started(
      first.network.start({ runtime: "codex", root: "/projects/app", executionPolicy: "plan" }),
    );
    await openTunnel(
      proxyOf(launch.endpoint),
      "registry.npmjs.org:443",
      basicAuthorization(tokenOf(launch.environment)),
    );
    await launch.release();

    const restarted = runtimeHost({ directory: first.directory });
    expect(restarted.store.account()).toEqual([{ kind: "range", range: "192.168.1.0/24" }]);
    expect(restarted.store.projectOverride(projectId)).toEqual([
      { kind: "host", host: "nas.example.com" },
    ]);
    expect(restarted.store.placesFor(otherProjectId)).toEqual([
      { kind: "range", range: "192.168.1.0/24" },
    ]);
    expect(restarted.network.refusals(projectId)).toEqual([
      expect.objectContaining({ host: "registry.npmjs.org", requests: 1, runtime: "codex" }),
    ]);
    expect(restarted.events(SAFE_NETWORKS_AGGREGATE).map((event) => event.eventName)).toEqual([
      SAFE_NETWORKS_EVENT_NAMES.placesSet,
      SAFE_NETWORKS_EVENT_NAMES.placesSet,
    ]);
  });

  it("refuses a change from a paired device, a place that is not one, and a range that reaches link-local, and journals none of them", () => {
    const host = runtimeHost();
    expect(
      host.store.set({
        scope: { kind: "account" },
        places: [{ kind: "host", host: "a.example" }],
        principal: "remote-device",
      }),
    ).toEqual({ kind: "refused", reason: "needs-local-window" });
    expect(
      host.store.set({
        scope: { kind: "account" },
        places: [
          { kind: "host", host: "ok.example" },
          { kind: "host", host: "localhost" },
        ],
        principal: "local-window",
      }),
    ).toEqual({ kind: "refused", reason: "invalid-place", placeIndex: 1 });
    expect(
      host.store.set({
        scope: { kind: "account" },
        places: [{ kind: "range", range: "169.254.0.0/16" }],
        principal: "local-window",
      }),
    ).toEqual({ kind: "refused", reason: "covers-link-local", placeIndex: 0 });
    expect(
      host.store.set({
        scope: {
          kind: "project",
          projectId: "00000000-0000-4000-8000-00000000dead" as AggregateId,
        },
        places: [],
        principal: "local-window",
      }),
    ).toEqual({ kind: "refused", reason: "project-not-found" });
    expect(host.events(SAFE_NETWORKS_AGGREGATE)).toEqual([]);
  });

  it("serves the Safe networks view and refuses a paired device's change over the route", async () => {
    const host = runtimeHost();
    const windowId = decodeWindowId("00000000-0000-4000-8000-000000000468");
    const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const windows = new WindowAuthorityStore();
    windows.register({ windowId, capability, now: 0 });
    const handler = createSafeNetworkRouteHandler({
      windowAuthorityStore: windows,
      store: host.store,
      network: host.network,
      projectExists: (id) => id === projectId,
      now: () => 1,
    });
    const url = "http://127.0.0.1/api/access/safe-networks";
    const body = JSON.stringify({
      kind: "set-places",
      scope: { kind: "account" },
      places: [{ kind: "private-network", tag: "local-network" }],
    });
    expect((await handler(new Request(url)))?.status).toBe(401);
    const remote = new Request(url, { method: "POST", body });
    bindPrincipalRouteContext(remote, {
      principal: {
        kind: "remote-device",
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      } as never,
      scopeId: windowId,
    });
    const refused = await handler(remote);
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toMatchObject({ reason: "needs-local-window" });
    const local = await handler(
      new Request(url, {
        method: "POST",
        body,
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(local?.status).toBe(200);
    expect(await local?.json()).toMatchObject({
      kind: "safe-networks-updated",
      view: {
        account: [{ kind: "private-network", tag: "local-network" }],
        enforced: true,
        limitsOn: false,
      },
    });
    const read = await handler(
      new Request(`${url}?projectId=${projectId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(await read?.json()).toMatchObject({ view: { project: { projectId, override: null } } });
    const missing = await handler(
      new Request(`${url}?projectId=${otherProjectId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(missing?.status).toBe(404);
    const limits = await handler(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ kind: "set-limits", enabled: true }),
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(limits?.status).toBe(200);
    expect(await limits?.json()).toMatchObject({
      kind: "safe-networks-updated",
      view: { limitsOn: true },
    });
  });
});

describe("runtime Project resolution", () => {
  it("gives a managed worktree its own thread's Project and a bound folder the innermost Project that holds it", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-runtime-project-")));
    directories.push(base);
    const outer = join(base, "repo");
    const inner = join(outer, "packages", "app");
    const worktree = join(
      base,
      ".octant-worktrees",
      "repo-id",
      "00000000-0000-4000-8000-0000000000c1",
    );
    for (const folder of [inner, worktree]) mkdirSync(folder, { recursive: true });
    const project = (id: string, root: string) =>
      ({ id, type: "code", lifecycle: "active", binding: { canonicalRoot: root } }) as never;
    const persistence = {
      readProjects: () => [project(projectId, outer), project(otherProjectId, inner)],
      readCodeThread: (threadId: unknown) =>
        String(threadId) === "00000000-0000-4000-8000-0000000000c1"
          ? ({ projectId: otherProjectId } as never)
          : undefined,
    };
    expect(resolveRuntimeProject(persistence, outer)).toBe(projectId);
    expect(resolveRuntimeProject(persistence, join(outer, "packages"))).toBe(projectId);
    expect(resolveRuntimeProject(persistence, inner)).toBe(otherProjectId);
    expect(resolveRuntimeProject(persistence, worktree)).toBe(otherProjectId);
    expect(resolveRuntimeProject(persistence, `${outer}-sibling`)).toBeUndefined();
    expect(resolveRuntimeProject(persistence, "/")).toBeUndefined();
  });
});

// Real `sandbox-exec` around a Codex-shaped launch: the app-server's own
// profile is what a command it runs can reach, so `curl` in its place shows
// what a wrapped runtime reaches. Both servers listen on this machine's
// loopback; nothing leaves it.
describe.skipIf(process.platform !== "darwin")("a wrapped runtime under Seatbelt", () => {
  it("reaches a trusted loopback server through its proxy, is refused an untrusted one, and cannot go around the proxy", async () => {
    const answer = (body: string) =>
      createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(body);
      });
    const trusted = answer("TRUSTED-ORIGIN");
    const other = answer("OTHER-ORIGIN");
    for (const server of [trusted, other]) {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    }
    const portOf = (server: HttpServer) => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : 0;
    };
    const planted = mkdtempSync(join(homedir(), ".octant-runtime-network-"));
    directories.push(planted);
    try {
      const root = join(planted, "project");
      const codexHome = join(planted, "codex-home");
      mkdirSync(root);
      mkdirSync(codexHome, { mode: 0o700 });
      const host = runtimeHost();
      host.store.set({
        scope: { kind: "account" },
        places: [{ kind: "private-network", tag: "this-mac", port: portOf(trusted) }],
        principal: "local-window",
      });
      const network = await started(
        host.network.start({ runtime: "codex", root, executionPolicy: "approval-gated" }),
      );
      const curl = "/usr/bin/curl -s -m 5";
      const script = [
        `${curl} http://127.0.0.1:${String(portOf(trusted))}/; echo " trusted-exit=$?"`,
        `${curl} -o /dev/null -w 'other-status=%{http_code}' http://127.0.0.1:${String(portOf(other))}/; echo " other-exit=$?"`,
        `${curl} --noproxy '*' http://127.0.0.1:${String(portOf(trusted))}/; echo " direct-exit=$?"`,
        `${curl} -o /dev/null -w 'name-status=%{http_connect}' https://unlisted.example/; echo " name-exit=$?"`,
      ].join("; ");
      const prepared = prepareCodexLaunch({
        binaryPath: "/bin/sh",
        args: ["-c", script],
        authority: { kind: "thread", root, mode: "code", executionPolicy: "approval-gated" },
        environment: { HOME: homedir(), PATH: "/usr/bin:/bin", CODEX_HOME: codexHome },
        confinement: makeProcessConfinementLive(),
        platform: "darwin",
        network: { endpoint: network.endpoint, environment: network.environment },
      });
      if (prepared.status === "refused") throw new Error(prepared.failure.message);
      let output: string;
      try {
        const result = await new Promise<string>((resolve) => {
          execFile(
            prepared.launch.command,
            [...prepared.launch.args],
            { cwd: prepared.launch.cwd, env: prepared.launch.environment, timeout: 30_000 },
            (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
          );
        });
        output = result;
      } finally {
        prepared.launch.release();
      }
      expect(output).toContain("TRUSTED-ORIGIN trusted-exit=0");
      expect(output).toContain("other-status=403");
      expect(output).not.toContain("OTHER-ORIGIN");
      expect(output).not.toMatch(/TRUSTED-ORIGIN direct-exit/);
      expect(output).toMatch(/direct-exit=[1-9]/);
      expect(output).toContain("name-status=403");
      await network.release();
      const summary = host
        .events(RUNTIME_NETWORK_AGGREGATE)
        .find((event) => event.eventName === RUNTIME_NETWORK_EVENT_NAMES.launchSummarized);
      expect(summary?.payload).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({
            host: "127.0.0.1",
            port: portOf(trusted),
            decision: "allowed",
          }),
          expect.objectContaining({
            host: "127.0.0.1",
            port: portOf(other),
            decision: "refused",
            reason: "ip-literal",
          }),
          expect.objectContaining({
            host: "unlisted.example",
            decision: "refused",
            reason: "no-rule",
          }),
        ]),
      });
    } finally {
      for (const server of [trusted, other]) server.close();
    }
  });
});

// Real Bubblewrap around a runtime launch: the capsule's private network has
// only loopback, so its forwarder is the one way out. `curl` stands in for
// the runtime. Every server listens on this machine's loopback.
describe.runIf(process.platform === "linux" && existsSync("/usr/bin/bwrap"))(
  "a wrapped runtime under Bubblewrap",
  () => {
    it("reaches a trusted server and its own tool bridge through its proxy, is refused the rest, and cannot go around it", async () => {
      const answer = (body: string) =>
        createHttpServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(body);
        });
      const trusted = answer("TRUSTED-ORIGIN");
      const other = answer("OTHER-ORIGIN");
      const bridge = answer("TOOL-BRIDGE");
      for (const server of [trusted, other, bridge]) {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      }
      const portOf = (server: HttpServer) => {
        const address = server.address();
        return typeof address === "object" && address !== null ? address.port : 0;
      };
      const planted = mkdtempSync("/tmp/octant-runtime-capsule-");
      directories.push(planted);
      try {
        const root = join(planted, "project");
        const work = join(planted, "work");
        const sockets = join(planted, "sockets");
        mkdirSync(root);
        mkdirSync(work, { mode: 0o700 });
        mkdirSync(sockets, { mode: 0o700 });
        const host = runtimeHost({ socketDirectory: sockets });
        host.store.set({
          scope: { kind: "account" },
          places: [{ kind: "private-network", tag: "this-mac", port: portOf(trusted) }],
          principal: "local-window",
        });
        const network = await started(
          host.network.start({
            runtime: "pi",
            root,
            executionPolicy: "approval-gated",
            loopbackPorts: [portOf(bridge)],
          }),
        );
        expect(network.endpoint.kind).toBe("unix-socket");
        const curl = "curl -s -m 5";
        const script = [
          `${curl} http://127.0.0.1:${String(portOf(trusted))}/; echo " trusted-exit=$?"`,
          `${curl} -o /dev/null -w 'other-status=%{http_code}' http://127.0.0.1:${String(portOf(other))}/; echo " other-exit=$?"`,
          `${curl} --noproxy '*' http://127.0.0.1:${String(portOf(bridge))}/; echo " bridge-exit=$?"`,
          `${curl} --noproxy '*' http://127.0.0.1:${String(portOf(trusted))}/; echo " direct-exit=$?"`,
          `${curl} -o /dev/null -w 'name-status=%{http_connect}' https://unlisted.example/; echo " name-exit=$?"`,
        ].join("; ");
        const launch = makeProcessConfinementLive({ platform: "linux" }).prepare({
          executable: "/bin/sh",
          args: ["-c", script],
          boundRoot: root,
          temporaryDirectory: work,
          networkEgress: { kind: "proxied", endpoint: network.endpoint },
          loopbackRelayPorts: [portOf(bridge)],
          allowFileReadStar: true,
        });
        const output = await new Promise<string>((resolve) => {
            execFile(
              launch.command,
              [...launch.args],
              {
                cwd: root,
                env: { PATH: "/usr/bin:/bin", HOME: work, ...network.environment },
                timeout: 30_000,
              },
              (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
            );
        });
        expect(output).toContain("TRUSTED-ORIGIN trusted-exit=0");
        expect(output).toContain("other-status=403");
        expect(output).not.toContain("OTHER-ORIGIN");
        expect(output).toContain("TOOL-BRIDGE bridge-exit=0");
        expect(output).not.toMatch(/TRUSTED-ORIGIN direct-exit/);
        expect(output).toMatch(/direct-exit=[1-9]/);
        expect(output).toContain("name-status=403");
        await network.release();
        const summary = host
          .events(RUNTIME_NETWORK_AGGREGATE)
          .find((event) => event.eventName === RUNTIME_NETWORK_EVENT_NAMES.launchSummarized);
        expect(summary?.payload).toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({ host: "127.0.0.1", port: portOf(trusted), decision: "allowed" }),
            expect.objectContaining({ host: "127.0.0.1", port: portOf(bridge), decision: "allowed" }),
            expect.objectContaining({ host: "127.0.0.1", port: portOf(other), decision: "refused" }),
          ]),
        });
      } finally {
        for (const server of [trusted, other, bridge]) server.close();
      }
    });
  },
);
