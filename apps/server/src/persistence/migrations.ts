import { createHash } from "node:crypto";
import {
  DatabaseVersionTooNew,
  MigrationChecksumMismatch,
  MigrationFailed,
  MigrationHistoryMismatch,
} from "./migrationErrors";
import type { SqliteConnection } from "./sqlitePort";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrationStatus {
  readonly currentVersion: number;
  readonly appliedVersions: ReadonlyArray<number>;
}

const INITIAL_EVENT_STORE_SQL = `
CREATE TABLE event_journal (
  global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK(length(trim(event_id)) > 0),
  aggregate_type TEXT NOT NULL CHECK(length(trim(aggregate_type)) > 0),
  aggregate_id TEXT NOT NULL CHECK(length(trim(aggregate_id)) > 0),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  event_name TEXT NOT NULL CHECK(length(trim(event_name)) > 0),
  event_version INTEGER NOT NULL CHECK(event_version > 0),
  correlation_id TEXT NOT NULL CHECK(length(trim(correlation_id)) > 0),
  causation_id TEXT CHECK(causation_id IS NULL OR length(trim(causation_id)) > 0),
  actor_kind TEXT NOT NULL CHECK(length(trim(actor_kind)) > 0),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) > 0),
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  UNIQUE (aggregate_type, aggregate_id, aggregate_version)
) STRICT;

CREATE TABLE aggregate_heads (
  aggregate_type TEXT NOT NULL CHECK(length(trim(aggregate_type)) > 0),
  aggregate_id TEXT NOT NULL CHECK(length(trim(aggregate_id)) > 0),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL,
  PRIMARY KEY (aggregate_type, aggregate_id),
  FOREIGN KEY (last_sequence) REFERENCES event_journal(global_sequence)
) STRICT;

CREATE TABLE projection_checkpoints (
  projection_name TEXT PRIMARY KEY CHECK(length(trim(projection_name)) > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE event_quarantine (
  projection_name TEXT NOT NULL CHECK(length(trim(projection_name)) > 0),
  global_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL CHECK(length(trim(event_id)) > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (projection_name, global_sequence),
  FOREIGN KEY (global_sequence) REFERENCES event_journal(global_sequence)
) STRICT;
`;

const SHELL_PROJECTIONS_SQL = `
CREATE TABLE shell_settings_projection (
  projection_key TEXT PRIMARY KEY CHECK(projection_key = 'shell-settings'),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

CREATE TABLE window_workspace_projection (
  window_id TEXT PRIMARY KEY CHECK(length(trim(window_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  workspace_json TEXT NOT NULL CHECK(json_valid(workspace_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;
`;

const THEME_PROJECTIONS_SQL = `
CREATE TABLE theme_settings_projection (
  projection_key TEXT PRIMARY KEY CHECK(projection_key = 'theme-settings'),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;
`;

const PROJECT_PROJECTIONS_SQL = `
CREATE TABLE project_projection (
  project_id TEXT PRIMARY KEY CHECK(length(trim(project_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  project_type TEXT NOT NULL CHECK(project_type IN ('chat', 'work', 'code')),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'archived')),
  pinned INTEGER NOT NULL CHECK(pinned IN (0, 1)),
  project_json TEXT NOT NULL CHECK(json_valid(project_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

CREATE INDEX project_projection_mode_idx
  ON project_projection(project_type);
CREATE INDEX project_projection_lifecycle_idx
  ON project_projection(lifecycle);
CREATE INDEX project_projection_pin_idx
  ON project_projection(pinned);

CREATE TABLE project_memory_projection (
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  entry_id TEXT NOT NULL CHECK(length(trim(entry_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'retracted')),
  memory_kind TEXT NOT NULL CHECK(memory_kind IN ('decision', 'fact', 'preference', 'summary', 'outcome')),
  entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  PRIMARY KEY (project_id, entry_id)
) STRICT;
`;

const PROVIDER_PROJECTIONS_SQL = `
CREATE TABLE provider_instance_projection (
  instance_id TEXT PRIMARY KEY CHECK(length(trim(instance_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  driver_kind TEXT NOT NULL CHECK(driver_kind IN (
    'codex', 'claude', 'cursor', 'opencode', 'kilo', 'pi', 'devin',
    'mistral-vibe', 'ollama', 'openai-compatible'
  )),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  instance_json TEXT NOT NULL CHECK(json_valid(instance_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

CREATE INDEX provider_instance_projection_driver_idx
  ON provider_instance_projection(driver_kind);
CREATE INDEX provider_instance_projection_enabled_idx
  ON provider_instance_projection(enabled);

CREATE TABLE provider_defaults_projection (
  projection_key TEXT PRIMARY KEY CHECK(projection_key = 'provider-defaults'),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  defaults_json TEXT NOT NULL CHECK(json_valid(defaults_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;
`;

const ADD_KIMI_PROVIDER_PROJECTION_SQL = `
DROP INDEX provider_instance_projection_driver_idx;
DROP INDEX provider_instance_projection_enabled_idx;

ALTER TABLE provider_instance_projection RENAME TO provider_instance_projection_v4;

CREATE TABLE provider_instance_projection (
  instance_id TEXT PRIMARY KEY CHECK(length(trim(instance_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  driver_kind TEXT NOT NULL CHECK(driver_kind IN (
    'codex', 'claude', 'cursor', 'opencode', 'kilo', 'pi', 'devin',
    'mistral-vibe', 'ollama', 'openai-compatible', 'kimi-code'
  )),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  instance_json TEXT NOT NULL CHECK(json_valid(instance_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

INSERT INTO provider_instance_projection (
  instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
)
SELECT instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
FROM provider_instance_projection_v4;

DROP TABLE provider_instance_projection_v4;

CREATE INDEX provider_instance_projection_driver_idx
  ON provider_instance_projection(driver_kind);
CREATE INDEX provider_instance_projection_enabled_idx
  ON provider_instance_projection(enabled);
`;

const ADD_ANTHROPIC_PROVIDER_PROJECTION_SQL = `
DROP INDEX provider_instance_projection_driver_idx;
DROP INDEX provider_instance_projection_enabled_idx;

ALTER TABLE provider_instance_projection RENAME TO provider_instance_projection_v10;

CREATE TABLE provider_instance_projection (
  instance_id TEXT PRIMARY KEY CHECK(length(trim(instance_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  driver_kind TEXT NOT NULL CHECK(driver_kind IN (
    'codex', 'claude', 'cursor', 'opencode', 'kilo', 'pi', 'devin',
    'mistral-vibe', 'ollama', 'openai-compatible', 'kimi-code', 'anthropic-compatible'
  )),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  instance_json TEXT NOT NULL CHECK(json_valid(instance_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

INSERT INTO provider_instance_projection (
  instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
)
SELECT instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
FROM provider_instance_projection_v10;

DROP TABLE provider_instance_projection_v10;

CREATE INDEX provider_instance_projection_driver_idx
  ON provider_instance_projection(driver_kind);
CREATE INDEX provider_instance_projection_enabled_idx
  ON provider_instance_projection(enabled);
`;

