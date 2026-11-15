import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSearchSettings } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { MIGRATED_SEARXNG_ENTRY_ID, WebSearchSettingsService } from "./webSearchSettingsService";

const directories: Array<string> = [];
let tick = 0;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openHarness(chatAddress: { value: string | undefined }) {
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

describe("web search settings", () => {
  it("reads Chat's SearXNG address as the first backend under Any until a list is saved", () => {
    const { service } = openHarness({ value: "https://search.example/" });
    expect(service.view()).toEqual({
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

  it("holds no backends and offers no search on a host with no SearXNG address", () => {
    const { service } = openHarness({ value: undefined });
    expect(service.read()).toEqual({
      settings: { policy: "any", backends: [] },
      source: "migrated",
    });
    expect(service.eligible()).toEqual([]);
    expect(service.readyWithChatAddress(undefined)).toBe(false);
  });

  it("journals who changed the list, with the list before and after, and stops reading Chat's address", () => {
    const chat = { value: "https://search.example/" as string | undefined };
    const { service, journal } = openHarness(chat);
    const outcome = service.set({ settings: own }, "local-window");
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

  it("records nothing when the saved list is saved again unchanged", () => {
    const { service, journal } = openHarness({ value: undefined });
    service.set({ settings: own }, "local-window");
    service.set({ settings: own }, "local-window");
    expect(
      journal.replayAggregateType({
        aggregateType: "web-search-settings",
        afterSequence: 0,
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it("offers no search when the policy leaves no backend eligible", () => {
    const { service } = openHarness({ value: undefined });
    service.set({ settings: { ...own, policy: "eu-and-zdr" } }, "local-window");
    expect(service.eligible()).toEqual([]);
    expect(service.view().states).toEqual([
      { id: own.backends[0]?.id, state: { kind: "not-eligible", reason: "zdr-not-stated" } },
    ]);
  });

  it("refuses an address that is not HTTPS or loopback HTTP and a device another person introduced", () => {
    const { service, journal } = openHarness({ value: undefined });
    expect(
      service.set(
        {
          settings: {
            ...own,
            backends: [{ ...own.backends[0]!, address: "http://search.example/" }],
          },
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", code: "invalid-address" });
    expect(service.set({ settings: own }, "remote-device")).toMatchObject({
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

  it("replays to the same list when the projection is rebuilt from the journal", () => {
    const { service, journal, runtime, connection, clock } = openHarness({ value: undefined });
    service.set({ settings: own }, "local-window");
    service.set({ settings: { ...own, policy: "any" } }, "local-window");
    connection.exec("DELETE FROM web_search_settings_projection;");
    expect(service.read().source).toBe("migrated");
    const projection = runtime.projections.get("web-search-settings");
    if (projection === undefined) throw new Error("web-search-settings must be registered");
    rebuildProjection({ connection, journal, projection, clock });
    expect(service.read()).toMatchObject({ source: "saved", settings: { policy: "any" } });
  });
});
