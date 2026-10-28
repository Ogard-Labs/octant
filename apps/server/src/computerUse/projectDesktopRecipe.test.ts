import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeDesktopHostTag,
  decodeDesktopProviderId,
  decodeEventActor,
  decodeProjectId,
  decodeWindowId,
  type DesktopRecipe,
  type ProjectId,
} from "@octant/contracts";
import {
  DESKTOP_CREDENTIAL_REJECTED,
  type DesktopProvider,
} from "@octant/plugin-api/desktop-provider";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeDesktopProvider } from "../../../../packages/plugin-api/src/fakeDesktopProvider";
import {
  Persistence,
  makePersistenceLive,
  type PersistenceService,
} from "../persistence/persistenceService";
import { ProjectService } from "../projectService";
import { leasableProvidersOf } from "./computerUseDestination";
import { createDesktopLeaseService } from "./desktopLeaseService";
import { createDesktopRecipeKeys } from "./desktopRecipeKeys";
import { readProjectDesktopRecipe } from "./projectDesktopRecipe";

const START = Date.parse("2026-10-27T09:00:00.000Z");
const windowId = decodeWindowId("e7500000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("e7500000-0000-4000-8000-000000000002");
const threadId = "e7500000-0000-4000-8000-000000000003";
const person = decodeEventActor({
  kind: "local-user",
  actorId: "e7500000-0000-4000-8000-000000000004",
});
const system = decodeEventActor({
  kind: "system",
  actorId: "e7500000-0000-4000-8000-000000000005",
});
const recipe = {
  providerId: "fake-desktop",
  screen: { width: 1440, height: 900 },
  network: "none",
  leaseMinutes: 20,
  maximumLeaseMinutes: 120,
  idleMinutes: 10,
} as const;

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * One host over one data directory: the Project service a local window saves
 * the recipe through, and the lease service that reads it, wired as the
 * server wires them. The thread belongs to the Project; everything else about
 * it is allowed so only the recipe decides.
 */
function hostOver(persistence: PersistenceService, clock: { now: number }) {
  const fake = createFakeDesktopProvider();
  const screens: Array<DesktopRecipe["screen"]> = [];
  const provider: DesktopProvider = {
    ...fake.provider,
    acquire: (request) => {
      screens.push(request.recipe.screen);
      return fake.provider.acquire(request);
    },
  };
  const leases = createDesktopLeaseService({
    journal: persistence.journal,
    projection: persistence.desktopLeaseProjection,
    hostTag: decodeDesktopHostTag("e7500000-0000-4000-8000-0000000000aa"),
    platform: "linux",
    hasScreen: false,
    providers: () => [{ provider, effective: true }],
    recipe: (owner) =>
      readProjectDesktopRecipe({
        owner,
        codeThreadProject: (id) => (id === threadId ? projectId : undefined),
        readProject: (id: ProjectId) => persistence.readProject(id),
      }),
    thread: () => ({ active: true, executionPolicy: "approval-gated" }),
    callerMayOpen: () => true,
    computerUseEnabled: () => true,
    confirm: async () => "approved",
    threadRoot: async () => undefined,
    confirmTransfer: async () => "declined",
    systemActor: system,
    now: () => clock.now,
    uuid: randomUUID,
    teardownTimeoutMs: 1_000,
  });
  const projects = new ProjectService({
    persistence,
    bindingReceiptStore: { consume: () => ({ canonicalRoot: "/repositories/desktop-app" }) },
    projectRootPort: { validate: async (_type, path) => ({ canonicalRoot: path }) },
    uuid: randomUUID,
    clock: () => new Date(clock.now).toISOString(),
    offeredDesktopProviders: () => leasableProvidersOf(leases.destination()),
  });
  return { leases, projects, backend: fake.backend, screens };
}

function runHost<A>(
  directory: string,
  clock: { now: number },
  body: (host: ReturnType<typeof hostOver>) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        return yield* Effect.promise(() => body(hostOver(persistence, clock)));
      }).pipe(
        Effect.provide(
          makePersistenceLive({
            dataDirectory: directory,
            clock: () => new Date(clock.now).toISOString(),
          }),
        ),
      ),
    ),
  );
}

const caller = {
  owner: { mode: "code" as const, threadId },
  actor: person,
  scopeId: String(windowId),
};

