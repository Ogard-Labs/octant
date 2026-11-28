import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

/** A calendar date as it is written in `STATUS.md`. */
export const WorkStatusDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type WorkStatusDate = typeof WorkStatusDate.Type;

/**
 * How near a dated line in `STATUS.md` is, judged against the host's clock on
 * the day it was read. `overdue` is a date already passed; `due-soon` falls
 * inside the window the resume brief treats as urgent.
 */
export const WorkStatusDueState = Schema.Literals(["overdue", "due-soon", "upcoming"]);
export type WorkStatusDueState = typeof WorkStatusDueState.Type;

/** One dated line from the Deadlines or Follow-ups section. */
export const WorkStatusDatedItem = Schema.Struct({
  date: WorkStatusDate,
  text: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  state: WorkStatusDueState,
});
export type WorkStatusDatedItem = typeof WorkStatusDatedItem.Type;

/** Names for the sections the template writes and the parser looks for. */
export const WORK_STATUS_SECTIONS = {
  currentStatus: "Current status",
  followUps: "Follow-ups",
  deadlines: "Deadlines",
  recentChanges: "Recent changes",
} as const;

export const MAX_WORK_STATUS_ITEMS = 32;
export const MAX_WORK_STATUS_EXCERPT_LENGTH = 2_000;

/**
 * What the host read out of the `STATUS.md` of a Work Project that keeps one.
 * Derived from the file on every read, never journaled: the folder is the
 * source of truth for a Work Project's status.
 */
export const WorkProjectStatus = Schema.Struct({
  projectId: ProjectId,
  hasStatusFile: Schema.Boolean,
  /** The `Last updated:` line of `STATUS.md`, when it parses. */
  lastUpdatedOn: Schema.optional(WorkStatusDate),
  /** The file's modification time as the host saw it. */
  modifiedAt: Schema.optional(UtcTimestamp),
  /** True when the status is older than the stale threshold or has no date. */
  stale: Schema.Boolean,
  /** The `Current status` section, bounded, for the Project page. */
  currentStatus: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_WORK_STATUS_EXCERPT_LENGTH)),
  ),
  followUps: Schema.Array(WorkStatusDatedItem).check(Schema.isMaxLength(MAX_WORK_STATUS_ITEMS)),
  deadlines: Schema.Array(WorkStatusDatedItem).check(Schema.isMaxLength(MAX_WORK_STATUS_ITEMS)),
});
export type WorkProjectStatus = typeof WorkProjectStatus.Type;

export const decodeWorkProjectStatus = Schema.decodeUnknownSync(
  WorkProjectStatus,
  STRICT_DECODE_OPTIONS,
);