const ADD_AZURE_FOUNDRY_PROVIDER_PROJECTION_SQL = `
DROP INDEX provider_instance_projection_driver_idx;
DROP INDEX provider_instance_projection_enabled_idx;

ALTER TABLE provider_instance_projection RENAME TO provider_instance_projection_v11;

CREATE TABLE provider_instance_projection (
  instance_id TEXT PRIMARY KEY CHECK(length(trim(instance_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  driver_kind TEXT NOT NULL CHECK(driver_kind IN (
    'codex', 'claude', 'cursor', 'opencode', 'kilo', 'pi', 'devin',
    'mistral-vibe', 'ollama', 'openai-compatible', 'kimi-code', 'anthropic-compatible',
    'azure-foundry'
  )),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  instance_json TEXT NOT NULL CHECK(json_valid(instance_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

INSERT INTO provider_instance_projection (
  instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
)
SELECT instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
FROM provider_instance_projection_v11;

DROP TABLE provider_instance_projection_v11;

CREATE INDEX provider_instance_projection_driver_idx
  ON provider_instance_projection(driver_kind);
CREATE INDEX provider_instance_projection_enabled_idx
  ON provider_instance_projection(enabled);
`;

const ADD_OH_MY_PI_PROVIDER_PROJECTION_SQL = `
DROP INDEX provider_instance_projection_driver_idx;
DROP INDEX provider_instance_projection_enabled_idx;

ALTER TABLE provider_instance_projection RENAME TO provider_instance_projection_v30;

CREATE TABLE provider_instance_projection (
  instance_id TEXT PRIMARY KEY CHECK(length(trim(instance_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  driver_kind TEXT NOT NULL CHECK(driver_kind IN (
    'codex', 'claude', 'cursor', 'opencode', 'kilo', 'pi', 'oh-my-pi', 'devin',
    'mistral-vibe', 'ollama', 'openai-compatible', 'kimi-code', 'anthropic-compatible',
    'azure-foundry'
  )),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  instance_json TEXT NOT NULL CHECK(json_valid(instance_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

INSERT INTO provider_instance_projection (
  instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
)
SELECT instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
FROM provider_instance_projection_v30;

DROP TABLE provider_instance_projection_v30;

CREATE INDEX provider_instance_projection_driver_idx
  ON provider_instance_projection(driver_kind);
CREATE INDEX provider_instance_projection_enabled_idx
  ON provider_instance_projection(enabled);
`;

const ADD_GROK_PROVIDER_PROJECTION_SQL = `
DROP INDEX provider_instance_projection_driver_idx;
DROP INDEX provider_instance_projection_enabled_idx;

ALTER TABLE provider_instance_projection RENAME TO provider_instance_projection_v44;

CREATE TABLE provider_instance_projection (
  instance_id TEXT PRIMARY KEY CHECK(length(trim(instance_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  driver_kind TEXT NOT NULL CHECK(driver_kind IN (
    'codex', 'claude', 'cursor', 'opencode', 'kilo', 'pi', 'oh-my-pi', 'devin',
    'mistral-vibe', 'ollama', 'openai-compatible', 'kimi-code', 'anthropic-compatible',
    'azure-foundry', 'grok'
  )),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  instance_json TEXT NOT NULL CHECK(json_valid(instance_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

INSERT INTO provider_instance_projection (
  instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
)
SELECT instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
FROM provider_instance_projection_v44;

DROP TABLE provider_instance_projection_v44;

CREATE INDEX provider_instance_projection_driver_idx
  ON provider_instance_projection(driver_kind);
CREATE INDEX provider_instance_projection_enabled_idx
  ON provider_instance_projection(enabled);
`;

const ZEN_PROJECTION_SQL = `
CREATE TABLE zen_space_projection (
  space_id TEXT PRIMARY KEY CHECK(length(trim(space_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  space_json TEXT NOT NULL CHECK(json_valid(space_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;
`;

const THREAD_CHECKPOINT_PROJECTION_SQL = `
CREATE TABLE thread_checkpoint_projection (
  checkpoint_id TEXT PRIMARY KEY CHECK(length(trim(checkpoint_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  mode TEXT NOT NULL CHECK(mode IN ('chat', 'code')),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('marked', 'forgotten')),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;
CREATE INDEX thread_checkpoint_thread_idx
  ON thread_checkpoint_projection (thread_id, last_sequence);
`;

const THREAD_RETENTION_PROJECTION_SQL = `
CREATE TABLE thread_retention_projection (
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('host', 'project', 'thread')),
  scope_key TEXT NOT NULL CHECK(length(trim(scope_key)) > 0),
  window_json TEXT NOT NULL CHECK(json_valid(window_json)),
  updated_at TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  PRIMARY KEY (scope_kind, scope_key)
) STRICT;

CREATE TABLE thread_purge_tombstone (
  mode TEXT NOT NULL CHECK(mode IN ('chat', 'work', 'code')),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  project_id TEXT CHECK(project_id IS NULL OR length(trim(project_id)) > 0),
  purged_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  PRIMARY KEY (mode, thread_id)
) STRICT;
`;

const PRODUCT_FEEDBACK_PROJECTION_SQL = `
CREATE TABLE product_feedback_projection (
  note_id TEXT PRIMARY KEY CHECK(length(trim(note_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('pending', 'delivered', 'discarded')),
  note_json TEXT NOT NULL CHECK(json_valid(note_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;
CREATE INDEX product_feedback_thread_idx
  ON product_feedback_projection (thread_id, lifecycle, last_sequence);
`;

const USAGE_PROJECTION_SQL = `
CREATE TABLE usage_record_projection (
  reconciliation_id TEXT PRIMARY KEY CHECK(length(trim(reconciliation_id)) > 0),
  subject_type TEXT NOT NULL CHECK(length(trim(subject_type)) > 0),
  subject_id TEXT NOT NULL CHECK(length(trim(subject_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK(length(trim(provider_instance_id)) > 0),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
  request_shape TEXT NOT NULL CHECK(length(trim(request_shape)) > 0),
  quality TEXT NOT NULL CHECK(quality IN ('exact', 'estimated', 'reconciled', 'stale', 'unavailable')),
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  planned_input_tokens INTEGER NOT NULL CHECK(planned_input_tokens >= 0),
  variance_tokens INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  attribution_json TEXT NOT NULL CHECK(json_valid(attribution_json)),
  observed_at TEXT NOT NULL CHECK(length(trim(observed_at)) > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;
CREATE INDEX idx_usage_record_provider ON usage_record_projection(provider_instance_id);
CREATE INDEX idx_usage_record_model ON usage_record_projection(model_id);
CREATE INDEX idx_usage_record_subject ON usage_record_projection(subject_type, subject_id);
CREATE INDEX idx_usage_record_observed ON usage_record_projection(observed_at);
CREATE INDEX idx_usage_record_quality ON usage_record_projection(quality);
`;

const PROVIDER_CATALOG_PROJECTION_SQL = `
CREATE TABLE provider_catalog_projection (
  instance_id TEXT PRIMARY KEY CHECK(length(trim(instance_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  catalog_json TEXT NOT NULL CHECK(json_valid(catalog_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;
`;