describe("a Code Project's stored desktop recipe", () => {
  it("is what a thread leases from, across a restart, until a person removes it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-desktop-recipe-"));
    directories.push(directory);
    const clock = { now: START };

    await runHost(directory, clock, async ({ leases, projects }) => {
      await expect(leases.acquire(caller)).resolves.toEqual({
        status: "refused",
        reason: "no-provider-configured",
      });
      await projects.executeProject(windowId, {
        kind: "create-code-project",
        projectId,
        expectedVersion: 0,
        name: "Desktop app",
        receiptId: "A".repeat(42) + "A",
        hostId: "local",
      });
      await expect(
        projects.executeProject(windowId, {
          kind: "change-code-project-desktop-recipe",
          projectId,
          expectedVersion: 1,
          recipe,
        }),
      ).resolves.toMatchObject({
        kind: "code-project-desktop-recipe-changed",
        project: { desktopRecipe: recipe, version: 2 },
      });
    });

    // The recipe is read back from the journal's projection on the next start.
    await runHost(directory, clock, async ({ leases, projects, backend, screens }) => {
      const acquired = await leases.acquire(caller);
      expect(acquired).toMatchObject({
        status: "acquired",
        lease: {
          providerId: "fake-desktop",
          state: "ready",
          idleMinutes: 10,
          expiresAt: new Date(START + 20 * 60_000).toISOString(),
          maximumExpiresAt: new Date(START + 120 * 60_000).toISOString(),
        },
      });
      expect(backend.desktops()).toHaveLength(1);
      expect(screens).toEqual([recipe.screen]);

      await projects.executeProject(windowId, {
        kind: "change-code-project-desktop-recipe",
        projectId,
        expectedVersion: 2,
        recipe: null,
      });
      await leases.sweep();
      const overview = await leases.overview(caller);
      expect(overview).toMatchObject({
        status: "overview",
        leases: [{ state: "released", endReason: "recipe-removed" }],
        start: { status: "refused", reason: "no-provider-configured" },
      });
      expect(backend.desktops()).toHaveLength(0);
    });
  });

  it("refuses a recipe naming a provider this host does not offer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-desktop-recipe-"));
    directories.push(directory);
    await runHost(directory, { now: START }, async ({ projects }) => {
      await projects.executeProject(windowId, {
        kind: "create-code-project",
        projectId,
        expectedVersion: 0,
        name: "Desktop app",
        receiptId: "A".repeat(42) + "A",
        hostId: "local",
      });
      await expect(
        projects.executeProject(windowId, {
          kind: "change-code-project-desktop-recipe",
          projectId,
          expectedVersion: 1,
          recipe: { ...recipe, providerId: "cloud-desktop" },
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
    });
  });
});

/** The broker's desktop-provider namespace, in memory. */
function memoryKeyStore() {
  const held = new Map<string, string>();
  return {
    held,
    store: {
      has: async (ref: string) => held.has(ref),
      set: async (ref: string, key: string) => {
        held.set(ref, key);
      },
      delete: async (ref: string) => {
        held.delete(ref);
      },
    },
  };
}

/** Every byte the host wrote under its data directory, journal and projections included. */
function everythingWritten(directory: string): string {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"))
    .join("\n");
}

/**
 * A host that offers a billed cloud provider, as no production host does yet:
 * key entry sits behind the same offer E2B waits on, so this test offers a
 * fake one. Keys are kept as the server keeps them.
 */
