import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_ARTIFACT_MAXIMUM_BYTES,
  decodeDesktopHostTag,
  decodeDesktopLeaseId,
  decodeDesktopMachineId,
  decodeDesktopPlacementId,
  decodeDesktopProviderId,
  decodeDesktopRecipe,
  decodeEventActor,
  decodeUtcTimestamp,
  type DesktopLeaseId,
  type DesktopRecipe,
  type EventActor,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { decodeComputerControlCommand } from "@octant/contracts/computer-use-plugin";
import {
  DESKTOP_CREDENTIAL_MISSING,
  DESKTOP_SESSION_READABLE,
  type DesktopFrame,
  type DesktopProvider,
} from "@octant/plugin-api/desktop-provider";
import {
  createFakeDesktopProvider,
  FAKE_DESKTOP_FRAME,
  type FakeDesktopBackend,
} from "../../../../packages/plugin-api/src/fakeDesktopProvider";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  createDesktopLeaseService,
  type DesktopLeaseService,
  type DesktopTransferConfirmation,
  type RegisteredDesktopProvider,
} from "./desktopLeaseService";

const START = Date.parse("2026-10-26T12:00:00.000Z");
const MINUTE = 60_000;
const hostTag = decodeDesktopHostTag("e1000000-0000-4000-8000-0000000000aa");
const threadA = "e1000000-0000-4000-8000-000000000001";
const threadB = "e1000000-0000-4000-8000-000000000002";
const threadC = "e1000000-0000-4000-8000-000000000003";
const person = decodeEventActor({
  kind: "local-user",
  actorId: "e1000000-0000-4000-8000-0000000000b1",
});
const paired = decodeEventActor({
  kind: "remote-device",
  actorId: "e1000000-0000-4000-8000-0000000000b2",
  deviceId: "e1000000-0000-4000-8000-0000000000b3",
});
const system = decodeEventActor({
  kind: "system",
  actorId: "e1000000-0000-4000-8000-0000000000b4",
});
const agentOf = (threadId: string): EventActor =>
  decodeEventActor({
    kind: "agent",
    actorId: "e1000000-0000-4000-8000-0000000000b5",
    providerInstanceId: "e1000000-0000-4000-8000-0000000000b6",
    threadId,
  });

/** The person's key for a cloud provider, by reference only. */
const cloudCredential = "e1000000-0000-4000-8000-0000000000c1";

const recipeFor = (
  providerId: string,
  credentialRef?: string,
  hourlyCostUsdCents?: number,
): DesktopRecipe =>
  decodeDesktopRecipe({
    providerId,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(hourlyCostUsdCents === undefined ? {} : { hourlyCostUsdCents }),
    screen: { width: 1280, height: 800 },
    network: "none",
    leaseMinutes: 30,
    maximumLeaseMinutes: 240,
    idleMinutes: 15,
  });

/** The person's own figure for an hour of a billed desktop in these tests: $1.00. */
const HOURLY_COST = 100;

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface HostState {
  now: number;
  computerUse: boolean;
  answer: "approved" | "declined";
  readonly asked: Array<string>;
  readonly askedTransfers: Array<DesktopTransferConfirmation>;
  /** Runs while a person is deciding on a transfer. */
  whileDeciding: () => void | Promise<void>;
  readonly roots: Map<string, string>;
  readonly threads: Map<string, { active: boolean; executionPolicy: ProviderExecutionPolicy }>;
  readonly recipes: Map<string, DesktopRecipe>;
  providers: Array<RegisteredDesktopProvider>;
  /** Windows and devices that may not open any thread. */
  readonly deniedScopes: Set<string>;
  /** The user Octant runs as, whose home holds a daemon-run provider's socket. */
  daemonUserId?: number;
}

function openJournal(connection: SqliteConnection) {
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date(START).toISOString(),
  });
  for (const projection of runtime.projections.all()) {
    catchUpProjection({
      connection,
      journal,
      projection,
      clock: () => new Date(START).toISOString(),
    });
  }
  return { journal, projection: runtime.desktopLeaseProjection };
}

function serviceOver(connection: SqliteConnection, state: HostState): DesktopLeaseService {
  const { journal, projection } = openJournal(connection);
  return createDesktopLeaseService({
    journal,
    projection,
    hostTag,
    platform: "linux",
    hasScreen: false,
    providers: () => state.providers,
    recipe: (owner) => state.recipes.get(String(owner.threadId)),
    thread: (owner) => state.threads.get(String(owner.threadId)),
    callerMayOpen: (_actor, owner, scopeId) =>
      state.threads.has(String(owner.threadId)) &&
      (scopeId === undefined || !state.deniedScopes.has(scopeId)),
    computerUseEnabled: () => state.computerUse,
    confirm: async (request) => {
      state.asked.push(request.asks);
      return state.answer;
    },
    threadRoot: async (owner) => state.roots.get(String(owner.threadId)),
    confirmTransfer: async (request) => {
      state.askedTransfers.push(request);
      await state.whileDeciding();
      return state.answer;
    },
    systemActor: system,
    now: () => state.now,
    uuid: randomUUID,
    ...(state.daemonUserId === undefined ? {} : { daemonUserId: state.daemonUserId }),
    teardownTimeoutMs: 1_000,
  });
}

function host(
  options: {
    readonly providers?: ReadonlyArray<{ readonly provider: DesktopProvider }>;
    readonly executionPolicy?: ProviderExecutionPolicy;
    /** The monthly cap a person set at start, or `null` for none. */
    readonly spendCap?: number | null;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-desktop-lease-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());
  const fake = createFakeDesktopProvider();
  const providers = options.providers ?? [fake];
  const checkout = join(directory, "checkout");
  mkdirSync(checkout);
  const state: HostState = {
    now: START,
    computerUse: true,
    answer: "approved",
    asked: [],
    askedTransfers: [],
    whileDeciding: () => undefined,
    roots: new Map([threadA, threadB, threadC].map((threadId) => [threadId, checkout])),
    threads: new Map(
      [threadA, threadB, threadC].map((threadId) => [
        threadId,
        { active: true, executionPolicy: options.executionPolicy ?? "full-access" },
      ]),
    ),
    recipes: new Map(
      [threadA, threadB, threadC].map((threadId) => [
        threadId,
        recipeFor(
          String(providers[0]?.provider.id ?? "fake-desktop"),
          providers[0]?.provider.locality === "cloud" ? cloudCredential : undefined,
          // A billed provider's recipe carries the person's hourly figure.
          providers[0]?.provider.billed === true ? HOURLY_COST : undefined,
        ),
      ]),
    ),
    providers: providers.map(({ provider }) => ({ provider, effective: true })),
    deniedScopes: new Set(),
  };
  const service = serviceOver(connection, state);
  // Billed desktops are off until a person sets a cap; a host with a billed
  // provider or placement starts with one far above anything these tests
  // spend, unless the test is about the cap itself.
  const spendCap =
    options.spendCap === undefined
      ? providers.some(
          ({ provider }) =>
            provider.billed || provider.placements?.some((entry) => entry.billed) === true,
        )
        ? 1_000_000
        : null
      : options.spendCap;
  if (spendCap !== null) service.setSpendCap({ actor: person, monthlyCapUsdCents: spendCap });
  return {
    state,
    backend: fake.backend,
    checkout,
    connection,
    service,
    restart: () => serviceOver(connection, state),
  };
}

const code = (threadId: string) => ({ mode: "code" as const, threadId });

async function acquired(service: DesktopLeaseService, threadId: string): Promise<DesktopLeaseId> {
  const result = await service.acquire({ owner: code(threadId), actor: agentOf(threadId) });
  if (result.status !== "acquired")
    throw new Error(`expected a lease, got ${JSON.stringify(result)}`);
  return result.lease.leaseId;
}

const runningDesktops = (backend: FakeDesktopBackend) => backend.desktops().length;