const ENVIRONMENT_PRESENTATION_PROJECTION_SQL = `
CREATE TABLE environment_presentation_projection (
  window_id TEXT PRIMARY KEY CHECK(length(trim(window_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  presentation_json TEXT NOT NULL CHECK(json_valid(presentation_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;
`;

const CONTEXT_PROJECTIONS_SQL = `
CREATE TABLE context_manifest_projection (
  manifest_id TEXT PRIMARY KEY CHECK(length(trim(manifest_id)) > 0),
  subject_type TEXT NOT NULL CHECK(length(trim(subject_type)) > 0),
  subject_id TEXT NOT NULL CHECK(length(trim(subject_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK(length(trim(provider_instance_id)) > 0),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  created_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX context_manifest_subject_created_idx
  ON context_manifest_projection(subject_type, subject_id, created_at);

CREATE TABLE context_override_projection (
  manifest_id TEXT PRIMARY KEY CHECK(length(trim(manifest_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  overrides_json TEXT NOT NULL CHECK(json_valid(overrides_json)),
  occurred_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE TABLE context_plan_projection (
  plan_id TEXT PRIMARY KEY CHECK(length(trim(plan_id)) > 0),
  manifest_id TEXT NOT NULL CHECK(length(trim(manifest_id)) > 0),
  health TEXT NOT NULL CHECK(health IN (
    'healthy', 'watch', 'optimizing', 'action-needed', 'blocked', 'rate-limited'
  )),
  blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  created_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX context_plan_manifest_created_idx
  ON context_plan_projection(manifest_id, created_at);

CREATE TABLE context_summary_projection (
  summary_id TEXT PRIMARY KEY CHECK(length(trim(summary_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK(length(trim(provider_instance_id)) > 0),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  created_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE TABLE context_usage_projection (
  reconciliation_id TEXT PRIMARY KEY CHECK(length(trim(reconciliation_id)) > 0),
  plan_id TEXT NOT NULL CHECK(length(trim(plan_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK(length(trim(provider_instance_id)) > 0),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
  request_shape TEXT NOT NULL CHECK(length(trim(request_shape)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  reconciliation_json TEXT NOT NULL CHECK(json_valid(reconciliation_json)),
  observed_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX context_usage_plan_observed_idx
  ON context_usage_projection(plan_id, observed_at);
CREATE INDEX context_usage_provider_observed_idx
  ON context_usage_projection(provider_instance_id, observed_at);

CREATE TABLE context_capacity_projection (
  reservation_id TEXT PRIMARY KEY CHECK(length(trim(reservation_id)) > 0),
  subject_type TEXT NOT NULL CHECK(length(trim(subject_type)) > 0),
  subject_id TEXT NOT NULL CHECK(length(trim(subject_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK(length(trim(provider_instance_id)) > 0),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
  state TEXT NOT NULL CHECK(state IN (
    'requested', 'reserved', 'running', 'reconciled', 'released', 'ambiguous'
  )),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  reservation_json TEXT NOT NULL CHECK(json_valid(reservation_json)),
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX context_capacity_provider_state_idx
  ON context_capacity_projection(provider_instance_id, state);
CREATE INDEX context_capacity_subject_idx
  ON context_capacity_projection(subject_type, subject_id);
`;

const CHAT_PROJECTIONS_SQL = `
CREATE TABLE chat_settings_projection (
  projection_key TEXT PRIMARY KEY CHECK(projection_key = 'chat-settings'),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

CREATE TABLE chat_thread_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  project_id TEXT CHECK(project_id IS NULL OR length(trim(project_id)) > 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'archived', 'deleting', 'deleted')),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  thread_json TEXT NOT NULL CHECK(json_valid(thread_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX chat_thread_lifecycle_updated_idx
  ON chat_thread_projection(lifecycle, updated_at DESC);
CREATE INDEX chat_thread_project_idx
  ON chat_thread_projection(project_id);

CREATE TABLE chat_turn_projection (
  turn_id TEXT PRIMARY KEY CHECK(length(trim(turn_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  turn_json TEXT NOT NULL CHECK(json_valid(turn_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  created_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  UNIQUE (thread_id, sequence),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX chat_turn_thread_sequence_idx
  ON chat_turn_projection(thread_id, sequence);

CREATE TABLE chat_attempt_projection (
  attempt_id TEXT PRIMARY KEY CHECK(length(trim(attempt_id)) > 0),
  turn_id TEXT NOT NULL CHECK(length(trim(turn_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  attempt_json TEXT NOT NULL CHECK(json_valid(attempt_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  FOREIGN KEY (turn_id) REFERENCES chat_turn_projection(turn_id),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX chat_attempt_thread_idx
  ON chat_attempt_projection(thread_id);

CREATE TABLE chat_content_store (
  content_id TEXT PRIMARY KEY CHECK(length(trim(content_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  content_role TEXT NOT NULL CHECK(content_role IN ('user', 'assistant', 'research', 'snippet')),
  body_text TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0)
) STRICT;

CREATE INDEX chat_content_thread_idx
  ON chat_content_store(thread_id);

CREATE TABLE chat_attachment_projection (
  attachment_id TEXT PRIMARY KEY CHECK(length(trim(attachment_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  turn_id TEXT CHECK(turn_id IS NULL OR length(trim(turn_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  attachment_json TEXT NOT NULL CHECK(json_valid(attachment_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX chat_attachment_thread_idx
  ON chat_attachment_projection(thread_id);

CREATE TABLE chat_citation_projection (
  citation_id TEXT PRIMARY KEY CHECK(length(trim(citation_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  turn_id TEXT NOT NULL CHECK(length(trim(turn_id)) > 0),
  attempt_id TEXT NOT NULL CHECK(length(trim(attempt_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  citation_json TEXT NOT NULL CHECK(json_valid(citation_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX chat_citation_thread_idx
  ON chat_citation_projection(thread_id);

CREATE TABLE chat_search_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  search_text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE TABLE thread_work_item_projection (
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  item_id TEXT NOT NULL CHECK(length(trim(item_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  work_item_json TEXT NOT NULL CHECK(json_valid(work_item_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  PRIMARY KEY (thread_id, item_id),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX thread_work_item_thread_idx
  ON thread_work_item_projection(thread_id);

CREATE TABLE thread_follow_up_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  follow_up_json TEXT NOT NULL CHECK(json_valid(follow_up_json)),
  state TEXT NOT NULL CHECK(state IN ('open', 'completed')),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX thread_follow_up_open_idx
  ON thread_follow_up_projection(state)
  WHERE state = 'open';

CREATE TABLE chat_purge_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  state TEXT NOT NULL CHECK(state IN ('pending', 'completed')),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX chat_purge_pending_idx
  ON chat_purge_projection(state)
  WHERE state = 'pending';
`;

