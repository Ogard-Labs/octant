import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "./sqlitePort";
import type { SqliteConnection } from "./sqlitePort";
import { MIGRATIONS, applyMigrations, type Migration } from "./migrations";
import {
  DatabaseVersionTooNew,
  MigrationChecksumMismatch,
  MigrationFailed,
} from "./migrationErrors";

const temporaryDirectories: Array<string> = [];

function openTemporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "octant-migrations-"));
  temporaryDirectories.push(directory);
  return openSqlite(join(directory, "octant.sqlite"));
}

const clock = () => "2026-07-13T12:00:00.000Z";

interface EventValues {
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly actorKind: string;
  readonly actorId: string;
}

const validEventValues: EventValues = {
  eventId: "11111111-1111-4111-8111-111111111111",
  aggregateType: "fixture",
  aggregateId: "22222222-2222-4222-8222-222222222222",
  correlationId: "33333333-3333-4333-8333-333333333333",
  causationId: null,
  actorKind: "system",
  actorId: "44444444-4444-4444-8444-444444444444",
};

function insertEvent(connection: SqliteConnection, values: EventValues): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name,
        event_version, correlation_id, causation_id, actor_kind, actor_id,
        occurred_at, payload_json
      ) VALUES (?, ?, ?, 1, 'FixtureCreated', 1, ?, ?, ?, ?, ?, '{}')
    `)
    .run(
      values.eventId,
      values.aggregateType,
      values.aggregateId,
      values.correlationId,
      values.causationId,
      values.actorKind,
      values.actorId,
      clock(),
    );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("applyMigrations", () => {
  it("adds the extension projection to a version 23 store without rewriting journal history", () => {
    const connection = openTemporaryDatabase();
    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 23), clock);
      insertEvent(connection, validEventValues);
      const before = connection.prepare("SELECT * FROM event_journal").all();

      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [
          24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
          46, 47, 48, 49, 50, 51, 52, 53,
        ],
      });
      expect(connection.prepare("SELECT * FROM event_journal").all()).toEqual(
        (before as ReadonlyArray<Record<string, unknown>>).map((row) => ({
          ...row,
          actor_json: null,
        })),
      );
      expect(
        connection
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extension_package_projection'",
          )
          .get(),
      ).toEqual({ name: "extension_package_projection" });
    } finally {
      connection.close();
    }
  });

  it("rewinds the Code checkpoint so an upgraded store replays thread activity", () => {
    const connection = openTemporaryDatabase();
    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 44), clock);
      // An upgraded store carries a Code checkpoint already at the journal head.
      // Left there, catch-up replays nothing and the new activity table stays
      // empty for every thread that already exists.
      connection
        .prepare(
          `INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at)
           VALUES ('code', 42, ?)`,
        )
        .run(clock());
      connection
        .prepare(
          `INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at)
           VALUES ('chat', 42, ?)`,
        )
        .run(clock());

      applyMigrations(connection, MIGRATIONS, clock);

      expect(
        connection
          .prepare("SELECT projection_name FROM projection_checkpoints ORDER BY projection_name")
          .all(),
      ).toEqual([{ projection_name: "chat" }]);
    } finally {
      connection.close();
    }
  });

  it("creates the event store and strict shell, Project, provider, and context projection tables on a fresh database", () => {
    const connection = openTemporaryDatabase();

    try {
      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
          26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
          48, 49, 50, 51, 52, 53,
        ],
      });

      const rows = connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as ReadonlyArray<{ readonly name: string }>;

      expect(rows.map(({ name }) => name)).toEqual([
        "agent_profile_projection",
        "agent_run_content_store",
        "aggregate_heads",
        "binding_receipt_store",
        "chat_attachment_projection",
        "chat_attempt_projection",
        "chat_citation_projection",
        "chat_content_store",
        "chat_purge_projection",
        "chat_search_projection",
        "chat_settings_projection",
        "chat_thread_projection",
        "chat_turn_projection",
        "chat_turn_route_projection",
        "code_checkout_projection",
        "code_evidence_content_store",
        "code_file_projection",
        "code_review_projection",
        "code_runtime_projection",
        "code_settings_projection",
        "code_thread_activity_projection",
        "code_thread_follow_up_projection",
        "code_thread_projection",
        "context_capacity_projection",
        "context_manifest_projection",
        "context_override_projection",
        "context_plan_projection",
        "context_summary_content_store",
        "context_summary_projection",
        "context_usage_projection",
        "diagnostics_export_receipt_projection",
        "diagnostics_failure_incident_projection",
        "environment_presentation_projection",
        "event_journal",
        "event_quarantine",
        "extension_package_projection",
        "host_identity_projection",
        "local_authority_clock_guard",
        "product_feedback_projection",
        "project_memory_projection",
        "project_projection",
        "projection_checkpoints",
        "provider_catalog_projection",
        "provider_defaults_projection",
        "provider_instance_projection",
        "remote_auth_challenge_store",
        "remote_clock_guard",
        "remote_command_receipt_projection",
        "remote_device_projection",
        "remote_request_nonce_store",
        "remote_security_audit_projection",
        "remote_session_invalidation_projection",
        "remote_session_store",
        "schema_migrations",
        "shell_settings_projection",
        "theme_settings_projection",
        "thread_checkpoint_projection",
        "thread_external_content_ingestion_projection",
        "thread_external_content_taint_projection",
        "thread_follow_up_projection",
        "thread_purge_tombstone",
        "thread_retention_projection",
        "thread_work_item_projection",
        "usage_audit_log",
        "usage_record_projection",
        "validation_evidence_projection",
        "window_workspace_projection",
        "zen_space_projection",
      ]);

      const projectionTables = connection
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?, ?, ?, ?) ORDER BY name",
        )
        .all(
          "project_memory_projection",
          "project_projection",
          "provider_catalog_projection",
          "provider_defaults_projection",
          "provider_instance_projection",
          "shell_settings_projection",
          "window_workspace_projection",
          "agent_profile_projection",
          "validation_evidence_projection",
        ) as ReadonlyArray<{
        readonly name: string;
        readonly sql: string;
      }>;
      expect(projectionTables).toHaveLength(9);
      expect(projectionTables.every(({ sql }) => sql.endsWith(") STRICT"))).toBe(true);

      const projectIndexes = connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'project_projection_%' ORDER BY name",
        )
        .all() as ReadonlyArray<{ readonly name: string }>;
      expect(projectIndexes.map(({ name }) => name)).toEqual([
        "project_projection_lifecycle_idx",
        "project_projection_mode_idx",
        "project_projection_pin_idx",
      ]);

      const providerIndexes = connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'provider_instance_projection_%' ORDER BY name",
        )
        .all() as ReadonlyArray<{ readonly name: string }>;
      expect(providerIndexes.map(({ name }) => name)).toEqual([
        "provider_instance_projection_driver_idx",
        "provider_instance_projection_enabled_idx",
      ]);

      const contextTables = connection
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'context_%_projection' ORDER BY name",
        )
        .all() as ReadonlyArray<{ readonly name: string; readonly sql: string }>;
      expect(contextTables).toHaveLength(6);
      expect(contextTables.every(({ sql }) => sql.endsWith(") STRICT"))).toBe(true);

      const contextIndexes = connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'context_%_idx' ORDER BY name",
        )
        .all() as ReadonlyArray<{ readonly name: string }>;
      expect(contextIndexes.map(({ name }) => name)).toEqual([
        "context_capacity_provider_state_idx",
        "context_capacity_subject_idx",
        "context_manifest_subject_created_idx",
        "context_plan_manifest_created_idx",
        "context_summary_content_subject_idx",
        "context_usage_plan_observed_idx",
        "context_usage_provider_observed_idx",
      ]);

      const chatTables = connection
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_%' ORDER BY name",
        )
        .all() as ReadonlyArray<{ readonly name: string; readonly sql: string }>;
      expect(chatTables.length).toBeGreaterThanOrEqual(9);
      expect(chatTables.every(({ sql }) => sql.endsWith(") STRICT"))).toBe(true);

      const chatIndexes = connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'chat_%' OR name LIKE 'thread_%') ORDER BY name",
        )
        .all() as ReadonlyArray<{ readonly name: string }>;
      expect(chatIndexes.map(({ name }) => name)).toEqual([
        "chat_attachment_thread_idx",
        "chat_attempt_thread_idx",
        "chat_citation_thread_idx",
        "chat_content_thread_idx",
        "chat_purge_pending_idx",
        "chat_thread_lifecycle_updated_idx",
        "chat_thread_project_idx",
        "chat_turn_route_thread_idx",
        "chat_turn_thread_sequence_idx",
        "thread_checkpoint_thread_idx",
        "thread_follow_up_open_idx",
        "thread_work_item_thread_idx",
      ]);

      const journalForeignKeys = connection
        .prepare("PRAGMA foreign_key_list(event_journal)")
        .all() as ReadonlyArray<unknown>;
      expect(journalForeignKeys).toEqual([]);
      expect(connection.prepare("PRAGMA foreign_key_list(chat_content_store)").all()).toEqual([]);
      for (const table of [
        "code_checkout_projection",
        "code_file_projection",
        "code_runtime_projection",
        "code_review_projection",
        "code_settings_projection",
        "code_thread_activity_projection",
        "code_thread_follow_up_projection",
        "code_thread_projection",
      ]) {
        expect(connection.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual([]);
      }
    } finally {
      connection.close();
    }
  });

  it.each(["eventId", "aggregateId", "correlationId", "actorKind", "actorId"] as const)(
    "rejects empty and whitespace-only %s values",
    (field) => {
      for (const invalidValue of ["", "   "]) {
        const connection = openTemporaryDatabase();

        try {
          applyMigrations(connection, MIGRATIONS, clock);
          expect(() =>
            insertEvent(connection, { ...validEventValues, [field]: invalidValue }),
          ).toThrow();
        } finally {
          connection.close();
        }
      }
    },
  );

  it("accepts a null causation identity but rejects empty and whitespace-only values", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS, clock);
      expect(() => insertEvent(connection, validEventValues)).not.toThrow();

      for (const causationId of ["", "   "]) {
        expect(() =>
          insertEvent(connection, {
            ...validEventValues,
            eventId: `${causationId.length}-55555555-5555-4555-8555-555555555555`,
            aggregateId: `${causationId.length}-66666666-6666-4666-8666-666666666666`,
            causationId,
          }),
        ).toThrow();
      }
    } finally {
      connection.close();
    }
  });

  it("puts back a profile scope that an edit had widened to the whole user", () => {
    const connection = openTemporaryDatabase();
    const profileId = "55555555-5555-4555-8555-555555555555";
    const projectId = "66666666-6666-4666-8666-666666666666";

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 51), clock);
      connection
        .prepare(`
          INSERT INTO event_journal (
            event_id, aggregate_type, aggregate_id, aggregate_version, event_name,
            event_version, correlation_id, causation_id, actor_kind, actor_id,
            occurred_at, payload_json
          ) VALUES (?, 'agent-profile', ?, 1, 'agent.profile-created@1', 1, ?, NULL,
            'system', ?, ?, ?)
        `)
        .run(
          "77777777-7777-4777-8777-777777777777",
          profileId,
          validEventValues.correlationId,
          validEventValues.actorId,
          clock(),
          JSON.stringify({ scope: { scopeKind: "project", scopeRef: projectId } }),
        );
      // What an edit left behind before the scope was carried forward.
      connection
        .prepare(`
          INSERT INTO agent_profile_projection (
            profile_id, schema_version, scope_kind, scope_ref, profile_json, aggregate_version
          ) VALUES (?, 1, 'user', '00000000-0000-0000-0000-000000000010', '{}', 2)
        `)
        .run(profileId);

      applyMigrations(connection, MIGRATIONS, clock);

      expect(
        connection
          .prepare(
            `SELECT scope_kind, scope_ref FROM agent_profile_projection WHERE profile_id = ?`,
          )
          .get(profileId),
      ).toEqual({ scope_kind: "project", scope_ref: projectId });
    } finally {
      connection.close();
    }
  });

  it("adds Kimi Code to provider projections without rewriting existing rows", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 4), clock);
      connection
        .prepare(`
          INSERT INTO provider_instance_projection (
            instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
          ) VALUES (?, 1, 'codex', 1, '{}', 1)
        `)
        .run("existing-provider");

      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [
          5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
          29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
          51, 52, 53,
        ],
      });
      expect(
        connection
          .prepare(
            "SELECT instance_id, driver_kind FROM provider_instance_projection ORDER BY instance_id",
          )
          .all(),
      ).toEqual([{ instance_id: "existing-provider", driver_kind: "codex" }]);
      expect(() =>
        connection
          .prepare(`
            INSERT INTO provider_instance_projection (
              instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
            ) VALUES (?, 1, 'kimi-code', 1, '{}', 1)
          `)
          .run("kimi-provider"),
      ).not.toThrow();
    } finally {
      connection.close();
    }
  });

  it("adds Anthropic-compatible to provider projections without rewriting existing rows", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 10), clock);
      connection
        .prepare(`
          INSERT INTO provider_instance_projection (
            instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
          ) VALUES (?, 1, 'kimi-code', 1, '{}', 1)
        `)
        .run("kimi-provider");

      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [
          11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
          33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
        ],
      });
      expect(
        connection
          .prepare(
            "SELECT instance_id, driver_kind FROM provider_instance_projection ORDER BY instance_id",
          )
          .all(),
      ).toEqual([{ instance_id: "kimi-provider", driver_kind: "kimi-code" }]);
      expect(() =>
        connection
          .prepare(`
            INSERT INTO provider_instance_projection (
              instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
            ) VALUES (?, 1, 'anthropic-compatible', 1, '{}', 1)
          `)
          .run("anthropic-provider"),
      ).not.toThrow();
      expect(() =>
        connection
          .prepare(`
            INSERT INTO provider_instance_projection (
              instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
            ) VALUES (?, 1, 'azure-foundry', 1, '{}', 1)
          `)
          .run("foundry-provider"),
      ).not.toThrow();
    } finally {
      connection.close();
    }
  });

  it("adds Azure Foundry to provider projections without rewriting existing rows", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 12), clock);
      connection
        .prepare(`
          INSERT INTO provider_instance_projection (
            instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
          ) VALUES (?, 1, 'anthropic-compatible', 1, '{}', 1)
        `)
        .run("anthropic-provider");

      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [
          13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
          35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
        ],
      });
      expect(
        connection
          .prepare(
            "SELECT instance_id, driver_kind FROM provider_instance_projection ORDER BY instance_id",
          )
          .all(),
      ).toEqual([{ instance_id: "anthropic-provider", driver_kind: "anthropic-compatible" }]);
      expect(() =>
        connection
          .prepare(`
            INSERT INTO provider_instance_projection (
              instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
            ) VALUES (?, 1, 'azure-foundry', 1, '{}', 1)
          `)
          .run("foundry-provider"),
      ).not.toThrow();
    } finally {
      connection.close();
    }
  });

  it("adds Grok to provider projections without rewriting existing rows", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 44), clock);
      connection
        .prepare(`
          INSERT INTO provider_instance_projection (
            instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
          ) VALUES (?, 1, 'azure-foundry', 1, '{}', 1)
        `)
        .run("foundry-provider");

      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [45, 46, 47, 48, 49, 50, 51, 52, 53],
      });
      expect(
        connection
          .prepare(
            "SELECT instance_id, driver_kind FROM provider_instance_projection ORDER BY instance_id",
          )
          .all(),
      ).toEqual([{ instance_id: "foundry-provider", driver_kind: "azure-foundry" }]);
      expect(() =>
        connection
          .prepare(`
            INSERT INTO provider_instance_projection (
              instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
            ) VALUES (?, 1, 'grok', 1, '{}', 1)
          `)
          .run("grok-provider"),
      ).not.toThrow();
    } finally {
      connection.close();
    }
  });

  it("accepts Oh My Pi provider projections", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS, clock);
      expect(() =>
        connection
          .prepare(`
            INSERT INTO provider_instance_projection (
              instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
            ) VALUES (?, 1, 'oh-my-pi', 0, '{}', 1)
          `)
          .run("oh-my-pi-provider"),
      ).not.toThrow();
    } finally {
      connection.close();
    }
  });

  it("adds context projections to a version 5 store without rewriting existing journal or provider rows", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 5), clock);
      insertEvent(connection, validEventValues);
      connection
        .prepare(`
          INSERT INTO provider_instance_projection (
            instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
          ) VALUES (?, 1, 'codex', 1, '{}', 1)
        `)
        .run("existing-provider");
      const journalBefore = connection
        .prepare("SELECT * FROM event_journal")
        .all() as ReadonlyArray<Record<string, unknown>>;
      const providerBefore = connection.prepare("SELECT * FROM provider_instance_projection").all();

      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [
          6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
          29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
          51, 52, 53,
        ],
      });
      expect(connection.prepare("SELECT * FROM event_journal").all()).toEqual(
        journalBefore.map((row) => ({ ...row, host_id: "local", actor_json: null })),
      );
      expect(connection.prepare("SELECT * FROM provider_instance_projection").all()).toEqual(
        providerBefore,
      );
    } finally {
      connection.close();
    }
  });

  it("does not rewrite migration history on repeated startup", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS, clock);
      const before = connection.prepare("SELECT * FROM schema_migrations").all();

      expect(applyMigrations(connection, MIGRATIONS, () => "2099-01-01T00:00:00.000Z")).toEqual({
        currentVersion: 53,
        appliedVersions: [],
      });
      expect(connection.prepare("SELECT * FROM schema_migrations").all()).toEqual(before);
    } finally {
      connection.close();
    }
  });

  it("adds host identity to an existing version 14 journal without rewriting events", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 14), clock);
      insertEvent(connection, validEventValues);
      const eventBefore = connection
        .prepare("SELECT event_id, aggregate_id, payload_json FROM event_journal")
        .get() as Record<string, unknown>;

      expect(applyMigrations(connection, MIGRATIONS.slice(0, 15), clock)).toEqual({
        currentVersion: 15,
        appliedVersions: [15],
      });
      expect(
        connection
          .prepare("SELECT event_id, aggregate_id, payload_json, host_id FROM event_journal")
          .get(),
      ).toEqual({ ...eventBefore, host_id: "local" });
    } finally {
      connection.close();
    }
  });

  it("adds Code metadata projections to a version 7 store without rewriting journal or Project rows", () => {
    const connection = openTemporaryDatabase();

    try {
      applyMigrations(connection, MIGRATIONS.slice(0, 7), clock);
      insertEvent(connection, validEventValues);
      connection
        .prepare(`
          INSERT INTO project_projection (
            project_id, schema_version, project_type, lifecycle, pinned,
            project_json, aggregate_version
          ) VALUES (?, 1, 'code', 'active', 0, '{}', 1)
        `)
        .run("existing-project");
      const journalBefore = connection
        .prepare("SELECT * FROM event_journal")
        .all() as ReadonlyArray<Record<string, unknown>>;
      const projectBefore = connection.prepare("SELECT * FROM project_projection").all();

      expect(applyMigrations(connection, MIGRATIONS, clock)).toEqual({
        currentVersion: 53,
        appliedVersions: [
          8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
          31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
          53,
        ],
      });
      expect(connection.prepare("SELECT * FROM event_journal").all()).toEqual(
        journalBefore.map((row) => ({ ...row, host_id: "local", actor_json: null })),
      );
      expect(connection.prepare("SELECT * FROM project_projection").all()).toEqual(projectBefore);
      expect(
        connection
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'code_%_projection' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "code_checkout_projection" },
        { name: "code_file_projection" },
        { name: "code_review_projection" },
        { name: "code_runtime_projection" },
        { name: "code_settings_projection" },
        { name: "code_thread_activity_projection" },
        { name: "code_thread_follow_up_projection" },
        { name: "code_thread_projection" },
      ]);
    } finally {
      connection.close();
    }
  });

  it("applies pending migrations in version order", () => {
    const connection = openTemporaryDatabase();
    const migrations: ReadonlyArray<Migration> = [
      { version: 2, name: "second", sql: "CREATE TABLE second (id INTEGER) STRICT;" },
      { version: 1, name: "first", sql: "CREATE TABLE first (id INTEGER) STRICT;" },
    ];

    try {
      expect(applyMigrations(connection, migrations, clock)).toEqual({
        currentVersion: 2,
        appliedVersions: [1, 2],
      });
      expect(
        connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      connection.close();
    }
  });

  it("rejects a changed checksum for an applied migration", () => {
    const connection = openTemporaryDatabase();
    const original: Migration = {
      version: 1,
      name: "original",
      sql: "CREATE TABLE original (id INTEGER) STRICT;",
    };

    try {
      applyMigrations(connection, [original], clock);

      expect(() =>
        applyMigrations(
          connection,
          [{ ...original, sql: "CREATE TABLE changed (id INTEGER) STRICT;" }],
          clock,
        ),
      ).toThrow(MigrationChecksumMismatch);
    } finally {
      connection.close();
    }
  });

  it("rejects applied history missing from the registry before applying later migrations", () => {
    const connection = openTemporaryDatabase();
    const first: Migration = {
      version: 1,
      name: "first",
      sql: "CREATE TABLE first (id INTEGER) STRICT;",
    };
    const second: Migration = {
      version: 2,
      name: "second",
      sql: "CREATE TABLE second (id INTEGER) STRICT;",
    };
    const third: Migration = {
      version: 3,
      name: "third",
      sql: "CREATE TABLE third (id INTEGER) STRICT;",
    };

    try {
      applyMigrations(connection, [first, second], clock);

      let observedError: unknown;
      try {
        applyMigrations(connection, [first, third], clock);
      } catch (error) {
        observedError = error;
      }

      expect(observedError).toMatchObject({
        _tag: "MigrationHistoryMismatch",
        version: 2,
        name: "second",
      });
      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'third'")
          .get(),
      ).toBeUndefined();
      expect(
        connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      connection.close();
    }
  });

  it("rejects a changed applied migration name even when its checksum matches", () => {
    const connection = openTemporaryDatabase();
    const migration: Migration = {
      version: 1,
      name: "stable_name",
      sql: "CREATE TABLE named_migration (id INTEGER) STRICT;",
    };

    try {
      applyMigrations(connection, [migration], clock);

      let observedError: unknown;
      try {
        applyMigrations(connection, [{ ...migration, name: "replacement_name" }], clock);
      } catch (error) {
        observedError = error;
      }

      expect(observedError).toMatchObject({
        _tag: "MigrationHistoryMismatch",
        version: 1,
        name: "stable_name",
      });
    } finally {
      connection.close();
    }
  });

  it("rejects a database with a newer migration version", () => {
    const connection = openTemporaryDatabase();
    const migrations: ReadonlyArray<Migration> = [
      { version: 1, name: "first", sql: "CREATE TABLE first (id INTEGER) STRICT;" },
      { version: 2, name: "second", sql: "CREATE TABLE second (id INTEGER) STRICT;" },
    ];

    try {
      applyMigrations(connection, migrations, clock);

      expect(() => applyMigrations(connection, migrations.slice(0, 1), clock)).toThrow(
        DatabaseVersionTooNew,
      );
    } finally {
      connection.close();
    }
  });

  it("rolls back every statement when a migration fails", () => {
    const connection = openTemporaryDatabase();
    const broken: Migration = {
      version: 1,
      name: "broken",
      sql: `
        CREATE TABLE should_not_exist (id INTEGER) STRICT;
        INSERT INTO missing_table (id) VALUES (1);
      `,
    };

    try {
      expect(() => applyMigrations(connection, [broken], clock)).toThrow(MigrationFailed);
      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("should_not_exist"),
      ).toBeUndefined();
      expect(connection.prepare("SELECT version FROM schema_migrations").all()).toEqual([]);
    } finally {
      connection.close();
    }
  });
});
