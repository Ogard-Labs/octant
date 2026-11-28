import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  LinkedThreadReceiptId,
  LinkedThreadRequestId,
  LinkedThreadSourceThreadId,
  LinkedThreadTargetThreadId,
  MAX_LINKED_THREAD_TARGETS,
} from "./linkedThread";
import { UtcTimestamp } from "./events";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const BoundedReferenceId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const BoundedReason = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024));
const BoundedLabel = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const SkillName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/),
  Schema.isMaxLength(64),
);
const LinkedThreadPreviewId = brandedUuid("LinkedThreadPreviewId");
const LinkedThreadRequestedCount = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_LINKED_THREAD_TARGETS),
);

export const LinkedThreadAggregateId = brandedUuid("LinkedThreadAggregateId");
export type LinkedThreadAggregateId = typeof LinkedThreadAggregateId.Type;

export const LinkedThreadTargetResultStatus = Schema.Literals([
  "created",
  "queued",
  "rejected",
  "failed",
]);
export type LinkedThreadTargetResultStatus = typeof LinkedThreadTargetResultStatus.Type;

export const LinkedThreadTargetResult = Schema.Struct({
  targetIndex: PositiveInt,
  label: BoundedLabel,
  status: LinkedThreadTargetResultStatus,
  threadId: Schema.optional(LinkedThreadTargetThreadId),
  resultRefId: Schema.optional(BoundedReferenceId),
  reason: Schema.optional(BoundedReason),
}).check(
  Schema.makeFilter((result) => {
    if (result.status === "created" && result.threadId === undefined) return false;
    if (
      (result.status === "rejected" || result.status === "failed") &&
      result.reason === undefined
    ) {
      return false;
    }
    return true;
  }),
);
export type LinkedThreadTargetResult = typeof LinkedThreadTargetResult.Type;

export const LinkedThreadAggregateStatus = Schema.Literals([
  "created",
  "queued",
  "partial",
  "rejected",
  "failed",
]);
export type LinkedThreadAggregateStatus = typeof LinkedThreadAggregateStatus.Type;

export const LinkedThreadAggregate = Schema.Struct({
  aggregateId: LinkedThreadAggregateId,
  requestId: LinkedThreadRequestId,
  receiptId: Schema.optional(LinkedThreadReceiptId),
  previewId: Schema.optional(LinkedThreadPreviewId),
  sourceThreadId: LinkedThreadSourceThreadId,
  skillName: Schema.optional(SkillName),
  requestedCount: LinkedThreadRequestedCount,
  status: LinkedThreadAggregateStatus,
  results: Schema.Array(LinkedThreadTargetResult).check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (results) => new Set(results.map((result) => result.targetIndex)).size === results.length,
    ),
  ),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).check(Schema.makeFilter((aggregate) => aggregate.results.length <= aggregate.requestedCount));
export type LinkedThreadAggregate = typeof LinkedThreadAggregate.Type;

export const LinkedThreadAggregateRecorded = Schema.Struct({
  aggregate: LinkedThreadAggregate,
});
export type LinkedThreadAggregateRecorded = typeof LinkedThreadAggregateRecorded.Type;

export const LINKED_THREAD_AGGREGATE_EVENT_NAMES = ["linked.thread-aggregate-recorded@1"] as const;
export type LinkedThreadAggregateEventName = (typeof LINKED_THREAD_AGGREGATE_EVENT_NAMES)[number];

export const decodeLinkedThreadAggregateId = Schema.decodeUnknownSync(
  LinkedThreadAggregateId,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadTargetResult = Schema.decodeUnknownSync(
  LinkedThreadTargetResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadAggregate = Schema.decodeUnknownSync(
  LinkedThreadAggregate,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadAggregateRecorded = Schema.decodeUnknownSync(
  LinkedThreadAggregateRecorded,
  STRICT_DECODE_OPTIONS,
);
