import type { ProfileScopeKind } from "@octant/contracts/agent-profile";

export const AGENT_PROFILE_PROJECTION_SCHEMA_VERSION = 1;

export interface AgentProfileProjectionRow {
  readonly profile_id: string;
  readonly schema_version: number;
  readonly scope_kind: ProfileScopeKind;
  readonly scope_ref: string;
  readonly profile_json: string;
  readonly aggregate_version: number;
}

export function assertAgentProfileProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== AGENT_PROFILE_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported agent profile projection schema version");
  }
}