const CODE_PROJECTIONS_SQL = `
CREATE TABLE code_settings_projection (
  projection_key TEXT PRIMARY KEY CHECK(projection_key = 'code-settings'),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE TABLE code_thread_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  checkout_id TEXT NOT NULL CHECK(length(trim(checkout_id)) > 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'archived', 'waiting', 'interrupted')),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  thread_json TEXT NOT NULL CHECK(json_valid(thread_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX code_thread_project_idx ON code_thread_projection(project_id);
CREATE INDEX code_thread_lifecycle_updated_idx
  ON code_thread_projection(lifecycle, updated_at DESC);

CREATE TABLE code_checkout_projection (
  checkout_id TEXT PRIMARY KEY CHECK(length(trim(checkout_id)) > 0),
  repository_id TEXT NOT NULL CHECK(
    length(repository_id) = 69 AND
    substr(repository_id, 1, 5) = 'repo_' AND
    substr(repository_id, 6) NOT GLOB '*[^a-f0-9]*'
  ),
  availability TEXT NOT NULL CHECK(availability IN ('available', 'unavailable', 'waiting')),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  checkout_json TEXT NOT NULL CHECK(json_valid(checkout_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  observed_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX code_checkout_repository_idx ON code_checkout_projection(repository_id);
CREATE INDEX code_checkout_availability_idx ON code_checkout_projection(availability);

CREATE TABLE code_file_projection (
  file_id TEXT PRIMARY KEY CHECK(length(trim(file_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  checkout_id TEXT NOT NULL CHECK(length(trim(checkout_id)) > 0),
  content_id TEXT CHECK(content_id IS NULL OR length(trim(content_id)) > 0),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^a-f0-9]*'),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  state TEXT NOT NULL CHECK(state IN (
    'available', 'read-only', 'saving', 'completed', 'conflict',
    'interrupted', 'failed', 'deleted', 'rescan-required'
  )),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  file_json TEXT NOT NULL CHECK(json_valid(file_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX code_file_thread_state_idx ON code_file_projection(thread_id, state);
CREATE INDEX code_file_checkout_idx ON code_file_projection(checkout_id);

CREATE TABLE code_runtime_projection (
  runtime_work_id TEXT PRIMARY KEY CHECK(length(trim(runtime_work_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  work_kind TEXT NOT NULL CHECK(work_kind IN (
    'provider-turn', 'file', 'terminal', 'test', 'git', 'delivery', 'review'
  )),
  state TEXT NOT NULL CHECK(state IN (
    'running', 'ambiguous', 'waiting', 'interrupted', 'completed', 'failed'
  )),
  evidence_content_id TEXT CHECK(
    evidence_content_id IS NULL OR length(trim(evidence_content_id)) > 0
  ),
  digest TEXT CHECK(
    digest IS NULL OR (length(digest) = 64 AND digest NOT GLOB '*[^a-f0-9]*')
  ),
  byte_length INTEGER CHECK(byte_length IS NULL OR byte_length >= 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  work_json TEXT NOT NULL CHECK(json_valid(work_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  CHECK((digest IS NULL) = (byte_length IS NULL))
) STRICT;

CREATE INDEX code_runtime_thread_state_idx ON code_runtime_projection(thread_id, state);
`;

const CODE_REVIEW_PROJECTION_SQL = `
CREATE TABLE code_review_projection (
  finding_id TEXT PRIMARY KEY CHECK(length(trim(finding_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  checkout_id TEXT NOT NULL CHECK(length(trim(checkout_id)) > 0),
  file_id TEXT NOT NULL CHECK(length(trim(file_id)) > 0),
  severity TEXT NOT NULL CHECK(severity IN ('note', 'warning', 'error')),
  state TEXT NOT NULL CHECK(state IN ('open', 'resolved', 'dismissed')),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  finding_json TEXT NOT NULL CHECK(json_valid(finding_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX code_review_thread_state_idx
  ON code_review_projection(thread_id, state, updated_at DESC);
CREATE INDEX code_review_file_idx
  ON code_review_projection(file_id);
`;

const CODE_FOLLOW_UP_PROJECTION_SQL = `
CREATE TABLE code_thread_follow_up_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  follow_up_json TEXT NOT NULL CHECK(json_valid(follow_up_json)),
  state TEXT NOT NULL CHECK(state IN ('open', 'completed')),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX code_thread_follow_up_open_idx
  ON code_thread_follow_up_projection(state)
  WHERE state = 'open';
`;

const CODE_THREAD_ACTIVITY_PROJECTION_SQL = `
CREATE TABLE code_thread_activity_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

-- An upgraded database has a Code checkpoint sitting at the journal head, so
-- catch-up would never replay the operation events this new table is derived
-- from, and every thread that already exists would report no activity at all.
-- Rewinding the checkpoint replays them. The projection's writes are idempotent
-- and its other tables are guarded by aggregate version, so the replay fills
-- this table without disturbing what they already hold.
DELETE FROM projection_checkpoints WHERE projection_name = 'code';
`;

const ADD_EVENT_JOURNAL_HOST_ID_SQL = `
ALTER TABLE event_journal
  ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'
  CHECK(length(trim(host_id)) > 0);
`;

const ADD_USAGE_RECORD_HOST_ID_SQL = `
ALTER TABLE usage_record_projection
  ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'
  CHECK(length(trim(host_id)) > 0);
CREATE INDEX idx_usage_record_host ON usage_record_projection(host_id);
CREATE INDEX idx_usage_record_request_shape ON usage_record_projection(request_shape);
`;

const USAGE_AUDIT_LOG_SQL = `
CREATE TABLE usage_audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK(action IN ('reset', 'purge', 'export')),
  purged_count INTEGER NOT NULL CHECK(purged_count >= 0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  occurred_at TEXT NOT NULL
) STRICT;
`;

const ADD_USAGE_ADVANCED_DIMENSIONS_SQL = `
ALTER TABLE usage_record_projection
  ADD COLUMN reasoning_tokens INTEGER
    CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0);
ALTER TABLE usage_record_projection
  ADD COLUMN cache_read_input_tokens INTEGER
    CHECK(cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0);
ALTER TABLE usage_record_projection
  ADD COLUMN cache_write_input_tokens INTEGER
    CHECK(cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0);
ALTER TABLE usage_record_projection
  ADD COLUMN provider_execution_duration_ms INTEGER
    CHECK(provider_execution_duration_ms IS NULL OR provider_execution_duration_ms >= 0);
UPDATE usage_record_projection SET schema_version = 2;
CREATE INDEX idx_usage_record_execution_duration
  ON usage_record_projection(provider_execution_duration_ms);
`;

const ADD_VALIDATION_PLAN_SEQUENCE_SQL = `
ALTER TABLE validation_evidence_projection
  ADD COLUMN plan_sequence INTEGER NOT NULL DEFAULT 0
  CHECK(plan_sequence >= 0);

DELETE FROM validation_evidence_projection;
DELETE FROM projection_checkpoints WHERE projection_name = 'validation-evidence';
`;

