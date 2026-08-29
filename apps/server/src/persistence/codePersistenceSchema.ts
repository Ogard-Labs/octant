import type {
  CodeCheckoutIdentity,
  CodeFileLifecycle,
  CodeRuntimeWorkKind,
  CodeRuntimeWorkState,
  CodeSettings,
  CodeThreadLifecycle,
  CodeReviewFinding,
} from "@octant/contracts";

export const CODE_PROJECTION_SCHEMA_VERSION = 1;
export const CODE_SETTINGS_KEY = "code-settings";

export interface ProjectedCodeSettings {
  readonly settings: CodeSettings;
  readonly aggregateVersion: number;
  readonly lastSequence: number;
}

export interface CodeSettingsProjectionRow {
  readonly projection_key: string;
  readonly schema_version: number;
  readonly settings_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export interface CodeThreadProjectionRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly checkout_id: string;
  readonly lifecycle: CodeThreadLifecycle;
  readonly schema_version: number;
  readonly thread_json: string;
  readonly aggregate_version: number;
  readonly updated_at: string;
  readonly last_sequence: number;
}

/**
 * How far a thread's journaled operation activity has advanced. Kept apart from
 * `code_thread_projection` because it is driven by a different aggregate: a
 * provider turn is journaled on `code-operation`, so it never touches the
 * thread row's `aggregate_version` or `updated_at`.
 */
export interface CodeThreadActivityProjectionRow {
  readonly thread_id: string;
  readonly schema_version: number;
  readonly last_sequence: number;
}

export interface CodeCheckoutProjectionRow {
  readonly checkout_id: string;
  readonly repository_id: string;
  readonly availability: CodeCheckoutIdentity["availability"];
  readonly schema_version: number;
  readonly checkout_json: string;
  readonly aggregate_version: number;
  readonly observed_at: string;
  readonly last_sequence: number;
}

export interface CodeFileProjectionRow {
  readonly file_id: string;
  readonly thread_id: string;
  readonly checkout_id: string;
  readonly content_id: string | null;
  readonly digest: string;
  readonly byte_length: number;
  readonly state: CodeFileLifecycle;
  readonly schema_version: number;
  readonly file_json: string;
  readonly aggregate_version: number;
  readonly updated_at: string;
  readonly last_sequence: number;
}

export interface CodeRuntimeProjectionRow {
  readonly runtime_work_id: string;
  readonly thread_id: string;
  readonly work_kind: CodeRuntimeWorkKind;
  readonly state: CodeRuntimeWorkState;
  readonly evidence_content_id: string | null;
  readonly digest: string | null;
  readonly byte_length: number | null;
  readonly schema_version: number;
  readonly work_json: string;
  readonly aggregate_version: number;
  readonly updated_at: string;
  readonly last_sequence: number;
  /**
   * Journal position of the event that first projected this work. Written once
   * at insert and never rewritten, so it is the record's durable chronology.
   * Null only for rows projected before the column existed.
   */
  readonly first_sequence: number | null;
}

export interface CodeReviewProjectionRow {
  readonly finding_id: string;
  readonly thread_id: string;
  readonly checkout_id: string;
  readonly file_id: string;
  readonly severity: CodeReviewFinding["severity"];
  readonly state: CodeReviewFinding["state"];
  readonly schema_version: number;
  readonly finding_json: string;
  readonly aggregate_version: number;
  readonly updated_at: string;
  readonly last_sequence: number;
}

export interface CodePlannerProjectionRow {
  readonly project_id: string;
  readonly planner_thread_id: string | null;
  readonly schema_version: number;
  readonly designation_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export interface CodePlannerProposalProjectionRow {
  readonly proposal_id: string;
  readonly project_id: string;
  readonly status: "pending" | "confirmed" | "declined";
  readonly schema_version: number;
  readonly proposal_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export function assertCodeProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== CODE_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported Code projection schema version");
  }
}
