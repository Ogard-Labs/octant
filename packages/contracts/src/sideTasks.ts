/**
 * Side tasks: work a model notices while doing something else and offers to
 * run separately, so the current thread stays on its own task.
 *
 * A model offers one through the app-managed `octant_offer_side_task` tool,
 * on any provider that runs app-managed tools, in any mode. The offer is a
 * card the person reads; it carries no authority. A Code Project's designated
 * planner may also offer one to the Project board (target `board`), which
 * records a pending planner proposal the person confirms in the planner
 * instead of a card (see `codePlanner.ts`). Starting it is the
 * person's confirmation: the host creates the thread through the mode's
 * ordinary creation command and sends the offer's prompt as its first
 * message, under the new thread's own authority.
 */

import { Schema } from "effect";
import { AgentRunResultDeliveryMark } from "./agentRun";
import { FollowUpSuggestedBy } from "./followUpSuggestions";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SIDE_TASK_TOOL_NAME = "octant_offer_side_task";
/**
 * The profile allowlist entry for the planner's `board` target. A non-empty
 * allowlist must name it for the designated planner to offer tasks to the
 * Project board; proposing was a separate tool a profile could leave out, and
 * folding it into side tasks must not hand an existing allowlist that power.
 */
export const SIDE_TASK_BOARD_ALLOWLIST_ENTRY = "octant_offer_side_task.board";
export const MAX_SIDE_TASK_TITLE_LENGTH = 80;
export const MAX_SIDE_TASK_REASON_LENGTH = 280;
export const MAX_SIDE_TASK_PROMPT_LENGTH = 8_192;
/** Offers still waiting on a person; a model past this is refused, not queued. */
export const MAX_OPEN_SIDE_TASKS = 5;
/** Offered, dismissed and continued-here entries a thread's view keeps, newest last. */
export const MAX_SIDE_TASK_VIEW_ENTRIES = 10;
/**
 * Started receipts a thread's view keeps beside them. A started child goes on
 * reporting, so its Stop reporting control must outlive the offers around it.
 */
export const MAX_STARTED_SIDE_TASK_RECEIPTS = 50;

export const SideTaskId = Schema.UUID.pipe(Schema.brand("SideTaskId"));
export type SideTaskId = typeof SideTaskId.Type;

/** A worktree needs a checkout, so only a Code thread can offer one. */
export const SideTaskTarget = Schema.Literal("new-thread", "new-worktree");
export type SideTaskTarget = typeof SideTaskTarget.Type;

/**
 * What a new thread starts with: only the offer's prompt, or this thread's
 * conversation through the offering turn followed by the prompt. A fork
 * needs the offering turn to have finished; in Code it always gets its own
 * worktree, because a fork carries the checkout as that turn left it.
 */
export const SideTaskContext = Schema.Literal("fresh", "fork");
export type SideTaskContext = typeof SideTaskContext.Type;

export const SideTaskStatus = Schema.Literal("offered", "started", "continued-here", "dismissed");
export type SideTaskStatus = typeof SideTaskStatus.Type;

/** Unconfirmed is a durable dispatch claim, never permission to replay it. */
export const SideTaskHereDelivery = Schema.Literal("sent", "queued", "unconfirmed");

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
  /** Absent on offers made before forks existed; those start fresh. */
  context: Schema.optional(SideTaskContext),
  /**
   * The turn that made the offer, in the mode's own identity (a Chat turn,
   * a Work turn, or a Code operation): where the card sits in the
   * transcript and the point a fork is taken through. Absent on offers made
   * before cards were placed inline.
   */
  turnId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  offeredAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskOffer = typeof SideTaskOffer.Type;

/**
 * What a started child thread is doing, in the sidebar row's vocabulary:
 * `working` while a turn executes, `attention` while it waits on the person,
 * `quiet` otherwise. Read-time state only — it is derived from the
 * navigation projections when the thread's tasks are read, never journaled,
 * and absent when the child cannot be read.
 */
