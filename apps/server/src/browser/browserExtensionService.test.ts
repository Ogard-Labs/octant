import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeEventActor,
  decodeProject,
  decodeProjectId,
  decodeWindowId,
  type Project,
  type StoredBrowserProfile,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { BrowserExtensionService, extensionIdFromName } from "./browserExtensionService";
import type { BrowserRuntimePort } from "./browserRuntimePort";

const now = "2026-10-31T12:00:00.000Z";
const projectId = decodeProjectId("a0000000-0000-4000-8000-000000000002");
const actorId = "a0000000-0000-4000-8000-000000000001";
const windowId = decodeWindowId("a0000000-0000-4000-8000-000000000006");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "octant-extensions-"));
  roots.push(root);
  return root;
}

function journal(root: string): Journal {
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

function project(lifecycle: "active" | "archived" = "active"): Project {
  const actor = { kind: "local-user", actorId } as const;
  return decodeProject({
    id: String(projectId),
    name: "Research",
    lifecycle,
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

function extensionFolder(
  root: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const folder = join(root, `source-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(folder, name, ".."), { recursive: true });
    writeFileSync(join(folder, name), content);
  }
  return folder;
}

const manifest = (overrides: Record<string, unknown> = {}) => ({
  manifest_version: 3,
  name: "Reading tool",
  version: "1.0.0",
  permissions: ["storage"],
  host_permissions: ["https://example.com/*"],
  action: { default_popup: "popup.html" },
  ...overrides,
});

function harness(options: { readonly native?: boolean; readonly home?: string } = {}) {
  const root = scratch();
  const live = journal(root);
  const syncs: Array<{
    profile: StoredBrowserProfile;
    extensions: ReadonlyArray<{ id: string; path: string; contentHash: string }>;
  }> = [];
  const folders = new Map<string, string>();
  const runtime: BrowserRuntimePort = {
    available: async () => true,
    nativeAvailable: async () => options.native ?? true,
    profiles: {
      list: async () => [],
      clear: async () => undefined,
      syncExtensions: async (profile, extensions) => void syncs.push({ profile, extensions }),
      importCookies: async () => ({ imported: 0, skipped: 0 }),
    },
    createContext: async () => undefined,
    inspectTarget: async () => ({ sensitive: false }),
    act: async () => ({}),
    closeContext: async () => undefined,
    closeAll: async () => undefined,
  };
  const service = new BrowserExtensionService({
    dataDirectory: root,
    journal: live,
    actor: decodeEventActor({ kind: "local-user", actorId }),
    receipts: {
      consume: ({ receiptId, windowId: owner }) =>
        owner === String(windowId) ? folders.get(receiptId) : undefined,
    },
    runtime,
    ...(options.home === undefined ? {} : { importHome: options.home }),
    readProject: (id) => (String(id) === String(projectId) ? project() : undefined),
    uuid: randomUUID,
    clock: () => now,
    now: () => 1_000,
  });
  const pick = (folder: string): string => {
    const receiptId = randomUUID();
    folders.set(receiptId, folder);
    return receiptId;
  };
  const install = (folder: string) =>
    service.execute(windowId, "local-window", { kind: "install", receiptId: pick(folder) });
  return { root, live, service, syncs, pick, install };
}

const personal: StoredBrowserProfile = { kind: "personal" };
const projectProfile: StoredBrowserProfile = { kind: "project", projectId };

describe("Browser extension service", () => {
  it("installs a Manifest V3 folder off everywhere, copies it, and journals what it asks for", async () => {
    const { root, install, service, live } = harness();
    const source = extensionFolder(root, manifest(), { "popup.html": "<p>hi</p>" });

    const result = await install(source);

    expect(result).toMatchObject({
      kind: "browser-extension-installed",
      updated: false,
      extension: {
        name: "Reading tool",
        version: "1.0.0",
        enabledIn: [],
        needsConfirmation: [],
        hasPopup: true,
        hasOptionsPage: false,
        access: { permissions: ["storage"], hostPatterns: ["https://example.com/*"] },
      },
    });
    const id = extensionIdFromName("Reading tool");
    expect(existsSync(join(root, "browser-extensions", String(id), "manifest.json"))).toBe(true);
    // Later edits to the source folder change nothing.
    writeFileSync(join(source, "manifest.json"), "tampered");
    expect(
      readFileSync(join(root, "browser-extensions", String(id), "manifest.json"), "utf8"),
    ).toContain("Reading tool");
    expect(service.list()).toHaveLength(1);
    const events = live.replayAggregateType({
      aggregateType: "browser-extension",
      afterSequence: 0,
      limit: 10,
    });
    expect(events.map((event) => event.eventName)).toEqual(["browser.extension-installed@1"]);
  });

  it("refuses a caller that is not the person at a local window before reading anything", async () => {
    const { root, install, service, pick } = harness();
    const receiptId = pick(extensionFolder(root, manifest()));

    for (const command of [
      { kind: "install", receiptId } as const,
      { kind: "remove", extensionId: extensionIdFromName("x") } as const,
    ]) {
      expect(await service.execute(windowId, "remote-device", command)).toMatchObject({
        kind: "browser-extension-refused",
        reason: "extension-not-local",
      });
    }
    expect(service.list()).toEqual([]);
    expect(await service.execute(windowId, "remote-device", { kind: "list" })).toEqual({
      kind: "browser-extensions",
      extensions: [],
    });
    expect(await install(extensionFolder(root, manifest()))).toMatchObject({
      kind: "browser-extension-installed",
    });
  });

  it("refuses Manifest V2, native messaging, a missing manifest, and an expired pick", async () => {
    const { root, install, service } = harness();

    expect(await install(extensionFolder(root, manifest({ manifest_version: 2 })))).toMatchObject({
      reason: "extension-unsupported",
    });
    expect(
      await install(extensionFolder(root, manifest({ permissions: ["nativeMessaging"] }))),
    ).toMatchObject({ reason: "extension-unsupported" });
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(await install(empty)).toMatchObject({ reason: "invalid" });
    expect(
      await service.execute(windowId, "local-window", {
        kind: "install",
        receiptId: "never-issued",
      }),
    ).toMatchObject({ reason: "invalid" });
    expect(service.list()).toEqual([]);
  });

  it("says extensions need the desktop app when there is none", async () => {
    const { root, install } = harness({ native: false });

    expect(await install(extensionFolder(root, manifest()))).toMatchObject({
      kind: "browser-extension-refused",
      reason: "extension-unsupported",
    });
  });

  it("refuses a folder that holds a link rather than following it", async () => {
    const { root, install, service } = harness();
    const source = extensionFolder(root, manifest());
    symlinkSync("/etc/hosts", join(source, "leak.txt"));

    expect(await install(source)).toMatchObject({ reason: "invalid" });
    expect(service.list()).toEqual([]);
    expect(existsSync(join(root, "browser-extensions"))).toBe(true);
  });

  it("enables only in the profile the person named, only for the version they saw, and tells the desktop app", async () => {
    const { root, install, service, syncs } = harness();
    const installed = await install(extensionFolder(root, manifest(), { "popup.html": "x" }));
    if (installed.kind !== "browser-extension-installed") throw new Error("not installed");
    const { id, contentHash } = installed.extension;

    expect(
      await service.execute(windowId, "local-window", {
        kind: "enable",
        extensionId: id,
        profile: personal,
        contentHash: "f".repeat(64),
      }),
    ).toMatchObject({ reason: "stale" });
    expect(service.list()[0]?.enabledIn).toEqual([]);

    const enabled = await service.execute(windowId, "local-window", {
      kind: "enable",
      extensionId: id,
      profile: personal,
      contentHash,
    });

    expect(enabled).toMatchObject({
      kind: "browser-extension-changed",
      extension: { enabledIn: [personal] },
    });
    expect(syncs.at(-1)).toMatchObject({
      profile: personal,
      extensions: [{ id, contentHash, path: join(root, "browser-extensions", String(id)) }],
    });
    expect(service.enabledFolders(projectProfile)).toEqual([]);
  });

  it("will not enable in a Project that is gone, archived, or not there", async () => {
    const { root, install, service } = harness();
    const installed = await install(extensionFolder(root, manifest()));
    if (installed.kind !== "browser-extension-installed") throw new Error("not installed");

    const other = decodeProjectId("a0000000-0000-4000-8000-0000000000ff");
    expect(
      await service.execute(windowId, "local-window", {
        kind: "enable",
        extensionId: installed.extension.id,
        profile: { kind: "project", projectId: other },
        contentHash: installed.extension.contentHash,
      }),
    ).toMatchObject({ reason: "not-found" });
  });

  it("keeps an update that asks for the same or less where it was, and turns a wider one off everywhere", async () => {
    const { root, install, service, syncs } = harness();
    const first = await install(extensionFolder(root, manifest(), { "popup.html": "1" }));
    if (first.kind !== "browser-extension-installed") throw new Error("not installed");
    const { id, contentHash } = first.extension;
    for (const profile of [personal, projectProfile]) {
      await service.execute(windowId, "local-window", {
        kind: "enable",
        extensionId: id,
        profile,
        contentHash,
      });
    }

    const same = await install(
      extensionFolder(root, manifest({ version: "1.1.0", host_permissions: [] }), {
        "popup.html": "2",
      }),
    );
    expect(same).toMatchObject({
      kind: "browser-extension-installed",
      updated: true,
      extension: { version: "1.1.0", enabledIn: [personal, projectProfile], needsConfirmation: [] },
    });

    const wider = await install(
      extensionFolder(root, manifest({ version: "2.0.0", permissions: ["storage", "cookies"] }), {
        "popup.html": "3",
      }),
    );
    expect(wider).toMatchObject({
      extension: {
        version: "2.0.0",
        enabledIn: [],
        needsConfirmation: [personal, projectProfile],
        addedAccess: { permissions: ["cookies"], hostPatterns: ["https://example.com/*"] },
      },
    });
    expect(service.enabledFolders(personal)).toEqual([]);
    // Both profiles were told to drop the extension.
    expect(syncs.slice(-2).map((entry) => entry.extensions)).toEqual([[], []]);
  });

  it("treats enabling again as the confirmation of a widened update", async () => {
    const { root, install, service } = harness();
    const first = await install(extensionFolder(root, manifest(), { "popup.html": "1" }));
    if (first.kind !== "browser-extension-installed") throw new Error("not installed");
    await service.execute(windowId, "local-window", {
      kind: "enable",
      extensionId: first.extension.id,
      profile: personal,
      contentHash: first.extension.contentHash,
    });
    const wider = await install(
      extensionFolder(root, manifest({ permissions: ["storage", "cookies"] }), {
        "popup.html": "2",
      }),
    );
    if (wider.kind !== "browser-extension-installed") throw new Error("not installed");

    const confirmed = await service.execute(windowId, "local-window", {
      kind: "enable",
      extensionId: wider.extension.id,
      profile: personal,
      contentHash: wider.extension.contentHash,
    });

    expect(confirmed).toMatchObject({
      extension: { enabledIn: [personal], needsConfirmation: [] },
    });
  });

  it("disables per profile and removes everywhere, deleting its copy", async () => {
    const { root, install, service, syncs } = harness();
    const first = await install(extensionFolder(root, manifest(), { "popup.html": "1" }));
    if (first.kind !== "browser-extension-installed") throw new Error("not installed");
    const { id, contentHash } = first.extension;
    for (const profile of [personal, projectProfile]) {
      await service.execute(windowId, "local-window", {
        kind: "enable",
        extensionId: id,
        profile,
        contentHash,
      });
    }

    await service.execute(windowId, "local-window", {
      kind: "disable",
      extensionId: id,
      profile: personal,
    });
    expect(service.list()[0]?.enabledIn).toEqual([projectProfile]);

    const removed = await service.execute(windowId, "local-window", {
      kind: "remove",
      extensionId: id,
    });
    expect(removed).toEqual({ kind: "browser-extension-removed", extensionId: id });
    expect(service.list()).toEqual([]);
    expect(existsSync(join(root, "browser-extensions", String(id)))).toBe(false);
    expect(syncs.at(-1)?.extensions).toEqual([]);
  });

  it("rebuilds installed and enabled state from the journal after a restart", async () => {
    const { root, install, service, live } = harness();
    const first = await install(extensionFolder(root, manifest(), { "popup.html": "1" }));
    if (first.kind !== "browser-extension-installed") throw new Error("not installed");
    await service.execute(windowId, "local-window", {
      kind: "enable",
      extensionId: first.extension.id,
      profile: projectProfile,
      contentHash: first.extension.contentHash,
    });

    const restarted = new BrowserExtensionService({
      dataDirectory: root,
      journal: live,
      actor: decodeEventActor({ kind: "local-user", actorId }),
      receipts: { consume: () => undefined },
      runtime: { available: async () => true } as BrowserRuntimePort,
      readProject: () => undefined,
      uuid: randomUUID,
      clock: () => now,
      now: () => 1,
    });

    expect(restarted.list()).toEqual(service.list());
    expect(restarted.enabledFolders(projectProfile)).toHaveLength(1);
  });

  it("turns every extension off in a profile that goes away with its Project", async () => {
    const { root, install, service } = harness();
    const first = await install(extensionFolder(root, manifest(), { "popup.html": "1" }));
    if (first.kind !== "browser-extension-installed") throw new Error("not installed");
    for (const profile of [personal, projectProfile]) {
      await service.execute(windowId, "local-window", {
        kind: "enable",
        extensionId: first.extension.id,
        profile,
        contentHash: first.extension.contentHash,
      });
    }

    await service.forgetProfile(projectProfile);

    expect(service.list()[0]?.enabledIn).toEqual([personal]);
  });

  it("does not let a failing desktop sync undo what the journal says", async () => {
    const { root, service, pick } = harness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const folder = extensionFolder(root, manifest(), { "popup.html": "1" });

    const result = await service.execute(windowId, "local-window", {
      kind: "install",
      receiptId: pick(folder),
    });

    expect(result).toMatchObject({ kind: "browser-extension-installed" });
    expect(service.list()).toHaveLength(1);
  });
});

describe("Importing an extension from another browser", () => {
  const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
  const V2_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";
  const NATIVE_ID = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";

  /** A Chrome profile on a fake Mac; the real one is never read. */
  function fakeChrome(root: string): string {
    const home = join(root, "fake-home");
    const base = join(home, "Library", "Application Support", "Google", "Chrome");
    mkdirSync(join(base, "Default", "Extensions"), { recursive: true });
    writeFileSync(
      join(base, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" } } } }),
    );
    const add = (id: string, version: string, files: Record<string, string>) => {
      const folder = join(base, "Default", "Extensions", id, version);
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(folder, name, ".."), { recursive: true });
        writeFileSync(join(folder, name), content);
      }
    };
    add(CHROME_ID, "1.0_0", {
      "manifest.json": JSON.stringify(
        manifest({ name: "__MSG_appName__", default_locale: "en", version: "1.0" }),
      ),
      "_locales/en/messages.json": JSON.stringify({ appName: { message: "Reader view" } }),
      "_metadata/verified_contents.json": "{}",
      "popup.html": "<p>hi</p>",
    });
    add(CHROME_ID, "0.9_0", {
      "manifest.json": JSON.stringify(manifest({ name: "Old", version: "0.9" })),
    });
    add(V2_ID, "2.0_0", {
      "manifest.json": JSON.stringify({ manifest_version: 2, name: "Legacy", version: "2.0" }),
    });
    add(NATIVE_ID, "3.0_0", {
      "manifest.json": JSON.stringify(
        manifest({ name: "Vault", permissions: ["nativeMessaging"] }),
      ),
    });
    return home;
  }

  const importCommand = (id: string) =>
    ({
      kind: "import",
      browser: "chrome",
      sourceProfile: "Default",
      sourceExtensionId: id,
    }) as const;

  it("lists the extensions in a browser profile, and says in plain words why one is unsupported", async () => {
    const root = scratch();
    const { service } = harness({ home: fakeChrome(root) });

    const result = await service.execute(windowId, "local-window", { kind: "import-sources" });

    expect(result).toMatchObject({ kind: "browser-extension-import-sources" });
    if (result.kind !== "browser-extension-import-sources") return;
    expect(result.sources.map((source) => source.browser)).toEqual(["chrome"]);
    const extensions = result.sources[0]?.profiles[0]?.extensions ?? [];
    expect(extensions.find((entry) => entry.id === CHROME_ID)).toEqual({
      id: CHROME_ID,
      name: "Reader view",
      version: "1.0",
    });
    expect(extensions.find((entry) => entry.id === V2_ID)?.unsupportedReason).toContain(
      "Manifest V2",
    );
    expect(extensions.find((entry) => entry.id === NATIVE_ID)?.unsupportedReason).toContain(
      "native messaging",
    );
    // No folder on this Mac reaches a window.
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("copies the picked extension in, installed but off, and journals where it came from", async () => {
    const { root, service, live, syncs } = harness({ home: fakeChrome(scratch()) });

    const result = await service.execute(windowId, "local-window", importCommand(CHROME_ID));

    expect(result).toMatchObject({
      kind: "browser-extension-installed",
      updated: false,
      extension: { name: "Reader view", version: "1.0", enabledIn: [], hasPopup: true },
    });
    const copy = join(root, "browser-extensions", String(extensionIdFromName("Reader view")));
    expect(existsSync(join(copy, "popup.html"))).toBe(true);
    // The browser's own integrity files stay behind, and its profile is never loaded in place.
    expect(existsSync(join(copy, "_metadata"))).toBe(false);
    expect(syncs).toEqual([]);
    const events = live.replayAggregateType({
      aggregateType: "browser-extension",
      afterSequence: 0,
      limit: 10,
    });
    expect(events.map((event) => event.eventName)).toEqual(["browser.extension-installed@1"]);
    expect(events[0]?.payload).toMatchObject({ importedFrom: "chrome", name: "Reader view" });
  });

  it("refuses an unsupported extension with its reason and copies nothing", async () => {
    const root = scratch();
    const { service } = harness({ home: fakeChrome(root) });

    for (const [id, words] of [
      [V2_ID, "Manifest V2"],
      [NATIVE_ID, "native messaging"],
    ] as const) {
      const result = await service.execute(windowId, "local-window", importCommand(id));
      expect(result).toMatchObject({
        kind: "browser-extension-refused",
        reason: "extension-unsupported",
      });
      expect(JSON.stringify(result)).toContain(words);
    }
    expect(service.list()).toEqual([]);
  });

  it("refuses a pick the listing did not offer, so a name from a window never becomes a path", async () => {
    const root = scratch();
    const { service } = harness({ home: fakeChrome(root) });

    const result = await service.execute(windowId, "local-window", {
      ...importCommand(CHROME_ID),
      sourceProfile: "../../Default",
    });

    expect(result).toMatchObject({ kind: "browser-extension-refused", reason: "not-found" });
  });

  it("is the person's alone: a paired device sees no browser extensions and imports none", async () => {
    const root = scratch();
    const { service } = harness({ home: fakeChrome(root) });

    for (const command of [{ kind: "import-sources" } as const, importCommand(CHROME_ID)]) {
      expect(await service.execute(windowId, "remote-device", command)).toMatchObject({
        kind: "browser-extension-refused",
        reason: "extension-not-local",
      });
    }
    expect(service.list()).toEqual([]);
  });

  it("imports nothing without the desktop app", async () => {
    const root = scratch();
    const { service } = harness({ home: fakeChrome(root), native: false });

    expect(await service.execute(windowId, "local-window", importCommand(CHROME_ID))).toMatchObject(
      { kind: "browser-extension-refused", reason: "extension-unsupported" },
    );
  });
});
