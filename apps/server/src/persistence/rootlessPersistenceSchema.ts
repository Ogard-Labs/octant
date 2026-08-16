import type { OctantMode } from "@octant/contracts/modes";
import type { HostId } from "@octant/contracts/shell";
import type { ProjectId } from "@octant/contracts/projects";
import type { RootlessThreadId, RootlessTurnState } from "@octant/contracts/rootless-thread";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";

export const ROOTLESS_PROJECTION_SCHEMA_VERSION = 1;

export type RootlessWorkspaceKind = "rootless" | "project-backed";

export interface RootlessThreadProjectionRow {
  readonly thread_id: string;
  readonly mode: OctantMode;
  readonly host_id: string;
  readonly workspace_kind: RootlessWorkspaceKind;
  readonly project_id: string | null;
  readonly schema_version: number;
  readonly thread_json: string;
  readonly aggregate_version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_sequence: number;
}

export interface RootlessTurnRequestProjectionRow {
  readonly request_id: string;
  readonly thread_id: string;
  readonly accepted_event_id: string;
  readonly last_sequence: number;
}

/**
 * Projected rootless thread record. Rebuildable from the authoritative event
 * journal. Carries the workspace variant so Recents/All can group and an
 * explicit Unfiled filter works. No host path, credential, or authority token.
 */
export interface ProjectedRootlessThread {
  readonly threadId: RootlessThreadId;
  readonly title: string;
  readonly mode: OctantMode;
  readonly hostId: HostId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly workspaceKind: RootlessWorkspaceKind;
  readonly projectId: ProjectId | null;
  readonly initialTurn?: RootlessTurnState;
  readonly initialTurnAcceptedEventId?: string;
  readonly aggregateVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function assertRootlessProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== ROOTLESS_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported Rootless projection schema version");
  }
}
