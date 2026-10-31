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
import type { BrowserCookieReader } from "./cookieImport/browserCookieReader";

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
    profiles: {
      list: async () => stored,
      clear,
      importCookies: async () => ({ imported: 0, skipped: 0 }),
    },
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

describe("Browser profile cookie import", () => {
  const SENTINEL = "SENTINEL-cookie-value-7f3a9c";
  const cookie = (name: string) => ({
    domain: ".example.com",
    hostOnly: false,
    name,
    value: SENTINEL,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
  });

  function importHarness(
    options: {
      readonly read?: Awaited<ReturnType<BrowserCookieReader["read"]>>;
      readonly importCookies?: BrowserRuntimePort["profiles"] extends infer P
        ? P extends { importCookies: infer F }
          ? F
          : never
        : never;
      readonly native?: boolean;
    } = {},
  ) {
    const live = journal();
    const batches: Array<ReadonlyArray<unknown>> = [];
    const read = vi.fn<BrowserCookieReader["read"]>(
      async () =>
        options.read ?? {
          status: "read",
          cookies: [cookie("a"), cookie("b"), cookie("c")],
          skipped: 2,
        },
    );
    const runtime: BrowserRuntimePort = {
      available: async () => true,
      nativeAvailable: async () => options.native ?? true,
      profiles: {
        list: async () => [],
        clear: async () => undefined,
        importCookies:
          options.importCookies ??
          (async (_profile, cookies) => {
            batches.push(cookies);
            return { imported: cookies.length, skipped: 0 };
          }),
      },
      createContext: async () => undefined,
      inspectTarget: async () => ({ sensitive: false }),
      act: async () => ({}),
      closeContext: async () => undefined,
      closeAll: async () => undefined,
    };
    const service = new BrowserProfileService({
      runtime,
      readProject: () => undefined,
      journal: live,
      actor: decodeEventActor({ kind: "local-user", actorId }),
      closePages: async () => undefined,
      cookieReader: {
        listSources: () => [
          {
            browser: "chrome",
            label: "Google Chrome",
            profiles: [{ id: "Default", label: "Person 1" }],
          },
        ],
        read,
      },
      uuid: randomUUID,
      clock: () => now,
    });
    return { service, read, batches, journal: live };
  }

  const importCommand = {
    kind: "import-cookies",
    profile: { kind: "personal" },
    browser: "chrome",
    sourceProfile: "Default",
  } as const;
  const replay = (live: Journal) =>
    live.replayAggregateType({
      aggregateType: BROWSER_PROFILE_AGGREGATE,
      afterSequence: 0,
      limit: 10,
    });

  it("lists the browsers and profiles a person can import from, reading no cookie to do it", async () => {
    const { service, read } = importHarness();

    expect(await service.execute("local-window", { kind: "import-sources" })).toEqual({
      kind: "browser-cookie-sources",
      sources: [
        {
          browser: "chrome",
          label: "Google Chrome",
          profiles: [{ id: "Default", label: "Person 1" }],
        },
      ],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("imports the picked profile's cookies into the picked Octant profile and reports counts only", async () => {
    const { service, read, batches, journal: live } = importHarness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await service.execute("local-window", importCommand);

    expect(read).toHaveBeenCalledWith("chrome", "Default");
    expect(batches.flat()).toHaveLength(3);
    expect(result).toEqual({
      kind: "browser-cookies-imported",
      profile: { kind: "personal" },
      browser: "chrome",
      sourceProfile: "Default",
      imported: 3,
      skipped: 2,
    });
    // No cookie value reaches what the window is told, the journal, or any log.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    const events = replay(live);
    expect(events.map((event) => event.eventName)).toEqual([
      BROWSER_PROFILE_EVENT_NAMES.cookiesImported,
    ]);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(events[0]?.payload).toEqual({
      kind: "browser-cookies-imported",
      profile: { kind: "personal" },
      browser: "chrome",
      sourceProfile: "Default",
      imported: 3,
      skipped: 2,
    });
    for (const spy of [log, warn, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SENTINEL);
      spy.mockRestore();
    }
  });

  it("hands the desktop app bounded batches", async () => {
    const many = Array.from({ length: 450 }, (_, index) => cookie(`c${String(index)}`));
    const { service, batches } = importHarness({
      read: { status: "read", cookies: many, skipped: 0 },
    });

    const result = await service.execute("local-window", importCommand);

    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(result).toMatchObject({ kind: "browser-cookies-imported", imported: 450 });
  });

  it("imports nothing and journals nothing when the Keychain prompt is refused", async () => {
    const {
      service,
      batches,
      journal: live,
    } = importHarness({
      read: { status: "refused", reason: "keychain-refused" },
    });

    const result = await service.execute("local-window", importCommand);

    expect(result).toMatchObject({ kind: "browser-profiles-refused", reason: "keychain-refused" });
    expect(batches).toEqual([]);
    expect(live.headSequence()).toBe(0);
  });

  it("says in words why a source could not be read", async () => {
    for (const reason of ["source-not-found", "source-unreadable"] as const) {
      const { service } = importHarness({ read: { status: "refused", reason } });

      const result = await service.execute("local-window", importCommand);

      expect(result).toMatchObject({ kind: "browser-profiles-refused", reason });
    }
  });

  it("refuses a paired device before it reads anything", async () => {
    const { service, read } = importHarness();

    expect(await service.execute("remote-device", importCommand)).toMatchObject({
      kind: "browser-profiles-refused",
      reason: "profile-not-local",
    });
    expect(await service.execute("remote-device", { kind: "import-sources" })).toMatchObject({
      reason: "profile-not-local",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads nothing when no desktop app holds the store", async () => {
    const { service, read } = importHarness({ native: false });

    expect(await service.execute("local-window", importCommand)).toMatchObject({
      reason: "profile-unavailable",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("records what arrived when the store fails part way, and says it failed", async () => {
    let calls = 0;
    const many = Array.from({ length: 300 }, (_, index) => cookie(`c${String(index)}`));
    const { service, journal: live } = importHarness({
      read: { status: "read", cookies: many, skipped: 0 },
      importCookies: async (_profile, cookies) => {
        calls += 1;
        if (calls === 2) throw new Error(`failed on ${SENTINEL}`);
        return { imported: cookies.length, skipped: 0 };
      },
    });

    const result = await service.execute("local-window", importCommand);

    expect(result).toMatchObject({
      kind: "browser-profiles-refused",
      reason: "profile-unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(replay(live)[0]?.payload).toMatchObject({ imported: 200 });
  });
});