function cloudHostOver(
  persistence: PersistenceService,
  clock: { now: number },
  keys: ReturnType<typeof memoryKeyStore>,
  refuseKey: { current: boolean },
) {
  const fake = createFakeDesktopProvider({ id: "fake-cloud", locality: "cloud", billed: true });
  const keyRefs: Array<string | undefined> = [];
  const provider: DesktopProvider = {
    ...fake.provider,
    acquire: (request) => {
      keyRefs.push(request.recipe.credentialRef);
      return refuseKey.current
        ? Promise.resolve({ status: "refused", reason: DESKTOP_CREDENTIAL_REJECTED })
        : fake.provider.acquire(request);
    },
  };
  const leases = createDesktopLeaseService({
    journal: persistence.journal,
    projection: persistence.desktopLeaseProjection,
    hostTag: decodeDesktopHostTag("e7500000-0000-4000-8000-0000000000ab"),
    platform: "linux",
    hasScreen: false,
    providers: () => [{ provider, effective: true }],
    recipe: (owner) =>
      readProjectDesktopRecipe({
        owner,
        codeThreadProject: (id) => (id === threadId ? projectId : undefined),
        readProject: (id: ProjectId) => persistence.readProject(id),
      }),
    thread: () => ({ active: true, executionPolicy: "approval-gated" }),
    callerMayOpen: () => true,
    computerUseEnabled: () => true,
    confirm: async () => "declined",
    threadRoot: async () => undefined,
    confirmTransfer: async () => "declined",
    systemActor: system,
    now: () => clock.now,
    uuid: randomUUID,
    teardownTimeoutMs: 1_000,
  });
  const recipeKeys = createDesktopRecipeKeys({
    store: keys.store,
    leases: () => persistence.desktopLeaseProjection.list().map((record) => record.lease),
    holdsCredential: (ref) => leases.holdsCredential(ref),
    namedByRecipes: () =>
      persistence
        .readProjects({ type: "code" })
        .flatMap((project) =>
          project.type === "code" && project.desktopRecipe?.credentialRef !== undefined
            ? [project.desktopRecipe.credentialRef]
            : [],
        ),
  });
  const projects = new ProjectService({
    persistence,
    bindingReceiptStore: { consume: () => ({ canonicalRoot: "/repositories/desktop-app" }) },
    projectRootPort: { validate: async (_type, path) => ({ canonicalRoot: path }) },
    uuid: randomUUID,
    clock: () => new Date(clock.now).toISOString(),
    offeredDesktopProviders: () => leasableProvidersOf(leases.destination()),
    desktopRecipeKeys: recipeKeys,
  });
  const saved = () => {
    const project = persistence.readProject(projectId);
    return project?.type === "code" ? project : undefined;
  };
  return {
    leases,
    projects,
    recipeKeys,
    keyRefs,
    backend: fake.backend,
    version: () => saved()?.version ?? 0,
    savedRef: () => saved()?.desktopRecipe?.credentialRef,
    keyView: () => recipeKeys.view(saved()?.desktopRecipe),
  };
}

function runCloudHost<A>(
  directory: string,
  keys: ReturnType<typeof memoryKeyStore>,
  refuseKey: { current: boolean },
  body: (host: ReturnType<typeof cloudHostOver>) => Promise<A>,
): Promise<A> {
  const clock = { now: START };
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        return yield* Effect.promise(() =>
          body(cloudHostOver(persistence, clock, keys, refuseKey)),
        );
      }).pipe(
        Effect.provide(
          makePersistenceLive({
            dataDirectory: directory,
            clock: () => new Date(clock.now).toISOString(),
          }),
        ),
      ),
    ),
  );
}

