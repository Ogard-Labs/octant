import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { readExtensionRecord } from "../persistence/extensionProjection";
import {
  BOARD_EXTENSION_ID,
  boardPluginManifest,
  seedFirstPartyPluginIfAbsent,
} from "./firstPartyPlugins";

const directories: Array<string> = [];
const now = "2026-08-16T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-first-party-plugins-"));
  directories.push(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  return { connection, journal };
}

describe("seedFirstPartyPluginIfAbsent", () => {
  it("seeds the board manifest as a real, enabled, trusted projected extension", async () => {
    const { connection, journal } = await setup();
    seedFirstPartyPluginIfAbsent({
      journal,
      connection,
      uuid: randomUUID,
      clock: () => now,
      manifest: boardPluginManifest(),
    });

    const record = readExtensionRecord(connection, BOARD_EXTENSION_ID);
    expect(record?.lifecycleState).toBe("installed");
    expect(record?.trusted).toBe(true);
    expect(record?.pluginDesired).toBe(true);
    expect(record?.componentDesired["board"]).toBe(true);
    expect(record?.current?.slug).toBe("board");
  });

  it("is idempotent: a second call leaves the journal and projection unchanged", async () => {
    const { connection, journal } = await setup();
    const manifest = boardPluginManifest();
    seedFirstPartyPluginIfAbsent({
      journal,
      connection,
      uuid: randomUUID,
      clock: () => now,
      manifest,
    });
    const head = journal.headSequence();
    const firstRecord = readExtensionRecord(connection, BOARD_EXTENSION_ID);

    seedFirstPartyPluginIfAbsent({
      journal,
      connection,
      uuid: randomUUID,
      clock: () => now,
      manifest,
    });

    expect(journal.headSequence()).toBe(head);
    expect(readExtensionRecord(connection, BOARD_EXTENSION_ID)).toEqual(firstRecord);
  });
});