export const SideTaskChildState = Schema.Literal("working", "attention", "quiet");
export type SideTaskChildState = typeof SideTaskChildState.Type;

export const SideTask = Schema.Struct({
  offer: SideTaskOffer,
  status: SideTaskStatus,
  /** The thread a start created, present once started. */
  startedThreadId: Schema.optional(Schema.UUID),
  /** Whether a new thread was forked from this conversation; present once started. */
  startedWith: Schema.optional(SideTaskContext),
  /** Confirmed delivery or a durable claim whose outcome is still unknown. */
  continuedDelivery: Schema.optional(SideTaskHereDelivery),
  settledAt: Schema.optional(UtcTimestamp),
  /** The child thread's live state at read time; absent when it cannot be read. */
  childState: Schema.optional(SideTaskChildState),
  /**
   * Whether the child still owes this thread reports of its ended turns, as
   * the report aggregate reads it now. Read-time only, like `childState`:
   * absent when the host cannot say, and `on` unless the person stopped it.
   */
  reporting: Schema.optional(Schema.Literal("on", "stopped")),
}).annotations(strict);
export type SideTask = typeof SideTask.Type;

export const ThreadSideTasks = Schema.Struct({
  threadId: Schema.UUID,
  tasks: Schema.Array(SideTask).pipe(
    Schema.maxItems(MAX_SIDE_TASK_VIEW_ENTRIES + MAX_STARTED_SIDE_TASK_RECEIPTS),
  ),
}).annotations(strict);
export type ThreadSideTasks = typeof ThreadSideTasks.Type;

