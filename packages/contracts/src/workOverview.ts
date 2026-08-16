import { Schema } from "effect";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Sanitized Overview list item. Labels and details are renderer-facing only —
 * no host paths, binding receipts, or authority tokens.
 */
export const WorkOverviewItem = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
}).annotations(strict);
export type WorkOverviewItem = typeof WorkOverviewItem.Type;

/**
 * Rebuildable Work Project Overview projection composed from existing
 * artifact / capability / export facts. Not an analytics store.
 */
export const WorkOverviewProjection = Schema.Struct({
  projectId: ProjectId,
  filesAndArtifacts: Schema.Array(WorkOverviewItem).pipe(Schema.maxItems(64)),
  workflowsAndThreads: Schema.Array(WorkOverviewItem).pipe(Schema.maxItems(64)),
  approvals: Schema.Array(WorkOverviewItem).pipe(Schema.maxItems(64)),
  versions: Schema.Array(WorkOverviewItem).pipe(Schema.maxItems(64)),
  validation: Schema.Array(WorkOverviewItem).pipe(Schema.maxItems(64)),
  exports: Schema.Array(WorkOverviewItem).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type WorkOverviewProjection = typeof WorkOverviewProjection.Type;

export const decodeWorkOverviewItem = Schema.decodeUnknownSync(WorkOverviewItem);
export const decodeWorkOverviewProjection = Schema.decodeUnknownSync(WorkOverviewProjection);
