import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * A Project View's lifecycle lens. `all` is a view choice, not a Project
 * lifecycle: Projects remain `active` or `archived` in the journal.
 */
export const ProjectViewLifecycle = Schema.Literal("active", "archived", "all");
export type ProjectViewLifecycle = typeof ProjectViewLifecycle.Type;

/** How the Project list is grouped. Mode is never a grouping axis. */
export const ProjectViewGrouping = Schema.Literal("project", "environment", "status", "none");
export type ProjectViewGrouping = typeof ProjectViewGrouping.Type;

export const ProjectViewSort = Schema.Literal("recency", "alphabetical", "created");
export type ProjectViewSort = typeof ProjectViewSort.Type;

/**
 * Inclusive local-calendar activity windows. `all` means no activity
 * constraint. Custom ranges carry `YYYY-MM-DD` local dates, not timestamps.
 */
export const ProjectViewActivityPeriod = Schema.Literal(
  "all",
  "today",
  "3-days",
  "7-days",
  "14-days",
  "30-days",
  "custom",
);
export type ProjectViewActivityPeriod = typeof ProjectViewActivityPeriod.Type;

export const ProjectViewLocalDate = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/));
export type ProjectViewLocalDate = typeof ProjectViewLocalDate.Type;

export const ProjectViewActivityRange = Schema.Struct({
  from: Schema.optional(ProjectViewLocalDate),
  to: Schema.optional(ProjectViewLocalDate),
}).annotations(strict);
export type ProjectViewActivityRange = typeof ProjectViewActivityRange.Type;

/**
 * Durable filter/group/sort state for one Project View. Empty
 * `environmentIds` means every host environment available to the window.
 * Host ids are ordinary strings so a disconnected host can still round-trip
 * without branding a value the window no longer has.
 */
export const ProjectViewFilters = Schema.Struct({
  lifecycle: ProjectViewLifecycle,
  environmentIds: Schema.Array(Schema.NonEmptyTrimmedString),
  showEmptyProjects: Schema.Boolean,
  grouping: ProjectViewGrouping,
  sorting: ProjectViewSort,
  activity: ProjectViewActivityPeriod,
  activityRange: Schema.optional(ProjectViewActivityRange),
}).annotations(strict);
export type ProjectViewFilters = typeof ProjectViewFilters.Type;

export const ProjectViewEnvironment = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  name: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ProjectViewEnvironment = typeof ProjectViewEnvironment.Type;

/**
 * Conservative defaults: show Active Projects, every environment, empty
 * Projects, Project grouping, recency, and no activity window. Unknown saved
 * state migrates here rather than hiding work.
 */
export const DEFAULT_PROJECT_VIEW_FILTERS: ProjectViewFilters = {
  lifecycle: "active",
  environmentIds: [],
  showEmptyProjects: true,
  grouping: "project",
  sorting: "recency",
  activity: "all",
};

export const decodeProjectViewLifecycle = Schema.decodeUnknownSync(ProjectViewLifecycle);
export const decodeProjectViewGrouping = Schema.decodeUnknownSync(ProjectViewGrouping);
export const decodeProjectViewSort = Schema.decodeUnknownSync(ProjectViewSort);
export const decodeProjectViewActivityPeriod = Schema.decodeUnknownSync(ProjectViewActivityPeriod);
export const decodeProjectViewLocalDate = Schema.decodeUnknownSync(ProjectViewLocalDate);
export const decodeProjectViewActivityRange = Schema.decodeUnknownSync(ProjectViewActivityRange);
export const decodeProjectViewFilters = Schema.decodeUnknownSync(ProjectViewFilters);
export const decodeProjectViewEnvironment = Schema.decodeUnknownSync(ProjectViewEnvironment);
