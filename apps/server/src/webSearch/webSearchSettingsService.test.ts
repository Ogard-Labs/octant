import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProviderInstance, type WebSearchSettings } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { sessionNativeSetup } from "../providers/providerNativeSetup";
import {
  MIGRATED_SEARXNG_ENTRY_ID,
  WebSearchSettingsService,
  type WebSearchKeyStore,
} from "./webSearchSettingsService";

const directories: Array<string> = [];
let tick = 0;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openHarness(
  chatAddress: { value: string | undefined },
  extra: {
    readonly keys?: WebSearchKeyStore;
    readonly fetch?: typeof fetch;
    readonly log?: (line: string) => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-web-search-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-11-14T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const clock = () =>
    new Date(Date.parse("2026-11-14T12:00:00.000Z") + tick++ * 1000).toISOString();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  const service = new WebSearchSettingsService({
    connection,
    journal,
    clock,
    uuid: randomUUID,
    readChatSearxngBaseUrl: () => chatAddress.value,
    ...(extra.keys === undefined ? {} : { keys: extra.keys }),
    ...(extra.fetch === undefined ? {} : { fetch: extra.fetch }),
    ...(extra.log === undefined ? {} : { log: extra.log }),
  });
  return { connection, journal, runtime, service, clock };
}

const own: WebSearchSettings = {
  policy: "eu-only",
  backends: [
    {
      id: "00000000-0000-4000-8000-0000000000b1" as WebSearchSettings["backends"][number]["id"],
      kind: "searxng",
      address: "https://eu.search.example",
      enabled: true,
      statesZdr: false,
      statesEuProcessing: true,
    },
  ],
};

describe("web search settings", async () => {
  it("leaves a Codex account's own web search on after an EU only policy is saved", async () => {
    // The policy governs Octant's own backends only; a vendor runtime's own
    // web tools follow the person's and the account's switches (maintainer
    // decision, 2026-11-15).
    const { service } = openHarness({ value: undefined });
    expect(await service.set({ settings: own }, "local-window")).toMatchObject({
      kind: "saved",
      view: { settings: { policy: "eu-only" } },
    });
    const codex = decodeProviderInstance({
      id: "00000000-0000-4000-8000-0000000000c1",
      displayName: "Codex",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-11-14T12:00:00.000Z",
      updatedAt: "2026-11-14T12:00:00.000Z",
    });
    expect(
      sessionNativeSetup(
        { readProviderInstance: () => codex, readProject: () => undefined },
        { providerInstanceId: codex.id, mode: "work", executionPolicy: "approval-gated" },
      ),
    ).toMatchObject({ webTools: true, subagents: true });
  });

  it("reads Chat's SearXNG address as the first backend under Any until a list is saved", async () => {
    const { service } = openHarness({ value: "https://search.example/" });
    expect(await service.view()).toEqual({
      source: "migrated",
      settings: {
        policy: "any",
        backends: [
          {
            id: MIGRATED_SEARXNG_ENTRY_ID,
            kind: "searxng",
            address: "https://search.example/",
            enabled: true,
            statesZdr: false,
            statesEuProcessing: false,
          },
        ],
      },
      states: [{ id: MIGRATED_SEARXNG_ENTRY_ID, state: { kind: "ready" } }],
    });
    expect(service.eligible()).toHaveLength(1);
  });

  it("holds no backends and offers no search on a host with no SearXNG address", async () => {
    const { service } = openHarness({ value: undefined });
    expect(service.read()).toEqual({
      settings: { policy: "any", backends: [] },
      source: "migrated",
    });
    expect(service.eligible()).toEqual([]);
    expect(service.readyWithChatAddress(undefined)).toBe(false);
  });

  it("journals who changed the list, with the list before and after, and stops reading Chat's address", async () => {
    const chat = { value: "https://search.example/" as string | undefined };
    const { service, journal } = openHarness(chat);
    const outcome = await service.set({ settings: own }, "local-window");
    expect(outcome).toMatchObject({ kind: "saved", view: { source: "saved" } });

    const events = journal.replayAggregateType({
      aggregateType: "web-search-settings",
      afterSequence: 0,
      limit: 10,
    });
    expect(events.map((event) => event.payload)).toEqual([
      {
        kind: "web-search-settings-changed",
        previous: {
          policy: "any",
          backends: [expect.objectContaining({ address: "https://search.example/" })],
        },
        // The address is stored in the form it is searched in.
        next: {
          ...own,
          backends: [{ ...own.backends[0], address: "https://eu.search.example/" }],
        },
        changedBy: "local-window",
        changedAt: expect.stringMatching(/^2026-11-14T12:00:\d\d\.000Z$/),
      },
    ]);

    chat.value = undefined;
    expect(service.eligible().map((entry) => entry.address)).toEqual([
      "https://eu.search.example/",
    ]);
    expect(service.readyWithChatAddress(undefined)).toBe(true);
  });

  it("records nothing when the saved list is saved again unchanged", async () => {
    const { service, journal } = openHarness({ value: undefined });
    await service.set({ settings: own }, "local-window");
    await service.set({ settings: own }, "local-window");
    expect(
      journal.replayAggregateType({
        aggregateType: "web-search-settings",
        afterSequence: 0,
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it("offers no search when the policy leaves no backend eligible", async () => {
    const { service } = openHarness({ value: undefined });
    await service.set({ settings: { ...own, policy: "eu-and-zdr" } }, "local-window");
    expect(service.eligible()).toEqual([]);
    expect((await service.view()).states).toEqual([
      { id: own.backends[0]?.id, state: { kind: "not-eligible", reason: "zdr-not-stated" } },
    ]);
  });

  it("refuses an address that is not HTTPS or loopback HTTP and a device another person introduced", async () => {
    const { service, journal } = openHarness({ value: undefined });
    expect(
      await service.set(
        {
          settings: {
            ...own,
            backends: [{ ...own.backends[0]!, address: "http://search.example/" }],
          },
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", code: "invalid-address" });
    expect(await service.set({ settings: own }, "remote-device")).toMatchObject({
      kind: "refused",
      code: "unauthorized",
    });
    expect(
      journal.replayAggregateType({
        aggregateType: "web-search-settings",
        afterSequence: 0,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("replays to the same list when the projection is rebuilt from the journal", async () => {
    const { service, journal, runtime, connection, clock } = openHarness({ value: undefined });
    await service.set({ settings: own }, "local-window");
    await service.set({ settings: { ...own, policy: "any" } }, "local-window");
    connection.exec("DELETE FROM web_search_settings_projection;");
    expect(service.read().source).toBe("migrated");
    const projection = runtime.projections.get("web-search-settings");
    if (projection === undefined) throw new Error("web-search-settings must be registered");
    rebuildProjection({ connection, journal, projection, clock });
    expect(service.read()).toMatchObject({ source: "saved", settings: { policy: "any" } });
  });
});

function memoryKeys() {
  const stored = new Map<string, string>();
  const keys: WebSearchKeyStore = {
    has: async (ref) => stored.has(ref),
    resolve: async (ref) => {
      const value = stored.get(ref);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    set: async (ref, value) => void stored.set(ref, value),
    delete: async (ref) => void stored.delete(ref),
  };
  return { keys, stored };
}

const braveEntry = {
  id: "00000000-0000-4000-8000-0000000000d1" as WebSearchSettings["backends"][number]["id"],
  kind: "brave" as const,
  enabled: true,
  statesZdr: false,
  statesEuProcessing: false,
};

describe("web search keys", () => {
  it("keeps a vendor's key in the broker under a reference the host assigns, never in the settings", async () => {
    const { keys, stored } = memoryKeys();
    const { service, journal } = openHarness({ value: undefined }, { keys });
    const forged = { ...braveEntry, credentialRef: "00000000-0000-4000-8000-0000000000ff" };
    await service.set({ settings: { policy: "any", backends: [forged] } }, "local-window");
    const saved = service.read().settings.backends[0];
    expect(saved?.credentialRef).toBeDefined();
    expect(saved?.credentialRef).not.toBe(forged.credentialRef);
    expect((await service.view()).states[0]?.state).toEqual({ kind: "needs-key" });

    expect(
      await service.setKey({ entryId: braveEntry.id, key: "brave-secret" }, "local-window"),
    ).toMatchObject({ kind: "saved", view: { states: [{ state: { kind: "ready" } }] } });
    expect([...stored.values()]).toEqual(["brave-secret"]);
    const events = journal.replayAggregateType({
      aggregateType: "web-search-settings",
      afterSequence: 0,
      limit: 10,
    });
    expect(JSON.stringify(events)).not.toContain("brave-secret");
  });

  it("records nothing when a list with a keyed vendor is saved again unchanged", async () => {
    const { keys } = memoryKeys();
    const { service, journal } = openHarness({ value: undefined }, { keys });
    const settings = { policy: "any" as const, backends: [braveEntry] };
    await service.set({ settings }, "local-window");
    const credentialRef = service.read().settings.backends[0]?.credentialRef;
    await service.set({ settings }, "local-window");
    expect(service.read().settings.backends[0]?.credentialRef).toBe(credentialRef);
    expect(
      journal.replayAggregateType({
        aggregateType: "web-search-settings",
        afterSequence: 0,
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it("refuses a key from a device another person introduced, for an unsaved entry, and for SearXNG", async () => {
    const { keys, stored } = memoryKeys();
    const { service } = openHarness({ value: "https://search.example/" }, { keys });
    expect(
      await service.setKey({ entryId: braveEntry.id, key: "k" }, "remote-device"),
    ).toMatchObject({ kind: "refused", code: "unauthorized" });
    expect(
      await service.setKey({ entryId: braveEntry.id, key: "k" }, "local-window"),
    ).toMatchObject({ kind: "refused", code: "unknown-entry" });
    expect(
      await service.setKey({ entryId: MIGRATED_SEARXNG_ENTRY_ID, key: "k" }, "local-window"),
    ).toMatchObject({ kind: "refused", code: "key-not-taken" });
    expect(stored.size).toBe(0);
  });

  it("deletes the stored key when the entry's address changes or the entry is removed", async () => {
    const { keys, stored } = memoryKeys();
    const { service } = openHarness({ value: undefined }, { keys });
    const linkup = {
      ...braveEntry,
      kind: "linkup" as const,
      address: "https://eu-a.linkup.example/",
    };
    await service.set({ settings: { policy: "any", backends: [linkup] } }, "local-window");
    await service.setKey({ entryId: linkup.id, key: "first" }, "local-window");
    const firstRef = service.read().settings.backends[0]?.credentialRef;

    await service.set(
      {
        settings: {
          policy: "any",
          backends: [{ ...linkup, address: "https://eu-b.linkup.example/" }],
        },
      },
      "local-window",
    );
    expect(stored.size).toBe(0);
    expect(service.read().settings.backends[0]?.credentialRef).not.toBe(firstRef);

    await service.setKey({ entryId: linkup.id, key: "second" }, "local-window");
    expect(stored.size).toBe(1);
    await service.set({ settings: { policy: "any", backends: [] } }, "local-window");
    expect(stored.size).toBe(0);
  });

  it("deletes the stored key when a keyed entry becomes a SearXNG instance under the same id", async () => {
    const { keys, stored } = memoryKeys();
    const { service } = openHarness({ value: undefined }, { keys });
    await service.set({ settings: { policy: "any", backends: [braveEntry] } }, "local-window");
    await service.setKey({ entryId: braveEntry.id, key: "brave-key" }, "local-window");
    expect(stored.size).toBe(1);

    await service.set(
      {
        settings: {
          policy: "any",
          backends: [{ ...braveEntry, kind: "searxng", address: "https://search.example" }],
        },
      },
      "local-window",
    );

    expect(stored.size).toBe(0);
    expect(service.read().settings.backends[0]?.credentialRef).toBeUndefined();
  });

  it("leaves no key behind when the entry's address changes while its key is being stored", async () => {
    const { keys, stored } = memoryKeys();
    let release = () => {};
    const slowKeys: WebSearchKeyStore = {
      ...keys,
      set: async (ref, value) => {
        await new Promise<void>((resolve) => (release = resolve));
        await keys.set(ref, value);
      },
    };
    const { service } = openHarness({ value: undefined }, { keys: slowKeys });
    const linkup = { ...braveEntry, kind: "linkup" as const, address: "https://a.linkup.example/" };
    await service.set({ settings: { policy: "any", backends: [linkup] } }, "local-window");

    const storing = service.setKey({ entryId: linkup.id, key: "first" }, "local-window");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const moving = service.set(
      {
        settings: {
          policy: "any",
          backends: [{ ...linkup, address: "https://b.linkup.example/" }],
        },
      },
      "local-window",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([storing, moving]);

    expect(stored.size).toBe(0);
    expect((await service.view()).states[0]?.state).toEqual({ kind: "needs-key" });
  });

  it("offers search through a keyed vendor only while its key is stored, and learns stored keys after a restart", async () => {
    const { keys } = memoryKeys();
    const { service, connection, journal, clock } = openHarness({ value: undefined }, { keys });
    await service.set({ settings: { policy: "any", backends: [braveEntry] } }, "local-window");
    expect(service.eligible()).toEqual([]);
    await service.setKey({ entryId: braveEntry.id, key: "brave-secret" }, "local-window");
    expect(service.eligible().map((entry) => entry.id)).toEqual([braveEntry.id]);

    const restarted = new WebSearchSettingsService({
      connection,
      journal,
      clock,
      uuid: randomUUID,
      readChatSearxngBaseUrl: () => undefined,
      keys,
    });
    await restarted.view();
    expect(restarted.eligible().map((entry) => entry.id)).toEqual([braveEntry.id]);

    await service.setKey({ entryId: braveEntry.id }, "local-window");
    expect(service.eligible()).toEqual([]);
  });

  it("logs a stored key it could not delete without the key itself", async () => {
    const { keys } = memoryKeys();
    const lines: string[] = [];
    const { service } = openHarness(
      { value: undefined },
      {
        keys: { ...keys, delete: async () => Promise.reject(new Error("locked")) },
        log: (line) => lines.push(line),
      },
    );
    await service.set({ settings: { policy: "any", backends: [braveEntry] } }, "local-window");
    await service.setKey({ entryId: braveEntry.id, key: "brave-secret" }, "local-window");
    await service.set({ settings: { policy: "any", backends: [] } }, "local-window");
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("brave-secret");
  });

  it("journals the backend that answered and the one that refused its key with the thread's tool call, and reads that entry as Needs key", async () => {
    const { keys } = memoryKeys();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.search.brave.com/")) {
        return new Response("{}", { status: 401 });
      }
      return Response.json({
        results: [{ title: "Octant", url: "https://example.com/octant", content: "A workspace." }],
      });
    });
    const { service, journal } = openHarness(
      { value: undefined },
      { keys, fetch: fetchMock as unknown as typeof fetch },
    );
    const searx = {
      id: "00000000-0000-4000-8000-0000000000d2" as WebSearchSettings["backends"][number]["id"],
      kind: "searxng" as const,
      address: "https://search.example/",
      enabled: true,
      statesZdr: false,
      statesEuProcessing: false,
    };
    await service.set(
      { settings: { policy: "any", backends: [braveEntry, searx] } },
      "local-window",
    );
    await service.setKey({ entryId: braveEntry.id, key: "revoked" }, "local-window");

    const threadId = "00000000-0000-4000-8000-0000000000c7";
    const answer = await service.search({
      query: "octant",
      limit: 5,
      threadId,
      toolCallId: "toolu_search_1",
    });
    expect(answer.results.map((result) => result.url)).toEqual(["https://example.com/octant"]);
    const routed = journal.replayAggregateType({
      aggregateType: "web-search-calls",
      afterSequence: 0,
      limit: 10,
    });
    expect(routed.map((event) => event.payload)).toEqual([
      {
        kind: "web-search-call-routed",
        threadId,
        toolCallId: "toolu_search_1",
        answeredBy: { entryId: searx.id, backend: "searxng" },
        failed: [{ entryId: braveEntry.id, backend: "brave", failure: "key-refused" }],
        routedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(routed)).not.toContain('octant"');
    expect((await service.view()).states[0]?.state).toEqual({ kind: "needs-key" });
  });
});
