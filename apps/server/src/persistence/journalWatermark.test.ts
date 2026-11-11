import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EventRegistry } from "./eventRegistry";
import { journalVerificationFingerprint } from "./journalWatermark";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

function withConnection<T>(use: (connection: SqliteConnection) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "octant-fingerprint-"));
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  try {
    return use(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function fingerprintOf(registry: EventRegistry): string | undefined {
  return withConnection((connection) => {
    connection.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (1);",
    );
    return journalVerificationFingerprint(registry, connection);
  });
}

const PersistedV1 = Schema.Struct({ value: Schema.String });

describe("journal verification fingerprint", () => {
  it("is the same for two registries that decode the same way", () => {
    const first = new EventRegistry().register("fixture.recorded", 1, PersistedV1);
    const second = new EventRegistry().register("fixture.recorded", 1, PersistedV1);

    expect(fingerprintOf(first)).toBeDefined();
    expect(fingerprintOf(first)).toBe(fingerprintOf(second));
  });

  it("changes when a persisted schema changes without a version bump", () => {
    const before = new EventRegistry().register("fixture.recorded", 1, PersistedV1);
    const after = new EventRegistry().register("fixture.recorded", 1, PersistedV1, {
      persistedSchema: Schema.Struct({ value: Schema.Number }),
    });

    expect(fingerprintOf(before)).not.toBe(fingerprintOf(after));
  });

  it("changes when the current decode schema changes without a version bump", () => {
    const before = new EventRegistry().register("fixture.recorded", 1, PersistedV1);
    const after = new EventRegistry().register(
      "fixture.recorded",
      1,
      Schema.Struct({ value: Schema.String, extra: Schema.String }),
    );

    expect(fingerprintOf(before)).not.toBe(fingerprintOf(after));
  });

  it("changes when a refinement changes", () => {
    const before = new EventRegistry().register(
      "fixture.recorded",
      1,
      Schema.Struct({ value: Schema.String.pipe(Schema.minLength(1)) }),
    );
    const after = new EventRegistry().register(
      "fixture.recorded",
      1,
      Schema.Struct({ value: Schema.String.pipe(Schema.minLength(2)) }),
    );

    expect(fingerprintOf(before)).not.toBe(fingerprintOf(after));
  });

  it("gives no fingerprint, so startup scans everything, when the fingerprint cannot be computed", () => {
    const registry = new EventRegistry().register("fixture.recorded", 1, PersistedV1);
    // No schema_migrations table: the migration head cannot be read.
    expect(
      withConnection((connection) => journalVerificationFingerprint(registry, connection)),
    ).toBeUndefined();
  });
});