const VALIDATION_EVIDENCE_PROJECTION_SQL = `
CREATE TABLE validation_evidence_projection (
  plan_id TEXT PRIMARY KEY CHECK(length(trim(plan_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  mode TEXT NOT NULL CHECK(mode IN ('chat', 'work', 'code')),
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  root_id TEXT CHECK(root_id IS NULL OR length(trim(root_id)) > 0),
  worktree_id TEXT CHECK(worktree_id IS NULL OR length(trim(worktree_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK(length(trim(provider_instance_id)) > 0),
  extension_kind TEXT NOT NULL CHECK(extension_kind IN ('core', 'trusted-extension')),
  extension_id TEXT CHECK(extension_id IS NULL OR length(trim(extension_id)) > 0),
  plan_json TEXT CHECK(plan_json IS NULL OR json_valid(plan_json)),
  timeline_json TEXT NOT NULL CHECK(json_valid(timeline_json)),
  steps_json TEXT NOT NULL CHECK(json_valid(steps_json)),
  overall_outcome TEXT NOT NULL CHECK(overall_outcome IN (
    'passed', 'failed', 'inconclusive', 'unavailable', 'interrupted', 'skipped'
  )),
  report_json TEXT CHECK(report_json IS NULL OR json_valid(report_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX validation_evidence_authority_idx
  ON validation_evidence_projection(
    host_id, mode, project_id, root_id, worktree_id, provider_instance_id,
    extension_kind, extension_id
  );
`;

const AGENT_PROFILE_PROJECTION_SQL = `
CREATE TABLE agent_profile_projection (
  profile_id TEXT PRIMARY KEY CHECK(length(trim(profile_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('user', 'mode', 'project', 'one-off')),
  scope_ref TEXT NOT NULL CHECK(length(trim(scope_ref)) > 0),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0)
) STRICT;

CREATE INDEX agent_profile_projection_scope_idx
  ON agent_profile_projection(scope_kind, scope_ref);
`;

const ROOTLESS_PROJECTIONS_SQL = `
CREATE TABLE rootless_thread_projection (
  thread_id TEXT PRIMARY KEY CHECK(length(trim(thread_id)) > 0),
  mode TEXT NOT NULL CHECK(mode IN ('work', 'code')),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  workspace_kind TEXT NOT NULL CHECK(workspace_kind IN ('rootless', 'project-backed')),
  project_id TEXT CHECK(project_id IS NULL OR length(trim(project_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  thread_json TEXT NOT NULL CHECK(json_valid(thread_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX rootless_thread_mode_idx ON rootless_thread_projection(mode);
CREATE INDEX rootless_thread_workspace_idx ON rootless_thread_projection(workspace_kind);
CREATE INDEX rootless_thread_project_idx ON rootless_thread_projection(project_id);

CREATE TABLE binding_receipt_store (
  receipt_id TEXT PRIMARY KEY CHECK(length(trim(receipt_id)) > 0),
  window_id TEXT NOT NULL CHECK(length(trim(window_id)) > 0),
  project_type TEXT NOT NULL CHECK(project_type IN ('work', 'code')),
  canonical_root TEXT NOT NULL CHECK(length(trim(canonical_root)) > 0),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  consumed INTEGER NOT NULL CHECK(consumed IN (0, 1))
) STRICT;

CREATE INDEX binding_receipt_store_expires_idx
  ON binding_receipt_store(expires_at)
  WHERE consumed = 0;
`;

const ROOTLESS_TURN_REQUEST_PROJECTION_SQL = `
CREATE TABLE rootless_turn_request_projection (
  request_id TEXT PRIMARY KEY CHECK(length(trim(request_id)) > 0),
  thread_id TEXT NOT NULL UNIQUE CHECK(length(trim(thread_id)) > 0),
  accepted_event_id TEXT NOT NULL UNIQUE CHECK(length(trim(accepted_event_id)) > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

INSERT INTO rootless_turn_request_projection (
  request_id, thread_id, accepted_event_id, last_sequence
)
SELECT
  json_extract(thread_json, '$.initialTurn.requestId'),
  thread_id,
  json_extract(thread_json, '$.initialTurnAcceptedEventId'),
  last_sequence
FROM rootless_thread_projection
WHERE json_type(thread_json, '$.initialTurn.requestId') = 'text'
  AND json_type(thread_json, '$.initialTurnAcceptedEventId') = 'text';
`;

/*
 * Rootless threads were retired by decision 0037. The tables the two
 * migrations above created are dropped rather than left behind: no projector
 * writes them and no read path queries them, so a stale copy could only ever
 * be mistaken for live state. The journal keeps the events themselves.
 */
const DROP_ROOTLESS_PROJECTIONS_SQL = `
DROP TABLE IF EXISTS rootless_turn_request_projection;
DROP TABLE IF EXISTS rootless_thread_projection;
DELETE FROM projection_checkpoints WHERE projection_name = 'rootless';
`;

const EXTENSION_PROJECTION_SQL = `
CREATE TABLE extension_package_projection (
  extension_id TEXT PRIMARY KEY CHECK(length(trim(extension_id)) > 0),
  package_id TEXT NOT NULL CHECK(length(trim(package_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN (
    'prepared', 'installed', 'disabled', 'draining', 'waiting',
    'interrupted', 'quarantined', 'broken', 'unavailable', 'uninstalled'
  )),
  installed INTEGER NOT NULL CHECK(installed IN (0, 1)),
  trusted INTEGER NOT NULL CHECK(trusted IN (0, 1)),
  plugin_desired INTEGER NOT NULL CHECK(plugin_desired IN (0, 1)),
  quarantined INTEGER NOT NULL CHECK(quarantined IN (0, 1)),
  broken INTEGER NOT NULL CHECK(broken IN (0, 1)),
  waiting INTEGER NOT NULL CHECK(waiting IN (0, 1)),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0)
) STRICT;

CREATE INDEX extension_package_projection_package_idx
  ON extension_package_projection(package_id);
CREATE INDEX extension_package_projection_lifecycle_idx
  ON extension_package_projection(lifecycle_state);
CREATE INDEX extension_package_projection_effective_dimensions_idx
  ON extension_package_projection(
    installed, trusted, plugin_desired, quarantined, broken, waiting
  );
`;

