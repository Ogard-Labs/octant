import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { decodeWindowId } from "@octant/contracts";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ShellService } from "../shellService";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { Persistence, PersistenceStartupFailed, makePersistenceLive } from "./persistenceService";
import { SHELL_SETTINGS_AGGREGATE_ID } from "./shellProjection";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-persistence-service-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PersistenceLive", () => {
  it("enters recovery before creating a fresh store beside a staged removal", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "octant.sqlite3");
    const stagedDirectory = join(directory, ".octant-remove-interrupted");
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS, () => now);
    seeded.close();
    mkdirSync(stagedDirectory);
    renameSync(databasePath, join(stagedDirectory, "octant.sqlite3"));

    const result = await startupResult(directory);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ category: "recovery-required" });
    }
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(stagedDirectory, "octant.sqlite3"))).toBe(true);
  });

  it("creates a verified, confined online backup through the live connection", async () => {
    const directory = temporaryDirectory();
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    insertFixtureEvent(seeded);
    seeded.close();

    const receipt = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          return persistence.createVerifiedBackup("manual");
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );

    expect(receipt).toMatchObject({
      migrationVersion: MIGRATIONS.at(-1)!.version,
      journalHead: 1,
      path: realpathSync(join(directory, "octant.sqlite3.backup-manual")),
    });
    expect(receipt.byteLength).toBeGreaterThan(0);
    expect(existsSync(join(directory, "octant.sqlite3.backup-manual"))).toBe(true);
  });

  it("refuses online backup labels that are not confined identifiers", async () => {
    const directory = temporaryDirectory();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          return Either.try(() => persistence.createVerifiedBackup("../escape"));
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(existsSync(join(directory, "escape"))).toBe(false);
  });

  it("migrates and catches up projections before reporting ready", async () => {
    const directory = temporaryDirectory();
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    insertFixtureEvent(seeded);
    seeded.close();

    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          return persistence.status();
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );

    expect(status).toMatchObject({
      migrationVersion: MIGRATIONS.at(-1)!.version,
      journalHead: 1,
      aggregateCount: 1,
      state: "current",
      quarantineCount: 0,
      projections: [
        { name: "aggregate-heads", lastSequence: 1, lag: 0 },
        { name: "projects", lastSequence: 1, lag: 0 },
        { name: "providers", lastSequence: 1, lag: 0 },
        { name: "contexts", lastSequence: 1, lag: 0 },
        { name: "usage", lastSequence: 1, lag: 0 },
        { name: "diagnostics-exports", lastSequence: 1, lag: 0 },
        { name: "shell", lastSequence: 1, lag: 0 },
        { name: "chat", lastSequence: 1, lag: 0 },
        { name: "code", lastSequence: 1, lag: 0 },
        { name: "agent-runs", lastSequence: 1, lag: 0 },
        { name: "canvas", lastSequence: 1, lag: 0 },
        { name: "automations", lastSequence: 1, lag: 0 },
        { name: "github-clones", lastSequence: 1, lag: 0 },
        { name: "zen", lastSequence: 1, lag: 0 },
        { name: "agent-profiles", lastSequence: 1, lag: 0 },
        { name: "validation-evidence", lastSequence: 1, lag: 0 },
        { name: "theme", lastSequence: 1, lag: 0 },
        { name: "extensions", lastSequence: 1, lag: 0 },
        { name: "remote-access", lastSequence: 1, lag: 0 },
        { name: "thread-checkpoint", lastSequence: 1, lag: 0 },
        { name: "product-feedback", lastSequence: 1, lag: 0 },
        { name: "thread-retention", lastSequence: 1, lag: 0 },
        { name: "thread-external-content-taint", lastSequence: 1, lag: 0 },
      ],
    });
  });

  it("boots from exact legacy shell settings without rewriting persisted v1 data", async () => {
    const directory = temporaryDirectory();
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    const legacySettings = {
      chatEnabled: false,
      workEnabled: true,
      sidebarWidth: 320,
      sidebarMaterial: "opaque",
    } as const;
    const legacyPayloadJson = JSON.stringify({ settings: legacySettings });
    const legacySettingsJson = JSON.stringify(legacySettings);
    insertLegacyShellState(seeded, legacyPayloadJson, legacySettingsJson);
    seeded.close();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const service = new ShellService({
            persistence,
            uuid: () => "00000000-0000-4000-8000-000000000915",
            clock: () => now,
          });
          const bootstrap = service.bootstrap(
            decodeWindowId("00000000-0000-4000-8000-000000000916"),
          );
          return {
            bootstrap,
            event: persistence.connection
              .prepare("SELECT payload_json FROM event_journal WHERE global_sequence = 1")
              .get(),
            projection: persistence.connection
              .prepare(
                "SELECT settings_json FROM shell_settings_projection WHERE projection_key = ?",
              )
              .get("shell-settings"),
          };
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );

    expect(result.bootstrap.settings).toEqual({
      ...legacySettings,
      contextSidebarWidth: 360,
      // A persisted store that predates first-run onboarding was written by a
      // host that already finished its first run, so the upcast stamps
      // `completed`; re-running the walkthrough on upgrade would be wrong.
      // Only a genuinely new store starts `pending`.
      firstRunOnboarding: "completed",
      automaticUpdateChecks: true,
      lastContextSurface: null,
      modeSwitcherPresentation: "dropdown",
      navigatorAssistant: {},
      projectViewSwitcherPresentation: "dropdown",
      userProfile: { accent: "indigo", avatar: { kind: "initials" } },
      sidebarBackground: {
        kind: "none",
        overlayColor: "#1a1a1c",
        overlayOpacity: 100,
        vibrancyMode: "off",
      },
      environmentPresentationByMode: { chat: "hidden", work: "floating", code: "floating" },
    });
    expect(result.bootstrap.settingsVersion).toBe(1);
    expect(result.event).toEqual({ payload_json: legacyPayloadJson });
    expect(result.projection).toEqual({ settings_json: legacySettingsJson });
  });

  it("closes SQLite when the Effect scope ends", async () => {
    const directory = temporaryDirectory();
    let closed = false;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Persistence;
          expect(closed).toBe(false);
        }).pipe(
          Effect.provide(
            makePersistenceLive({
              dataDirectory: directory,
              clock: () => now,
              openConnection: (path) => trackClose(openSqlite(path), () => (closed = true)),
            }),
          ),
        ),
      ),
    );

    expect(closed).toBe(true);
  });

  it("fails closed for a checksum-incompatible store and closes its connection", async () => {
    const directory = temporaryDirectory();
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    connection.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (1, 'create_event_store', 'changed', '${now}');
    `);
    connection.close();
    let closed = false;

    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.provide(
            Persistence,
            makePersistenceLive({
              dataDirectory: directory,
              clock: () => now,
              openConnection: (path) => trackClose(openSqlite(path), () => (closed = true)),
            }),
          ),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PersistenceStartupFailed);
      expect(result.left).toMatchObject({ category: "migration-incompatible" });
      expect(String(result.left)).not.toContain(directory);
    }
    expect(closed).toBe(true);
  });

  it("fails closed when startup finds quarantined state", async () => {
    const directory = temporaryDirectory();
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    insertFixtureEvent(seeded);
    seeded
      .prepare(`
        INSERT INTO event_quarantine (
          projection_name, global_sequence, event_id, reason, observed_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        "aggregate-heads",
        1,
        "00000000-0000-4000-8000-000000000904",
        "unsupported-event-version",
        now,
      );
    seeded.close();

    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.provide(
            Persistence,
            makePersistenceLive({ dataDirectory: directory, clock: () => now }),
          ),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PersistenceStartupFailed);
      expect(result.left).toMatchObject({ category: "recovery-required" });
    }
  });

  it("fails closed when a projection checkpoint is ahead of the journal", async () => {
    const directory = temporaryDirectory();
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    seeded
      .prepare(
        "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?)",
      )
      .run("aggregate-heads", 1, now);
    seeded.close();

    const result = await startupResult(directory);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ category: "recovery-required" });
    }
  });

  it("fails closed when recovered projection state is inconsistent", async () => {
    const directory = temporaryDirectory();
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    insertFixtureEvent(seeded);
    seeded
      .prepare(
        "INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence) VALUES (?, ?, ?, ?)",
      )
      .run("fixture", "00000000-0000-4000-8000-000000000901", 2, 1);
    seeded
      .prepare(
        "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?)",
      )
      .run("aggregate-heads", 1, now);
    seeded.close();

    const result = await startupResult(directory);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ category: "recovery-required" });
    }
  });

  it.each([
    [
      "an unsupported future event",
      2,
      JSON.stringify({ value: "private-future" }),
      "unsupported-event-version",
    ],
    ["a malformed registered payload", 1, JSON.stringify({ value: 42 }), "event-payload-invalid"],
  ] as const)(
    "fails closed and quarantines %s even when the projection checkpoint is current",
    async (_name, eventVersion, payloadJson, reason) => {
      const directory = temporaryDirectory();
      const seeded = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(seeded, MIGRATIONS, () => now);
      insertFixtureEvent(seeded, { eventVersion, payloadJson });
      seedCurrentAggregateHeadAndCheckpoint(seeded);
      const journalBefore = seeded.prepare("SELECT * FROM event_journal").all();
      seeded.close();

      const result = await startupResult(directory);

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({ category: "recovery-required" });
        expect(String(result.left)).not.toContain("private-");
        expect(String(result.left)).not.toContain(directory);
      }

      const inspected = openSqlite(join(directory, "octant.sqlite3"));
      expect(inspected.prepare("SELECT * FROM event_journal").all()).toEqual(journalBefore);
      expect(
        inspected
          .prepare("SELECT projection_name, global_sequence, reason FROM event_quarantine")
          .all(),
      ).toEqual([
        { projection_name: "aggregate-heads", global_sequence: 1, reason },
        { projection_name: "projects", global_sequence: 1, reason },
        { projection_name: "providers", global_sequence: 1, reason },
        { projection_name: "contexts", global_sequence: 1, reason },
        { projection_name: "usage", global_sequence: 1, reason },
        { projection_name: "diagnostics-exports", global_sequence: 1, reason },
        { projection_name: "shell", global_sequence: 1, reason },
        { projection_name: "chat", global_sequence: 1, reason },
        { projection_name: "code", global_sequence: 1, reason },
        { projection_name: "agent-runs", global_sequence: 1, reason },
        { projection_name: "canvas", global_sequence: 1, reason },
        { projection_name: "automations", global_sequence: 1, reason },
        { projection_name: "github-clones", global_sequence: 1, reason },
        { projection_name: "zen", global_sequence: 1, reason },
        { projection_name: "agent-profiles", global_sequence: 1, reason },
        { projection_name: "validation-evidence", global_sequence: 1, reason },
        { projection_name: "theme", global_sequence: 1, reason },
        { projection_name: "extensions", global_sequence: 1, reason },
        { projection_name: "remote-access", global_sequence: 1, reason },
        { projection_name: "thread-checkpoint", global_sequence: 1, reason },
        { projection_name: "product-feedback", global_sequence: 1, reason },
        { projection_name: "thread-retention", global_sequence: 1, reason },
        { projection_name: "thread-external-content-taint", global_sequence: 1, reason },
      ]);
      inspected.close();
    },
  );

  it.each([
    ["SQLITE_BUSY", "storage-busy"],
    ["SQLITE_CANTOPEN", "storage-unavailable"],
  ] as const)("reports %s startup failures without internal details", async (code, category) => {
    const directory = temporaryDirectory();
    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.provide(
            Persistence,
            makePersistenceLive({
              dataDirectory: directory,
              openConnection: () => {
                throw Object.assign(new Error("private database detail"), { code });
              },
            }),
          ),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ category });
      expect(String(result.left)).not.toContain("private database detail");
    }
  });
});

