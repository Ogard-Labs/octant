import type { CapacityReservationState, ContextHealth } from "@octant/contracts";

export const CONTEXT_PROJECTION_SCHEMA_VERSION = 1;

export interface ContextManifestProjectionRow {
  readonly manifest_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly provider_instance_id: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly manifest_json: string;
  readonly created_at: string;
  readonly last_sequence: number;
}

export interface ContextOverrideProjectionRow {
  readonly manifest_id: string;
  readonly schema_version: number;
  readonly overrides_json: string;
  readonly occurred_at: string;
  readonly last_sequence: number;
}

export interface ContextPlanProjectionRow {
  readonly plan_id: string;
  readonly manifest_id: string;
  readonly health: ContextHealth;
  readonly blocked: number;
  readonly schema_version: number;
  readonly plan_json: string;
  readonly created_at: string;
  readonly last_sequence: number;
}

export interface ContextSummaryProjectionRow {
  readonly summary_id: string;
  readonly provider_instance_id: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly summary_json: string;
  readonly created_at: string;
  readonly last_sequence: number;
}

/**
 * Generated summary text, owned by the subject whose conversation produced it.
 * It is a store rather than a projection: the journal carries only the
 * summary's identity, so a rebuild must not clear text that no event can
 * restore, and a subject purge must be able to remove it for good.
 */
export interface ContextSummaryContentStoreRow {
  readonly summary_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly body_text: string;
  readonly created_at: string;
}

export interface ContextUsageProjectionRow {
  readonly reconciliation_id: string;
  readonly plan_id: string;
  readonly provider_instance_id: string;
  readonly model_id: string;
  readonly request_shape: string;
  readonly schema_version: number;
  readonly reconciliation_json: string;
  readonly observed_at: string;
  readonly last_sequence: number;
}

export interface ContextCapacityProjectionRow {
  readonly reservation_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly provider_instance_id: string;
  readonly model_id: string;
  readonly state: CapacityReservationState;
  readonly schema_version: number;
  readonly reservation_json: string;
  readonly updated_at: string;
  readonly last_sequence: number;
}

export function assertContextProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== CONTEXT_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported context projection schema version");
  }
}
