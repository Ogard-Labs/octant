import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeDesktopHostTag,
  decodeEventActor,
  decodeProjectId,
  decodeWindowId,
  type DesktopRecipe,
  type ProjectId,
} from "@octant/contracts";
import type { DesktopProvider } from "@octant/plugin-api/desktop-provider";
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
