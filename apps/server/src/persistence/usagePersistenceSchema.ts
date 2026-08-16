export const USAGE_PROJECTION_SCHEMA_VERSION = 2;

export interface UsageRecordProjectionRow {
  readonly reconciliation_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly provider_instance_id: string;
  readonly model_id: string;
  readonly request_shape: string;
  readonly quality: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number | null;
  readonly cache_read_input_tokens: number | null;
  readonly cache_write_input_tokens: number | null;
  readonly provider_execution_duration_ms: number | null;
  readonly planned_input_tokens: number;
  readonly variance_tokens: number;
  readonly schema_version: number;
  readonly attribution_json: string;
  readonly observed_at: string;
  readonly last_sequence: number;
  readonly host_id: string;
}

export function assertUsageProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== USAGE_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported usage projection schema version");
  }
}
