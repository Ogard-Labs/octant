import {
  decodeValidationEvidenceSnapshot,
  decodeValidationPlan,
  decodeValidationReport,
  decodeValidationStepSummary,
  decodeValidationTimelineEntry,
  type ToolActionAuthority,
  type ValidationEvidenceSnapshot,
  type ValidationOutcome,
  type ValidationPlan,
  type ValidationReport,
  type ValidationStepSummary,
  type ValidationTimelineEntry,
} from "@octant/contracts";

export const VALIDATION_PROJECTION_SCHEMA_VERSION = 2;

export interface ValidationEvidenceProjectionRow {
  readonly schema_version: number;
  readonly plan_id: string;
  readonly host_id: string;
  readonly mode: "chat" | "work" | "code";
  readonly project_id: string;
  readonly root_id: string | null;
  readonly worktree_id: string | null;
  readonly provider_instance_id: string;
  readonly extension_kind: "core" | "trusted-extension";
  readonly extension_id: string | null;
  readonly plan_json: string | null;
  readonly timeline_json: string;
  readonly steps_json: string;
  readonly overall_outcome: ValidationOutcome;
  readonly report_json: string | null;
  readonly aggregate_version: number;
  readonly plan_sequence: number;
  readonly last_sequence: number;
}

export interface ValidationEvidenceProjectionState {
  readonly planId: string;
  readonly authority: ToolActionAuthority;
  readonly plan: ValidationPlan | undefined;
  readonly timeline: ReadonlyArray<ValidationTimelineEntry>;
  readonly steps: ReadonlyArray<ValidationStepSummary>;
  readonly overallOutcome: ValidationOutcome;
  readonly report: ValidationReport | undefined;
  readonly aggregateVersion: number;
  readonly planSequence: number;
  readonly lastSequence: number;
}

export function decodePersistedPlan(raw: unknown): ValidationPlan | undefined {
  if (raw === null || raw === undefined) return undefined;
  return decodeValidationPlan(raw);
}

export function decodePersistedReport(raw: unknown): ValidationReport | undefined {
  if (raw === null || raw === undefined) return undefined;
  return decodeValidationReport(raw);
}

export function decodePersistedTimeline(raw: unknown): ReadonlyArray<ValidationTimelineEntry> {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => decodeValidationTimelineEntry(entry));
}

export function decodePersistedSteps(raw: unknown): ReadonlyArray<ValidationStepSummary> {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => decodeValidationStepSummary(entry));
}

export function snapshotFromState(
  state: ValidationEvidenceProjectionState,
  snapshotAt: string,
): ValidationEvidenceSnapshot {
  return decodeValidationEvidenceSnapshot({
    authority: state.authority,
    sequence: state.lastSequence,
    snapshotAt,
    ...(state.plan !== undefined ? { plan: state.plan } : {}),
    timeline: [...state.timeline],
    steps: [...state.steps],
    overallOutcome: state.overallOutcome,
    ...(state.report !== undefined ? { report: state.report } : {}),
  });
}