function startupResult(directory: string) {
  return Effect.runPromise(
    Effect.either(
      Effect.scoped(
        Effect.provide(
          Persistence,
          makePersistenceLive({ dataDirectory: directory, clock: () => now }),
        ),
      ),
    ),
  );
}

function trackClose(connection: SqliteConnection, onClose: () => void): SqliteConnection {
  return {
    ...connection,
    close: () => {
      connection.close();
      onClose();
    },
  };
}

function insertFixtureEvent(
  connection: SqliteConnection,
  overrides: { readonly eventVersion?: number; readonly payloadJson?: string } = {},
): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, correlation_id, causation_id,
        actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "00000000-0000-4000-8000-000000000904",
      "fixture",
      "00000000-0000-4000-8000-000000000901",
      1,
      "fixture.recorded",
      overrides.eventVersion ?? 1,
      "00000000-0000-4000-8000-000000000903",
      null,
      "system",
      "00000000-0000-4000-8000-000000000902",
      now,
      overrides.payloadJson ?? JSON.stringify({ value: "startup" }),
    );
}

function seedCurrentAggregateHeadAndCheckpoint(connection: SqliteConnection): void {
  connection
    .prepare(
      "INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence) VALUES (?, ?, ?, ?)",
    )
    .run("fixture", "00000000-0000-4000-8000-000000000901", 1, 1);
  connection
    .prepare(
      "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?)",
    )
    .run("aggregate-heads", 1, now);
}

function insertLegacyShellState(
  connection: SqliteConnection,
  payloadJson: string,
  settingsJson: string,
): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, correlation_id, causation_id,
        actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "00000000-0000-4000-8000-000000000914",
      "shell-settings",
      SHELL_SETTINGS_AGGREGATE_ID,
      1,
      "shell.settings-replaced",
      1,
      "00000000-0000-4000-8000-000000000913",
      null,
      "system",
      "00000000-0000-4000-8000-000000000912",
      now,
      payloadJson,
    );
  connection
    .prepare(
      "INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence) VALUES (?, ?, ?, ?)",
    )
    .run("shell-settings", SHELL_SETTINGS_AGGREGATE_ID, 1, 1);
  connection
    .prepare(
      "INSERT INTO shell_settings_projection (projection_key, schema_version, settings_json, aggregate_version) VALUES (?, ?, ?, ?)",
    )
    .run("shell-settings", 1, settingsJson, 1);
  const checkpoint = connection.prepare(
    "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?)",
  );
  for (const projectionName of ["aggregate-heads", "projects", "providers", "contexts", "shell"]) {
    checkpoint.run(projectionName, 1, now);
  }
}
