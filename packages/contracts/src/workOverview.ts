import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProjectId } from "./projects";
import { WorkProjectStatus } from "./workProjectStatus";

/**
 * Sanitized Overview list item. Labels and details are renderer-facing only —
 * no host paths, binding receipts, or authority tokens.
 */
export const WorkOverviewItem = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  detail: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
});
export type WorkOverviewItem = typeof WorkOverviewItem.Type;

/**
 * Rebuildable Work Project Overview projection composed from existing
 * artifact / capability / export facts. Not an analytics store.
 */
export const WorkOverviewProjection = Schema.Struct({
  projectId: ProjectId,
  filesAndArtifacts: Schema.Array(WorkOverviewItem).check(Schema.isMaxLength(64)),
  workflowsAndThreads: Schema.Array(WorkOverviewItem).check(Schema.isMaxLength(64)),
  approvals: Schema.Array(WorkOverviewItem).check(Schema.isMaxLength(64)),
  versions: Schema.Array(WorkOverviewItem).check(Schema.isMaxLength(64)),
  validation: Schema.Array(WorkOverviewItem).check(Schema.isMaxLength(64)),
  exports: Schema.Array(WorkOverviewItem).check(Schema.isMaxLength(64)),
  /**
   * The top level of the bound folder: what is actually in the Project,
   * beside what Octant produced. Absent on a host that could not list it.
   */
  folder: Schema.optional(Schema.Array(WorkOverviewItem).check(Schema.isMaxLength(64))),
  /** What `STATUS.md` says, read from the folder. Absent when unreadable. */
  status: Schema.optional(WorkProjectStatus),
});
export type WorkOverviewProjection = typeof WorkOverviewProjection.Type;

export const decodeWorkOverviewItem = Schema.decodeUnknownSync(
  WorkOverviewItem,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkOverviewProjection = Schema.decodeUnknownSync(
  WorkOverviewProjection,
  STRICT_DECODE_OPTIONS,
);
