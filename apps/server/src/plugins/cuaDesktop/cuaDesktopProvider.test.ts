import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeDesktopCredentialRef,
  decodeDesktopHostTag,
  decodeDesktopLeaseId,
  decodeDesktopPlacementId,
  decodeDesktopProviderId,
  decodeDesktopRecipe,
  decodeEventActor,
  decodeUtcTimestamp,
  type DesktopRecipe,
} from "@octant/contracts";
import {
  decodeComputerControlCommand,
  type ComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import {
  desktopDaemonMethodDeclared,
  type DesktopProvider,
} from "@octant/plugin-api/desktop-provider";
import { runDesktopProviderConformance } from "@octant/plugin-api/desktop-provider-conformance";
import { createDesktopLeaseService } from "../../computerUse/desktopLeaseService";
import { Journal } from "../../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../../persistence/migrations";
import { catchUpProjection } from "../../persistence/projection";
import { createPhase1RuntimeRegistries } from "../../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../../persistence/sqlitePort";
import {
  createCuaDesktopProvider,
  CUA_DESKTOP_DAEMON,
  CUA_DESKTOP_PROVIDER_ID,
  CUA_HOST_LABEL,
  CUA_LEASE_LABEL,
} from "./cuaDesktopProvider";
import {
  mapOf,
  messageOf,
  numberOf,
  RECORDED_LOOPBACK_TOKEN,
  RECORDED_SPACE_TOKEN,
  RecordedCuaDaemon,
  textOf,
  type RecordedCuaHost,
  type RecordedCuaScenario,
} from "./cuaRecordedDaemon.test-support";

const START = Date.parse("2026-10-27T09:00:00.000Z");
const MINUTE = 60_000;
const recipe: DesktopRecipe = decodeDesktopRecipe({
  providerId: "cua",
  placementId: "this-machine",
  screen: { width: 1024, height: 768 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
});
const otherMachineRecipe: DesktopRecipe = decodeDesktopRecipe({
  ...recipe,
  placementId: "other-machine",
});
/** The person's spare machine, set up with `cua host setup --provide-spaces`. */
const SPARE: RecordedCuaHost = { id: "m-7f3a", name: "spare mini", via: "relay", online: true };
const hostTag = decodeDesktopHostTag("c5000000-0000-4000-8000-0000000000aa");
const ELEMENT_CLICK = decodeComputerControlCommand({
  operation: "click",
  observationId: randomUUID(),
  elementIndex: 0,
});
const immediately = async () => undefined;

const daemons: Array<RecordedCuaDaemon> = [];
const directories: Array<string> = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function daemonWith(
  scenario: RecordedCuaScenario = {},
  now: () => number = () => Date.now(),
): Promise<RecordedCuaDaemon> {
  const daemon = await RecordedCuaDaemon.start(scenario, now);
  daemons.push(daemon);
  return daemon;
}

/** The Cua driver over the host's real daemon port, with the recorded daemon behind it. */
function driverOver(daemon: RecordedCuaDaemon, now: () => number = () => Date.now()) {
  return createCuaDesktopProvider(daemon.port(), { now, sleep: immediately, readyPollMs: 1 });
}

async function harness(scenario: RecordedCuaScenario = {}) {
  const clock = { now: START };
  const daemon = await daemonWith(scenario, () => clock.now);
  return { clock, daemon, provider: driverOver(daemon, () => clock.now) };
}

const acquireRequest = (
  minutes = 30,
  signal = new AbortController().signal,
  leaseRecipe: DesktopRecipe = recipe,
) => ({
  leaseId: decodeDesktopLeaseId(randomUUID()),
  hostTag,
  recipe: leaseRecipe,
  expiresAt: decodeUtcTimestamp(new Date(START + minutes * MINUTE).toISOString()),
  signal,
});

async function acquired(provider: DesktopProvider, leaseRecipe: DesktopRecipe = recipe) {
  const request = acquireRequest(30, new AbortController().signal, leaseRecipe);
  const result = await provider.acquire(request);
  if (result.status !== "acquired") throw new Error(`not acquired: ${JSON.stringify(result)}`);
  return { leaseId: request.leaseId, result };
}

const methodsCalled = (daemon: RecordedCuaDaemon) =>
  daemon.calls().map((call) => call.method.replace(/^\/v1\/spaces\/[^/]+\/env\//, "env/"));

const threadId = "c5000000-0000-4000-8000-000000000001";
const person = decodeEventActor({
  kind: "local-user",
  actorId: "c5000000-0000-4000-8000-0000000000b1",
});

/** One host process: the lease service over the journal on disk, with its own Cua driver. */
function hostProcess(
  connection: SqliteConnection,
  provider: DesktopProvider,
  leaseRecipe: DesktopRecipe = recipe,
  asked: Array<string> = [],
) {
  const runtime = createPhase1RuntimeRegistries();
  const clock = () => new Date(START).toISOString();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  for (const projection of runtime.projections.all()) {
    catchUpProjection({ connection, journal, projection, clock });
  }
  return {
    projection: runtime.desktopLeaseProjection,
    service: createDesktopLeaseService({
      journal,
      projection: runtime.desktopLeaseProjection,
      hostTag,
      platform: "linux",
      hasScreen: false,
      providers: () => [{ provider, effective: true }],
      recipe: () => leaseRecipe,
      thread: () => ({ active: true, executionPolicy: "full-access" }),
      callerMayOpen: () => true,
      computerUseEnabled: () => true,
      confirm: async (request) => {
        asked.push(request.asks);
        return "declined";
      },
      threadRoot: async () => undefined,
      confirmTransfer: async () => "declined",
      systemActor: decodeEventActor({
        kind: "system",
        actorId: "c5000000-0000-4000-8000-0000000000b4",
      }),
      now: () => START,
      uuid: randomUUID,
      daemonUserId: process.getuid?.() ?? 0,
      teardownTimeoutMs: 5_000,
    }),
  };
}

describe("Cua desktop provider", () => {
  it("keeps the desktop-provider seam's promises against a recorded Cua daemon on a real socket", async () => {
    // A daemon that declines an extension holds a Space's lifetime below
    // what is asked; one whose Space outlives its delete answers the delete.
    const ordinary = await daemonWith();
    const declining = await daemonWith({ holdsLifetimeMs: 45 * MINUTE });
    const lingering = await daemonWith({ outlivesDelete: true });
    const backends = new WeakMap<DesktopProvider, RecordedCuaDaemon>();
    await expect(
      runDesktopProviderConformance({
        create: (scenario) => {
          const daemon = scenario.providerDeclinesExtension
            ? declining
            : scenario.desktopOutlivesDestroy
              ? lingering
              : ordinary;
          const provider = driverOver(daemon);
          backends.set(provider, daemon);
          return provider;
        },
        // A host killed while a Space ran: a new driver keeps no memory of
        // it and has only the daemon's own listing to go on.
        restarted: (previous) => {
          const daemon = backends.get(previous);
          if (daemon === undefined) throw new Error("no recorded daemon for that driver");
          return driverOver(daemon);
        },
        recipe,
        unsupportedCommand: ELEMENT_CLICK,
      }),
    ).resolves.toEqual({
      stoppedWhenCancelled: true,
      taggedWhatItCreated: true,
      setProviderExpiryWhenBilled: true,
      extendedOnlyWhenConfirmed: true,
      reportedAbsenceOnlyWhenAbsent: true,
      refusedUnsupportedCommand: true,
      foundAfterRestart: true,
    });
  });

  it("keeps the seam's promises for a Space on the person's other machine", async () => {
    const ordinary = await daemonWith({ hosts: [SPARE] });
    const declining = await daemonWith({ hosts: [SPARE], holdsLifetimeMs: 45 * MINUTE });
    const lingering = await daemonWith({ hosts: [SPARE], outlivesDelete: true });
    const backends = new WeakMap<DesktopProvider, RecordedCuaDaemon>();
    await expect(
      runDesktopProviderConformance({
        create: (scenario) => {
          const daemon = scenario.providerDeclinesExtension
            ? declining
            : scenario.desktopOutlivesDestroy
              ? lingering
              : ordinary;
          const provider = driverOver(daemon);
          backends.set(provider, daemon);
          return provider;
        },
        restarted: (previous) => {
          const daemon = backends.get(previous);
          if (daemon === undefined) throw new Error("no recorded daemon for that driver");
          return driverOver(daemon);
        },
        recipe: otherMachineRecipe,
        unsupportedCommand: ELEMENT_CLICK,
      }),
    ).resolves.toMatchObject({
      stoppedWhenCancelled: true,
      taggedWhatItCreated: true,
      extendedOnlyWhenConfirmed: true,
      reportedAbsenceOnlyWhenAbsent: true,
      foundAfterRestart: true,
    });
  });

  it("creates a Space on the person's one other machine that answers, and refuses to choose among several or none", async () => {
    const asleep = { ...SPARE, id: "m-0b1c", name: "old laptop", online: false };
    const { daemon, provider } = await harness({ hosts: [asleep, SPARE] });
    await acquired(provider, otherMachineRecipe);
    const [space] = daemon.spaces();
    const create = space?.createRequest ?? [];
    expect(textOf(create, 2)).toBe("host:m-7f3a");
    expect(textOf(create, 3)).toBe("vm");
    expect(textOf(create, 4)).toBe("qemu");
    expect(textOf(create, 20)).toBe("none");
    expect(space?.host).toBe("m-7f3a");
    expect(methodsCalled(daemon).slice(0, 2)).toEqual([
      "/cua.daemon.v1.SpaceService/ListHosts",
      "/cua.daemon.v1.SpaceService/CreateSpace",
    ]);

    const second = { ...SPARE, id: "m-9d2e", name: "studio" };
    for (const [hosts, reason] of [
      [[], "no-other-machine"],
      [[asleep], "no-other-machine"],
      [[SPARE, second], "other-machine-ambiguous"],
    ] as const) {
      const other = await harness({ hosts });
      await expect(
        other.provider.acquire(
          acquireRequest(30, new AbortController().signal, otherMachineRecipe),
        ),
      ).resolves.toEqual({ status: "refused", reason });
      expect(methodsCalled(other.daemon)).toEqual(["/cua.daemon.v1.SpaceService/ListHosts"]);
    }
  });

  it("destroys a Space the daemon reports on another machine than the one asked", async () => {
    const elsewhere = await harness({ hosts: [SPARE], placesOnHost: "m-9d2e" });
    await expect(
      elsewhere.provider.acquire(
        acquireRequest(30, new AbortController().signal, otherMachineRecipe),
      ),
    ).resolves.toEqual({ status: "failed", reason: "space-mismatched" });
    expect(elsewhere.daemon.spaces()).toEqual([]);

    const awayFromHere = await harness({ placesOnHost: "m-7f3a" });
    await expect(awayFromHere.provider.acquire(acquireRequest())).resolves.toEqual({
      status: "failed",
      reason: "space-mismatched",
    });
    expect(awayFromHere.daemon.spaces()).toEqual([]);
  });

  it("refuses the screen, input, files, and agent control of a Space on another machine while Cua's relay can read the session", async () => {
    const { daemon, provider } = await harness({ hosts: [SPARE], route: "relay_https" });
    const { result } = await acquired(provider, otherMachineRecipe);
    const acquiring = daemon.calls().length;
    const relayReads = { status: "refused", reason: "relay-reads-session" };
    await expect(provider.screen(result.handle)).resolves.toEqual(relayReads);
    await expect(
      provider.deliver(result.handle, "app", new TextEncoder().encode("#!/bin/sh\n")),
    ).resolves.toEqual(relayReads);
    await expect(provider.control(result.handle, { operation: "apps" })).resolves.toMatchObject({
      kind: "refused",
      reason: "relay-reads-session",
    });
    // Each was refused on the route alone: nothing reached the Space.
    expect(methodsCalled(daemon).slice(acquiring)).toEqual(
      Array.from({ length: 3 }, () => "/cua.daemon.v1.SpaceService/GetSpaceRoute"),
    );

    // The end-to-end mesh and a direct route carry the session.
    for (const transport of ["mesh", "direct"]) {
      daemon.routeOver(transport);
      const opened = await provider.screen(result.handle);
      if (opened.status !== "ready") throw new Error(`no screen over ${transport}`);
      await expect(opened.screen.frame()).resolves.toMatchObject({ status: "frame" });
    }

    // A route that falls back to the relay's HTTPS path while a view is open
    // stops the view's frames and input.
    const open = await provider.screen(result.handle);
    if (open.status !== "ready") throw new Error("no screen");
    daemon.routeOver("relay_https");
    await expect(open.screen.frame()).resolves.toEqual(relayReads);
    await expect(open.screen.input({ kind: "text", text: "secret" })).resolves.toEqual(relayReads);
    expect(daemon.spaces()[0]?.input.filter((line) => line.startsWith("type"))).toEqual([]);

    // A route Octant cannot name is refused as well.
    for (const transport of ["cloud", "", "relay_wss"]) {
      daemon.routeOver(transport);
      await expect(provider.screen(result.handle)).resolves.toEqual({
        status: "refused",
        reason: "route-unverified",
      });
    }
  });

  it("asks a person before a Space starts on another machine, and starts it only for the placement they confirmed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-cua-away-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());
    const daemon = await daemonWith({ hosts: [SPARE] }, () => START);
    const asked: Array<string> = [];
    const { service } = hostProcess(
      connection,
      driverOver(daemon, () => START),
      otherMachineRecipe,
      asked,
    );
    const caller = { owner: { mode: "code" as const, threadId }, actor: person, scopeId: "w-1" };
    const cua = decodeDesktopProviderId("cua");

    // An agent under Full access asks in its thread, and is declined here.
    await expect(
      service.acquire({
        owner: { mode: "code", threadId },
        actor: decodeEventActor({
          kind: "agent",
          actorId: "c5000000-0000-4000-8000-0000000000b5",
          providerInstanceId: "c5000000-0000-4000-8000-0000000000b6",
          threadId,
        }),
      }),
    ).resolves.toEqual({ status: "refused", reason: "declined" });
    expect(asked).toEqual(["off-machine"]);
    // A person's Start without their confirmation of this placement starts nothing.
    for (const unconfirmed of [
      caller,
      { ...caller, confirmedProvider: cua },
      {
        ...caller,
        confirmedProvider: cua,
        confirmedPlacement: decodeDesktopPlacementId("this-machine"),
      },
    ]) {
      await expect(service.acquire(unconfirmed)).resolves.toEqual({
        status: "refused",
        reason: "declined",
      });
    }
    expect(methodsCalled(daemon)).not.toContain("/cua.daemon.v1.SpaceService/ListHosts");
    expect(methodsCalled(daemon)).not.toContain("/cua.daemon.v1.SpaceService/CreateSpace");

    await expect(
      service.acquire({
        ...caller,
        confirmedProvider: cua,
        confirmedPlacement: decodeDesktopPlacementId("other-machine"),
      }),
    ).resolves.toMatchObject({
      status: "acquired",
      lease: { placementId: "other-machine", locality: "cloud", billed: false },
    });
    expect(daemon.spaces().map((space) => space.host)).toEqual(["m-7f3a"]);
  });

  it("creates a labelled QEMU VM on this machine with the lease id as its create id, and nothing else", async () => {
    const { daemon, provider } = await harness();
    const { leaseId, result } = await acquired(provider);
    const [space] = daemon.spaces();
    expect(space?.labels).toEqual(
      new Map([
        [CUA_LEASE_LABEL, String(leaseId)],
        [CUA_HOST_LABEL, String(hostTag)],
      ]),
    );
    const create = space?.createRequest ?? [];
    expect(textOf(create, 1)).toBe("ghcr.io/trycua/linux:24.04");
    expect(textOf(create, 2)).toBe("local");
    expect(textOf(create, 3)).toBe("vm");
    expect(textOf(create, 4)).toBe("qemu");
    expect(textOf(create, 5)).toBe(`octant-${String(leaseId)}`);
    expect(numberOf(create, 9)).toBe(0);
    expect(textOf(create, 17)).toBe(String(leaseId));
    expect(textOf(create, 20)).toBe("none");
    expect(mapOf(create, 21).size).toBe(2);
    // No volumes, environment, services, egress, durability, reuse, or anything else.
    expect([...new Set(create.map((field) => field.field))].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 9, 17, 20, 21,
    ]);
    expect(result.handle).toEqual({ leaseId, resource: space?.id });
    expect(methodsCalled(daemon)).toEqual([
      "/cua.daemon.v1.SpaceService/CreateSpace",
      "/cua.daemon.v1.SpaceService/SetSpaceLifetime",
      "/cua.daemon.v1.SpaceService/ResolveSpace",
      "/cua.daemon.v1.SpaceService/ResolveSpace",
      "/cua.daemon.v1.SpaceService/ConnectSpace",
      "env/cua.env.v1.SystemService/GetCapabilities",
    ]);
  });

  it("sets the daemon's lifetime past the lease expiry, deleting the Space when it passes", async () => {
    const { daemon, provider } = await harness();
    const { result } = await acquired(provider);
    const lifetime = daemon
      .calls()
      .find((call) => call.method.endsWith("/SetSpaceLifetime"))?.request;
    expect(numberOf(messageOf(lifetime ?? [], 2) ?? [], 1)).toBe(30 * 60 + 120);
    expect(textOf(lifetime ?? [], 3)).toBe("delete");
    expect(result.providerExpiresAt).toBe(new Date(START + 32 * MINUTE).toISOString());
    expect(daemon.spaces()[0]?.expiresAt).toBe(START + 32 * MINUTE);
  });

  it("refuses an extension the daemon holds below the new expiry, and reports the one it confirms", async () => {
    const asked = decodeUtcTimestamp(new Date(START + 90 * MINUTE).toISOString());
    const held = await harness({ holdsLifetimeMs: 60 * MINUTE });
    const short = await acquired(held.provider);
    await expect(held.provider.extend(short.result.handle, asked)).resolves.toEqual({
      status: "failed",
      reason: "lifetime-short",
    });

    const open = await harness();
    const lease = await acquired(open.provider);
    open.clock.now = START + 10 * MINUTE;
    await expect(open.provider.extend(lease.result.handle, asked)).resolves.toEqual({
      status: "extended",
      expiresAt: new Date(START + 92 * MINUTE).toISOString(),
    });
  });

  it("cancels a create still running in the daemon through CancelCreateSpace with the lease id", async () => {
    const { daemon, provider } = await harness({ createHangs: true });
    const controller = new AbortController();
    const request = acquireRequest(30, controller.signal);
    const pending = provider.acquire(request);
    await expect.poll(() => daemon.creating()).toEqual([String(request.leaseId)]);
    // While it runs, the daemon's listing cannot yet say whose it is.
    await expect(provider.listOwned(hostTag)).resolves.toEqual({
      status: "failed",
      reason: "space-still-creating",
    });
    await expect(
      provider.verifyGone({ leaseId: request.leaseId, resource: "space-not-yet-named" }),
    ).resolves.toEqual({ status: "present" });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    const cancel = daemon.calls().find((call) => call.method.endsWith("/CancelCreateSpace"));
    expect(textOf(cancel?.request ?? [], 1)).toBe(String(request.leaseId));
    expect(daemon.creating()).toEqual([]);
    await expect(provider.listOwned(hostTag)).resolves.toEqual({ status: "listed", resources: [] });
  });

  it.each(["incomplete", "stale", "relay-unreachable"] as const)(
    "answers a %s listing as failed, never as the Space being absent",
    async (listing) => {
      const { provider } = await harness({ listing });
      const { result } = await acquired(provider);
      await expect(provider.listOwned(hostTag)).resolves.toMatchObject({ status: "failed" });
      await expect(provider.verifyGone(result.handle)).resolves.toMatchObject({
        status: "failed",
      });
    },
  );

  it("destroys a Space whose create reports a network other than none instead of keeping it", async () => {
    const { daemon, provider } = await harness({ network: "" });
    await expect(provider.acquire(acquireRequest())).resolves.toEqual({
      status: "failed",
      reason: "network-not-none",
    });
    expect(daemon.spaces()).toEqual([]);
    expect(methodsCalled(daemon)).toContain("/cua.daemon.v1.SpaceService/DeleteSpace");
  });

  it("destroys a Space the daemon placed in a cloud, and refuses a Space speaking another protocol", async () => {
    const elsewhere = await harness({ placesInCloud: "aws" });
    await expect(elsewhere.provider.acquire(acquireRequest())).resolves.toEqual({
      status: "failed",
      reason: "space-mismatched",
    });
    expect(elsewhere.daemon.spaces()).toEqual([]);

    const newer = await harness({ protocolVersion: 2 });
    await expect(newer.provider.acquire(acquireRequest())).resolves.toEqual({
      status: "refused",
      reason: "env-protocol-unsupported",
    });
    expect(newer.daemon.spaces()).toEqual([]);
  });

  it("refuses a placement it does not offer, a recipe with network, or one naming a key, before calling Cua", async () => {
    const { daemon, provider } = await harness();
    for (const refusedRecipe of [
      decodeDesktopRecipe({ ...recipe, placementId: "your-aws" }),
      decodeDesktopRecipe({ ...recipe, network: "allow" }),
      decodeDesktopRecipe({ ...recipe, credentialRef: "c5000000-0000-4000-8000-0000000000c1" }),
    ]) {
      await expect(
        provider.acquire({ ...acquireRequest(), recipe: refusedRecipe }),
      ).resolves.toMatchObject({ status: "refused" });
    }
    expect(daemon.calls()).toEqual([]);
  });

  it("declares only the daemon methods it uses, sends only those, and never a caller's identity or a token the daemon hands out", async () => {
    expect(CUA_DESKTOP_DAEMON).toEqual({
      socketPath: ".cua/cua.sock",
      methods: [
        "/cua.daemon.v1.DaemonService/GetInfo",
        "/cua.daemon.v1.SpaceService/CreateSpace",
        "/cua.daemon.v1.SpaceService/CancelCreateSpace",
        "/cua.daemon.v1.SpaceService/SetSpaceLifetime",
        "/cua.daemon.v1.SpaceService/DeleteSpace",
        "/cua.daemon.v1.SpaceService/ListSpaces",
        "/cua.daemon.v1.SpaceService/ResolveSpace",
        "/cua.daemon.v1.SpaceService/ConnectSpace",
        "/cua.daemon.v1.SpaceService/ListHosts",
        "/cua.daemon.v1.SpaceService/GetSpaceRoute",
        "/v1/spaces/*/env/cua.env.v1.SystemService/GetCapabilities",
        "/v1/spaces/*/env/cua.env.v1.ComputerService/Screenshot",
        "/v1/spaces/*/env/cua.env.v1.ComputerService/Pointer",
        "/v1/spaces/*/env/cua.env.v1.ComputerService/Keyboard",
        "/v1/spaces/*/env/cua.env.v1.FilesystemService/BeginUpload",
        "/v1/spaces/*/env/cua.env.v1.FilesystemService/UploadChunk",
        "/v1/spaces/*/env/cua.env.v1.FilesystemService/CommitUpload",
        "/v1/spaces/*/env/cua.env.v1.FilesystemService/Move",
        "/v1/spaces/*/env/cua.env.v1.ProcessService/StartProcess",
      ],
    });
    for (const forbidden of [
      "/cua.daemon.v1.DaemonService/Shutdown",
      "/cua.daemon.v1.SpaceService/CallSpaceTool",
      "/cua.daemon.v1.SpaceService/PoolRequest",
      "/cua.daemon.v1.SpaceService/AddSpace",
      "/cua.daemon.v1.ShareService/CreateShare",
      "/mcp",
    ]) {
      expect(desktopDaemonMethodDeclared(forbidden, CUA_DESKTOP_DAEMON.methods)).toBe(false);
    }

    const { daemon, provider } = await harness();
    await provider.status();
    const { result } = await acquired(provider);
    const screen = await provider.screen(result.handle);
    if (screen.status !== "ready") throw new Error("no screen");
    await screen.screen.frame();
    await screen.screen.input({ kind: "text", text: "hello" });
    await provider.deliver(result.handle, "app", new TextEncoder().encode("#!/bin/sh\n"));
    await provider.control(result.handle, { operation: "launch", appId: "app" });
    await provider.release(result.handle);
    await provider.verifyGone(result.handle);
    const decoder = new TextDecoder();
    for (const call of daemon.calls()) {
      expect(desktopDaemonMethodDeclared(call.method, CUA_DESKTOP_DAEMON.methods)).toBe(true);
      expect(call.headers["x-cua-host-caller"]).toBeUndefined();
      expect(call.headers["x-cua-share-caller"]).toBeUndefined();
      expect(call.headers.authorization).toBeUndefined();
      // GetInfo offers the daemon's loopback token and ConnectSpace the
      // Space's; both stay in the daemon, so no call carries either anywhere.
      const sent = [
        call.method,
        JSON.stringify(call.headers),
        ...call.request.map((field) => (field.wire === "bytes" ? decoder.decode(field.value) : "")),
      ].join("\n");
      expect(sent).not.toContain(RECORDED_LOOPBACK_TOKEN);
      expect(sent).not.toContain(RECORDED_SPACE_TOKEN);
    }
    expect(JSON.stringify(result)).not.toContain(RECORDED_SPACE_TOKEN);
  });

  it("answers ready only for a daemon release it was written for that runs Spaces", async () => {
    await expect((await harness()).provider.status()).resolves.toEqual({ status: "ready" });
    await expect((await harness({ version: "0.8.9" })).provider.status()).resolves.toEqual({
      status: "refused",
      reason: "daemon-too-old",
    });
    await expect(
      (await harness({ features: ["env", "sandboxes"] })).provider.status(),
    ).resolves.toEqual({ status: "refused", reason: "spaces-unavailable" });
    const stopped = await harness();
    rmSync(join(stopped.daemon.home, CUA_DESKTOP_DAEMON.socketPath));
    await expect(stopped.provider.status()).resolves.toEqual({ status: "not-connected" });
  });

  it("shows the screen and takes a person's pointer, keys, and text on the frame they saw", async () => {
    const { daemon, provider } = await harness({ display: { width: 1280, height: 800 } });
    const { result } = await acquired(provider);
    const screen = await provider.screen(result.handle);
    if (screen.status !== "ready") throw new Error("no screen");
    await expect(
      screen.screen.input({ kind: "pointer", action: "move", x: 1, y: 1 }),
    ).resolves.toEqual({ status: "refused", reason: "no-frame" });
    // Cua scales the frame to the recipe's longer edge.
    await expect(screen.screen.frame()).resolves.toMatchObject({
      status: "frame",
      frame: { mediaType: "image/png", width: 1024, height: 640 },
    });
    for (const event of [
      { kind: "pointer", action: "down", button: "right", x: 10.5, y: 20 },
      { kind: "key", action: "down", key: "Enter" },
      { kind: "key", action: "up", key: "a" },
      { kind: "key", action: "down", key: "F5" },
      { kind: "text", text: "$(rm -rf ~) 'quoted'" },
      { kind: "scroll", x: 5, y: 5, deltaX: 0, deltaY: 120 },
    ] as const) {
      await expect(screen.screen.input(event)).resolves.toEqual({ status: "delivered" });
    }
    await expect(
      screen.screen.input({ kind: "pointer", action: "move", x: 1024, y: 0 }),
    ).resolves.toEqual({ status: "refused", reason: "outside-screen" });
    await expect(
      screen.screen.input({ kind: "key", action: "down", key: "constructor" }),
    ).resolves.toEqual({ status: "refused", reason: "unsupported-key" });
    // A Space on this machine is never asked for its route.
    expect(methodsCalled(daemon)).not.toContain("/cua.daemon.v1.SpaceService/GetSpaceRoute");
    const shot = daemon.spaces()[0]?.input.find((line) => line.startsWith("pointer"));
    expect(shot).toMatch(/ space=3 shot=shot-\d+$/);
    expect(
      daemon.spaces()[0]?.input.map((line) => line.replace(/ space=3 shot=shot-\d+$/, "")),
    ).toEqual([
      "screenshot format=1",
      "pointer down 10.5,20 button=2",
      "key down named=20",
      "key up char=a",
      "key down named=64",
      "type $(rm -rf ~) 'quoted'",
      "pointer scroll 5,5 delta=0,120 unit=2",
    ]);
  });

  it("lands a sent file read-only in the inbox and launches only a file that landed", async () => {
    const { daemon, provider } = await harness();
    const { result } = await acquired(provider);
    const bytes = new TextEncoder().encode("#!/bin/sh\necho app\n");
    await expect(
      provider.control(result.handle, { operation: "launch", appId: "app.AppImage" }),
    ).resolves.toMatchObject({ kind: "refused", reason: "not-sent" });
    await expect(provider.deliver(result.handle, "app.AppImage", bytes)).resolves.toEqual({
      status: "delivered",
    });
    const files = daemon.spaces()[0]?.files;
    expect(files?.get("/home/user/inbox/app.AppImage")).toEqual({ bytes, permissions: 0o444 });
    expect([...(files?.keys() ?? [])]).toEqual(["/home/user/inbox/app.AppImage"]);

    await expect(
      provider.control(result.handle, { operation: "launch", appId: "app.AppImage" }),
    ).resolves.toMatchObject({ kind: "windows", appId: "app.AppImage" });
    const windows = (await provider.control(result.handle, {
      operation: "windows",
      appId: "app.AppImage",
    })) as Extract<ComputerControlResult, { kind: "windows" }>;
    expect(windows.windows).toHaveLength(1);
    await expect(
      provider.control(
        result.handle,
        decodeComputerControlCommand({ operation: "observe", appId: "app.AppImage", windowId: 1 }),
      ),
    ).resolves.toMatchObject({ kind: "observation", elements: [], imageWidth: 1024 });
  });

  it("lists only this host's labelled Spaces, and refuses an account a key would name", async () => {
    const { daemon, provider } = await harness();
    const mine = [await acquired(provider), await acquired(provider)];
    await driverOver(daemon, () => START).acquire({
      ...acquireRequest(),
      hostTag: decodeDesktopHostTag("c5000000-0000-4000-8000-0000000000bb"),
    });
    const listed = await provider.listOwned(hostTag);
    expect(listed.status).toBe("listed");
    if (listed.status !== "listed") return;
    expect(listed.resources.map((resource) => String(resource.handle.leaseId)).sort()).toEqual(
      mine.map(({ leaseId }) => String(leaseId)).sort(),
    );
    await expect(
      provider.listOwned(
        hostTag,
        decodeDesktopCredentialRef("c5000000-0000-4000-8000-0000000000c1"),
      ),
    ).resolves.toEqual({ status: "failed", reason: "credential-not-used" });
  });

  it.each(["ready", "provisioning"] as const)(
    "lets a host killed with a lease %s find and destroy its Space by its labels once it starts again",
    async (killedWhile) => {
      const directory = mkdtempSync(join(tmpdir(), "octant-cua-kill-"));
      directories.push(directory);
      const connection = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());
      const daemon = await daemonWith({}, () => START);
      const driver = driverOver(daemon, () => START);
      // A process killed mid-create never sees the daemon's answer.
      const dying: DesktopProvider =
        killedWhile === "ready"
          ? driver
          : {
              ...driver,
              acquire: async (request) => {
                await driver.acquire(request);
                return new Promise(() => undefined);
              },
            };
      const before = hostProcess(connection, dying);
      const started = before.service.acquire({
        owner: { mode: "code", threadId },
        actor: person,
        scopeId: "window-1",
      });
      if (killedWhile === "ready") {
        await expect(started).resolves.toMatchObject({
          status: "acquired",
          lease: {
            providerId: String(CUA_DESKTOP_PROVIDER_ID),
            placementId: "this-machine",
            locality: "host-local",
            daemon: { socketPath: ".cua/cua.sock", userId: process.getuid?.() ?? 0 },
          },
        });
      } else {
        await expect.poll(() => daemon.spaces().length).toBe(1);
      }
      expect(daemon.spaces()).toHaveLength(1);

      // The replacement process has the journal and the daemon's listing, nothing else.
      const after = hostProcess(
        connection,
        driverOver(daemon, () => START),
      );
      await expect(after.service.start()).resolves.toEqual({
        released: 1,
        stillRunning: 0,
        orphansDestroyed: 0,
      });
      expect(daemon.spaces()).toEqual([]);
    },
  );

  it("keeps to the imports a third-party desktop plugin could make", () => {
    const files = readdirSync(import.meta.dirname).filter(
      (name) =>
        name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"),
    );
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const match of source.matchAll(
        /\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"|^\s*import\s+"([^"]+)"|\brequire\(\s*"([^"]+)"/gm,
      )) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
        const allowed =
          specifier.startsWith("./") ||
          specifier === "@octant/contracts" ||
          specifier.startsWith("@octant/contracts/") ||
          specifier === "@octant/plugin-api/desktop-provider";
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
      expect(source, `${file} reaches the network itself`).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
