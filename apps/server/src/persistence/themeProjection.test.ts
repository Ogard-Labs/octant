import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection, type Projection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { THEME_SETTINGS_AGGREGATE_ID, readThemeSettings } from "./themeProjection";

const directories: string[] = [];
const now = "2026-07-28T10:00:00.000Z";

function openStore(): {
  connection: SqliteConnection;
  journal: Journal;
  projection: Projection;
} {
  const directory = mkdtempSync(join(tmpdir(), "octant-theme-projection-"));
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
  const projection = runtime.projections.get("theme");
  if (projection === undefined) throw new Error("theme projection is not registered");
  return { connection, journal, projection };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ThemeProjection", () => {
  it("persists and rebuilds the complete settings snapshot", () => {
    const store = openStore();
    store.journal.append({
      aggregate: { aggregateType: "theme-settings", aggregateId: THEME_SETTINGS_AGGREGATE_ID },
      expectedVersion: 0,
      events: [
        {
          eventId: "00000000-0000-4000-8000-000000000101",
          eventName: "theme.settings-updated@1",
          eventVersion: 1,
          correlationId: "00000000-0000-4000-8000-000000000102",
          actor: { kind: "system", actorId: "00000000-0000-0000-0000-000000000002" },
          occurredAt: now,
          payload: {
            settings: { ...DEFAULT_THEME_SETTINGS, mode: "dark" },
            version: 1,
            updatedAt: now,
          },
        },
      ],
    });
    expect(readThemeSettings(store.connection)?.settings.mode).toBe("dark");
    rebuildProjection({
      connection: store.connection,
      journal: store.journal,
      projection: store.projection,
      clock: () => now,
    });
    expect(readThemeSettings(store.connection)?.settings.mode).toBe("dark");
    store.connection.close();
  });
});
