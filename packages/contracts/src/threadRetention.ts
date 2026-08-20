import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const ConfirmedBoolean = Schema.Boolean.pipe(Schema.filter((value) => value === true));
const PositiveDays = Schema.Int.pipe(Schema.between(1, 3_650));

/**
 * Data-lifecycle retention and purge for Chat, Work, and Code threads.
 *
 * Setting a window never deletes. A purge requires `confirm: true` and reports
 * exactly which scopes it removed and which it retained.
 */

export const ThreadRetentionThreadId = brandedUuid("ThreadRetentionThreadId");
export type ThreadRetentionThreadId = typeof ThreadRetentionThreadId.Type;

export const RetentionWindow = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("forever") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("duration-days"),
    days: PositiveDays,
  }).annotations(strict),
);
export type RetentionWindow = typeof RetentionWindow.Type;

export const DEFAULT_RETENTION_WINDOW: RetentionWindow = { kind: "forever" };

export const RetentionScope = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("host") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    mode: OctantMode,
    threadId: ThreadRetentionThreadId,
  }).annotations(strict),
);
export type RetentionScope = typeof RetentionScope.Type;

export const ThreadRetentionWindowEntry = Schema.Struct({
  scope: RetentionScope,
  window: RetentionWindow,
  updatedAt: UtcTimestamp,
  version: AggregateVersion,
}).annotations(strict);
export type ThreadRetentionWindowEntry = typeof ThreadRetentionWindowEntry.Type;

export const ThreadPurgeTombstone = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
  projectId: Schema.optional(ProjectId),
  purgedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadPurgeTombstone = typeof ThreadPurgeTombstone.Type;

export const ThreadRetentionState = Schema.Struct({
  windows: Schema.Array(ThreadRetentionWindowEntry).pipe(Schema.maxItems(4_096)),
  tombstones: Schema.Array(ThreadPurgeTombstone).pipe(Schema.maxItems(16_384)),
}).annotations(strict);
export type ThreadRetentionState = typeof ThreadRetentionState.Type;

export const SetThreadRetentionRequest = Schema.Struct({
  scope: RetentionScope,
  window: RetentionWindow,
}).annotations(strict);
export type SetThreadRetentionRequest = typeof SetThreadRetentionRequest.Type;

export const PurgeThreadsRequest = Schema.Struct({
  scope: RetentionScope,
  confirm: ConfirmedBoolean,
}).annotations(strict);
export type PurgeThreadsRequest = typeof PurgeThreadsRequest.Type;

export const ThreadRetentionDeletedScope = Schema.Literal(
  "thread-journal",
  "thread-projections",
  "thread-content",
  "thread-attachments",
);
export type ThreadRetentionDeletedScope = typeof ThreadRetentionDeletedScope.Type;

export const ThreadRetentionRetainedScope = Schema.Literal(
  "host-identity",
  "store-schema",
  "other-threads",
  "projects",
  "usage-records",
  "credentials",
  "external-repositories",
  "sqlite-free-pages",
);
export type ThreadRetentionRetainedScope = typeof ThreadRetentionRetainedScope.Type;

export const PurgedThreadRef = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
  projectId: Schema.optional(ProjectId),
}).annotations(strict);
export type PurgedThreadRef = typeof PurgedThreadRef.Type;

export const ThreadPurgeReport = Schema.Struct({
  operation: Schema.Literal("purge-threads"),
  scope: RetentionScope,
  purged: Schema.Array(PurgedThreadRef).pipe(Schema.maxItems(16_384)),
  alreadyPurged: Schema.Array(PurgedThreadRef).pipe(Schema.maxItems(16_384)),
  retained: Schema.Array(ThreadRetentionRetainedScope),
  deleted: Schema.Array(ThreadRetentionDeletedScope),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type ThreadPurgeReport = typeof ThreadPurgeReport.Type;

export const ThreadRetentionRefusal = Schema.Struct({
  kind: Schema.Literal("refused"),
  reason: Schema.Literal(
    "confirmation-required",
    "unauthorized",
    "unknown-thread",
    "unknown-project",
    "invalid",
  ),
  guidance: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
}).annotations(strict);
export type ThreadRetentionRefusal = typeof ThreadRetentionRefusal.Type;

export const SetThreadRetentionOutcome = Schema.Union(ThreadRetentionState, ThreadRetentionRefusal);
export type SetThreadRetentionOutcome = typeof SetThreadRetentionOutcome.Type;

export const PurgeThreadsOutcome = Schema.Union(ThreadPurgeReport, ThreadRetentionRefusal);
export type PurgeThreadsOutcome = typeof PurgeThreadsOutcome.Type;

export const ThreadRetentionWindowSet = Schema.Struct({
  kind: Schema.Literal("window-set"),
  scope: RetentionScope,
  window: RetentionWindow,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadRetentionWindowSet = typeof ThreadRetentionWindowSet.Type;

export const ThreadRetentionThreadPurged = Schema.Struct({
  kind: Schema.Literal("thread-purged"),
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
  projectId: Schema.optional(ProjectId),
  purgedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadRetentionThreadPurged = typeof ThreadRetentionThreadPurged.Type;

export const THREAD_RETENTION_EVENT_NAMES = {
  windowSet: "thread-retention.window-set@1",
  threadPurged: "thread-retention.thread-purged@1",
} as const;

export const decodeRetentionWindow = Schema.decodeUnknownSync(RetentionWindow);
export const decodeRetentionScope = Schema.decodeUnknownSync(RetentionScope);
export const decodeThreadRetentionState = Schema.decodeUnknownSync(ThreadRetentionState);
export const decodeSetThreadRetentionRequest = Schema.decodeUnknownSync(SetThreadRetentionRequest);
export const decodePurgeThreadsRequest = Schema.decodeUnknownSync(PurgeThreadsRequest);
export const decodeThreadPurgeReport = Schema.decodeUnknownSync(ThreadPurgeReport);
export const decodeThreadRetentionRefusal = Schema.decodeUnknownSync(ThreadRetentionRefusal);
export const decodeSetThreadRetentionOutcome = Schema.decodeUnknownSync(SetThreadRetentionOutcome);
export const decodePurgeThreadsOutcome = Schema.decodeUnknownSync(PurgeThreadsOutcome);
export const decodeThreadRetentionWindowSet = Schema.decodeUnknownSync(ThreadRetentionWindowSet);
export const decodeThreadRetentionThreadPurged = Schema.decodeUnknownSync(
  ThreadRetentionThreadPurged,
);
export const decodeThreadRetentionThreadId = Schema.decodeUnknownSync(ThreadRetentionThreadId);
