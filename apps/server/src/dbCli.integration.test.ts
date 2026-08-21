import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireHostRuntimeOwner,
  deriveHostRuntimeHostId,
  prepareHostRuntimePaths,
  resolveHostRuntimePaths,
} from "@octant/host-runtime";
import { decodeWindowId } from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ShellService } from "./shellService";
import { Persistence, makePersistenceLive } from "./persistence/persistenceService";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { SHELL_SETTINGS_AGGREGATE_ID } from "./persistence/shellProjection";
import { openSqlite } from "./persistence/sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database CLI runtime composition", () => {
  it("refuses to open the canonical store while another runtime owner is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-owner-"));
    directories.push(directory);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: directory },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: directory,
      temporaryDirectory: realpathSync(tmpdir()),
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const owner = await acquireHostRuntimeOwner({
      paths,
      hostId: deriveHostRuntimeHostId(paths.dataDirectory),
      instanceId: "11111111-1111-4111-8111-111111111111",
      serverVersion: "0.0.0-test",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "test-owner",
    });
    if (owner.kind !== "owner") throw new Error("expected test owner");
    try {
      const result = await runCliAsync(directory, "status");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"category": "owner-active"');
      expect(existsSync(join(directory, "octant.sqlite3"))).toBe(false);
    } finally {
      await owner.release();
    }
  });

  it("routes online backup through a live owner and refuses online restore", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-online-"));
    directories.push(directory);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: directory },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: directory,
      temporaryDirectory: realpathSync(tmpdir()),
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const backupLabels: Array<string | undefined> = [];
    const owner = await acquireHostRuntimeOwner({
      paths,
      hostId: deriveHostRuntimeHostId(paths.dataDirectory),
      instanceId: "44444444-4444-4444-8444-444444444444",
      serverVersion: "0.0.0-test",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "test-owner",
      onControlRequest: (request) => {
        if (request.type === "backup") {
          backupLabels.push(request.label);
          return {
            backup: {
              outcome: "created",
              path: join(directory, "octant.sqlite3.backup-manual"),
              migrationVersion: MIGRATIONS.at(-1)!.version,
              journalHead: 3,
              byteLength: 8_192,
            },
          };
        }
        if (request.type === "restore") {
          return {
            restore: {
              outcome: "refused-online",
              guidance: "Stop the Octant host, then run the offline restore command.",
            },
          };
        }
        return undefined;
      },
    });
    if (owner.kind !== "owner") throw new Error("expected test owner");
    try {
      const backup = await runCliAsync(directory, "backup");
      expect(backup.exitCode).toBe(0);
      expect(JSON.parse(backup.stdout)).toMatchObject({
        routedThroughOwner: true,
        migrationVersion: MIGRATIONS.at(-1)!.version,
        journalHead: 3,
      });
      expect(backupLabels).toEqual(["manual"]);
      // The CLI never opened the live store: no store was created by attach.
      expect(existsSync(join(directory, "octant.sqlite3"))).toBe(false);

      const restore = await runCliAsync(directory, "restore", "--confirm");
      expect(restore.exitCode).toBe(1);
      expect(restore.stderr).toContain('"category": "restore-requires-offline"');
    } finally {
      await owner.release();
    }
  });

  it("rebuilds a store written through Persistence without quarantining its event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-composition-"));
    directories.push(directory);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          persistence.journal.append({
            aggregate: {
              aggregateType: "fixture",
              aggregateId: "00000000-0000-4000-8000-000000001001",
            },
            expectedVersion: 0,
            events: [
              {
                eventId: "00000000-0000-4000-8000-000000001004",
                eventName: "fixture.recorded",
                eventVersion: 1,
                correlationId: "00000000-0000-4000-8000-000000001003",
                actor: {
                  kind: "system",
                  actorId: "00000000-0000-4000-8000-000000001002",
                },
                occurredAt: now,
                payload: { value: "shared-runtime-registry" },
              },
            ],
          });
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );
    const journalBefore = readJournalRows(directory);

    expect(runCli(directory, "status")).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"state": "current"'),
      stderr: "",
    });
    expect(runCli(directory, "verify")).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"valid": true'),
      stderr: "",
    });
    expect(runCli(directory, "rebuild")).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"rebuilt"'),
      stderr: "",
    });
    expect(runCli(directory, "verify")).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"valid": true'),
      stderr: "",
    });

    const status = runCli(directory, "status");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      journalHead: 1,
      aggregateCount: 1,
      quarantineCount: 0,
      state: "current",
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
      ],
    });

    expect(readJournalRows(directory)).toEqual(journalBefore);
    expect(journalBefore).toHaveLength(1);
  });

  it("backs up, diverges, restores, and reports a deterministic idempotent second start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-restore-"));
    directories.push(directory);
    await appendFixtureEvent(directory, "1");

    // Capture a verified backup at journal head 1.
    const backup = runCli(directory, "backup");
    expect(backup.exitCode).toBe(0);
    expect(JSON.parse(backup.stdout)).toMatchObject({
      migrationVersion: MIGRATIONS.at(-1)!.version,
      journalHead: 1,
    });

    // Diverge the live store past the backup point.
    await appendFixtureEvent(directory, "2");
    expect(JSON.parse(runCli(directory, "status").stdout)).toMatchObject({ journalHead: 2 });

    // Restore returns the store to the verified backup boundary.
    const restore = runCli(directory, "restore", "--confirm");
    expect(restore.exitCode).toBe(0);
    expect(JSON.parse(restore.stdout)).toMatchObject({ journalHead: 1 });

    // The restored store reports a consistent state, and a second start is
    // byte-for-byte identical (deterministic and idempotent replay).
    const firstStart = runCli(directory, "status");
    const secondStart = runCli(directory, "status");
    expect(firstStart.stdout).toBe(secondStart.stdout);
    expect(JSON.parse(firstStart.stdout)).toMatchObject({
      journalHead: 1,
      state: "current",
      integrity: "ok",
    });
    expect(runCli(directory, "verify").exitCode).toBe(0);
  });

  it("removes all local data within the confined directory and leaves unrelated files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-remove-"));
    directories.push(directory);
    await appendFixtureEvent(directory, "1");
    const unrelated = join(directory, "unrelated-user-note.txt");
    writeFileSync(unrelated, "kept");

    const removal = runCli(directory, "remove", "--confirm");
    if (process.platform === "darwin") {
      // macOS removal must not delete local data when the native Keychain
      // broker is absent. The real packaged purge is validated separately;
      // this integration test covers the CLI's fail-closed boundary.
      expect(removal.exitCode).toBe(1);
      expect(removal.stdout).toBe("");
      expect(removal.stderr).toContain('"category": "credential-cleanup-blocked"');
      expect(existsSync(join(directory, "octant.sqlite3"))).toBe(true);
    } else {
      expect(removal.exitCode).toBe(0);
      const report = JSON.parse(removal.stdout);
      expect(report).toMatchObject({ operation: "remove-all" });
      expect(report.deleted).toContain("host-identity");
      expect(report.removedArtifacts).toContain("octant.sqlite3");
      expect(existsSync(join(directory, "octant.sqlite3"))).toBe(false);
    }
    expect(existsSync(unrelated)).toBe(true);

    // A destructive removal without confirmation is refused.
    expect(runCli(directory, "remove").exitCode).toBe(2);
  });

  it("does not create a store while previewing removal of an absent store", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-dry-run-empty-"));
    directories.push(directory);

    const preview = runCli(directory, "remove", "--dry-run");

    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      operation: "remove-all",
      dryRun: true,
      wouldRemoveArtifacts: [],
    });
    expect(existsSync(join(directory, "octant.sqlite3"))).toBe(false);
  });

  it("reports journal incompatibility without mutating journal or quarantine", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-incompatible-"));
    directories.push(directory);
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    seeded
      .prepare(`
        INSERT INTO event_journal (
          event_id, aggregate_type, aggregate_id, aggregate_version,
          event_name, event_version, correlation_id, causation_id,
          actor_kind, actor_id, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "00000000-0000-4000-8000-000000001104",
        "fixture",
        "00000000-0000-4000-8000-000000001101",
        1,
        "fixture.recorded",
        2,
        "00000000-0000-4000-8000-000000001103",
        null,
        "system",
        "00000000-0000-4000-8000-000000001102",
        now,
        JSON.stringify({ value: "private-future" }),
      );
    seeded
      .prepare(
        "INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence) VALUES (?, ?, ?, ?)",
      )
      .run("fixture", "00000000-0000-4000-8000-000000001101", 1, 1);
    seeded
      .prepare(
        "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?)",
      )
      .run("aggregate-heads", 1, now);
    const journalBefore = seeded.prepare("SELECT * FROM event_journal").all();
    const quarantineBefore = seeded.prepare("SELECT * FROM event_quarantine").all();
    seeded.close();

    const status = runCli(directory, "status");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: "invalid",
      recoveryReason: "journal-incompatible",
    });
    expect(status.stdout).not.toContain("private-future");
    expect(status.stdout).not.toContain(directory);

    const verification = runCli(directory, "verify");
    expect(verification.exitCode).toBe(1);
    expect(JSON.parse(verification.stdout)).toMatchObject({
      valid: false,
      state: "invalid",
      issues: [{ kind: "journal-incompatible", reason: "unsupported-event-version" }],
    });
    expect(verification.stdout).not.toContain("private-future");
    expect(verification.stdout).not.toContain(directory);

    const inspected = openSqlite(join(directory, "octant.sqlite3"));
    expect(inspected.prepare("SELECT * FROM event_journal").all()).toEqual(journalBefore);
    expect(inspected.prepare("SELECT * FROM event_quarantine").all()).toEqual(quarantineBefore);
    inspected.close();
  });

  it("rebuilds an exact legacy shell store, retires stale quarantine, and preserves journal bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-db-cli-legacy-recovery-"));
    directories.push(directory);
    const legacySettings = {
      chatEnabled: false,
      workEnabled: true,
      sidebarWidth: 320,
      sidebarMaterial: "opaque",
    } as const;
    const legacyPayloadJson = JSON.stringify({ settings: legacySettings });
    const seeded = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(seeded, MIGRATIONS, () => now);
    seedLegacyShellState(seeded, legacyPayloadJson, JSON.stringify(legacySettings));
    for (const projectionName of [
      "aggregate-heads",
      "projects",
      "providers",
      "contexts",
      "shell",
    ]) {
      seeded
        .prepare(
          "INSERT INTO event_quarantine (projection_name, global_sequence, event_id, reason, observed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          projectionName,
          1,
          "00000000-0000-4000-8000-000000001204",
          "event-payload-invalid",
          now,
        );
    }
    const journalBefore = seeded
      .prepare("SELECT payload_json FROM event_journal WHERE global_sequence = 1")
      .get();
    seeded.close();

    expect(JSON.parse(runCli(directory, "status").stdout)).toMatchObject({
      state: "quarantined",
      quarantineCount: 5,
    });
    expect(runCli(directory, "rebuild")).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(runCli(directory, "verify").stdout)).toMatchObject({
      valid: true,
      state: "current",
    });

    const inspected = openSqlite(join(directory, "octant.sqlite3"));
    expect(
      inspected.prepare("SELECT payload_json FROM event_journal WHERE global_sequence = 1").get(),
    ).toEqual(journalBefore);
    expect(inspected.prepare("SELECT count(*) AS count FROM event_quarantine").get()).toEqual({
      count: 0,
    });
    inspected.close();

    const settings = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          return new ShellService({
            persistence,
            uuid: () => "00000000-0000-4000-8000-000000001205",
            clock: () => now,
          }).bootstrap(decodeWindowId("00000000-0000-4000-8000-000000001206")).settings;
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );
    expect(settings).toEqual({
      ...legacySettings,
      contextSidebarWidth: 360,
      // A pre-onboarding store already finished its first run, so the upcast
      // stamps `completed` rather than re-running the walkthrough on upgrade.
      firstRunOnboarding: "completed",
      automaticUpdateChecks: true,
      lastContextSurface: null,
      modeSwitcherPresentation: "buttons",
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
  });
});

function runCli(directory: string, ...command: ReadonlyArray<string>) {
  const result = spawnSync("bun", ["src/dbCli.ts", ...command], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, OCTANT_DATA_DIR: directory },
    encoding: "utf8",
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runCliAsync(directory: string, ...command: ReadonlyArray<string>) {
  const child = spawn("bun", ["src/dbCli.ts", ...command], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, OCTANT_DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

function appendFixtureEvent(directory: string, marker: string): Promise<void> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        persistence.journal.append({
          aggregate: {
            aggregateType: "fixture",
            aggregateId: `00000000-0000-4000-8000-${marker.padStart(12, "0")}`,
          },
          expectedVersion: 0,
          events: [
            {
              eventId: `00000000-0000-4000-8000-1${marker.padStart(11, "0")}`,
              eventName: "fixture.recorded",
              eventVersion: 1,
              correlationId: "00000000-0000-4000-8000-000000009003",
              actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000009002" },
              occurredAt: now,
              payload: { value: `recovery-${marker}` },
            },
          ],
        });
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now }))),
    ),
  );
}

function readJournalRows(directory: string): ReadonlyArray<unknown> {
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  try {
    return connection.prepare("SELECT * FROM event_journal ORDER BY global_sequence").all();
  } finally {
    connection.close();
  }
}

function seedLegacyShellState(
  connection: ReturnType<typeof openSqlite>,
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
      "00000000-0000-4000-8000-000000001204",
      "shell-settings",
      SHELL_SETTINGS_AGGREGATE_ID,
      1,
      "shell.settings-replaced",
      1,
      "00000000-0000-4000-8000-000000001203",
      null,
      "system",
      "00000000-0000-4000-8000-000000001202",
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
