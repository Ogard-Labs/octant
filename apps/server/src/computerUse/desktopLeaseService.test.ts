import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_ARTIFACT_MAXIMUM_BYTES,
  decodeDesktopHostTag,
  decodeDesktopLeaseId,
  decodeDesktopRecipe,
  decodeEventActor,
  decodeUtcTimestamp,
  type DesktopLeaseId,
  type DesktopRecipe,
  type EventActor,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import type { DesktopProvider } from "@octant/plugin-api/desktop-provider";
import {
  createFakeDesktopProvider,
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

const recipeFor = (providerId: string): DesktopRecipe =>
  decodeDesktopRecipe({
    providerId,
    screen: { width: 1280, height: 800 },
    network: "none",
    leaseMinutes: 30,
    maximumLeaseMinutes: 240,
    idleMinutes: 15,
  });

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
  whileDeciding: () => void;
  readonly roots: Map<string, string>;
  readonly threads: Map<string, { active: boolean; executionPolicy: ProviderExecutionPolicy }>;
  readonly recipes: Map<string, DesktopRecipe>;
  providers: Array<RegisteredDesktopProvider>;
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
    callerMayOpen: (_actor, owner) => state.threads.has(String(owner.threadId)),
    computerUseEnabled: () => state.computerUse,
    confirm: async (request) => {
      state.asked.push(request.asks);
      return state.answer;
    },
    threadRoot: async (owner) => state.roots.get(String(owner.threadId)),
    confirmTransfer: async (request) => {
      state.askedTransfers.push(request);
      state.whileDeciding();
      return state.answer;
    },
    systemActor: system,
    now: () => state.now,
    uuid: randomUUID,
    teardownTimeoutMs: 1_000,
  });
}

function host(
  options: {
    readonly providers?: ReadonlyArray<{ readonly provider: DesktopProvider }>;
    readonly executionPolicy?: ProviderExecutionPolicy;
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
        recipeFor(String(providers[0]?.provider.id ?? "fake-desktop")),
      ]),
    ),
    providers: providers.map(({ provider }) => ({ provider, effective: true })),
  };
  return {
    state,
    backend: fake.backend,
    checkout,
    connection,
    service: serviceOver(connection, state),
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
});

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

describe("desktop artifact transfer", () => {
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

    state.whileDeciding = () =>
      state.threads.set(threadA, { active: true, executionPolicy: "full-access" });
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