describe("desktop lease service", () => {
  it("reports the capability absent and refuses every lease command as a value with no provider", async () => {
    const { service, state } = host({ providers: [] });
    const unknownLease = decodeDesktopLeaseId(randomUUID());

    expect(service.destination()).toEqual({
      status: "unavailable",
      kind: "no-provider-configured",
    });
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    state.recipes.clear();
    await expect(service.acquire({ owner: code(threadA), actor: person })).resolves.toEqual({
      status: "refused",
      reason: "no-provider-configured",
    });
    const operating = { owner: code(threadA), actor: person, leaseId: unknownLease };
    await expect(service.release(operating)).resolves.toEqual({
      status: "refused",
      reason: "lease-ended",
    });
    await expect(service.extend({ ...operating, byMinutes: 30 })).resolves.toEqual({
      status: "refused",
      reason: "lease-ended",
    });
    await expect(
      service.control({ ...operating, command: { operation: "apps" } }),
    ).resolves.toEqual({ status: "refused", reason: "lease-ended" });
    await expect(service.retryRelease({ leaseId: unknownLease, actor: person })).resolves.toEqual({
      status: "refused",
      reason: "lease-ended",
    });
  });

  it("names a leasable provider and refuses Chat, Plan, and a declined approval before any provider call", async () => {
    const { service, state, backend } = host({ executionPolicy: "approval-gated" });
    expect(service.destination()).toMatchObject({
      status: "leasable",
      kind: "disposable-desktop",
      leasable: [{ providerId: "fake-desktop", locality: "host-local", billed: false }],
    });

    await expect(
      service.acquire({ owner: { mode: "chat", threadId: threadA }, actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "not-leasable-mode" });
    state.answer = "declined";
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "declined" });
    expect(state.asked).toEqual(["in-thread"]);
    state.threads.set(threadB, { active: true, executionPolicy: "plan" });
    await expect(
      service.acquire({ owner: code(threadB), actor: agentOf(threadB) }),
    ).resolves.toEqual({ status: "refused", reason: "plan-mode" });
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadB) }),
    ).resolves.toEqual({ status: "refused", reason: "not-permitted" });
    expect(backend.calls()).not.toContain("acquire");
  });

  it("asks a person to confirm a billed lease even under Full access", async () => {
    const cloud = createFakeDesktopProvider({
      id: "cloud.example",
      locality: "cloud",
      billed: true,
    });
    const { service, state } = host({ providers: [cloud] });
    const result = await service.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    expect(result.status).toBe("acquired");
    expect(state.asked).toEqual(["billed"]);
  });

  it("starts a person's billed lease only with their own confirmation of that provider", async () => {
    const cloud = createFakeDesktopProvider({
      id: "cloud.example",
      locality: "cloud",
      billed: true,
    });
    const { service, state } = host({ providers: [cloud] });
    const caller = { owner: code(threadA), actor: person, scopeId: "window-1" };

    await expect(service.acquire(caller)).resolves.toEqual({
      status: "refused",
      reason: "declined",
    });
    await expect(
      service.acquire({
        ...caller,
        confirmedProvider: decodeDesktopProviderId("other.example"),
      }),
    ).resolves.toEqual({ status: "refused", reason: "declined" });
    expect(cloud.backend.calls()).not.toContain("acquire");

    const started = await service.acquire({
      ...caller,
      confirmedProvider: decodeDesktopProviderId("cloud.example"),
    });
    expect(started).toMatchObject({ status: "acquired", lease: { billed: true } });
    // The person answered in their own tab; the host asks nobody else.
    expect(state.asked).toEqual([]);
  });

  it("starts a lease off this machine only once someone confirms where it runs, Full access and a person's own Start included", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    const spaces: DesktopProvider = {
      ...fake.provider,
      placements: [
        {
          id: decodeDesktopPlacementId("here"),
          displayName: "This machine",
          locality: "host-local",
          billed: false,
        },
        {
          id: decodeDesktopPlacementId("other-machine"),
          displayName: "Your other machine",
          locality: "cloud",
          billed: false,
        },
      ],
    };
    const { service, state } = host({ providers: [{ provider: spaces }] });
    const inPlacement = (placementId: string) =>
      decodeDesktopRecipe({ ...recipeFor("spaces.example", cloudCredential), placementId });
    state.recipes.set(threadA, inPlacement("other-machine"));

    // An agent asks in its thread under Full access, naming where it runs.
    state.answer = "declined";
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "declined" });
    expect(state.asked).toEqual(["off-machine"]);

    // A person's tab is offered the placement to confirm with the provider,
    // and their Start counts only with that confirmation, for that placement.
    const caller = { owner: code(threadA), actor: person, scopeId: "window-1" };
    await expect(service.overview(caller)).resolves.toMatchObject({
      start: {
        status: "available",
        placementId: "other-machine",
        provider: { providerId: "spaces.example", locality: "cloud", billed: false },
      },
    });
    const confirmedProvider = decodeDesktopProviderId("spaces.example");
    for (const unconfirmed of [
      caller,
      { ...caller, confirmedProvider },
      { ...caller, confirmedProvider, confirmedPlacement: decodeDesktopPlacementId("here") },
      {
        ...caller,
        confirmedProvider: decodeDesktopProviderId("other.example"),
        confirmedPlacement: decodeDesktopPlacementId("other-machine"),
      },
    ]) {
      await expect(service.acquire(unconfirmed)).resolves.toEqual({
        status: "refused",
        reason: "declined",
      });
    }
    expect(fake.backend.calls()).not.toContain("acquire");
    await expect(
      service.acquire({
        ...caller,
        confirmedProvider,
        confirmedPlacement: decodeDesktopPlacementId("other-machine"),
      }),
    ).resolves.toMatchObject({
      status: "acquired",
      lease: { placementId: "other-machine", locality: "cloud", billed: false },
    });
    expect(state.asked).toEqual(["off-machine"]);

    // On this machine, a person's Start is their decision and asks nothing more.
    state.recipes.set(threadB, inPlacement("here"));
    await expect(service.acquire({ ...caller, owner: code(threadB) })).resolves.toMatchObject({
      status: "acquired",
      lease: { placementId: "here" },
    });
    expect(state.asked).toEqual(["off-machine"]);
  });

  it("refuses a cloud recipe that names no credential before any provider call", async () => {
    const cloud = createFakeDesktopProvider({
      id: "cloud.example",
      locality: "cloud",
      billed: true,
    });
    const { service, state } = host({ providers: [cloud] });
    state.recipes.set(threadA, recipeFor("cloud.example"));
    await expect(
      service.acquire({
        owner: code(threadA),
        actor: person,
        scopeId: "window-1",
        confirmedProvider: decodeDesktopProviderId("cloud.example"),
      }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    // Restart reconciliation's listing is the only call the provider saw.
    expect(cloud.backend.calls()).toEqual(["listOwned"]);
  });

  it("journals the lease before asking the provider to create a desktop", async () => {
    const fake = createFakeDesktopProvider();
    let journaledFirst = false;
    const watching: DesktopProvider = {
      ...fake.provider,
      acquire: async (request) => {
        journaledFirst =
          harness.connection
            .prepare("SELECT event_name FROM event_journal WHERE aggregate_id = ?")
            .all(String(request.leaseId)).length > 0;
        return fake.provider.acquire(request);
      },
    };
    const harness = host({ providers: [{ provider: watching }] });
    await acquired(harness.service, threadA);
    expect(journaledFirst).toBe(true);
  });

  it("refuses another thread's commands on a lease as leased-by-another-thread", async () => {
    const { service } = host();
    const leaseId = await acquired(service, threadA);
    const fromB = { owner: code(threadB), actor: agentOf(threadB), leaseId };

    await expect(service.control({ ...fromB, command: { operation: "apps" } })).resolves.toEqual({
      status: "refused",
      reason: "leased-by-another-thread",
    });
    await expect(service.release(fromB)).resolves.toEqual({
      status: "refused",
      reason: "leased-by-another-thread",
    });
    await expect(service.extend({ ...fromB, actor: person, byMinutes: 30 })).resolves.toEqual({
      status: "refused",
      reason: "leased-by-another-thread",
    });
    await expect(
      service.control({
        owner: code(threadA),
        actor: agentOf(threadA),
        leaseId,
        command: { operation: "apps" },
      }),
    ).resolves.toEqual({ status: "answered", result: { kind: "apps", apps: [] } });
  });

  it("caps a thread at two leases and the host at two host-local ones", async () => {
    const { service } = host();
    await acquired(service, threadA);
    await acquired(service, threadA);
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "lease-limit" });
    await expect(
      service.acquire({ owner: code(threadB), actor: agentOf(threadB) }),
    ).resolves.toEqual({ status: "refused", reason: "lease-limit" });
  });

  it("destroys and verifies a lease when it expires", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    service.markTab(leaseId, "opened");
    state.now = START + 29 * MINUTE;
    await service.sweep();
    expect(runningDesktops(backend)).toBe(1);

    state.now = START + 30 * MINUTE;
    await service.sweep();
    expect(runningDesktops(backend)).toBe(0);
    expect(backend.calls().slice(-2)).toEqual(["release", "verifyGone"]);
    await expect(
      service.control({
        owner: code(threadA),
        actor: agentOf(threadA),
        leaseId,
        command: { operation: "apps" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "lease-ended" });
  });

  it("releases an idle lease only while no Desktop tab is open", async () => {
    const { service, state, backend } = host();
    const watched = await acquired(service, threadA);
    await acquired(service, threadB);
    service.markTab(watched, "opened");
    state.now = START + 15 * MINUTE;
    await service.sweep();
    expect(backend.desktops().map((desktop) => String(desktop.handle.leaseId))).toEqual([
      String(watched),
    ]);
  });

  it("destroys and verifies a lease when its thread is archived", async () => {
    const { service, state, backend } = host();
    await acquired(service, threadA);
    state.threads.set(threadA, { active: false, executionPolicy: "full-access" });
    await service.sweep();
    expect(runningDesktops(backend)).toBe(0);
  });

  it("destroys a desktop still being created when its thread ends meanwhile", async () => {
    const fake = createFakeDesktopProvider();
    let finish: () => void = () => undefined;
    const slow: DesktopProvider = {
      ...fake.provider,
      acquire: async (request) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        // A provider that finishes creating despite the cancellation.
        return fake.provider.acquire({ ...request, signal: new AbortController().signal });
      },
    };
    const { service, state } = host({ providers: [{ provider: slow }] });
    const pending = service.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.threads.set(threadA, { active: false, executionPolicy: "full-access" });
    await service.sweep();
    finish();
    const result = await pending;
    expect(result.status).toBe("not-acquired");
    expect(result.status === "not-acquired" ? result.lease.state : undefined).toBe("released");
    expect(fake.backend.desktops()).toEqual([]);
  });

  it("records who ended a lease and why when its provider stops creating it", async () => {
    const fake = createFakeDesktopProvider();
    const honouring: DesktopProvider = {
      ...fake.provider,
      acquire: (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), {
            once: true,
          });
        }),
    };
    const { service, connection } = host({ providers: [{ provider: honouring }] });
    const pending = service.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [record] = connection
      .prepare("SELECT aggregate_id FROM event_journal WHERE event_name = ?")
      .all("desktop.lease-requested@1") as Array<{ aggregate_id: string }>;
    const leaseId = decodeDesktopLeaseId(record?.aggregate_id);
    await expect(
      service.release({ owner: code(threadA), actor: person, leaseId }),
    ).resolves.toMatchObject({
      status: "releasing",
    });
    const result = await pending;

    expect(result.status === "not-acquired" ? result.lease : undefined).toMatchObject({
      state: "failed",
      endReason: "released",
    });
    const last = connection
      .prepare(
        "SELECT payload_json FROM event_journal WHERE aggregate_id = ? ORDER BY aggregate_version DESC LIMIT 1",
      )
      .get(String(leaseId)) as { payload_json: string };
    expect(JSON.parse(last.payload_json)).toMatchObject({
      to: "failed",
      endReason: "released",
      requestedBy: { kind: "local-user" },
    });
  });

  it("still destroys after recipe removal while the retained driver refuses acquire and control", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    state.recipes.delete(threadA);

    await expect(
      service.control({
        owner: code(threadA),
        actor: agentOf(threadA),
        leaseId,
        command: { operation: "apps" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    await service.sweep();
    expect(runningDesktops(backend)).toBe(0);
    expect(backend.calls().filter((call) => call === "control")).toEqual([]);
  });

  it("still destroys after the plugin is disabled and unloaded while acquire and control are refused", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    const [loaded] = state.providers;
    if (loaded === undefined) throw new Error("expected a provider");
    state.providers = [{ provider: loaded.provider, effective: false }];

    await expect(
      service.control({
        owner: code(threadA),
        actor: agentOf(threadA),
        leaseId,
        command: { operation: "apps" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "provider-disabled" });
    await expect(
      service.acquire({ owner: code(threadB), actor: agentOf(threadB) }),
    ).resolves.toEqual({ status: "refused", reason: "provider-disabled" });
    expect(service.destination()).toEqual({
      status: "unavailable",
      kind: "no-provider-configured",
    });

    // The plugin host drops the driver; the lease's retained teardown port still destroys it.
    state.providers = [];
    await service.sweep();
    expect(runningDesktops(backend)).toBe(0);
    expect(backend.calls().filter((call) => call === "acquire")).toHaveLength(1);
  });

  it("refuses an extension the driver does not confirm and keeps the original expiry", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    const fromPerson = { owner: code(threadA), actor: person, leaseId };
    backend.behaviour.declineExtensions = true;

    await expect(service.extend({ ...fromPerson, byMinutes: 30 })).resolves.toEqual({
      status: "refused",
      reason: "extension-unconfirmed",
    });
    state.now = START + 30 * MINUTE;
    await service.sweep();
    expect(runningDesktops(backend)).toBe(0);
  });

  it("extends only for a person, only to the recipe maximum, and only once the driver confirms", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    const lease = { owner: code(threadA), leaseId };

    await expect(
      service.extend({ ...lease, actor: agentOf(threadA), byMinutes: 30 }),
    ).resolves.toEqual({ status: "refused", reason: "agent-cannot-extend" });
    await expect(service.extend({ ...lease, actor: paired, byMinutes: 211 })).resolves.toEqual({
      status: "refused",
      reason: "beyond-maximum",
    });
    const extended = await service.extend({ ...lease, actor: paired, byMinutes: 30 });
    expect(extended.status === "extended" ? extended.lease.expiresAt : undefined).toBe(
      decodeUtcTimestamp(new Date(START + 60 * MINUTE).toISOString()),
    );
    service.markTab(leaseId, "opened");
    state.now = START + 45 * MINUTE;
    await service.sweep();
    expect(runningDesktops(backend)).toBe(1);
  });

  it("keeps an unverified release release-failed and refuses new leases on that provider until it clears", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    backend.behaviour.lingerAfterRelease = true;

    const released = await service.release({ owner: code(threadA), actor: person, leaseId });
    expect(released.status).toBe("release-failed");
    await expect(
      service.acquire({ owner: code(threadB), actor: agentOf(threadB) }),
    ).resolves.toEqual({ status: "refused", reason: "release-pending" });
    await service.sweep();
    expect(backend.calls().filter((call) => call === "release")).toHaveLength(1);

    backend.behaviour.lingerAfterRelease = false;
    await expect(service.retryRelease({ leaseId, actor: agentOf(threadA) })).resolves.toEqual({
      status: "refused",
      reason: "not-permitted",
    });
    const retried = await service.retryRelease({ leaseId, actor: person });
    expect(retried.status).toBe("released");
    state.now += MINUTE;
    await expect(
      service.acquire({ owner: code(threadB), actor: agentOf(threadB) }),
    ).resolves.toMatchObject({ status: "acquired" });
  });

  it("retries a failed release with backoff from the sweep", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    backend.behaviour.lingerAfterRelease = true;
    await service.release({ owner: code(threadA), actor: agentOf(threadA), leaseId });
    backend.behaviour.lingerAfterRelease = false;

    await service.sweep();
    expect(runningDesktops(backend)).toBe(1);
    state.now += 31_000;
    await service.sweep();
    expect(runningDesktops(backend)).toBe(0);
  });

  it("destroys every unreleased lease and orphaned tagged desktop on restart before admitting a new lease", async () => {
    const first = host();
    await acquired(first.service, threadA);
    const otherHost = decodeDesktopHostTag("e1000000-0000-4000-8000-0000000000cc");
    first.backend.plant({
      handle: { leaseId: decodeDesktopLeaseId(randomUUID()), resource: "orphan" },
      hostTag,
      providerExpiresAt: undefined,
    });
    first.backend.plant({
      handle: { leaseId: decodeDesktopLeaseId(randomUUID()), resource: "another-host" },
      hostTag: otherHost,
      providerExpiresAt: undefined,
    });
    const callsBefore = first.backend.calls().length;

    const restarted = first.restart();
    const admitted = await restarted.acquire({ owner: code(threadB), actor: agentOf(threadB) });
    expect(admitted.status).toBe("acquired");

    const afterRestart = first.backend.calls().slice(callsBefore);
    expect(afterRestart.indexOf("acquire")).toBeGreaterThan(afterRestart.lastIndexOf("verifyGone"));
    expect(
      first.backend
        .desktops()
        .map((desktop) => desktop.handle.resource)
        .sort(),
    ).toEqual(["another-host", "desktop-2"]);
  });

  it("finds a killed host's cloud desktops by listing the account each lease recorded", async () => {
    const cloud = createFakeDesktopProvider({
      id: "cloud.example",
      locality: "cloud",
      billed: true,
    });
    const listedAccounts: Array<string> = [];
    // A cloud provider lists one account at a time and cannot list without one.
    const perAccount: DesktopProvider = {
      ...cloud.provider,
      listOwned: async (tag, credentialRef) => {
        listedAccounts.push(String(credentialRef ?? "none"));
        return credentialRef === undefined
          ? { status: "failed", reason: "credential-required" }
          : cloud.provider.listOwned(tag, credentialRef);
      },
    };
    const first = host({ providers: [{ provider: perAccount }] });
    await acquired(first.service, threadA);
    cloud.backend.plant({
      handle: { leaseId: decodeDesktopLeaseId(randomUUID()), resource: "left-by-a-crash" },
      hostTag,
      providerExpiresAt: undefined,
    });

    // The host process is gone; its replacement holds no handle, only the journal.
    const restarted = first.restart();
    await expect(restarted.start()).resolves.toEqual({
      released: 1,
      stillRunning: 0,
      orphansDestroyed: 1,
    });
    expect(listedAccounts).toContain(cloudCredential);
    expect(cloud.backend.desktops()).toEqual([]);
  });

  it("keeps tearing down other leases when a driver throws instead of answering", async () => {
    const healthy = createFakeDesktopProvider();
    const throwing = createFakeDesktopProvider({ id: "throwing-desktop" });
    const throwsAtOnce = (): never => {
      throw new Error("driver bug");
    };
    const harness = host({
      providers: [
        healthy,
        {
          provider: {
            ...throwing.provider,
            release: throwsAtOnce,
            verifyGone: throwsAtOnce,
            listOwned: throwsAtOnce,
          },
        },
      ],
    });
    harness.state.recipes.set(threadA, recipeFor("throwing-desktop"));
    await acquired(harness.service, threadA);
    await acquired(harness.service, threadB);

    harness.state.now = START + 30 * MINUTE;
    await harness.service.sweep();
    expect(healthy.backend.desktops()).toEqual([]);
    await expect(harness.restart().start()).resolves.toMatchObject({ stillRunning: 1 });
  });

  it("never leaves a lease provisioning when the driver throws while creating", async () => {
    const fake = createFakeDesktopProvider();
    const { service } = host({
      providers: [
        {
          provider: {
            ...fake.provider,
            acquire: (): never => {
              throw new Error("driver bug");
            },
          },
        },
      ],
    });
    const result = await service.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    expect(result.status === "not-acquired" ? result.lease.state : result.status).toBe("failed");
  });

  it("journals the expiry the provider ended with when two people extend at once", async () => {
    const fake = createFakeDesktopProvider();
    let providerExpiresAt = "";
    const answers: Array<() => void> = [];
    const harness = host({
      providers: [
        {
          provider: {
            ...fake.provider,
            // The provider applies each extension as it arrives but answers late.
            extend: async (handle, expiresAt) => {
              providerExpiresAt = expiresAt;
              await new Promise<void>((resolve) => answers.push(resolve));
              return fake.provider.extend(handle, expiresAt);
            },
          },
        },
      ],
    });
    const leaseId = await acquired(harness.service, threadA);
    const lease = { owner: code(threadA), leaseId };
    const longer = harness.service.extend({ ...lease, actor: person, byMinutes: 60 });
    const shorter = harness.service.extend({ ...lease, actor: paired, byMinutes: 30 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let turn = 0; turn < 20; turn += 1) {
      // Answer the latest call first, as a provider racing two requests may.
      answers.pop()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const journaled = Math.max(
      ...(await Promise.all([longer, shorter])).map((result) =>
        result.status === "extended" ? Date.parse(result.lease.expiresAt) : 0,
      ),
    );
    expect(journaled).toBe(Date.parse(providerExpiresAt));
  });

  it("refuses a person's Retry on another thread's running lease", async () => {
    const { service, backend } = host();
    const leaseId = await acquired(service, threadA);
    await expect(service.retryRelease({ leaseId, actor: paired })).resolves.toEqual({
      status: "refused",
      reason: "not-permitted",
    });
    expect(runningDesktops(backend)).toBe(1);
  });

  it("refuses operating a lease once the recipe's credential reference changed", async () => {
    const { service, state } = host();
    const leaseId = await acquired(service, threadA);
    state.recipes.set(
      threadA,
      decodeDesktopRecipe({
        ...recipeFor("fake-desktop"),
        credentialRef: "e1000000-0000-4000-8000-0000000000dd",
      }),
    );
    await expect(
      service.control({
        owner: code(threadA),
        actor: agentOf(threadA),
        leaseId,
        command: { operation: "apps" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
  });

  it("refuses a recipe that names a placement its provider does not declare", async () => {
    const { service, state, backend } = host();
    state.recipes.set(
      threadA,
      decodeDesktopRecipe({ ...recipeFor("fake-desktop"), placementId: "here" }),
    );
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    expect(backend.calls()).not.toContain("acquire");
  });

  it("leases a provider with placements only in one it declares, on that placement's locality and billing", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    const spaces: DesktopProvider = {
      ...fake.provider,
      placements: [
        {
          id: decodeDesktopPlacementId("here"),
          displayName: "This machine",
          locality: "host-local",
          billed: false,
        },
        {
          id: decodeDesktopPlacementId("other-machine"),
          displayName: "Your other machine",
          locality: "cloud",
          billed: false,
        },
        {
          id: decodeDesktopPlacementId("own-cloud"),
          displayName: "Your cloud account",
          locality: "cloud",
          billed: true,
        },
      ],
    };
    const { service, state, checkout } = host({ providers: [{ provider: spaces }] });
    const inPlacement = (placementId: string, credentialRef?: string) =>
      decodeDesktopRecipe({
        ...recipeFor("spaces.example", credentialRef),
        placementId,
        ...(placementId === "own-cloud" ? { hourlyCostUsdCents: HOURLY_COST } : {}),
      });

    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    state.recipes.set(threadA, inPlacement("elsewhere"));
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    expect(fake.backend.calls()).not.toContain("acquire");

    state.recipes.set(threadA, inPlacement("here", cloudCredential));
    const here = await service.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    expect(here).toMatchObject({
      status: "acquired",
      lease: { placementId: "here", locality: "host-local", billed: false },
    });
    expect(state.asked).toEqual([]);

    // The billed placement asks even under Full access, and a desktop whose
    // provider set no expiry of its own is not kept, although the provider
    // itself declares no billing.
    state.recipes.set(threadB, inPlacement("own-cloud", cloudCredential));
    const billed = await service.acquire({ owner: code(threadB), actor: agentOf(threadB) });
    expect(state.asked).toEqual(["billed"]);
    expect(billed).toMatchObject({
      status: "not-acquired",
      lease: { state: "failed", placementId: "own-cloud", locality: "cloud", billed: true },
    });
    expect(runningDesktops(fake.backend)).toBe(1);

    // A file leaves the machine for a placement off it, Full access included.
    state.recipes.set(threadC, inPlacement("other-machine", cloudCredential));
    const away = await acquired(service, threadC);
    writeFileSync(join(checkout, "app.bin"), "built app");
    await expect(
      service.transfer({
        owner: code(threadC),
        actor: agentOf(threadC),
        leaseId: away,
        path: "app.bin",
      }),
    ).resolves.toMatchObject({ status: "delivered" });
    expect(state.askedTransfers.map((request) => request.asks)).toEqual(["off-machine"]);
    expect(state.askedTransfers[0]?.provider).toMatchObject({ locality: "cloud", billed: false });
    await service.release({ owner: code(threadC), actor: agentOf(threadC), leaseId: away });
    expect(runningDesktops(fake.backend)).toBe(1);

    // A recipe whose placement alone changed counts as removed.
    if (here.status !== "acquired") throw new Error("expected a lease");
    state.recipes.set(threadA, inPlacement("other-machine", cloudCredential));
    await expect(
      service.control({
        owner: code(threadA),
        actor: agentOf(threadA),
        leaseId: here.lease.leaseId,
        command: { operation: "apps" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    await service.sweep();
    expect(runningDesktops(fake.backend)).toBe(0);
  });

  it("leases a daemon-run provider on its placement with no key, records the daemon, and tears down only through it", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    const spaces: DesktopProvider = {
      ...fake.provider,
      daemon: { socketPath: ".spaces/spaces.sock", methods: [] },
      placements: [
        {
          id: decodeDesktopPlacementId("here"),
          displayName: "This machine",
          locality: "host-local",
          billed: false,
        },
        {
          id: decodeDesktopPlacementId("other-machine"),
          displayName: "Your other machine",
          locality: "cloud",
          billed: false,
        },
      ],
    };
    const { service, state, restart } = host({ providers: [{ provider: spaces }] });
    const inPlacement = (placementId: string, credentialRef?: string) =>
      decodeDesktopRecipe({ ...recipeFor("spaces.example", credentialRef), placementId });

    // A host that cannot name the daemon's user leases nothing through it.
    state.recipes.set(threadA, inPlacement("here"));
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });

    state.daemonUserId = 1_000;
    const running = restart();
    await running.start();
    expect(running.destination()).toMatchObject({
      leasable: [
        {
          providerId: "spaces.example",
          daemon: true,
          placements: [
            { placementId: "here", locality: "host-local", billed: false },
            { placementId: "other-machine", locality: "cloud", billed: false },
          ],
        },
      ],
    });
    // The daemon holds the sign-in, so a recipe naming a key is refused, and
    // a placement off this machine needs none.
    state.recipes.set(threadA, inPlacement("other-machine", cloudCredential));
    await expect(
      running.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    state.recipes.set(threadA, inPlacement("other-machine"));
    const away = await running.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    expect(away).toMatchObject({
      status: "acquired",
      lease: {
        placementId: "other-machine",
        locality: "cloud",
        daemon: { socketPath: ".spaces/spaces.sock", userId: 1_000 },
      },
    });
    expect(away).not.toHaveProperty("lease.credentialRef");

    // Octant now runs as another user, whose daemon never made this desktop:
    // its listing is not the provider confirming absence.
    state.daemonUserId = 1_001;
    await expect(restart().start()).resolves.toMatchObject({ released: 0, stillRunning: 1 });
    expect(runningDesktops(fake.backend)).toBe(1);

    state.daemonUserId = 1_000;
    await expect(restart().start()).resolves.toMatchObject({ released: 1, stillRunning: 0 });
    expect(runningDesktops(fake.backend)).toBe(0);
  });

  it("refuses a recipe that allows network where its desktop cannot have it before journaling anything", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    const spaces: DesktopProvider = {
      ...fake.provider,
      placements: [
        {
          id: decodeDesktopPlacementId("other-machine"),
          displayName: "Your other computer",
          locality: "cloud",
          billed: false,
        },
      ],
    };
    const { service, state, connection } = host({ providers: [{ provider: spaces }] });
    // A recipe saved before the rule existed still reaches the lease service.
    state.recipes.set(
      threadA,
      decodeDesktopRecipe({
        ...recipeFor("spaces.example", cloudCredential),
        placementId: "other-machine",
        network: "allow",
      }),
    );
    const caller = { owner: code(threadA), actor: person, scopeId: "window-1" };
    await expect(service.overview(caller)).resolves.toMatchObject({
      start: { status: "refused", reason: "no-provider-configured" },
    });
    await expect(
      service.acquire({
        ...caller,
        confirmedProvider: decodeDesktopProviderId("spaces.example"),
        confirmedPlacement: decodeDesktopPlacementId("other-machine"),
      }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    expect(state.asked).toEqual([]);
    expect(fake.backend.calls()).not.toContain("acquire");
    expect(
      connection
        .prepare("SELECT COUNT(*) AS rows FROM event_journal WHERE aggregate_type = ?")
        .get("desktop-lease"),
    ).toEqual({ rows: 0 });
  });

  it("runs a desktop on the machine its recipe names, and a confirmation covers only that machine", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    const spaces: DesktopProvider = {
      ...fake.provider,
      placements: [
        {
          id: decodeDesktopPlacementId("other-machine"),
          displayName: "Your other computer",
          locality: "cloud",
          billed: false,
          choosesMachine: true,
        },
      ],
    };
    const { service, state } = host({ providers: [{ provider: spaces }] });
    const studio = { machineId: decodeDesktopMachineId("host-studio"), displayName: "studio" };
    const onMachine = (machine?: typeof studio) =>
      decodeDesktopRecipe({
        ...recipeFor("spaces.example", cloudCredential),
        placementId: "other-machine",
        ...(machine === undefined ? {} : { machine }),
      });
    const caller = { owner: code(threadA), actor: person, scopeId: "window-1" };
    const confirmed = {
      ...caller,
      confirmedProvider: decodeDesktopProviderId("spaces.example"),
      confirmedPlacement: decodeDesktopPlacementId("other-machine"),
    };

    // A placement that chooses a machine leases nothing until the recipe names one.
    state.recipes.set(threadA, onMachine());
    await expect(service.acquire(confirmed)).resolves.toEqual({
      status: "refused",
      reason: "no-provider-configured",
    });

    state.recipes.set(threadA, onMachine(studio));
    await expect(service.overview(caller)).resolves.toMatchObject({
      start: { status: "available", placementId: "other-machine", machine: studio },
    });
    for (const confirmedMachine of [undefined, decodeDesktopMachineId("host-attic")]) {
      await expect(
        service.acquire({
          ...confirmed,
          ...(confirmedMachine === undefined ? {} : { confirmedMachine }),
        }),
      ).resolves.toEqual({ status: "refused", reason: "declined" });
    }
    expect(fake.backend.calls()).not.toContain("acquire");
    const started = await service.acquire({ ...confirmed, confirmedMachine: studio.machineId });
    expect(started).toMatchObject({ status: "acquired", lease: { machine: studio } });

    // Pointing the recipe at another machine ends the desktop on this one.
    state.recipes.set(
      threadA,
      onMachine({ machineId: decodeDesktopMachineId("host-attic"), displayName: "attic" }),
    );
    await service.sweep();
    expect(runningDesktops(fake.backend)).toBe(0);
  });

  it("checks again for a commit that arrives while a sweep is already tearing down", async () => {
    const fake = createFakeDesktopProvider();
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let slowLease = "";
    const harness = host({
      providers: [
        {
          provider: {
            ...fake.provider,
            release: async (handle) => {
              if (String(handle.leaseId) === slowLease) await gate;
              return fake.provider.release(handle);
            },
          },
        },
      ],
    });
    const watched = await acquired(harness.service, threadA);
    slowLease = String(await acquired(harness.service, threadB));
    harness.service.markTab(watched, "opened");
    harness.state.now = START + 15 * MINUTE;
    const first = harness.service.sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.state.threads.set(threadA, { active: false, executionPolicy: "full-access" });
    const second = harness.service.sweep();
    openGate();
    await Promise.all([first, second]);
    expect(fake.backend.desktops()).toEqual([]);
  });

  it("keeps a lease release-failed across restart when its driver is no longer loaded", async () => {
    const first = host();
    await acquired(first.service, threadA);
    first.state.providers = [];

    const restarted = first.restart();
    await expect(restarted.start()).resolves.toEqual({
      released: 0,
      stillRunning: 1,
      orphansDestroyed: 0,
    });
    expect(runningDesktops(first.backend)).toBe(1);
  });

  it("journals each input an agent sends with the agent as actor, before the driver, and never the text", async () => {
    const fake = createFakeDesktopProvider();
    const seenBeforeDriver: Array<number> = [];
    const watching: DesktopProvider = {
      ...fake.provider,
      control: async (handle, command) => {
        seenBeforeDriver.push(operatedEvents(harness.connection).length);
        return fake.provider.control(handle, command);
      },
    };
    const harness = host({ providers: [{ provider: watching }] });
    const leaseId = await acquired(harness.service, threadA);
    const caller = { owner: code(threadA), actor: agentOf(threadA), leaseId };
    const observationId = randomUUID();

    for (const command of [
      { operation: "launch", appId: "notes-app" },
      { operation: "observe", appId: "notes-app", windowId: 1 },
      { operation: "type", observationId, text: "a secret the agent typed" },
      { operation: "press", observationId, key: "Enter" },
      { operation: "apps" },
    ]) {
      await expect(
        harness.service.control({ ...caller, command: decodeComputerControlCommand(command) }),
      ).resolves.toMatchObject({ status: "answered" });
    }

    const operated = operatedEvents(harness.connection);
    expect(operated).toEqual([
      {
        actor: "agent",
        payload: {
          leaseId,
          owner: code(threadA),
          providerId: "fake-desktop",
          operation: "launch",
          appId: "notes-app",
        },
      },
      {
        actor: "agent",
        payload: { leaseId, owner: code(threadA), providerId: "fake-desktop", operation: "type" },
      },
      {
        actor: "agent",
        payload: { leaseId, owner: code(threadA), providerId: "fake-desktop", operation: "press" },
      },
    ]);
    expect(seenBeforeDriver).toEqual([1, 1, 2, 3, 3]);
    expect(JSON.stringify(operated)).not.toContain("secret");

    // Another thread's agent reaches nothing and leaves nothing on record.
    await expect(
      harness.service.control({
        owner: code(threadB),
        actor: agentOf(threadB),
        leaseId,
        command: { operation: "launch", appId: "notes-app" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "leased-by-another-thread" });
    expect(operatedEvents(harness.connection)).toHaveLength(3);
  });
});

function operatedEvents(connection: SqliteConnection) {
  return (
    connection
      .prepare(
        "SELECT actor_kind, payload_json FROM event_journal WHERE event_name = ? ORDER BY global_sequence",
      )
      .all("desktop.operated@1") as Array<{ actor_kind: string; payload_json: string }>
  ).map((row) => ({ actor: row.actor_kind, payload: JSON.parse(row.payload_json) as unknown }));
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function sentEvents(connection: SqliteConnection) {
  return (
    connection
      .prepare(
        "SELECT actor_kind, payload_json FROM event_journal WHERE event_name = ? ORDER BY global_sequence",
      )
      .all("desktop.artifact-sent@1") as Array<{ actor_kind: string; payload_json: string }>
  ).map((row) => ({ actor: row.actor_kind, payload: JSON.parse(row.payload_json) as unknown }));
}

// Only Linux names the file an open handle reached; elsewhere every read
// refuses `path-unverifiable`, which the artifact read's own suite covers.
describe.runIf(process.platform === "linux")("desktop artifact transfer", () => {
  it("sends one checkout-relative file and journals its path, size, and SHA-256 before delivery", async () => {
    const fake = createFakeDesktopProvider();
    let journaledFirst = false;
    const watching: DesktopProvider = {
      ...fake.provider,
      deliver: async (handle, name, bytes) => {
        journaledFirst = sentEvents(harness.connection).length === 1;
        return fake.provider.deliver(handle, name, bytes);
      },
    };
    const harness = host({ providers: [{ provider: watching }] });
    const { service, checkout, connection } = harness;
    const backend = fake.backend;
    mkdirSync(join(checkout, "dist"));
    writeFileSync(join(checkout, "dist", "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);

    const result = await service.transfer({
      owner: code(threadA),
      actor: agentOf(threadA),
      leaseId,
      path: "./dist//app.bin",
    });

    const artifact = {
      path: "dist/app.bin",
      name: "app.bin",
      size: 9,
      sha256: sha256("built app"),
    };
    expect(result).toEqual({ status: "delivered", artifact });
    expect(backend.delivered()).toEqual([
      {
        resource: expect.any(String),
        name: "app.bin",
        bytes: new TextEncoder().encode("built app"),
      },
    ]);
    expect(sentEvents(connection)).toEqual([
      {
        actor: "agent",
        payload: { leaseId, owner: code(threadA), providerId: "fake-desktop", ...artifact },
      },
    ]);
    expect(journaledFirst).toBe(true);
    // The lease's history still replays after a transfer, so release verifies as before.
    await expect(
      service.release({ owner: code(threadA), actor: person, leaseId }),
    ).resolves.toMatchObject({ status: "released" });
  });

  it("refuses absolute, escaping, symlinked, .git, oversized, and non-file paths without sending anything", async () => {
    const { service, backend, checkout, connection } = host();
    const outside = join(checkout, "..", "outside.txt");
    writeFileSync(outside, "host secret");
    mkdirSync(join(checkout, "dist"));
    writeFileSync(join(checkout, "dist", "app.bin"), "built app");
    symlinkSync(outside, join(checkout, "dist", "escape.bin"));
    symlinkSync(join(checkout, "dist", "app.bin"), join(checkout, "dist", "inside.bin"));
    symlinkSync(join(checkout, "dist"), join(checkout, "linked"));
    mkdirSync(join(checkout, ".git"));
    writeFileSync(join(checkout, ".git", "config"), "[remote]");
    // Sparse: one byte over the limit costs no disk.
    writeFileSync(join(checkout, "dist", "huge.bin"), "");
    truncateSync(join(checkout, "dist", "huge.bin"), DESKTOP_ARTIFACT_MAXIMUM_BYTES + 1);
    const leaseId = await acquired(service, threadA);
    const send = (path: string) =>
      service.transfer({ owner: code(threadA), actor: agentOf(threadA), leaseId, path });

    for (const [path, reason] of [
      [outside, "path-absolute"],
      ["../outside.txt", "path-escapes-root"],
      ["dist/../../outside.txt", "path-escapes-root"],
      ["dist/escape.bin", "path-symlink"],
      ["dist/inside.bin", "path-symlink"],
      ["linked/app.bin", "path-symlink"],
      [".git/config", "path-in-git"],
      ["dist/huge.bin", "too-large"],
      ["dist", "not-a-file"],
      ["dist/missing.bin", "not-found"],
      ["", "path-invalid"],
    ] as const) {
      await expect(send(path)).resolves.toEqual({ status: "refused", reason });
    }
    expect(backend.calls()).not.toContain("deliver");
    expect(sentEvents(connection)).toEqual([]);
  });

  it("refuses in Plan, and below Full access asks with the path, size, hash, and destination", async () => {
    const { service, state, backend, checkout, connection } = host({
      executionPolicy: "approval-gated",
    });
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    const fromAgent = { owner: code(threadA), actor: agentOf(threadA), leaseId, path: "app.bin" };

    state.answer = "declined";
    await expect(service.transfer(fromAgent)).resolves.toEqual({
      status: "refused",
      reason: "declined",
    });
    expect(state.askedTransfers).toEqual([
      {
        owner: code(threadA),
        leaseId,
        provider: {
          providerId: "fake-desktop",
          displayName: "Fake desktop",
          locality: "host-local",
          billed: false,
        },
        asks: "in-thread",
        artifact: { path: "app.bin", name: "app.bin", size: 9, sha256: sha256("built app") },
      },
    ]);
    expect(backend.calls()).not.toContain("deliver");
    expect(sentEvents(connection)).toEqual([]);

    state.answer = "approved";
    await expect(service.transfer(fromAgent)).resolves.toMatchObject({ status: "delivered" });
    // A person who sends a file to a host-local desktop has already decided.
    await expect(service.transfer({ ...fromAgent, actor: person })).resolves.toMatchObject({
      status: "delivered",
    });
    expect(state.askedTransfers).toHaveLength(2);

    state.threads.set(threadA, { active: true, executionPolicy: "plan" });
    await expect(service.transfer({ ...fromAgent, actor: person })).resolves.toEqual({
      status: "refused",
      reason: "plan-mode",
    });
    expect(state.askedTransfers).toHaveLength(2);
  });

  it("asks an agent's transfer where the agent's turn asks, and only there", async () => {
    const { service, state, checkout, connection } = host({ executionPolicy: "approval-gated" });
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    const askedInThread: Array<string> = [];
    const fromAgent = {
      owner: code(threadA),
      actor: agentOf(threadA),
      leaseId,
      path: "app.bin",
      confirm: async (request: DesktopTransferConfirmation) => {
        askedInThread.push(`${request.artifact.path} ${request.artifact.sha256}`);
        return "declined" as const;
      },
    };

    await expect(service.transfer(fromAgent)).resolves.toEqual({
      status: "refused",
      reason: "declined",
    });
    expect(askedInThread).toEqual([`app.bin ${sha256("built app")}`]);
    expect(state.askedTransfers).toEqual([]);
    expect(sentEvents(connection)).toEqual([]);

    await expect(
      service.transfer({ ...fromAgent, confirm: async () => "approved" }),
    ).resolves.toMatchObject({ status: "delivered" });
    expect(sentEvents(connection)).toMatchObject([{ actor: "agent" }]);
    expect(state.askedTransfers).toEqual([]);
  });

  it("asks an agent's transfer on a Full access thread when its turn runs lower or the thread read outside content", async () => {
    const { service, checkout, connection } = host({ executionPolicy: "full-access" });
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    const asked: Array<string> = [];
    const fromAgent = (
      executionPolicy: ProviderExecutionPolicy,
      externalContentIngested: boolean,
    ) => ({
      owner: code(threadA),
      actor: agentOf(threadA),
      leaseId,
      path: "app.bin",
      turn: { executionPolicy, externalContentIngested },
      confirm: async () => {
        asked.push(`${executionPolicy} ${String(externalContentIngested)}`);
        return "declined" as const;
      },
    });

    for (const [executionPolicy, tainted] of [
      ["approval-gated", false],
      ["auto-accept-edits", false],
      ["full-access", true],
    ] as const) {
      await expect(service.transfer(fromAgent(executionPolicy, tainted))).resolves.toEqual({
        status: "refused",
        reason: "declined",
      });
    }
    await expect(service.transfer(fromAgent("plan", false))).resolves.toEqual({
      status: "refused",
      reason: "plan-mode",
    });
    expect(asked).toEqual(["approval-gated false", "auto-accept-edits false", "full-access true"]);
    expect(sentEvents(connection)).toEqual([]);

    await expect(service.transfer(fromAgent("full-access", false))).resolves.toMatchObject({
      status: "delivered",
    });
    expect(asked).toHaveLength(3);
  });

  it("always asks before a file leaves the machine for a cloud desktop, Full access included", async () => {
    const cloud = createFakeDesktopProvider({
      id: "cloud.example",
      locality: "cloud",
      billed: true,
    });
    const { service, state, checkout } = host({ providers: [cloud] });
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    for (const actor of [agentOf(threadA), person]) {
      await expect(
        service.transfer({ owner: code(threadA), actor, leaseId, path: "app.bin" }),
      ).resolves.toMatchObject({ status: "delivered" });
    }
    expect(state.askedTransfers.map((request) => request.asks)).toEqual([
      "off-machine",
      "off-machine",
    ]);
  });

  it("delivers the bytes that were approved even when the file changes while a person decides", async () => {
    const { service, state, backend, checkout, connection } = host({
      executionPolicy: "approval-gated",
    });
    const file = join(checkout, "app.bin");
    writeFileSync(file, "approved build");
    const leaseId = await acquired(service, threadA);
    state.whileDeciding = () => writeFileSync(file, "something else entirely");

    await expect(
      service.transfer({ owner: code(threadA), actor: agentOf(threadA), leaseId, path: "app.bin" }),
    ).resolves.toMatchObject({
      status: "delivered",
      artifact: { sha256: sha256("approved build") },
    });
    expect(backend.delivered().map((delivery) => new TextDecoder().decode(delivery.bytes))).toEqual(
      ["approved build"],
    );
    expect(sentEvents(connection)[0]?.payload).toMatchObject({ sha256: sha256("approved build") });
  });

  it("refuses when the posture or the lease changes while a person decides", async () => {
    const { service, state, backend, checkout } = host({ executionPolicy: "approval-gated" });
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    const fromAgent = { owner: code(threadA), actor: agentOf(threadA), leaseId, path: "app.bin" };

    state.whileDeciding = () => {
      state.threads.set(threadA, { active: true, executionPolicy: "full-access" });
    };
    await expect(service.transfer(fromAgent)).resolves.toEqual({
      status: "refused",
      reason: "declined",
    });
    state.threads.set(threadA, { active: true, executionPolicy: "approval-gated" });
    state.whileDeciding = () => {
      void service.release({ owner: code(threadA), actor: person, leaseId });
    };
    await expect(service.transfer(fromAgent)).resolves.toEqual({
      status: "refused",
      reason: "lease-ended",
    });
    expect(backend.calls()).not.toContain("deliver");
  });

  it("holds one transfer's bytes per lease at a time, so concurrent transfers cannot multiply them", async () => {
    const { service, state, backend, checkout } = host({ executionPolicy: "approval-gated" });
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    const fromAgent = { owner: code(threadA), actor: agentOf(threadA), leaseId, path: "app.bin" };
    let answer: () => void = () => undefined;
    const asking = new Promise<void>((asked) => {
      state.whileDeciding = () =>
        new Promise<void>((resolve) => {
          answer = resolve;
          asked();
        });
    });

    const first = service.transfer(fromAgent);
    await asking;
    await expect(service.transfer(fromAgent)).resolves.toEqual({
      status: "refused",
      reason: "transfer-in-progress",
    });
    expect(state.askedTransfers).toHaveLength(1);
    answer();
    await expect(first).resolves.toMatchObject({ status: "delivered" });

    state.whileDeciding = () => undefined;
    await expect(service.transfer(fromAgent)).resolves.toMatchObject({ status: "delivered" });
    expect(backend.delivered()).toHaveLength(2);
  });

  it("refuses when the thread's root changes while the transfer waits behind another lease change", async () => {
    const fake = createFakeDesktopProvider();
    const harness = host({
      executionPolicy: "approval-gated",
      providers: [
        {
          provider: {
            ...fake.provider,
            // The extension holds the lease's order while the thread moves to another root.
            extend: async (handle, expiresAt) => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              harness.state.roots.set(threadA, join(harness.checkout, "elsewhere"));
              return fake.provider.extend(handle, expiresAt);
            },
          },
        },
      ],
    });
    const { service, state, checkout } = harness;
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    let extending: Promise<unknown> = Promise.resolve();
    state.whileDeciding = () => {
      extending = service.extend({ owner: code(threadA), actor: person, leaseId, byMinutes: 30 });
    };

    await expect(
      service.transfer({ owner: code(threadA), actor: agentOf(threadA), leaseId, path: "app.bin" }),
    ).resolves.toEqual({ status: "refused", reason: "declined" });
    await expect(extending).resolves.toMatchObject({ status: "extended" });
    expect(fake.backend.calls()).not.toContain("deliver");
  });

  it("refuses another thread's transfer, a system transfer, and one with no root", async () => {
    const { service, state, checkout } = host();
    writeFileSync(join(checkout, "app.bin"), "built app");
    const leaseId = await acquired(service, threadA);
    await expect(
      service.transfer({ owner: code(threadB), actor: agentOf(threadB), leaseId, path: "app.bin" }),
    ).resolves.toEqual({ status: "refused", reason: "leased-by-another-thread" });
    await expect(
      service.transfer({ owner: code(threadA), actor: system, leaseId, path: "app.bin" }),
    ).resolves.toEqual({ status: "refused", reason: "not-permitted" });
    state.roots.delete(threadA);
    await expect(
      service.transfer({ owner: code(threadA), actor: agentOf(threadA), leaseId, path: "app.bin" }),
    ).resolves.toEqual({ status: "refused", reason: "no-root" });
  });
});

describe("desktop lease service for a person's Desktop tab", () => {
  const windowScope = "e1000000-0000-4000-8000-0000000000c1";
  const deviceScope = String((paired as Extract<EventActor, { kind: "remote-device" }>).deviceId);
  const at = (threadId: string, actor: EventActor = person, scopeId = windowScope) => ({
    owner: code(threadId),
    actor,
    scopeId,
  });

  async function viewing(
    service: DesktopLeaseService,
    leaseId: DesktopLeaseId,
    caller = at(threadA),
  ) {
    const opened = await service.openView({ ...caller, leaseId });
    if (opened.status !== "viewing") throw new Error(`no view: ${JSON.stringify(opened)}`);
    return opened.viewId;
  }

  it("lets a person watch and operate the thread's desktop, journaling each press as theirs and asking nothing", async () => {
    const harness = host({ executionPolicy: "approval-gated" });
    const { service, state, backend, connection } = harness;
    const started = await service.acquire(at(threadA));
    if (started.status !== "acquired") throw new Error("not acquired");
    const leaseId = started.lease.leaseId;
    const viewId = await viewing(service, leaseId);

    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toMatchObject({
      status: "frame",
      frame: { mediaType: "image/png", width: 1, height: 1 },
    });
    for (const event of [
      { kind: "pointer", action: "move", x: 4, y: 4 },
      { kind: "pointer", action: "down", button: "left", x: 4, y: 4 },
      { kind: "pointer", action: "up", button: "left", x: 4, y: 4 },
      { kind: "text", text: "a secret the person typed" },
      { kind: "key", action: "down", key: "Enter" },
      { kind: "key", action: "up", key: "Enter" },
    ] as const) {
      await expect(service.input({ ...at(threadA), leaseId, viewId, event })).resolves.toEqual({
        status: "delivered",
      });
    }
    const pairedView = await viewing(service, leaseId, at(threadA, paired, deviceScope));
    await expect(
      service.input({
        ...at(threadA, paired, deviceScope),
        leaseId,
        viewId: pairedView,
        event: { kind: "scroll", x: 4, y: 4, deltaX: 0, deltaY: 120 },
      }),
    ).resolves.toEqual({ status: "delivered" });

    expect(state.asked).toEqual([]);
    expect(backend.inputs()).toHaveLength(7);
    const operated = operatedEvents(connection);
    expect(
      operated.map((row) => [row.actor, (row.payload as { operation: string }).operation]),
    ).toEqual([
      ["local-user", "click"],
      ["local-user", "type"],
      ["local-user", "press"],
      ["remote-device", "scroll"],
    ]);
    expect(JSON.stringify(operated)).not.toContain("secret");
  });

  it("refuses a view of another thread's lease, to an agent, and to a window that may not open the thread", async () => {
    const { service, state, backend } = host();
    const leaseId = await acquired(service, threadA);
    await expect(service.openView({ ...at(threadB), leaseId })).resolves.toEqual({
      status: "refused",
      reason: "leased-by-another-thread",
    });
    await expect(
      service.openView({ owner: code(threadA), actor: agentOf(threadA), leaseId }),
    ).resolves.toEqual({ status: "refused", reason: "not-permitted" });
    await expect(
      service.openView({ owner: code(threadA), actor: person, leaseId }),
    ).resolves.toEqual({
      status: "refused",
      reason: "not-permitted",
    });
    state.deniedScopes.add(windowScope);
    await expect(service.openView({ ...at(threadA), leaseId })).resolves.toEqual({
      status: "refused",
      reason: "not-permitted",
    });
    expect(backend.calls()).not.toContain("screen");
  });

  it("keeps a view to the window that opened it, and a restarted host holds no view and reconnects nothing", async () => {
    const harness = host();
    const leaseId = await acquired(harness.service, threadA);
    const viewId = await viewing(harness.service, leaseId);
    const otherWindow = "e1000000-0000-4000-8000-0000000000c2";
    await expect(
      harness.service.frame({ ...at(threadA, person, otherWindow), leaseId, viewId }),
    ).resolves.toEqual({ status: "refused", reason: "view-ended" });
    await expect(
      harness.service.input({
        ...at(threadA, paired, deviceScope),
        leaseId,
        viewId,
        event: { kind: "pointer", action: "down", x: 1, y: 1 },
      }),
    ).resolves.toEqual({ status: "refused", reason: "view-ended" });

    const restarted = harness.restart();
    await restarted.start();
    await expect(restarted.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "refused",
      reason: "view-ended",
    });
    await expect(restarted.openView({ ...at(threadA), leaseId })).resolves.toEqual({
      status: "refused",
      reason: "lease-ended",
    });
    await expect(restarted.overview(at(threadA))).resolves.toMatchObject({
      status: "overview",
      leases: [{ leaseId, state: "released", endReason: "host-restart" }],
    });
    expect(operatedEvents(harness.connection)).toEqual([]);
  });

  it("holds idle release off while a view is read, and lets it lapse once nobody reads it", async () => {
    const { service, state, backend } = host();
    state.recipes.set(
      threadA,
      decodeDesktopRecipe({ ...recipeFor("fake-desktop"), leaseMinutes: 60 }),
    );
    const leaseId = await acquired(service, threadA);
    const viewId = await viewing(service, leaseId);
    for (let minute = 1; minute <= 16; minute += 1) {
      state.now = START + minute * MINUTE;
      await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toMatchObject({
        status: "frame",
      });
      await service.sweep();
    }
    expect(backend.desktops()).toHaveLength(1);

    state.now += MINUTE;
    await service.sweep();
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "refused",
      reason: "view-ended",
    });
    state.now += 15 * MINUTE;
    await service.sweep();
    expect(backend.desktops()).toHaveLength(0);
    await expect(service.overview(at(threadA))).resolves.toMatchObject({
      leases: [{ leaseId, state: "released", endReason: "idle" }],
    });
  });

  it("ends a view when its tab closes, and when its lease ends", async () => {
    const { service, backend } = host();
    const leaseId = await acquired(service, threadA);
    const closing = await viewing(service, leaseId);
    await expect(service.closeView({ ...at(threadA), leaseId, viewId: closing })).resolves.toEqual({
      status: "view-closed",
    });
    await expect(service.frame({ ...at(threadA), leaseId, viewId: closing })).resolves.toEqual({
      status: "refused",
      reason: "view-ended",
    });
    const open = await viewing(service, leaseId);
    await service.release({ ...at(threadA), leaseId });
    await expect(service.frame({ ...at(threadA), leaseId, viewId: open })).resolves.toEqual({
      status: "refused",
      reason: "view-ended",
    });
    expect(backend.calls().filter((call) => call === "close-screen")).toHaveLength(2);
  });

  it("caps the views one lease holds", async () => {
    const { service } = host();
    const leaseId = await acquired(service, threadA);
    for (let view = 0; view < 4; view += 1) await viewing(service, leaseId);
    await expect(service.openView({ ...at(threadA), leaseId })).resolves.toEqual({
      status: "refused",
      reason: "view-limit",
    });
  });

  it("passes on no frame larger than the recipe's screen or not the image it claims to be", async () => {
    const fake = createFakeDesktopProvider({
      behaviour: {
        frame: { mediaType: "image/png", width: 4_000, height: 10, bytes: new Uint8Array(32) },
      },
    });
    const { service } = host({ providers: [fake] });
    const leaseId = await acquired(service, threadA);
    const viewId = await viewing(service, leaseId);
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "no-frame",
    });
    fake.backend.behaviour.frame = {
      mediaType: "image/png",
      width: 1,
      height: 1,
      bytes: new TextEncoder().encode("<svg onload=alert(1)>"),
    };
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "no-frame",
    });
    // A JPEG's own frame header names its size, which a small file can set
    // far past the screen; the declared size must match it.
    const jpeg = (width: number, height: number) =>
      new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xe0,
        0x00,
        0x04,
        0x00,
        0x00,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        height >> 8,
        height & 0xff,
        width >> 8,
        width & 0xff,
      ]);
    fake.backend.behaviour.frame = {
      mediaType: "image/jpeg",
      width: 1,
      height: 1,
      bytes: jpeg(60_000, 60_000),
    };
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "no-frame",
    });
    fake.backend.behaviour.frame = {
      mediaType: "image/jpeg",
      width: 1280,
      height: 800,
      bytes: jpeg(1280, 800),
    };
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toMatchObject({
      status: "frame",
    });
    // A driver's media type becomes the answer's content type, so only the
    // two image types pass, however image-like the bytes are.
    const html: string = "text/html";
    fake.backend.behaviour.frame = {
      ...FAKE_DESKTOP_FRAME,
      mediaType: html as DesktopFrame["mediaType"],
    };
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "no-frame",
    });
  });

  it("bounds a running desktop's frames by the screen it started with after a person edits the recipe", async () => {
    const png = (width: number, height: number) => {
      const bytes = new Uint8Array(24);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      bytes.set(new TextEncoder().encode("IHDR"), 12);
      const view = new DataView(bytes.buffer);
      view.setUint32(16, width);
      view.setUint32(20, height);
      return { mediaType: "image/png" as const, width, height, bytes };
    };
    const fake = createFakeDesktopProvider({ behaviour: { frame: png(1280, 800) } });
    const { service, state } = host({ providers: [fake] });
    const leaseId = await acquired(service, threadA);
    const viewId = await viewing(service, leaseId);

    // A smaller screen applies to the next desktop; this one keeps showing.
    state.recipes.set(
      threadA,
      decodeDesktopRecipe({ ...recipeFor("fake-desktop"), screen: { width: 1024, height: 768 } }),
    );
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toMatchObject({
      status: "frame",
      frame: { width: 1280, height: 800 },
    });

    // A larger one does not let this desktop's driver pass a frame past its own screen.
    state.recipes.set(
      threadA,
      decodeDesktopRecipe({ ...recipeFor("fake-desktop"), screen: { width: 1920, height: 1080 } }),
    );
    fake.backend.behaviour.frame = png(1920, 1080);
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "no-frame",
    });
  });

  it("tells a person whether the thread can start a desktop, and why not", async () => {
    const { service, state } = host();
    await expect(service.overview(at(threadA))).resolves.toEqual({
      status: "overview",
      leases: [],
      providers: [
        {
          providerId: "fake-desktop",
          displayName: "Fake desktop",
          locality: "host-local",
          billed: false,
        },
      ],
      start: {
        status: "available",
        provider: {
          providerId: "fake-desktop",
          displayName: "Fake desktop",
          locality: "host-local",
          billed: false,
        },
      },
    });
    state.recipes.delete(threadA);
    await expect(service.overview(at(threadA))).resolves.toMatchObject({
      status: "overview",
      start: { status: "refused", reason: "no-provider-configured" },
    });
    state.deniedScopes.add(windowScope);
    await expect(service.overview(at(threadA))).resolves.toEqual({
      status: "refused",
      reason: "not-permitted",
    });
  });

  it("tells a person when a view is refused because the session could be read on its way, and nothing else", async () => {
    const fake = createFakeDesktopProvider();
    let route: "private" | "readable" | "down" = "readable";
    const answer = (): { readonly status: "refused"; readonly reason: string } | undefined =>
      route === "readable"
        ? { status: "refused", reason: DESKTOP_SESSION_READABLE }
        : route === "down"
          ? { status: "refused", reason: "route-unverified" }
          : undefined;
    const relayed: DesktopProvider = {
      ...fake.provider,
      screen: async (handle) => {
        const refusedNow = answer();
        if (refusedNow !== undefined) return refusedNow;
        const opened = await fake.provider.screen(handle);
        if (opened.status !== "ready") return opened;
        return {
          status: "ready",
          screen: {
            ...opened.screen,
            frame: async () => answer() ?? opened.screen.frame(),
            input: async (event) => answer() ?? opened.screen.input(event),
          },
        };
      },
    };
    const { service } = host({ providers: [{ provider: relayed }] });
    const leaseId = await acquired(service, threadA);
    await expect(service.openView({ ...at(threadA), leaseId })).resolves.toEqual({
      status: "refused",
      reason: "session-readable",
    });
    // Any other reason a driver gives stays with the host.
    route = "down";
    await expect(service.openView({ ...at(threadA), leaseId })).resolves.toEqual({
      status: "refused",
      reason: "provider-unavailable",
    });

    route = "private";
    const viewId = await viewing(service, leaseId);
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toMatchObject({
      status: "frame",
    });
    // The route falls back to one that can read the session while the view is open.
    route = "readable";
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "refused",
      reason: "session-readable",
    });
    await expect(
      service.input({
        ...at(threadA),
        leaseId,
        viewId,
        event: { kind: "key", action: "down", key: "Enter" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "session-readable" });
    route = "down";
    await expect(service.frame({ ...at(threadA), leaseId, viewId })).resolves.toEqual({
      status: "no-frame",
    });
  });

  it("names a provider and a placement without the space a long name was cut at", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    const cut = (name: string) => `${name}${"n".repeat(127 - name.length)} cut here`;
    const spaces: DesktopProvider = {
      ...fake.provider,
      displayName: cut("p"),
      daemon: { socketPath: ".spaces/spaces.sock", methods: [] },
      placements: [
        {
          id: decodeDesktopPlacementId("here"),
          displayName: cut("q"),
          locality: "host-local",
          billed: false,
        },
      ],
    };
    const { service, state } = host({ providers: [{ provider: spaces }] });
    state.daemonUserId = 1_000;

    expect(service.destination()).toMatchObject({
      status: "leasable",
      leasable: [
        {
          displayName: `p${"n".repeat(126)}`,
          placements: [{ displayName: `q${"n".repeat(126)}` }],
        },
      ],
    });
  });

  it("says a key missing from the credential store is why a cloud desktop did not start", async () => {
    const fake = createFakeDesktopProvider({ id: "fake-cloud", locality: "cloud", billed: true });
    const lostKey: DesktopProvider = {
      ...fake.provider,
      acquire: async () => ({ status: "refused", reason: DESKTOP_CREDENTIAL_MISSING }),
    };
    const { service } = host({ providers: [{ provider: lostKey }] });

    const result = await service.acquire({
      owner: code(threadA),
      actor: agentOf(threadA),
      confirmedProvider: decodeDesktopProviderId("fake-cloud"),
    });
    expect(result).toMatchObject({
      status: "not-acquired",
      lease: {
        state: "refused",
        credentialRef: cloudCredential,
        credentialMissing: true,
      },
    });
    expect(result).not.toMatchObject({ lease: { credentialRejected: true } });
  });

  it("lists the person's machines for a placement that chooses one, only to a local window", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    let listed: Awaited<ReturnType<NonNullable<DesktopProvider["listMachines"]>>> = {
      status: "listed",
      machines: [
        { id: "host-studio", name: "  studio  ", online: true },
        { id: "host-attic", name: "", online: false },
        { id: "../not an id", name: "planted", online: true },
        { id: "host-long", name: `${"n".repeat(127)} cut here`, online: true },
      ],
    };
    const asked: Array<string> = [];
    const spaces: DesktopProvider = {
      ...fake.provider,
      daemon: { socketPath: ".spaces/spaces.sock", methods: [] },
      placements: [
        {
          id: decodeDesktopPlacementId("here"),
          displayName: "This computer",
          locality: "host-local",
          billed: false,
        },
        {
          id: decodeDesktopPlacementId("other-machine"),
          displayName: "Your other computer",
          locality: "cloud",
          billed: false,
          choosesMachine: true,
        },
      ],
      listMachines: async (placementId) => {
        asked.push(String(placementId));
        return listed;
      },
    };
    const { state, restart } = host({ providers: [{ provider: spaces }] });
    state.daemonUserId = 1_000;
    const service = restart();
    await service.start();
    const ask = (actor: EventActor, placementId = "other-machine", providerId = "spaces.example") =>
      service.recipeMachines({
        actor,
        providerId: decodeDesktopProviderId(providerId),
        placementId: decodeDesktopPlacementId(placementId),
      });

    await expect(ask(person)).resolves.toEqual({
      status: "recipe-machines",
      machines: [
        { machineId: "host-studio", displayName: "studio", online: true },
        { machineId: "host-attic", displayName: "host-attic", online: false },
        // A name cut at 128 characters never ends in the space it was cut at.
        { machineId: "host-long", displayName: "n".repeat(127), online: true },
      ],
    });
    // A paired device cannot set a recipe, so it is never shown the machines.
    for (const refusedAsk of [ask(paired), ask(agentOf(threadA)), ask(system)]) {
      await expect(refusedAsk).resolves.toEqual({ status: "refused", reason: "not-permitted" });
    }
    // Only a placement that chooses a machine, of a provider offered for leasing.
    await expect(ask(person, "here")).resolves.toEqual({
      status: "refused",
      reason: "no-provider-configured",
    });
    await expect(ask(person, "other-machine", "fake-desktop")).resolves.toEqual({
      status: "refused",
      reason: "no-provider-configured",
    });
    state.providers = [{ provider: spaces, effective: false }];
    await expect(ask(person)).resolves.toEqual({
      status: "refused",
      reason: "no-provider-configured",
    });
    state.providers = [{ provider: spaces, effective: true }];
    listed = { status: "not-connected" };
    await expect(ask(person)).resolves.toEqual({
      status: "refused",
      reason: "provider-unavailable",
    });
    expect(asked).toEqual(["other-machine", "other-machine"]);
  });

  it("tells a person a thread in Plan cannot start a desktop, and still refuses one it is asked for", async () => {
    const { service, state, backend } = host();
    state.threads.set(threadA, { active: true, executionPolicy: "plan" });
    await expect(service.overview(at(threadA))).resolves.toMatchObject({
      status: "overview",
      start: { status: "refused", reason: "plan-mode" },
    });
    await expect(service.acquire(at(threadA))).resolves.toEqual({
      status: "refused",
      reason: "plan-mode",
    });
    expect(backend.calls()).not.toContain("acquire");
    state.threads.set(threadA, { active: true, executionPolicy: "approval-gated" });
    await expect(service.overview(at(threadA))).resolves.toMatchObject({
      start: { status: "available" },
    });
  });
});

