import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROFILE_EVENT_NAMES,
  decodeBrowserProfileCleared,
  decodeEventActor,
  decodeProject,
  decodeProjectId,
  type Project,
  type StoredBrowserProfile,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { BROWSER_PROFILE_AGGREGATE, BrowserProfileService } from "./browserProfileService";
import type { BrowserRuntimePort } from "./browserRuntimePort";

const now = "2026-10-31T12:00:00.000Z";
const projectId = decodeProjectId("a0000000-0000-4000-8000-000000000002");
const removedProjectId = decodeProjectId("a0000000-0000-4000-8000-000000000009");
const actorId = "a0000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journal(): Journal {
  const root = mkdtempSync(join(tmpdir(), "octant-browser-profiles-"));
  roots.push(root);
  const connection = openSqlite(join(root, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
}

function project(): Project {
  const actor = { kind: "local-user", actorId } as const;
  return decodeProject({
    id: String(projectId),
    name: "Research",
    lifecycle: "active",
    pinned: false,
    rank: "1/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    type: "work",
    binding: { canonicalRoot: "/Users/person/research" },
    bindingHistory: [
      {
        revisionId: "a0000000-0000-4000-8000-000000000004",
        revision: 1,
        currentBinding: { canonicalRoot: "/Users/person/research" },
        actor,
        changedAt: now,
      },
    ],
  });
}

function harness(
  options: {
    readonly native?: boolean;
    readonly clearFails?: boolean;
    readonly sink?: Pick<Journal, "append">;
  } = {},
) {
  const stored: Array<{ profile: StoredBrowserProfile; sizeBytes: number }> = [
    { profile: { kind: "project", projectId }, sizeBytes: 2048 },
    { profile: { kind: "project", projectId: removedProjectId }, sizeBytes: 12 },
  ];
  const events: string[] = [];
  const clear = vi.fn(async () => {
    events.push("store-cleared");
    if (options.clearFails === true) throw new Error("locked");
  });
  const runtime: BrowserRuntimePort = {
    available: async () => true,
    nativeAvailable: async () => options.native ?? true,
    profiles: { list: async () => stored, clear },
    createContext: async () => undefined,
    inspectTarget: async () => ({ sensitive: false }),
    act: async () => ({}),
    closeContext: async () => undefined,
    closeAll: async () => undefined,
  };
  const closePages = vi.fn(async () => void events.push("pages-closed"));
  const live = options.sink ?? journal();
  const service = new BrowserProfileService({
    runtime,
    readProject: (id) => (String(id) === String(projectId) ? project() : undefined),
    journal: live,
    actor: decodeEventActor({ kind: "local-user", actorId }),
    closePages,
    uuid: randomUUID,
    clock: () => now,
  });
  return { service, clear, closePages, events, journal: live as Journal };
}

describe("Browser profiles service", () => {
  it("lists Personal even before anything is signed in, and each stored Project profile by its name", async () => {
    const { service } = harness();

    const result = await service.execute("local-window", { kind: "list" });

    expect(result).toEqual({
      kind: "browser-profiles",
      profiles: [
        { profile: { kind: "personal" }, label: "Personal", sizeBytes: 0 },
        { profile: { kind: "project", projectId }, label: "Research", sizeBytes: 2048 },
        {
          profile: { kind: "project", projectId: removedProjectId },
          label: "A Project that no longer exists",
          sizeBytes: 12,
        },
      ],
    });
  });

  it("closes the profile's pages before it removes the store, then journals what was cleared", async () => {
    const { service, events, journal: live } = harness();

    const result = await service.execute("local-window", {
      kind: "clear",
      profile: { kind: "personal" },
      scope: "all",
    });

    expect(result).toEqual({
      kind: "browser-profile-cleared",
      profile: { kind: "personal" },
      scope: "all",
    });
    expect(events).toEqual(["pages-closed", "store-cleared"]);
    const replayed = live
      .replayAggregateType({
        aggregateType: BROWSER_PROFILE_AGGREGATE,
        afterSequence: 0,
        limit: 10,
      })
      .map((event) => ({
        name: event.eventName,
        payload: decodeBrowserProfileCleared(event.payload),
      }));
    expect(replayed).toEqual([
      {
        name: BROWSER_PROFILE_EVENT_NAMES.cleared,
        payload: { kind: "browser-profile-cleared", profile: { kind: "personal" }, scope: "all" },
      },
    ]);
  });

  it("can clear only the cookies of a profile", async () => {
    const { service, clear } = harness();

    await service.execute("local-window", {
      kind: "clear",
      profile: { kind: "project", projectId },
      scope: "cookies",
    });

    expect(clear).toHaveBeenCalledWith({ kind: "project", projectId }, "cookies");
  });

  it("refuses a paired device with profile-not-local and touches nothing", async () => {
    const { service, clear, closePages, journal: live } = harness();

    for (const command of [
      { kind: "list" } as const,
      { kind: "clear", profile: { kind: "personal" }, scope: "all" } as const,
    ]) {
      expect(await service.execute("remote-device", command)).toMatchObject({
        kind: "browser-profiles-refused",
        reason: "profile-not-local",
      });
    }
    expect(clear).not.toHaveBeenCalled();
    expect(closePages).not.toHaveBeenCalled();
    expect(live.headSequence()).toBe(0);
  });

  it("refuses with profile-unavailable when no desktop app keeps the stores", async () => {
    const { service, clear } = harness({ native: false });

    expect(await service.execute("local-window", { kind: "list" })).toMatchObject({
      kind: "browser-profiles-refused",
      reason: "profile-unavailable",
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it("journals nothing when the store could not be cleared", async () => {
    const { service, journal: live } = harness({ clearFails: true });

    const result = await service.execute("local-window", {
      kind: "clear",
      profile: { kind: "personal" },
      scope: "all",
    });

    expect(result).toMatchObject({
      kind: "browser-profiles-refused",
      reason: "profile-unavailable",
    });
    expect(live.headSequence()).toBe(0);
  });
});
