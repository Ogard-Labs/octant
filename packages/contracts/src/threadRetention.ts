import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const ConfirmedBoolean = Schema.Boolean.check(Schema.makeFilter((value) => value === true));
const PositiveDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_650 }));

/**
 * Data-lifecycle retention and purge for Chat, Work, and Code threads.
 *
 * Setting a window never deletes. A purge requires `confirm: true` and reports
 * exactly which scopes it removed and which it retained.
 */

export const ThreadRetentionThreadId = brandedUuid("ThreadRetentionThreadId");
export type ThreadRetentionThreadId = typeof ThreadRetentionThreadId.Type;

export const RetentionWindow = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("forever") }),
  Schema.Struct({
    kind: Schema.Literal("duration-days"),
    days: PositiveDays,
  }),
]);
export type RetentionWindow = typeof RetentionWindow.Type;

export const RetentionScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("host") }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    mode: OctantMode,
    threadId: ThreadRetentionThreadId,
  }),
]);
export type RetentionScope = typeof RetentionScope.Type;

export const ThreadRetentionWindowEntry = Schema.Struct({
  scope: RetentionScope,
  window: RetentionWindow,
  updatedAt: UtcTimestamp,
  version: AggregateVersion,
});
export type ThreadRetentionWindowEntry = typeof ThreadRetentionWindowEntry.Type;

export const ThreadPurgeTombstone = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
  projectId: Schema.optional(ProjectId),
  purgedAt: UtcTimestamp,
});
export type ThreadPurgeTombstone = typeof ThreadPurgeTombstone.Type;

export const ThreadRetentionState = Schema.Struct({
  windows: Schema.Array(ThreadRetentionWindowEntry).check(Schema.isMaxLength(4_096)),
  tombstones: Schema.Array(ThreadPurgeTombstone).check(Schema.isMaxLength(16_384)),
});
export type ThreadRetentionState = typeof ThreadRetentionState.Type;

export const SetThreadRetentionRequest = Schema.Struct({
  scope: RetentionScope,
  window: RetentionWindow,
});
export type SetThreadRetentionRequest = typeof SetThreadRetentionRequest.Type;

export const PurgeThreadsRequest = Schema.Struct({
  scope: RetentionScope,
  confirm: ConfirmedBoolean,
});
export type PurgeThreadsRequest = typeof PurgeThreadsRequest.Type;

export const ThreadRetentionDeletedScope = Schema.Literals([
  "thread-journal",
  "thread-projections",
  "thread-content",
  "thread-attachments",
  "thread-canvases",
  "thread-sessions",
  "managed-worktrees",
  "project-memory",
  "project-canvases",
]);
export type ThreadRetentionDeletedScope = typeof ThreadRetentionDeletedScope.Type;

export const ThreadRetentionRetainedScope = Schema.Literals([
  "host-identity",
  "store-schema",
  "other-threads",
  "projects",
  "usage-records",
  "purge-tombstone",
  "credentials",
  "external-repositories",
  "sqlite-free-pages",
]);
export type ThreadRetentionRetainedScope = typeof ThreadRetentionRetainedScope.Type;

/**
 * Scopes a purge de-linked rather than kept whole: the aggregates stay for
 * accounting while the purged thread's identity leaves them.
 */
export const ThreadRetentionDelinkedScope = Schema.Literal("usage-records");
export type ThreadRetentionDelinkedScope = typeof ThreadRetentionDelinkedScope.Type;

export const PurgedThreadRef = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
  projectId: Schema.optional(ProjectId),
});
export type PurgedThreadRef = typeof PurgedThreadRef.Type;

export const ThreadPurgeReport = Schema.Struct({
  operation: Schema.Literal("purge-threads"),
  scope: RetentionScope,
  purged: Schema.Array(PurgedThreadRef).check(Schema.isMaxLength(16_384)),
  alreadyPurged: Schema.Array(PurgedThreadRef).check(Schema.isMaxLength(16_384)),
  retained: Schema.Array(ThreadRetentionRetainedScope),
  delinked: Schema.Array(ThreadRetentionDelinkedScope),
  deleted: Schema.Array(ThreadRetentionDeletedScope),
  occurredAt: UtcTimestamp,
});
export type ThreadPurgeReport = typeof ThreadPurgeReport.Type;

export const ThreadRetentionRefusal = Schema.Struct({
  kind: Schema.Literal("refused"),
  reason: Schema.Literals([
    "confirmation-required",
    "unauthorized",
    "unknown-thread",
    "unknown-project",
    "invalid",
  ]),
  guidance: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
});
export type ThreadRetentionRefusal = typeof ThreadRetentionRefusal.Type;

export const SetThreadRetentionOutcome = Schema.Union([
  ThreadRetentionState,
  ThreadRetentionRefusal,
]);
export type SetThreadRetentionOutcome = typeof SetThreadRetentionOutcome.Type;

export const PurgeThreadsOutcome = Schema.Union([ThreadPurgeReport, ThreadRetentionRefusal]);
export type PurgeThreadsOutcome = typeof PurgeThreadsOutcome.Type;

export const ThreadRetentionWindowSet = Schema.Struct({
  kind: Schema.Literal("window-set"),
  scope: RetentionScope,
  window: RetentionWindow,
  updatedAt: UtcTimestamp,
});
export type ThreadRetentionWindowSet = typeof ThreadRetentionWindowSet.Type;

export const ThreadRetentionThreadPurged = Schema.Struct({
  kind: Schema.Literal("thread-purged"),
  mode: OctantMode,
  threadId: ThreadRetentionThreadId,
  projectId: Schema.optional(ProjectId),
  purgedAt: UtcTimestamp,
});
export type ThreadRetentionThreadPurged = typeof ThreadRetentionThreadPurged.Type;

export const THREAD_RETENTION_EVENT_NAMES = {
  windowSet: "thread-retention.window-set@1",
  threadPurged: "thread-retention.thread-purged@1",
} as const;

export const decodeRetentionWindow = Schema.decodeUnknownSync(
  RetentionWindow,
  STRICT_DECODE_OPTIONS,
);
export const decodeRetentionScope = Schema.decodeUnknownSync(RetentionScope, STRICT_DECODE_OPTIONS);
export const decodeThreadRetentionState = Schema.decodeUnknownSync(
  ThreadRetentionState,
  STRICT_DECODE_OPTIONS,
);
export const decodeSetThreadRetentionRequest = Schema.decodeUnknownSync(
  SetThreadRetentionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePurgeThreadsRequest = Schema.decodeUnknownSync(
  PurgeThreadsRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadPurgeReport = Schema.decodeUnknownSync(
  ThreadPurgeReport,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadRetentionRefusal = Schema.decodeUnknownSync(
  ThreadRetentionRefusal,
  STRICT_DECODE_OPTIONS,
);
export const decodeSetThreadRetentionOutcome = Schema.decodeUnknownSync(
  SetThreadRetentionOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodePurgeThreadsOutcome = Schema.decodeUnknownSync(
  PurgeThreadsOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadRetentionWindowSet = Schema.decodeUnknownSync(
  ThreadRetentionWindowSet,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadRetentionThreadPurged = Schema.decodeUnknownSync(
  ThreadRetentionThreadPurged,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadRetentionThreadId = Schema.decodeUnknownSync(
  ThreadRetentionThreadId,
  STRICT_DECODE_OPTIONS,
);
