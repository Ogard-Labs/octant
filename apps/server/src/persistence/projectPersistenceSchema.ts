export const PROJECT_PROJECTION_SCHEMA_VERSION = 1;

export interface ProjectProjectionRow {
  readonly project_id: string;
  readonly schema_version: number;
  readonly project_type: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
  readonly pinned: number;
  readonly project_json: string;
  readonly aggregate_version: number;
}

export interface ProjectMemoryProjectionRow {
  readonly project_id: string;
  readonly entry_id: string;
  readonly schema_version: number;
  readonly status: "active" | "superseded" | "retracted";
  readonly memory_kind: "decision" | "fact" | "preference" | "summary" | "outcome";
  readonly entry_json: string;
  readonly aggregate_version: number;
}

export function assertProjectProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== PROJECT_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported Project projection schema version");
  }
}