describe("a cloud desktop recipe's key", () => {
  const cloudRecipe = { ...recipe, providerId: "fake-cloud" } as const;
  const billedCaller = { ...caller, confirmedProvider: decodeDesktopProviderId("fake-cloud") };
  const createProject = {
    kind: "create-code-project",
    projectId,
    expectedVersion: 0,
    name: "Desktop app",
    receiptId: "A".repeat(42) + "A",
    hostId: "local",
  } as const;

  it("lives only in the credential store, is replaced and removed there, and says when the provider refused it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-desktop-recipe-key-"));
    directories.push(directory);
    const keys = memoryKeyStore();
    const refuseKey = { current: true };
    const firstKey = "e2b_first-key-a1b2c3d4e5";
    const secondKey = "e2b_second-key-f6a7b8c9d0";

    await runCloudHost(directory, keys, refuseKey, async (host) => {
      const { projects, leases, keyView, savedRef } = host;
      await projects.executeProject(windowId, createProject);
      // A cloud recipe with no key configures nothing that could run.
      await expect(
        projects.executeProject(windowId, {
          kind: "change-code-project-desktop-recipe",
          projectId,
          expectedVersion: 1,
          recipe: cloudRecipe,
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });

      await projects.executeProject(windowId, {
        kind: "change-code-project-desktop-recipe",
        projectId,
        expectedVersion: 1,
        recipe: cloudRecipe,
        key: { action: "enter", key: firstKey },
      });
      const firstRef = savedRef();
      expect(firstRef).toBeDefined();
      expect([...keys.held]).toEqual([[String(firstRef), firstKey]]);
      await expect(keyView()).resolves.toEqual({ key: "saved", store: "available" });

      // The provider refuses the key on the next lease, and the editor says so.
      await expect(leases.acquire(billedCaller)).resolves.toMatchObject({
        status: "not-acquired",
        lease: { state: "refused", credentialRef: firstRef, credentialRejected: true },
      });
      expect(host.keyRefs).toEqual([firstRef]);
      await expect(keyView()).resolves.toEqual({ key: "rejected", store: "available" });

      // A new key replaces it under a new reference. The old one goes, since
      // no desktop made with it can still be running.
      await projects.executeProject(windowId, {
        kind: "change-code-project-desktop-recipe",
        projectId,
        expectedVersion: 2,
        recipe: { ...cloudRecipe, ...(firstRef === undefined ? {} : { credentialRef: firstRef }) },
        key: { action: "enter", key: secondKey },
      });
      const secondRef = savedRef();
      expect(String(secondRef)).not.toBe(String(firstRef));
      await host.recipeKeys.settle();
      expect([...keys.held]).toEqual([[String(secondRef), secondKey]]);
      await expect(keyView()).resolves.toEqual({ key: "saved", store: "available" });

      refuseKey.current = false;
      await expect(leases.acquire(billedCaller)).resolves.toMatchObject({
        status: "acquired",
        lease: { state: "ready", credentialRef: secondRef },
      });
    });

    // The journal and every projection on disk hold references, never a key.
    const written = everythingWritten(directory);
    expect(written).not.toContain(firstKey);
    expect(written).not.toContain(secondKey);

    await runCloudHost(directory, keys, refuseKey, async (host) => {
      const { projects, leases, keyView, savedRef } = host;
      const secondRef = savedRef();
      if (secondRef === undefined) throw new Error("The recipe lost its key across a restart.");
      // The restart ended the desktop that was running; this start leases another.
      await expect(leases.acquire(billedCaller)).resolves.toMatchObject({ status: "acquired" });

      // Removing the key keeps the recipe and ends its running desktop. The
      // key stays until that desktop is verified gone, since teardown uses it.
      await projects.executeProject(windowId, {
        kind: "change-code-project-desktop-recipe",
        projectId,
        expectedVersion: host.version(),
        recipe: { ...cloudRecipe, credentialRef: secondRef },
        key: { action: "remove" },
      });
      expect(savedRef()).toBeUndefined();
      await expect(keyView()).resolves.toEqual({ key: "none", store: "available" });
      await host.recipeKeys.settle();
      expect([...keys.held.keys()]).toEqual([String(secondRef)]);

      await leases.sweep();
      expect(host.backend.desktops()).toHaveLength(0);
      await host.recipeKeys.settle();
      expect(keys.held.size).toBe(0);
      await expect(leases.acquire(billedCaller)).resolves.toEqual({
        status: "refused",
        reason: "no-provider-configured",
      });
    });
  });

  it("stores nothing for a key the host would not keep", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-desktop-recipe-key-"));
    directories.push(directory);
    const keys = memoryKeyStore();
    await runCloudHost(directory, keys, { current: false }, async ({ projects }) => {
      await projects.executeProject(windowId, createProject);
      const key = { action: "enter", key: "e2b_never-stored" } as const;
      for (const change of [
        // A recipe the host refuses: it names a placement the provider lacks.
        { recipe: { ...cloudRecipe, placementId: "elsewhere" }, key },
        // A provider this host does not offer for leasing takes no key.
        { recipe: { ...recipe, providerId: "another-cloud" }, key },
        // A removed recipe has no key to change.
        { recipe: null, key },
        // A window never names a key reference of its own.
        { recipe: { ...cloudRecipe, credentialRef: randomUUID() } },
      ]) {
        await expect(
          projects.executeProject(windowId, {
            kind: "change-code-project-desktop-recipe",
            projectId,
            expectedVersion: 1,
            ...change,
          }),
        ).rejects.toMatchObject({ failure: { category: "invalid" } });
      }
      expect(keys.held.size).toBe(0);
    });
  });
});