function spendEvents(connection: SqliteConnection, eventName: string) {
  return (
    connection
      .prepare(
        "SELECT actor_kind, payload_json FROM event_journal WHERE event_name = ? ORDER BY global_sequence",
      )
      .all(eventName) as Array<{ actor_kind: string; payload_json: string }>
  ).map((row) => ({ actor: row.actor_kind, payload: JSON.parse(row.payload_json) as unknown }));
}

describe("desktop lease service spend cap for billed desktops", () => {
  const billedCloud = () =>
    createFakeDesktopProvider({ id: "cloud.example", locality: "cloud", billed: true });
  /** $1.00 an hour over the recipe's four-hour maximum. */
  const ESTIMATE = 400;

  it("starts no billed desktop until a person sets a cap, and journals the refusal with its figures", async () => {
    const cloud = billedCloud();
    const { service, connection } = host({ providers: [cloud], spendCap: null });

    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "spend-cap-unset" });
    expect(cloud.backend.calls()).not.toContain("acquire");
    expect(spendEvents(connection, "desktop.billed-lease-refused@1")).toEqual([
      {
        actor: "agent",
        payload: {
          owner: code(threadA),
          providerId: "cloud.example",
          reason: "spend-cap-unset",
          month: "2026-10",
          estimateUsdCents: ESTIMATE,
          spentUsdCents: 0,
        },
      },
    ]);
    // A person's Start shows the same refusal before it is pressed.
    const overview = await service.overview({
      owner: code(threadA),
      actor: person,
      scopeId: "window-1",
    });
    expect(overview).toMatchObject({ start: { status: "refused", reason: "spend-cap-unset" } });

    service.setSpendCap({ actor: person, monthlyCapUsdCents: 1_000 });
    const started = await service.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    expect(started).toMatchObject({
      status: "acquired",
      lease: { spend: { hourlyCostUsdCents: HOURLY_COST, estimateUsdCents: ESTIMATE } },
    });
  });

  it("refuses a lease whose estimate would pass the cap, tells the person, and ends no running desktop", async () => {
    const cloud = billedCloud();
    const { service, state, connection } = host({ providers: [cloud], spendCap: 1_000 });

    await acquired(service, threadA);
    await acquired(service, threadB);
    expect(service.spend({ actor: person })).toEqual({
      status: "spend",
      summary: { month: "2026-10", spentUsdCents: 2 * ESTIMATE, monthlyCapUsdCents: 1_000 },
    });

    await expect(
      service.acquire({ owner: code(threadC), actor: agentOf(threadC) }),
    ).resolves.toEqual({ status: "refused", reason: "spend-cap-reached" });
    const overview = await service.overview({
      owner: code(threadC),
      actor: person,
      scopeId: "window-1",
    });
    expect(overview).toMatchObject({ start: { status: "refused", reason: "spend-cap-reached" } });
    expect(spendEvents(connection, "desktop.billed-lease-refused@1").at(-1)?.payload).toEqual({
      owner: code(threadC),
      providerId: "cloud.example",
      reason: "spend-cap-reached",
      month: "2026-10",
      estimateUsdCents: ESTIMATE,
      spentUsdCents: 2 * ESTIMATE,
      monthlyCapUsdCents: 1_000,
    });

    // Lowering the cap below what runs ends neither desktop.
    service.setSpendCap({ actor: person, monthlyCapUsdCents: 100 });
    state.now += 5 * MINUTE;
    await service.sweep();
    expect(runningDesktops(cloud.backend)).toBe(2);
    expect(
      service
        .overview({ owner: code(threadA), actor: person, scopeId: "window-1" })
        .then((answer) => (answer.status === "overview" ? answer.leases[0]?.state : undefined)),
    ).resolves.toBe("ready");
  });

  it("counts a released lease at its running time, so the room it frees starts the next one", async () => {
    const cloud = billedCloud();
    const { service, state } = host({ providers: [cloud], spendCap: 900 });

    const first = await acquired(service, threadA);
    await acquired(service, threadB);
    await expect(
      service.acquire({ owner: code(threadC), actor: agentOf(threadC) }),
    ).resolves.toEqual({ status: "refused", reason: "spend-cap-reached" });

    // Released after 30 minutes at $1.00 an hour: 50 cents, not the estimate.
    state.now += 30 * MINUTE;
    await service.release({ owner: code(threadA), actor: agentOf(threadA), leaseId: first });
    expect(service.spend({ actor: person })).toMatchObject({
      summary: { spentUsdCents: 50 + ESTIMATE },
    });
    await expect(
      service.acquire({ owner: code(threadC), actor: agentOf(threadC) }),
    ).resolves.toMatchObject({ status: "acquired" });
  });

  it("starts each month's spend at zero and keeps last month's leases in last month", async () => {
    const cloud = billedCloud();
    const { service, state, restart } = host({ providers: [cloud], spendCap: 400 });
    state.now = Date.parse("2026-10-31T23:00:00.000Z");

    const october = await acquired(service, threadA);
    // Released after a minute, it counts the two cents that minute rounds up to.
    state.now += MINUTE;
    await service.release({ owner: code(threadA), actor: agentOf(threadA), leaseId: october });
    state.now = Date.parse("2026-10-31T23:30:00.000Z");
    await expect(
      service.acquire({ owner: code(threadB), actor: agentOf(threadB) }),
    ).resolves.toEqual({ status: "refused", reason: "spend-cap-reached" });

    state.now = Date.parse("2026-11-01T00:00:00.000Z");
    expect(service.spend({ actor: person })).toEqual({
      status: "spend",
      summary: { month: "2026-11", spentUsdCents: 0, monthlyCapUsdCents: 400 },
    });
    await expect(
      service.acquire({ owner: code(threadB), actor: agentOf(threadB) }),
    ).resolves.toMatchObject({ status: "acquired" });
    // A restarted host rebuilds the same figures and the same cap from the journal.
    expect(restart().spend({ actor: person })).toEqual({
      status: "spend",
      summary: { month: "2026-11", spentUsdCents: ESTIMATE, monthlyCapUsdCents: 400 },
    });
  });

  it("refuses an agent, a paired device, and the host itself that try to change or read the cap, journaling nothing", async () => {
    const cloud = billedCloud();
    const { service, connection } = host({ providers: [cloud], spendCap: 400 });
    const before = spendEvents(connection, "desktop.spend-cap-changed@1");
    expect(before).toEqual([{ actor: "local-user", payload: { monthlyCapUsdCents: 400 } }]);

    for (const actor of [agentOf(threadA), paired, system]) {
      expect(service.setSpendCap({ actor, monthlyCapUsdCents: 1_000_000 })).toEqual({
        status: "refused",
        reason: "spend-cap-local-only",
      });
      expect(service.setSpendCap({ actor, monthlyCapUsdCents: undefined })).toEqual({
        status: "refused",
        reason: "spend-cap-local-only",
      });
      expect(service.spend({ actor })).toEqual({
        status: "refused",
        reason: "spend-cap-local-only",
      });
    }
    expect(spendEvents(connection, "desktop.spend-cap-changed@1")).toEqual(before);
    expect(service.spend({ actor: person })).toMatchObject({
      summary: { monthlyCapUsdCents: 400 },
    });

    // The person clearing it turns billed desktops off again, journaled as theirs.
    service.setSpendCap({ actor: person, monthlyCapUsdCents: undefined });
    expect(spendEvents(connection, "desktop.spend-cap-changed@1").at(-1)).toEqual({
      actor: "local-user",
      payload: { previousMonthlyCapUsdCents: 400 },
    });
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "spend-cap-unset" });
  });

  it("refuses a billed recipe with no hourly cost before any provider call", async () => {
    const cloud = billedCloud();
    const { service, state } = host({ providers: [cloud] });
    state.recipes.set(threadA, recipeFor("cloud.example", cloudCredential));
    await expect(
      service.acquire({ owner: code(threadA), actor: agentOf(threadA) }),
    ).resolves.toEqual({ status: "refused", reason: "spend-unestimated" });
    expect(cloud.backend.calls()).not.toContain("acquire");
  });

  it("keeps a billed placement that declares its provider's stop without a provider expiry, and reserves that stop in the estimate", async () => {
    const fake = createFakeDesktopProvider({ id: "spaces.example" });
    const spaces: DesktopProvider = {
      ...fake.provider,
      placements: [
        {
          id: decodeDesktopPlacementId("own-cloud"),
          displayName: "Your cloud account",
          locality: "cloud",
          billed: true,
          billedIfHostStopsMinutes: 480,
        },
      ],
    };
    const { service, state } = host({ providers: [{ provider: spaces }] });
    state.recipes.set(
      threadA,
      decodeDesktopRecipe({
        ...recipeFor("spaces.example", cloudCredential, HOURLY_COST),
        placementId: "own-cloud",
      }),
    );
    // The fake sets no provider expiry for a provider that does not itself
    // bill; the placement's declared worst case stands in for it.
    const started = await service.acquire({ owner: code(threadA), actor: agentOf(threadA) });
    expect(started).toMatchObject({
      status: "acquired",
      lease: { billed: true, spend: { estimateUsdCents: 800 } },
    });
    expect(state.asked).toEqual(["billed"]);
    expect(service.destination()).toMatchObject({
      leasable: [
        {
          placements: [{ placementId: "own-cloud", billed: true, billedIfHostStopsMinutes: 480 }],
        },
      ],
    });
  });
});
