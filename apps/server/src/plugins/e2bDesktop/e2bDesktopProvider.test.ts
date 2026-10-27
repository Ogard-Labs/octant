import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeDesktopHostTag,
  decodeDesktopProviderId,
  decodeEventActor,
  decodeDesktopLeaseId,
  decodeDesktopRecipe,
  decodeUtcTimestamp,
  type DesktopRecipe,
} from "@octant/contracts";
import {
  decodeComputerControlCommand,
  type ComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import type { DesktopProvider } from "@octant/plugin-api/desktop-provider";
import { runDesktopProviderConformance } from "@octant/plugin-api/desktop-provider-conformance";
import { createDesktopHttpsPort } from "../../computerUse/desktopHttpsPort";
import { createDesktopLeaseService } from "../../computerUse/desktopLeaseService";
import { Journal } from "../../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../../persistence/migrations";
import { catchUpProjection } from "../../persistence/projection";
import { createPhase1RuntimeRegistries } from "../../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../../persistence/sqlitePort";
import {
  createE2bDesktopProvider,
  E2B_DESKTOP_HOSTS,
  E2B_HOST_METADATA_KEY,
  E2B_LEASE_METADATA_KEY,
} from "./e2bDesktopProvider";
import {
  RECORDED_E2B_API_KEY,
  RecordedE2b,
  type RecordedE2bScenario,
} from "./e2bRecordedApi.test-support";

const START = Date.parse("2026-10-27T09:00:00.000Z");
const MINUTE = 60_000;
const credentialRef = "e4000000-0000-4000-8000-0000000000c1";
const recipe: DesktopRecipe = decodeDesktopRecipe({
  providerId: "e2b",
  credentialRef,
  screen: { width: 1024, height: 768 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
});
const hostTag = decodeDesktopHostTag("e4000000-0000-4000-8000-0000000000aa");
const ELEMENT_CLICK = decodeComputerControlCommand({
  operation: "click",
  observationId: randomUUID(),
  elementIndex: 0,
});

/** The E2B driver over the host's real HTTPS port, with the recorded E2B behind it. */
function driverOver(e2b: RecordedE2b, clock: () => number = () => Date.now()): DesktopProvider {
  const port = createDesktopHttpsPort({
    hosts: () => E2B_DESKTOP_HOSTS,
    credentialPermitted: (ref) => String(ref) === credentialRef,
    credential: async () => RECORDED_E2B_API_KEY,
    fetch: e2b.fetch,
  });
  return createE2bDesktopProvider(port, { now: clock });
}

function harness(scenario: RecordedE2bScenario = {}) {
  const clock = { now: START };
  const e2b = new RecordedE2b(scenario, () => clock.now);
  return { clock, e2b, provider: driverOver(e2b, () => clock.now) };
}

async function acquired(provider: DesktopProvider, minutes = 30) {
  const leaseId = decodeDesktopLeaseId(randomUUID());
  const result = await provider.acquire({
    leaseId,
    hostTag,
    recipe,
    expiresAt: decodeUtcTimestamp(new Date(START + minutes * MINUTE).toISOString()),
    signal: new AbortController().signal,
  });
  if (result.status !== "acquired") throw new Error(`not acquired: ${JSON.stringify(result)}`);
  return { leaseId, result };
}

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const threadId = "e4000000-0000-4000-8000-000000000001";
const person = decodeEventActor({
  kind: "local-user",
  actorId: "e4000000-0000-4000-8000-0000000000b1",
});

/** One host process: the lease service over the journal on disk, with its own E2B driver. */
function hostProcess(connection: SqliteConnection, provider: DesktopProvider) {
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
  return createDesktopLeaseService({
    journal,
    projection: runtime.desktopLeaseProjection,
    hostTag,
    platform: "linux",
    hasScreen: false,
    providers: () => [{ provider, effective: true }],
    recipe: () => recipe,
    thread: () => ({ active: true, executionPolicy: "full-access" }),
    callerMayOpen: () => true,
    computerUseEnabled: () => true,
    confirm: async () => "declined",
    threadRoot: async () => undefined,
    confirmTransfer: async () => "declined",
    systemActor: decodeEventActor({
      kind: "system",
      actorId: "e4000000-0000-4000-8000-0000000000b4",
    }),
    now: () => START,
    uuid: randomUUID,
    teardownTimeoutMs: 1_000,
  });
}

describe("E2B desktop provider", () => {
  it("keeps the desktop-provider seam's promises against a recorded E2B", async () => {
    const backends = new WeakMap<DesktopProvider, RecordedE2b>();
    await expect(
      runDesktopProviderConformance({
        create: (scenario) => {
          const e2b = new RecordedE2b({
            // A provider that declines an extension: E2B holds a sandbox at
            // its plan's longest life, below what the extension asks for.
            ...(scenario.providerDeclinesExtension ? { holdsTimeoutAt: 45 * MINUTE } : {}),
            ...(scenario.desktopOutlivesDestroy ? { outlivesKill: true } : {}),
          });
          const provider = driverOver(e2b);
          backends.set(provider, e2b);
          return provider;
        },
        // A host killed while a desktop ran: a new driver keeps no memory of
        // it and has only E2B's own listing to go on.
        restarted: (previous) => {
          const e2b = backends.get(previous);
          if (e2b === undefined) throw new Error("no recorded E2B for that driver");
          return driverOver(e2b);
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

  it("creates a tagged sandbox whose own timeout outlasts the lease, with no internet or public ports", async () => {
    const { e2b, provider } = harness();
    const { leaseId, result } = await acquired(provider);
    const [sandbox] = e2b.running();
    expect(sandbox?.metadata).toEqual({
      [E2B_LEASE_METADATA_KEY]: String(leaseId),
      [E2B_HOST_METADATA_KEY]: String(hostTag),
    });
    expect(sandbox?.createBody).toMatchObject({
      templateID: "desktop",
      timeout: 30 * 60 + 120,
      autoPause: false,
      allow_internet_access: false,
      network: { allowPublicTraffic: false },
    });
    expect(result.providerExpiresAt).toBe(new Date(START + 32 * MINUTE).toISOString());
    expect(result.handle).toEqual({
      leaseId,
      resource: sandbox?.sandboxID,
      credentialRef,
    });
  });

  it("sends the person's key only to E2B's API and never into a sandbox", async () => {
    const { e2b, provider } = harness();
    const { result } = await acquired(provider);
    const screen = await provider.screen(result.handle);
    if (screen.status !== "ready") throw new Error("no screen");
    await screen.screen.frame();
    await provider.release(result.handle);
    const requests = e2b.requests();
    expect(new Set(requests.map((request) => request.host))).toEqual(
      new Set(["api.e2b.app", "sandbox.e2b.app"]),
    );
    for (const request of requests) {
      expect(request.headers["x-api-key"] !== undefined).toBe(request.host === "api.e2b.app");
    }
  });

  it("shows the screen and takes a person's pointer, keys, and text as xdotool arguments", async () => {
    const { e2b, provider } = harness();
    const { result } = await acquired(provider);
    const screen = await provider.screen(result.handle);
    if (screen.status !== "ready") throw new Error("no screen");
    await expect(screen.screen.frame()).resolves.toMatchObject({
      status: "frame",
      frame: { mediaType: "image/png", width: 1024, height: 768 },
    });
    for (const event of [
      { kind: "pointer", action: "down", button: "left", x: 10.6, y: 20 },
      { kind: "key", action: "down", key: "Enter" },
      { kind: "text", text: "$(rm -rf ~) 'quoted'" },
    ] as const) {
      await expect(screen.screen.input(event)).resolves.toEqual({ status: "delivered" });
    }
    await expect(
      screen.screen.input({ kind: "pointer", action: "move", x: 1024, y: 0 }),
    ).resolves.toEqual({ status: "refused", reason: "outside-screen" });
    await expect(
      screen.screen.input({ kind: "key", action: "down", key: "constructor" }),
    ).resolves.toEqual({ status: "refused", reason: "unsupported-key" });
    expect(e2b.running()[0]?.input).toEqual([
      ["mousemove", "10", "20", "mousedown", "1"],
      ["keydown", "Return"],
      ["type", "--", "$(rm -rf ~) 'quoted'"],
    ]);
  });

  it("lands a sent file read-only in the inbox and launches only a file that landed", async () => {
    const { e2b, provider } = harness();
    const { result } = await acquired(provider);
    const bytes = new TextEncoder().encode("#!/bin/sh\necho app\n");
    await expect(
      provider.control(result.handle, { operation: "launch", appId: "app.AppImage" }),
    ).resolves.toMatchObject({ kind: "refused", reason: "not-sent" });
    await expect(provider.deliver(result.handle, "app.AppImage", bytes)).resolves.toEqual({
      status: "delivered",
    });
    const files = e2b.running()[0]?.files;
    expect(files?.get("/home/user/inbox/app.AppImage")).toEqual(bytes);
    expect([...(files?.keys() ?? [])]).not.toContain("/home/user/.octant-incoming/app.AppImage");

    const launched = await provider.control(result.handle, {
      operation: "launch",
      appId: "app.AppImage",
    });
    expect(launched).toMatchObject({ kind: "windows", appId: "app.AppImage" });
    const windows = (await provider.control(result.handle, {
      operation: "windows",
      appId: "app.AppImage",
    })) as Extract<ComputerControlResult, { kind: "windows" }>;
    expect(windows.windows).toHaveLength(1);
    const observed = await provider.control(
      result.handle,
      decodeComputerControlCommand({ operation: "observe", appId: "app.AppImage", windowId: 1 }),
    );
    expect(observed).toMatchObject({
      kind: "observation",
      elements: [],
      imageWidth: 1024,
      imageHeight: 768,
    });
  });

  it("refuses an extension E2B holds below the new expiry, and reports the one E2B confirms", async () => {
    const held = harness({ holdsTimeoutAt: 60 * MINUTE });
    const { result } = await acquired(held.provider);
    const asked = decodeUtcTimestamp(new Date(START + 90 * MINUTE).toISOString());
    await expect(held.provider.extend(result.handle, asked)).resolves.toEqual({
      status: "failed",
      reason: "provider-expiry-short",
    });

    const open = harness();
    const lease = await acquired(open.provider);
    open.clock.now = START + 10 * MINUTE;
    await expect(open.provider.extend(lease.result.handle, asked)).resolves.toEqual({
      status: "extended",
      expiresAt: new Date(START + 92 * MINUTE).toISOString(),
    });
  });

  it("destroys a sandbox E2B serves outside its own domain instead of keeping it", async () => {
    const { e2b, provider } = harness({ domain: "e2b.elsewhere.example" });
    const result = await provider.acquire({
      leaseId: decodeDesktopLeaseId(randomUUID()),
      hostTag,
      recipe,
      expiresAt: decodeUtcTimestamp(new Date(START + 30 * MINUTE).toISOString()),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "failed", reason: "sandbox-unreachable" });
    expect(e2b.running()).toEqual([]);
  });

  it("lists every page of a host's sandboxes, and none of another host's", async () => {
    const { e2b, provider } = harness({ pageSize: 2 });
    const mine = [await acquired(provider), await acquired(provider), await acquired(provider)];
    const other = createE2bDesktopProvider(
      createDesktopHttpsPort({
        hosts: () => E2B_DESKTOP_HOSTS,
        credentialPermitted: () => true,
        credential: async () => RECORDED_E2B_API_KEY,
        fetch: e2b.fetch,
      }),
    );
    await other.acquire({
      leaseId: decodeDesktopLeaseId(randomUUID()),
      hostTag: decodeDesktopHostTag("e4000000-0000-4000-8000-0000000000bb"),
      recipe,
      expiresAt: decodeUtcTimestamp(new Date(START + 30 * MINUTE).toISOString()),
      signal: new AbortController().signal,
    });
    const listed = await provider.listOwned(hostTag, recipe.credentialRef);
    expect(listed.status).toBe("listed");
    if (listed.status !== "listed") return;
    expect(listed.resources.map((resource) => String(resource.handle.leaseId)).sort()).toEqual(
      mine.map(({ leaseId }) => String(leaseId)).sort(),
    );
    await expect(provider.listOwned(hostTag)).resolves.toEqual({
      status: "failed",
      reason: "credential-required",
    });
  });

  it("answers a rejected key as a refusal, never a desktop", async () => {
    const e2b = new RecordedE2b();
    const provider = createE2bDesktopProvider(
      createDesktopHttpsPort({
        hosts: () => E2B_DESKTOP_HOSTS,
        credentialPermitted: () => true,
        credential: async () => "a-revoked-key",
        fetch: e2b.fetch,
      }),
    );
    await expect(
      provider.acquire({
        leaseId: decodeDesktopLeaseId(randomUUID()),
        hostTag,
        recipe,
        expiresAt: decodeUtcTimestamp(new Date(Date.now() + 30 * MINUTE).toISOString()),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "refused", reason: "credential-rejected" });
  });

  it.each(["ready", "provisioning"] as const)(
    "lets a host killed with a lease %s find and destroy its sandbox by tag once it starts again",
    async (killedWhile) => {
      const directory = mkdtempSync(join(tmpdir(), "octant-e2b-kill-"));
      directories.push(directory);
      const connection = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());
      const e2b = new RecordedE2b({}, () => START);
      const driver = driverOver(e2b, () => START);
      // A process killed mid-create never sees E2B's answer.
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
      const started = before.acquire({
        owner: { mode: "code", threadId },
        actor: person,
        scopeId: "window-1",
        confirmedProvider: decodeDesktopProviderId("e2b"),
      });
      if (killedWhile === "ready") {
        await expect(started).resolves.toMatchObject({ status: "acquired" });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(e2b.running()).toHaveLength(1);

      // The replacement process has the journal and E2B's listing, nothing else.
      const after = hostProcess(
        connection,
        driverOver(e2b, () => START),
      );
      await expect(after.start()).resolves.toEqual({
        released: 1,
        stillRunning: 0,
        orphansDestroyed: 0,
      });
      expect(e2b.running()).toEqual([]);
    },
  );

  it("keeps to the imports a third-party desktop plugin could make", () => {
    const files = readdirSync(import.meta.dirname).filter(
      (name) =>
        name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
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
