/**
 * Side tasks: work a model notices while doing something else and offers to
 * run separately, so the current thread stays on its own task.
 *
 * A model offers one through the app-managed `octant_offer_side_task` tool,
 * on any provider that runs app-managed tools, in any mode. The offer is a
 * card the person reads; it carries no authority. Starting it is the
 * person's confirmation: the host creates the thread through the mode's
 * ordinary creation command and sends the offer's prompt as its first
 * message, under the new thread's own authority.
 */

import { Schema } from "effect";
import { FollowUpSuggestedBy } from "./followUpSuggestions";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SIDE_TASK_TOOL_NAME = "octant_offer_side_task";
export const MAX_SIDE_TASK_TITLE_LENGTH = 80;
export const MAX_SIDE_TASK_REASON_LENGTH = 280;
export const MAX_SIDE_TASK_PROMPT_LENGTH = 8_192;
/** Offers still waiting on a person; a model past this is refused, not queued. */
export const MAX_OPEN_SIDE_TASKS = 5;
export const MAX_SIDE_TASK_VIEW_ENTRIES = 10;

export const SideTaskId = Schema.UUID.pipe(Schema.brand("SideTaskId"));
export type SideTaskId = typeof SideTaskId.Type;

/** A worktree needs a checkout, so only a Code thread can offer one. */
export const SideTaskTarget = Schema.Literal("new-thread", "new-worktree");
export type SideTaskTarget = typeof SideTaskTarget.Type;

export const SideTaskStatus = Schema.Literal("offered", "started", "dismissed");
export type SideTaskStatus = typeof SideTaskStatus.Type;

export const SideTaskOffer = Schema.Struct({
  id: SideTaskId,
  threadId: Schema.UUID,
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  suggestedBy: FollowUpSuggestedBy,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_SIDE_TASK_TITLE_LENGTH)),
  /** What the model noticed and why it belongs elsewhere, in one sentence. */
  reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_SIDE_TASK_REASON_LENGTH)),
  /** Standalone: the new thread starts with this and nothing else. */
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_SIDE_TASK_PROMPT_LENGTH)),
  target: SideTaskTarget,
  offeredAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskOffer = typeof SideTaskOffer.Type;

export const SideTask = Schema.Struct({
  offer: SideTaskOffer,
  status: SideTaskStatus,
  /** The thread a start created, present once started. */
  startedThreadId: Schema.optional(Schema.UUID),
  settledAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type SideTask = typeof SideTask.Type;

export const ThreadSideTasks = Schema.Struct({
  threadId: Schema.UUID,
  tasks: Schema.Array(SideTask).pipe(Schema.maxItems(MAX_SIDE_TASK_VIEW_ENTRIES)),
}).annotations(strict);
export type ThreadSideTasks = typeof ThreadSideTasks.Type;

export const SideTaskStarted = Schema.Struct({
  sideTaskId: SideTaskId,
  startedThreadId: Schema.UUID,
  startedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskStarted = typeof SideTaskStarted.Type;

export const SideTaskDismissed = Schema.Struct({
  sideTaskId: SideTaskId,
  dismissedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskDismissed = typeof SideTaskDismissed.Type;

/** A person confirms; there is no shape in which a start is implicit. */
export const StartSideTask = Schema.Struct({
  sideTaskId: SideTaskId,
  confirmed: Schema.Literal(true),
}).annotations(strict);
export type StartSideTask = typeof StartSideTask.Type;

export const DismissSideTask = Schema.Struct({
  sideTaskId: SideTaskId,
}).annotations(strict);
export type DismissSideTask = typeof DismissSideTask.Type;

export const SideTaskResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("side-task-started"),
    sideTaskId: SideTaskId,
    mode: OctantMode,
    threadId: Schema.UUID,
    title: Schema.NonEmptyTrimmedString,
    projectId: Schema.optional(ProjectId),
    /**
     * False when the thread exists but its first message did not go out; the
     * prompt then waits in the new thread's composer for the person to send.
     */
    sent: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("side-task-dismissed"),
    sideTaskId: SideTaskId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("side-task-refused"),
    sideTaskId: Schema.String,
    reason: Schema.Literal("not-found", "already-settled", "target-unavailable"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type SideTaskResult = typeof SideTaskResult.Type;

export const THREAD_SIDE_TASKS_AGGREGATE_TYPE = "thread-side-tasks";
export const THREAD_SIDE_TASK_EVENT_NAMES = {
  offered: "side-task-offered@1",
  started: "side-task-started@1",
  dismissed: "side-task-dismissed@1",
} as const;

export const decodeSideTaskId = Schema.decodeUnknownSync(SideTaskId);
export const decodeSideTaskOffer = Schema.decodeUnknownSync(SideTaskOffer);
export const decodeThreadSideTasks = Schema.decodeUnknownSync(ThreadSideTasks);
export const decodeStartSideTask = Schema.decodeUnknownSync(StartSideTask);
export const decodeDismissSideTask = Schema.decodeUnknownSync(DismissSideTask);
export const decodeSideTaskResult = Schema.decodeUnknownSync(SideTaskResult);