const REMOTE_ACCESS_PROJECTIONS_SQL = `
CREATE TABLE host_identity_projection (
  identity_key TEXT PRIMARY KEY CHECK(identity_key = 'host'),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
  key_fingerprint TEXT NOT NULL CHECK(length(key_fingerprint) = 64),
  key_generation INTEGER NOT NULL CHECK(key_generation > 0),
  created_at TEXT NOT NULL,
  rotated_at TEXT
) STRICT;

CREATE TABLE remote_device_projection (
  device_id TEXT PRIMARY KEY CHECK(length(trim(device_id)) > 0),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  device_key_fingerprint TEXT NOT NULL CHECK(length(device_key_fingerprint) = 64),
  device_public_key TEXT NOT NULL CHECK(length(trim(device_public_key)) > 0),
  device_label TEXT NOT NULL CHECK(length(trim(device_label)) > 0),
  origin TEXT NOT NULL CHECK(length(trim(origin)) > 0),
  protocol_floor INTEGER NOT NULL CHECK(protocol_floor > 0),
  credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'revoked', 'expired')),
  revoked_at TEXT,
  revoked_reason TEXT
) STRICT;

CREATE INDEX remote_device_host_idx ON remote_device_projection(host_id);
CREATE INDEX remote_device_state_idx ON remote_device_projection(state);

CREATE TABLE remote_security_audit_projection (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind TEXT NOT NULL CHECK(length(trim(event_kind)) > 0),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  device_id TEXT,
  protocol_version INTEGER NOT NULL CHECK(protocol_version > 0),
  credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
  source_class TEXT NOT NULL CHECK(source_class IN ('loopback', 'lan-private', 'tailscale', 'unknown')),
  result_category TEXT NOT NULL CHECK(length(trim(result_category)) > 0),
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) > 0),
  correlation_id TEXT NOT NULL CHECK(length(trim(correlation_id)) > 0),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX remote_security_audit_host_idx ON remote_security_audit_projection(host_id, occurred_at);

CREATE TABLE remote_command_receipt_projection (
  command_id TEXT PRIMARY KEY CHECK(length(trim(command_id)) > 0),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  device_id TEXT,
  result_category TEXT NOT NULL CHECK(length(trim(result_category)) > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
`;

const REMOTE_CREDENTIAL_LIFECYCLE_SQL = `
CREATE TABLE remote_session_invalidation_projection (
  session_id_digest TEXT PRIMARY KEY CHECK(length(session_id_digest) = 64),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  device_id TEXT NOT NULL CHECK(length(trim(device_id)) > 0),
  credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
  state TEXT NOT NULL CHECK(state = 'invalidated'),
  invalidated_at TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) > 0),
  receipt_id TEXT NOT NULL CHECK(length(trim(receipt_id)) > 0)
) STRICT;

CREATE INDEX remote_session_invalidation_device_idx
  ON remote_session_invalidation_projection(host_id, device_id, credential_generation);
`;

const REMOTE_CREDENTIAL_RECEIPT_BINDING_SQL = `
ALTER TABLE remote_command_receipt_projection
  ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'legacy'
    CHECK(length(trim(operation_kind)) > 0 AND length(operation_kind) <= 128);
ALTER TABLE remote_command_receipt_projection
  ADD COLUMN operation_digest TEXT NOT NULL DEFAULT '${"0".repeat(64)}'
    CHECK(length(operation_digest) = 64);
`;

const REMOTE_REQUEST_PROOF_SQL = `
CREATE TABLE remote_auth_challenge_store (
  challenge_id_digest TEXT PRIMARY KEY CHECK(length(challenge_id_digest) = 64),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  device_id TEXT NOT NULL CHECK(length(trim(device_id)) > 0),
  credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
  nonce_digest TEXT NOT NULL CHECK(length(nonce_digest) = 64),
  issued_at INTEGER NOT NULL CHECK(issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
  consumed INTEGER NOT NULL CHECK(consumed IN (0, 1))
) STRICT;

CREATE INDEX remote_auth_challenge_expiry_idx
  ON remote_auth_challenge_store(expires_at)
  WHERE consumed = 0;

CREATE TABLE remote_session_store (
  session_id_digest TEXT PRIMARY KEY CHECK(length(session_id_digest) = 64),
  host_id TEXT NOT NULL CHECK(length(trim(host_id)) > 0),
  device_id TEXT NOT NULL CHECK(length(trim(device_id)) > 0),
  credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
  origin TEXT NOT NULL CHECK(length(trim(origin)) > 0),
  protocol_version INTEGER NOT NULL CHECK(protocol_version > 0),
  capability_digest TEXT NOT NULL CHECK(length(capability_digest) = 64),
  issued_at INTEGER NOT NULL CHECK(issued_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK(last_seen_at >= issued_at),
  idle_expires_at INTEGER NOT NULL CHECK(idle_expires_at > issued_at),
  absolute_expires_at INTEGER NOT NULL CHECK(absolute_expires_at > issued_at),
  csrf_digest TEXT NOT NULL CHECK(length(csrf_digest) = 64),
  state TEXT NOT NULL CHECK(state IN ('active', 'expired', 'revoked'))
) STRICT;

CREATE INDEX remote_session_device_idx
  ON remote_session_store(host_id, device_id, credential_generation);
CREATE INDEX remote_session_expiry_idx
  ON remote_session_store(idle_expires_at, absolute_expires_at)
  WHERE state = 'active';

CREATE TABLE remote_request_nonce_store (
  session_id_digest TEXT NOT NULL,
  nonce_digest TEXT NOT NULL CHECK(length(nonce_digest) = 64),
  expires_at INTEGER NOT NULL CHECK(expires_at > 0),
  PRIMARY KEY(session_id_digest, nonce_digest),
  FOREIGN KEY(session_id_digest) REFERENCES remote_session_store(session_id_digest)
) STRICT;

CREATE INDEX remote_request_nonce_expiry_idx
  ON remote_request_nonce_store(expires_at);
`;

const REMOTE_CLOCK_GUARD_SQL = `
CREATE TABLE remote_clock_guard (
  host_id TEXT PRIMARY KEY CHECK(length(trim(host_id)) > 0),
  high_water_mark_ms INTEGER NOT NULL CHECK(high_water_mark_ms >= 0),
  observed_at TEXT NOT NULL,
  posture TEXT NOT NULL CHECK(posture IN ('ok', 'recovery-required'))
) STRICT;
`;

const LOCAL_AUTHORITY_CLOCK_GUARD_SQL = `
CREATE TABLE local_authority_clock_guard (
  guard_id TEXT PRIMARY KEY CHECK(guard_id = 'local-authority'),
  high_water_mark_ms INTEGER NOT NULL CHECK(high_water_mark_ms >= 0),
  observed_at TEXT NOT NULL,
  posture TEXT NOT NULL CHECK(posture IN ('ok', 'recovery-required'))
) STRICT;
`;

const CODE_EVIDENCE_CONTENT_STORE_SQL = `
CREATE TABLE code_evidence_content_store (
  content_id TEXT PRIMARY KEY CHECK(length(trim(content_id)) > 0),
  body_text TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0 AND byte_length <= 8388608),
  created_at TEXT NOT NULL
) STRICT;
`;

const CONTEXT_SUMMARY_CONTENT_STORE_SQL = `
CREATE TABLE context_summary_content_store (
  summary_id TEXT PRIMARY KEY CHECK(length(trim(summary_id)) > 0),
  subject_type TEXT NOT NULL CHECK(length(trim(subject_type)) > 0),
  subject_id TEXT NOT NULL CHECK(length(trim(subject_id)) > 0),
  body_text TEXT NOT NULL CHECK(length(body_text) > 0 AND length(body_text) <= 20000),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX context_summary_content_subject_idx
  ON context_summary_content_store(subject_type, subject_id);

ALTER TABLE context_summary_projection DROP COLUMN summary_content;
`;

