import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_HOST_ID,
  decodeChatThreadId,
  decodeProviderInstanceId,
  decodeWindowId,
  decodeZenChecklistItemId,
  decodeZenElementId,
  decodeZenSpace,
  decodeZenSpaceId,
  type ZenSpace,
} from "@octant/contracts";
import { createZenSpace } from "@octant/domain";
import { afterEach, describe, expect, it } from "vitest";
import { ZenEventStore } from "../zen/zenEventStore";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection, type Projection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { loadZenSpace } from "./zenProjection";

const directories: string[] = [];
const now = "2026-07-29T08:30:00.000Z";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000941");
const timerId = decodeZenElementId("00000000-0000-4000-8000-000000000942");

function openStore(): {
  connection: SqliteConnection;
  eventStore: ZenEventStore;
  journal: Journal;
  projection: Projection;
} {
  const directory = mkdtempSync(join(tmpdir(), "octant-zen-timer-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const projection = runtime.projections.get("zen");
  if (projection === undefined) throw new Error("Zen projection is not registered");
  return {
    connection,
    journal,
    projection,
    eventStore: new ZenEventStore({
      journal,
      uuid: (() => {
        let next = 950;
        return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
      })(),
      actor: {
        kind: "local-user",
        actorId: "00000000-0000-4000-8000-000000000943" as never,
      },
      clock: () => now,
    }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Zen timer projection", () => {
  it("safely migrates a legacy running boolean to paused during replay", () => {
    const store = openStore();
    const legacy = createZenSpace(windowId, LOCAL_HOST_ID);
    store.journal.append({
      aggregate: { aggregateType: "zen-space", aggregateId: legacy.spaceId as never },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000944" as never,
          eventName: "zen.space-snapshot-recorded@1" as never,
          eventVersion: 1,
          correlationId: "00000000-0000-4000-8000-000000000945" as never,
          actor: {
            kind: "local-user",
            actorId: "00000000-0000-4000-8000-000000000943" as never,
          },
          occurredAt: now as never,
          payload: {
            spaceId: legacy.spaceId,
            space: {
              ...legacy,
              version: 1,
              elements: [
                {
                  elementId: timerId,
                  kind: "timer",
                  durationMs: 25 * 60 * 1000,
                  remainingMs: 20 * 60 * 1000,
                  running: true,
                  geometry: { x: 64, y: 96, width: 360, height: 220 },
                  zIndex: 1,
                  minimized: false,
                  locked: false,
                },
              ],
            },
          },
        },
      ],
    });

    expect(loadZenSpace(store.connection, legacy.spaceId)?.elements[0]).toMatchObject({
      kind: "timer",
      status: "paused",
      remainingMs: 20 * 60 * 1000,
    });
    store.connection.close();
  });

  it("replays explicit timer completion without changing non-timer Zen state", () => {
    const store = openStore();
    const initial = createZenSpace(windowId, LOCAL_HOST_ID);
    const space: ZenSpace = {
      ...initial,
      elements: [
        {
          elementId: timerId,
          kind: "timer",
          durationMs: 25 * 60 * 1000,
          remainingMs: 0,
          status: "completed",
          startedAt: null,
          deadlineAt: null,
          clockSessionId: null,
          monotonicStartedMs: null,
          geometry: { x: 64, y: 96, width: 360, height: 220 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
    };

    const committed = store.eventStore.append(space, 0);
    expect(loadZenSpace(store.connection, committed.spaceId)?.elements[0]).toMatchObject({
      kind: "timer",
      status: "completed",
      remainingMs: 0,
    });

    rebuildProjection({
      connection: store.connection,
      journal: store.journal,
      projection: store.projection,
      clock: () => now,
    });
    expect(loadZenSpace(store.connection, committed.spaceId)?.elements[0]).toMatchObject({
      kind: "timer",
      status: "completed",
      remainingMs: 0,
    });
    store.connection.close();
  });

  it("rebuilds stable checklist identities repeatedly without duplication", () => {
    const store = openStore();
    const checklistSpaceId = decodeZenSpaceId("00000000-0000-4000-8000-000000000201");
    const checklistElementId = decodeZenElementId("00000000-0000-4000-8000-000000000202");
    const firstId = decodeZenChecklistItemId("00000000-0000-4000-8000-000000000203");
    const secondId = decodeZenChecklistItemId("00000000-0000-4000-8000-000000000204");
    const checklistSpace = decodeZenSpace({
      spaceId: checklistSpaceId,
      windowId: decodeWindowId("00000000-0000-4000-8000-000000000205"),
      version: 3,
      elements: [
        {
          elementId: checklistElementId,
          kind: "checklist",
          widgetVersion: 3,
          items: [
            { itemId: secondId, text: "Second", done: true },
            { itemId: firstId, text: "First", done: false },
          ],
          geometry: { x: 64, y: 96, width: 420, height: 260 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
      viewport: { panX: 0, panY: 0, scale: 1 },
      appearance: {
        background: { kind: "solid", color: "#1a1a2e" },
        dimming: 0,
        elementOpacity: 1,
        reducedMotion: false,
        reducedTransparency: false,
        increasedContrast: false,
      },
      assistant: null,
      createdAt: now,
      updatedAt: now,
    });

    store.journal.append({
      aggregate: { aggregateType: "zen-space", aggregateId: checklistSpaceId },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000206",
          eventName: "zen.widget-mutation-recorded@1",
          eventVersion: 1,
          correlationId: "00000000-0000-4000-8000-000000000207",
          actor: {
            kind: "local-user",
            actorId: "00000000-0000-4000-8000-000000000208",
          },
          occurredAt: now,
          payload: {
            spaceId: checklistSpaceId,
            space: { ...checklistSpace, version: 1 },
            mutation: {
              operation: "checklist-item-reordered",
              elementId: checklistElementId,
              itemId: secondId,
              widgetVersion: 3,
            },
          },
        },
      ],
    });

    for (let pass = 0; pass < 2; pass += 1) {
      rebuildProjection({
        connection: store.connection,
        journal: store.journal,
        projection: store.projection,
        clock: () => now,
      });
      expect(loadZenSpace(store.connection, checklistSpaceId)?.elements[0]).toMatchObject({
        kind: "checklist",
        widgetVersion: 3,
        items: [
          { itemId: secondId, text: "Second", done: true },
          { itemId: firstId, text: "First", done: false },
        ],
      });
    }
    store.connection.close();
  });

  it("replays saved recipe provenance exactly after a projection rebuild", () => {
    const store = openStore();
    const initial = createZenSpace(windowId, LOCAL_HOST_ID);
    const assistantThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000311");
    const providerInstanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000312");
    const recipeSpace: ZenSpace = {
      ...initial,
      recipes: [
        {
          recipeId: "00000000-0000-4000-8000-000000000313" as never,
          name: "Release focus",
          primitives: ["text"],
          fields: [],
          provenance: {
            assistantThreadId,
            providerInstanceId,
            modelId: "model-local" as never,
            previewId: "00000000-0000-4000-8000-000000000314" as never,
            previewVersion: 0 as never,
            createdAt: "2026-07-29T08:30:00.000Z" as never,
            confirmedAt: "2026-07-29T08:31:00.000Z" as never,
          },
        },
      ],
    };

    const committed = store.eventStore.append(recipeSpace, 0);
    rebuildProjection({
      connection: store.connection,
      journal: store.journal,
      projection: store.projection,
      clock: () => now,
    });

    expect(loadZenSpace(store.connection, committed.spaceId)?.recipes).toEqual(recipeSpace.recipes);
    store.connection.close();
  });
});
