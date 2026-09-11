import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** A calendar date as it is written in `STATUS.md`. */
export const WorkStatusDate = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/));
export type WorkStatusDate = typeof WorkStatusDate.Type;

/**
 * How near a dated line in `STATUS.md` is, judged against the host's clock on
 * the day it was read. `overdue` is a date already passed; `due-soon` falls
 * inside the window the resume brief treats as urgent.
 */
export const WorkStatusDueState = Schema.Literal("overdue", "due-soon", "upcoming");
export type WorkStatusDueState = typeof WorkStatusDueState.Type;

/** One dated line from the Deadlines or Follow-ups section. */
export const WorkStatusDatedItem = Schema.Struct({
  date: WorkStatusDate,
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  state: WorkStatusDueState,
}).annotations(strict);
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
 * What the host read out of a Work Project's `STATUS.md` and `AGENTS.md`.
 * Derived from the files on every read, never journaled: the folder is the
 * source of truth for a Work Project's status (`docs/decisions/0118`).
 */
export const WorkProjectStatus = Schema.Struct({
  projectId: ProjectId,
  hasAgentsFile: Schema.Boolean,
  hasStatusFile: Schema.Boolean,
  /** The `Last updated:` line of `STATUS.md`, when it parses. */
  lastUpdatedOn: Schema.optional(WorkStatusDate),
  /** The file's modification time as the host saw it. */
  modifiedAt: Schema.optional(UtcTimestamp),
  /** True when the status is older than the stale threshold or has no date. */
  stale: Schema.Boolean,
  /** The `Current status` section, bounded, for the Project page. */
  currentStatus: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_WORK_STATUS_EXCERPT_LENGTH)),
  ),
  followUps: Schema.Array(WorkStatusDatedItem).pipe(Schema.maxItems(MAX_WORK_STATUS_ITEMS)),
  deadlines: Schema.Array(WorkStatusDatedItem).pipe(Schema.maxItems(MAX_WORK_STATUS_ITEMS)),
}).annotations(strict);
export type WorkProjectStatus = typeof WorkProjectStatus.Type;

export const decodeWorkProjectStatus = Schema.decodeUnknownSync(WorkProjectStatus);
