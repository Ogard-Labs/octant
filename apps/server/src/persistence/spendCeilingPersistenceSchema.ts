export const SPEND_CEILING_PROJECTION_SCHEMA_VERSION = 1;

export const SPEND_CEILING_PROJECTION_SQL = `
CREATE TABLE spend_ceiling_projection (
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project', 'thread')),
  scope_key TEXT NOT NULL CHECK(length(trim(scope_key)) > 0),
  thread_type TEXT CHECK(thread_type IS NULL OR thread_type IN ('chat-thread', 'work-thread', 'code-thread')),
  window_json TEXT NOT NULL CHECK(json_valid(window_json)),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  overrun_json TEXT CHECK(overrun_json IS NULL OR json_valid(overrun_json)),
  set_at TEXT NOT NULL,
  set_by_json TEXT NOT NULL CHECK(json_valid(set_by_json)),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  PRIMARY KEY (scope_kind, scope_key)
) STRICT;
CREATE INDEX spend_ceiling_scope_idx
  ON spend_ceiling_projection (scope_kind, scope_key);
`;

export interface SpendCeilingProjectionRow {
  readonly scope_kind: "project" | "thread";
  readonly scope_key: string;
  readonly thread_type: "chat-thread" | "work-thread" | "code-thread" | null;
  readonly window_json: string;
  readonly policy_json: string;
  readonly overrun_json: string | null;
  readonly set_at: string;
  readonly set_by_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export function spendCeilingScopeKey(input: {
  readonly kind: "project" | "thread";
  readonly id: string;
}): string {
  return input.id;
}
