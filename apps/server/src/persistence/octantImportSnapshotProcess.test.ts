import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { importFromOctant } from "./octantImport";
import { openSqlite } from "./sqlitePort";

const now = "2026-11-27T12:00:00.000Z";
const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The writer stands in for Octant's running host: its own process, appending
// journal rows in small transactions and checkpointing after each, as the
// host's WAL does, until the parent stops it or its lifetime ends.
const WRITER = `
const Database = require(process.argv[2]);
const { randomUUID } = require("node:crypto");
const database = new Database(process.argv[3]);
database.pragma("journal_mode = WAL");
database.pragma("busy_timeout = 5000");
const insert = database.prepare(\`INSERT INTO event_journal (event_id, aggregate_type, aggregate_id,
  aggregate_version, event_name, event_version, host_id, correlation_id, actor_kind, actor_id,
  occurred_at, payload_json) VALUES (?, 'fixture', ?, 1, 'fixture.recorded', 1, 'local', ?,
  'system', '0c7a0000-0000-4000-8000-0000000000a1', '${now}', '{"value":"written"}')\`);
const batch = database.transaction(() => {
  for (let index = 0; index < 20; index += 1) insert.run(randomUUID(), randomUUID(), randomUUID());
});
const stopAt = Date.now() + 20000;
let announced = false;
const step = () => {
  if (Date.now() > stopAt) { database.close(); return; }
  batch();
  database.pragma("wal_checkpoint(PASSIVE)");
  if (!announced) { announced = true; process.stdout.write("ready\\n"); }
  setImmediate(step);
};
process.on("SIGTERM", () => { database.close(); process.exit(0); });
step();
`;

describe("snapshot of a store another process is writing", () => {
  it("copies a consistent store while a separate writer process appends and checkpoints", async () => {
    const base = mkdtempSync(join(tmpdir(), "octant-import-writer-"));
    directories.push(base);
    const octant = join(base, "Octant");
    const nightly = join(base, "Octant Nightly");
    mkdirSync(octant);
    mkdirSync(nightly);
    const store = join(octant, "octant.sqlite3");
    const setup = openSqlite(store);
    applyMigrations(setup, MIGRATIONS, () => now);
    setup.close();
    const script = join(base, "writer.cjs");
    writeFileSync(script, WRITER);

    const betterSqlite = createRequire(import.meta.url).resolve("better-sqlite3");
    const writer = spawn(process.execPath, [script, betterSqlite, store], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        writer.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("ready")) resolve();
        });
        writer.once("exit", () => reject(new Error("the writer stopped before it was ready")));
      });

      const outcome = importFromOctant({
        octantDataDirectory: octant,
        nightlyDataDirectory: nightly,
        clock: () => now,
      });

      expect(outcome).toMatchObject({ kind: "imported" });
      if (outcome.kind !== "imported") return;
      expect(outcome.counts.events).toBeGreaterThan(0);
      // Rows the writer added after the copy wait for the next import.
      const reader = openSqlite(join(nightly, "octant.sqlite3"));
      const nightlyRows = reader
        .prepare("SELECT count(*) AS value FROM event_journal WHERE aggregate_type = 'fixture'")
        .get() as { readonly value: number };
      reader.close();
      expect(nightlyRows.value).toBe(outcome.counts.events);
    } finally {
      writer.kill("SIGTERM");
      await exited;
    }
  });
});