const AGENT_RUN_CONTENT_STORE_SQL = `
CREATE TABLE agent_run_content_store (
  content_id TEXT PRIMARY KEY CHECK(length(trim(content_id)) > 0),
  run_id TEXT NOT NULL CHECK(length(trim(run_id)) > 0),
  subject_type TEXT NOT NULL CHECK(length(trim(subject_type)) > 0),
  subject_id TEXT NOT NULL CHECK(length(trim(subject_id)) > 0),
  content_kind TEXT NOT NULL CHECK(content_kind IN ('admitted-context', 'result')),
  body_text TEXT NOT NULL CHECK(length(body_text) > 0 AND length(body_text) <= 131072),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX agent_run_content_subject_idx
  ON agent_run_content_store(subject_type, subject_id);
`;

const CHAT_TURN_ROUTE_PROJECTIONS_SQL = `
CREATE TABLE chat_turn_route_projection (
  turn_id TEXT PRIMARY KEY CHECK(length(trim(turn_id)) > 0),
  thread_id TEXT NOT NULL CHECK(length(trim(thread_id)) > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  decided_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  FOREIGN KEY (thread_id) REFERENCES chat_thread_projection(thread_id)
) STRICT;

CREATE INDEX chat_turn_route_thread_idx
  ON chat_turn_route_projection(thread_id);
`;

/**
 * Bounded receipt state for one authenticated diagnostics export.
 * Only identifiers, the closed redaction-tag set, and a content digest are
 * ever written here — no summary, recovery text, correlation, or version
 * fact column exists, so raw secrets or private content can never land in
 * this table even by accident.
 */
const DIAGNOSTICS_EXPORT_RECEIPT_PROJECTION_SQL = `
CREATE TABLE diagnostics_export_receipt_projection (
  packet_id TEXT PRIMARY KEY CHECK(length(trim(packet_id)) > 0),
  domain TEXT NOT NULL CHECK(length(trim(domain)) > 0),
  failure_code TEXT NOT NULL CHECK(length(trim(failure_code)) > 0),
  redactions_json TEXT NOT NULL CHECK(json_valid(redactions_json)),
  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX diagnostics_export_receipt_created_idx
  ON diagnostics_export_receipt_projection(created_at);
`;

/**
 * Indexes bounded, journal-recorded failure anchors. Export must resolve this
 * projection before constructing a packet, so a caller-supplied UUID can never
 * invent a failure, timestamp, or domain.
 */
const DIAGNOSTICS_FAILURE_INCIDENT_PROJECTION_SQL = `
CREATE TABLE diagnostics_failure_incident_projection (
  correlation_id TEXT PRIMARY KEY CHECK(length(trim(correlation_id)) > 0),
  domain TEXT NOT NULL CHECK(length(trim(domain)) > 0),
  outcome TEXT NOT NULL CHECK(outcome = 'failed'),
  observed_at TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  FOREIGN KEY (last_sequence) REFERENCES event_journal(global_sequence)
) STRICT;
`;