export const SideTaskStarted = Schema.Struct({
  sideTaskId: SideTaskId,
  startedThreadId: Schema.UUID,
  /** Absent on starts recorded before forks existed, which were all fresh. */
  startedWith: Schema.optional(SideTaskContext),
  startedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskStarted = typeof SideTaskStarted.Type;

/** The person chose to have the offering thread do the work itself. */
export const SideTaskContinuedHere = Schema.Struct({
  sideTaskId: SideTaskId,
  /** Claimed before dispatch, then confirmed as sent or queued when possible. */
  delivery: SideTaskHereDelivery,
  continuedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskContinuedHere = typeof SideTaskContinuedHere.Type;

/** A claimed continuation was explicitly refused before it dispatched anything. */
export const SideTaskContinuationRefused = Schema.Struct({
  sideTaskId: SideTaskId,
  refusedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskContinuationRefused = typeof SideTaskContinuationRefused.Type;

export const SideTaskDismissed = Schema.Struct({
  sideTaskId: SideTaskId,
  dismissedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskDismissed = typeof SideTaskDismissed.Type;

/**
 * A person confirms; there is no shape in which a start is implicit. The
 * person may override the model's suggested context; the host still refuses
 * a fork it cannot take.
 */
export const StartSideTask = Schema.Struct({
  sideTaskId: SideTaskId,
  confirmed: Schema.Literal(true),
  context: Schema.optional(SideTaskContext),
}).annotations(strict);
export type StartSideTask = typeof StartSideTask.Type;

/** "Do it here": the person confirms the offering thread should take the work on. */
export const ContinueSideTaskHere = Schema.Struct({
  sideTaskId: SideTaskId,
  confirmed: Schema.Literal(true),
}).annotations(strict);
export type ContinueSideTaskHere = typeof ContinueSideTaskHere.Type;

export const DismissSideTask = Schema.Struct({
  sideTaskId: SideTaskId,
}).annotations(strict);
export type DismissSideTask = typeof DismissSideTask.Type;

/** The person stops or resumes the reports a started child owes this thread. */
export const SetSideTaskReporting = Schema.Struct({
  sideTaskId: SideTaskId,
  on: Schema.Boolean,
}).annotations(strict);
export type SetSideTaskReporting = typeof SetSideTaskReporting.Type;

export const SideTaskResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("side-task-started"),
    sideTaskId: SideTaskId,
    mode: OctantMode,
    threadId: Schema.UUID,
    title: Schema.NonEmptyTrimmedString,
    projectId: Schema.optional(ProjectId),
    startedWith: SideTaskContext,
    /**
     * False when the thread exists but its first message did not go out; the
     * prompt then waits in the new thread's composer for the person to send.
     */
    sent: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("side-task-continued-here"),
    sideTaskId: SideTaskId,
    threadId: Schema.UUID,
    delivery: SideTaskHereDelivery,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("side-task-dismissed"),
    sideTaskId: SideTaskId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("side-task-refused"),
    sideTaskId: Schema.String,
    /**
     * `turn-running`: a fork waits for the offering turn to finish, because
     * a fork point must be a settled turn.
     */
    reason: Schema.Literal("not-found", "already-settled", "target-unavailable", "turn-running"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("side-task-reporting"),
    sideTaskId: SideTaskId,
    reporting: Schema.Literal("on", "stopped"),
  }).annotations(strict),
);
export type SideTaskResult = typeof SideTaskResult.Type;

export const THREAD_SIDE_TASKS_AGGREGATE_TYPE = "thread-side-tasks";
export const THREAD_SIDE_TASK_EVENT_NAMES = {
  offered: "side-task-offered@1",
  started: "side-task-started@1",
  dismissed: "side-task-dismissed@1",
  continuedHere: "side-task-continued-here@1",
  continuationRefused: "side-task-continuation-refused@1",
} as const;

export const decodeSideTaskId = Schema.decodeUnknownSync(SideTaskId);
export const decodeSideTaskOffer = Schema.decodeUnknownSync(SideTaskOffer);
export const decodeThreadSideTasks = Schema.decodeUnknownSync(ThreadSideTasks);
export const decodeStartSideTask = Schema.decodeUnknownSync(StartSideTask);
export const decodeDismissSideTask = Schema.decodeUnknownSync(DismissSideTask);
export const decodeContinueSideTaskHere = Schema.decodeUnknownSync(ContinueSideTaskHere);
export const decodeSetSideTaskReporting = Schema.decodeUnknownSync(SetSideTaskReporting);
export const decodeSideTaskResult = Schema.decodeUnknownSync(SideTaskResult);

// ── Completion reports back to the offering thread ──────────────────────────
//
// A thread started from a side task owes its offering thread a report of
// every turn that ends in it — completed, failed, or cancelled — delivered as
// an honestly marked delivery turn through the parent's mode. The reports are
// journaled on an aggregate keyed by the child thread, so a report owed while
// the host restarts is found in the projection and delivered then. The
// aggregate id is the child thread's id.

/** At most this much of a finished turn's reply rides in one report. */
export const MAX_SIDE_TASK_REPORT_TEXT_LENGTH = 4_096;
/**
 * One delivery turn carries at most this many reports; a larger owed set is
 * split across turns rather than making one turn carry an unbounded batch.
 */
export const MAX_SIDE_TASK_REPORT_DELIVERY_BATCH_SIZE = 8;

export const THREAD_SIDE_TASK_REPORTS_AGGREGATE_TYPE = "thread-side-task-reports";
export const THREAD_SIDE_TASK_REPORT_EVENT_NAMES = {
  owed: "side-task-report-owed@1",
  delivered: "side-task-report-delivered@1",
  refused: "side-task-report-refused@1",
  reportingStopped: "side-task-reporting-stopped@1",
  reportingResumed: "side-task-reporting-resumed@1",
} as const;

/** How the child's turn ended; only completions carry the reply's text. */
export const SideTaskReportOutcome = Schema.Literal("completed", "failed", "cancelled");
export type SideTaskReportOutcome = typeof SideTaskReportOutcome.Type;

/**
 * One ended turn in the child that the parent has not yet heard about. The
 * parent's identity, mode, and the offer's title ride in the event rather
 * than being looked up at delivery time, because the report must survive
 * anything that happens to the offering thread's own records in between.
 */
export const SideTaskReportOwed = Schema.Struct({
  reportId: Schema.UUID,
  parentThreadId: Schema.UUID,
  parentMode: OctantMode,
  /**
   * The thread whose turn ended. A title can be shared by several side tasks,
   * so only this says which one reported. Absent on reports journaled before
   * it was carried.
   */
  childThreadId: Schema.optional(Schema.UUID),
  /** The offer's title: how the parent and its agent know the task. */
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_SIDE_TASK_TITLE_LENGTH)),
  outcome: SideTaskReportOutcome,
  /** The finished turn's reply, honestly truncated; absent on failure and cancellation. */
  text: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_SIDE_TASK_REPORT_TEXT_LENGTH)),
  ),
  /** True when the reply was cut to fit; the report says so rather than pretending completeness. */
  truncated: Schema.optional(Schema.Literal(true)),
  endedAt: UtcTimestamp,
  owedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskReportOwed = typeof SideTaskReportOwed.Type;

/**
 * The reports these ids name entered the parent as a delivery turn. One event
 * covers a coalesced delivery: several owed reports may share one turn, each
 * honestly labelled, and nothing is marked delivered that was not in it.
 */
export const SideTaskReportDelivered = Schema.Struct({
  reportIds: Schema.Array(Schema.UUID).pipe(Schema.minItems(1)),
  deliveredAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskReportDelivered = typeof SideTaskReportDelivered.Type;

/**
 * The reports these ids name can never reach their parent: the parent is gone
 * or refuses the delivery for good. Settled honestly rather than retried
 * forever and never silently dropped — the refusal is journaled with why.
 */
export const SideTaskReportRefused = Schema.Struct({
  reportIds: Schema.Array(Schema.UUID).pipe(Schema.minItems(1)),
  detail: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  refusedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskReportRefused = typeof SideTaskReportRefused.Type;

/** The person asked the child to stop reporting; new turns in it owe nothing. */
export const SideTaskReportingStopped = Schema.Struct({
  stoppedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskReportingStopped = typeof SideTaskReportingStopped.Type;

export const SideTaskReportingResumed = Schema.Struct({
  resumedAt: UtcTimestamp,
}).annotations(strict);
export type SideTaskReportingResumed = typeof SideTaskReportingResumed.Type;

export const decodeSideTaskReportOwed = Schema.decodeUnknownSync(SideTaskReportOwed);
export const decodeSideTaskReportDelivered = Schema.decodeUnknownSync(SideTaskReportDelivered);
export const decodeSideTaskReportRefused = Schema.decodeUnknownSync(SideTaskReportRefused);
export const decodeSideTaskReportingStopped = Schema.decodeUnknownSync(SideTaskReportingStopped);
export const decodeSideTaskReportingResumed = Schema.decodeUnknownSync(SideTaskReportingResumed);

/**
 * The idempotency mark a delivery turn carries when it entered the parent:
 * which reports it delivered, so replaying or retrying the admission never
 * mints a second turn. Mirrors the agent-result delivery mark but keyed by
 * report rather than run — a side-task child is a person-confirmed thread,
 * not a managed run, and the journal says so honestly.
 */
export const SideTaskReportDeliveryMark = Schema.Struct({
  kind: Schema.Literal("side-task-report"),
  reportIds: Schema.Array(Schema.UUID).pipe(Schema.minItems(1)),
}).annotations(strict);
export type SideTaskReportDeliveryMark = typeof SideTaskReportDeliveryMark.Type;

/** What a journaled delivery turn may carry as its idempotency mark. */
export const ThreadDeliveryMark = Schema.Union(
  AgentRunResultDeliveryMark,
  SideTaskReportDeliveryMark,
);
export type ThreadDeliveryMark = typeof ThreadDeliveryMark.Type;