const ADD_DIAGNOSTICS_FAILURE_INCIDENT_CODE_SQL = `
ALTER TABLE diagnostics_failure_incident_projection
  ADD COLUMN failure_code TEXT NOT NULL DEFAULT 'legacy-unknown'
  CHECK(length(trim(failure_code)) > 0);
`;

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "create_event_store",
    sql: INITIAL_EVENT_STORE_SQL,
  },
  {
    version: 2,
    name: "create_shell_projections",
    sql: SHELL_PROJECTIONS_SQL,
  },
  {
    version: 3,
    name: "create_project_projections",
    sql: PROJECT_PROJECTIONS_SQL,
  },
  {
    version: 4,
    name: "create_provider_projections",
    sql: PROVIDER_PROJECTIONS_SQL,
  },
  {
    version: 5,
    name: "add_kimi_provider_projection",
    sql: ADD_KIMI_PROVIDER_PROJECTION_SQL,
  },
  {
    version: 6,
    name: "create_context_projections",
    sql: CONTEXT_PROJECTIONS_SQL,
  },
  {
    version: 7,
    name: "create_chat_projections",
    sql: CHAT_PROJECTIONS_SQL,
  },
  {
    version: 8,
    name: "create_code_projections",
    sql: CODE_PROJECTIONS_SQL,
  },
  {
    version: 9,
    name: "create_code_review_projection",
    sql: CODE_REVIEW_PROJECTION_SQL,
  },
  {
    version: 10,
    name: "create_provider_catalog_projection",
    sql: PROVIDER_CATALOG_PROJECTION_SQL,
  },
  {
    version: 11,
    name: "add_anthropic_provider_projection",
    sql: ADD_ANTHROPIC_PROVIDER_PROJECTION_SQL,
  },
  {
    version: 12,
    name: "create_environment_presentation_projection",
    sql: ENVIRONMENT_PRESENTATION_PROJECTION_SQL,
  },
  {
    version: 13,
    name: "add_azure_foundry_provider_projection",
    sql: ADD_AZURE_FOUNDRY_PROVIDER_PROJECTION_SQL,
  },
  {
    version: 14,
    name: "create_zen_projection",
    sql: ZEN_PROJECTION_SQL,
  },
  {
    version: 15,
    name: "add_event_journal_host_id",
    sql: ADD_EVENT_JOURNAL_HOST_ID_SQL,
  },
  {
    version: 16,
    name: "create_usage_record_projection",
    sql: USAGE_PROJECTION_SQL,
  },
  {
    version: 17,
    name: "create_rootless_projections",
    sql: ROOTLESS_PROJECTIONS_SQL,
  },
  {
    version: 18,
    name: "create_agent_profile_projection",
    sql: AGENT_PROFILE_PROJECTION_SQL,
  },
  {
    version: 19,
    name: "create_validation_evidence_projection",
    sql: VALIDATION_EVIDENCE_PROJECTION_SQL,
  },
  {
    version: 20,
    name: "add_usage_record_host_id_and_audit_log",
    sql: `${ADD_USAGE_RECORD_HOST_ID_SQL}\n${USAGE_AUDIT_LOG_SQL}`,
  },
  {
    version: 21,
    name: "add_validation_plan_sequence",
    sql: ADD_VALIDATION_PLAN_SEQUENCE_SQL,
  },
  {
    version: 22,
    name: "create_theme_projection",
    sql: THEME_PROJECTIONS_SQL,
  },
  {
    version: 23,
    name: "add_usage_advanced_dimensions",
    sql: ADD_USAGE_ADVANCED_DIMENSIONS_SQL,
  },
  {
    version: 24,
    name: "create_extension_package_projection",
    sql: EXTENSION_PROJECTION_SQL,
  },
  {
    version: 25,
    name: "create_remote_access_foundation_projections",
    sql: REMOTE_ACCESS_PROJECTIONS_SQL,
  },
  {
    version: 26,
    name: "create_rootless_turn_request_projection",
    sql: ROOTLESS_TURN_REQUEST_PROJECTION_SQL,
  },
  {
    version: 27,
    name: "create_remote_request_proof_store",
    sql: REMOTE_REQUEST_PROOF_SQL,
  },
  {
    version: 28,
    name: "bind_remote_command_receipts_to_inputs",
    sql: `${REMOTE_CREDENTIAL_LIFECYCLE_SQL}\n${REMOTE_CREDENTIAL_RECEIPT_BINDING_SQL}`,
  },
  {
    version: 29,
    name: "create_remote_clock_guard",
    sql: REMOTE_CLOCK_GUARD_SQL,
  },
  {
    version: 30,
    name: "create_code_thread_follow_up_projection",
    sql: CODE_FOLLOW_UP_PROJECTION_SQL,
  },
  {
    version: 31,
    name: "add_oh_my_pi_provider_projection",
    sql: ADD_OH_MY_PI_PROVIDER_PROJECTION_SQL,
  },
  {
    version: 32,
    name: "create_code_evidence_content_store",
    sql: CODE_EVIDENCE_CONTENT_STORE_SQL,
  },
  {
    version: 33,
    name: "index_code_evidence_content_digest",
    sql: "CREATE INDEX code_evidence_content_digest_idx ON code_evidence_content_store(digest);",
  },
  {
    version: 34,
    name: "create_chat_turn_route_projection",
    sql: CHAT_TURN_ROUTE_PROJECTIONS_SQL,
  },
  {
    version: 35,
    name: "create_diagnostics_export_receipt_projection",
    sql: DIAGNOSTICS_EXPORT_RECEIPT_PROJECTION_SQL,
  },
  {
    version: 36,
    name: "create_diagnostics_failure_incident_projection",
    sql: DIAGNOSTICS_FAILURE_INCIDENT_PROJECTION_SQL,
  },
  {
    version: 37,
    name: "add_diagnostics_failure_incident_code",
    sql: ADD_DIAGNOSTICS_FAILURE_INCIDENT_CODE_SQL,
  },
  {
    version: 38,
    name: "create_local_authority_clock_guard",
    sql: LOCAL_AUTHORITY_CLOCK_GUARD_SQL,
  },
  {
    version: 39,
    name: "record_local_authority_clock_recovery_reason",
    sql: `
ALTER TABLE local_authority_clock_guard
  ADD COLUMN recovery_reason TEXT
    CHECK(recovery_reason IS NULL OR recovery_reason IN ('clock-rollback', 'malformed-clock', 'forward-jump'));
`,
  },
  {
    version: 40,
    name: "record_local_authority_clock_elapsed_checkpoint",
    sql: `
ALTER TABLE local_authority_clock_guard
  ADD COLUMN elapsed_checkpoint_ms REAL
    CHECK(elapsed_checkpoint_ms IS NULL OR elapsed_checkpoint_ms >= 0);
`,
  },
  {
    version: 41,
    name: "add_event_journal_actor_json",
    sql: `
ALTER TABLE event_journal
  ADD COLUMN actor_json TEXT
    CHECK(actor_json IS NULL OR json_valid(actor_json));
`,
  },
  {
    version: 42,
    name: "store_context_summary_content",
    sql: `
ALTER TABLE context_summary_projection
  ADD COLUMN summary_content TEXT NOT NULL DEFAULT ''
    CHECK(length(summary_content) <= 20000);
`,
  },
  {
    version: 43,
    name: "move_context_summary_content_to_subject_store",
    sql: CONTEXT_SUMMARY_CONTENT_STORE_SQL,
  },
  {
    version: 44,
    name: "move_agent_run_text_to_subject_store",
    sql: AGENT_RUN_CONTENT_STORE_SQL,
  },
  {
    version: 45,
    name: "record_code_runtime_first_sequence",
    sql: `
ALTER TABLE code_runtime_projection
  ADD COLUMN first_sequence INTEGER
    CHECK(first_sequence IS NULL OR first_sequence > 0);
`,
  },
  {
    version: 46,
    name: "create_code_thread_activity_projection",
    sql: CODE_THREAD_ACTIVITY_PROJECTION_SQL,
  },
  {
    version: 47,
    name: "add_grok_provider_projection",
    sql: ADD_GROK_PROVIDER_PROJECTION_SQL,
  },
  {
    version: 48,
    name: "create_thread_checkpoint_projection",
    sql: THREAD_CHECKPOINT_PROJECTION_SQL,
  },
  {
    version: 49,
    name: "create_product_feedback_projection",
    sql: PRODUCT_FEEDBACK_PROJECTION_SQL,
  },
  {
    version: 50,
    name: "drop_rootless_projections",
    sql: DROP_ROOTLESS_PROJECTIONS_SQL,
  },
  {
    version: 51,
    name: "create_thread_retention_projection",
    sql: THREAD_RETENTION_PROJECTION_SQL,
  },
];

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function ensureMigrationHistoryTable(connection: SqliteConnection): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

/**
 * Validates that the recorded migration history is compatible with the known
 * migration set without applying anything. Fails closed for a downgraded store,
 * an unrecognized applied migration, or a changed checksum. Only creates the
 * (idempotent) history table, so a refused store is left otherwise untouched.
 */
export function assertMigrationsApplicable(
  connection: SqliteConnection,
  migrations: ReadonlyArray<Migration>,
): void {
  ensureMigrationHistoryTable(connection);
  const orderedMigrations = [...migrations].sort((left, right) => left.version - right.version);
  const appliedRows = connection
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as ReadonlyArray<AppliedMigrationRow>;
  const latestKnownVersion = orderedMigrations.at(-1)?.version ?? 0;
  const databaseVersion = appliedRows.at(-1)?.version ?? 0;

  if (databaseVersion > latestKnownVersion) {
    throw new DatabaseVersionTooNew({ databaseVersion, latestKnownVersion });
  }

  const migrationsByVersion = new Map(
    orderedMigrations.map((migration) => [migration.version, migration]),
  );
  for (const applied of appliedRows) {
    const migration = migrationsByVersion.get(applied.version);
    if (migration === undefined || migration.name !== applied.name) {
      throw new MigrationHistoryMismatch({
        version: applied.version,
        name: applied.name,
      });
    }
    if (applied.checksum !== checksum(migration.sql)) {
      throw new MigrationChecksumMismatch({
        version: migration.version,
        name: migration.name,
      });
    }
  }
}

export function applyMigrations(
  connection: SqliteConnection,
  migrations: ReadonlyArray<Migration>,
  clock: () => string,
): MigrationStatus {
  assertMigrationsApplicable(connection, migrations);

  const orderedMigrations = [...migrations].sort((left, right) => left.version - right.version);
  const appliedRows = connection
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as ReadonlyArray<AppliedMigrationRow>;
  const databaseVersion = appliedRows.at(-1)?.version ?? 0;
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const appliedVersions: Array<number> = [];
  const insertHistory = connection.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const migration of orderedMigrations) {
    if (appliedByVersion.has(migration.version)) {
      continue;
    }

    try {
      connection.transaction(() => {
        connection.exec(migration.sql);
        insertHistory.run(migration.version, migration.name, checksum(migration.sql), clock());
      })();
    } catch {
      throw new MigrationFailed({ version: migration.version, name: migration.name });
    }

    appliedVersions.push(migration.version);
  }

  return {
    currentVersion: orderedMigrations.at(-1)?.version ?? databaseVersion,
    appliedVersions,
  };
}
