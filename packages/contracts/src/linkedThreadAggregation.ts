import { Schema } from "effect";
import {
  LinkedThreadReceiptId,
  LinkedThreadRequestId,
  LinkedThreadSourceThreadId,
  LinkedThreadTargetThreadId,
  MAX_LINKED_THREAD_TARGETS,
} from "./linkedThread";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const BoundedReferenceId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));
const BoundedReason = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024));
const BoundedLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const SkillName = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]{0,63}$/),
  Schema.maxLength(64),
);
const LinkedThreadPreviewId = brandedUuid("LinkedThreadPreviewId");
const LinkedThreadRequestedCount = Schema.Int.pipe(
  Schema.positive(),
  Schema.lessThanOrEqualTo(MAX_LINKED_THREAD_TARGETS),
);

export const LinkedThreadAggregateId = brandedUuid("LinkedThreadAggregateId");
export type LinkedThreadAggregateId = typeof LinkedThreadAggregateId.Type;

export const LinkedThreadTargetResultStatus = Schema.Literal(
  "created",
  "queued",
  "rejected",
  "failed",
);
export type LinkedThreadTargetResultStatus = typeof LinkedThreadTargetResultStatus.Type;

export const LinkedThreadTargetResult = Schema.Struct({
  targetIndex: PositiveInt,
  label: BoundedLabel,
  status: LinkedThreadTargetResultStatus,
  threadId: Schema.optional(LinkedThreadTargetThreadId),
  resultRefId: Schema.optional(BoundedReferenceId),
  reason: Schema.optional(BoundedReason),
})
  .annotations(strict)
  .pipe(
    Schema.filter((result) => {
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

export const LinkedThreadAggregateStatus = Schema.Literal(
  "created",
  "queued",
  "partial",
  "rejected",
  "failed",
);
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
  results: Schema.Array(LinkedThreadTargetResult).pipe(
    Schema.minItems(1),
    Schema.filter(
      (results) => new Set(results.map((result) => result.targetIndex)).size === results.length,
    ),
  ),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((aggregate) => aggregate.results.length <= aggregate.requestedCount));
export type LinkedThreadAggregate = typeof LinkedThreadAggregate.Type;

export const LinkedThreadAggregateRecorded = Schema.Struct({
  aggregate: LinkedThreadAggregate,
}).annotations(strict);
export type LinkedThreadAggregateRecorded = typeof LinkedThreadAggregateRecorded.Type;

export const LINKED_THREAD_AGGREGATE_EVENT_NAMES = ["linked.thread-aggregate-recorded@1"] as const;
export type LinkedThreadAggregateEventName = (typeof LINKED_THREAD_AGGREGATE_EVENT_NAMES)[number];

export const decodeLinkedThreadAggregateId = Schema.decodeUnknownSync(LinkedThreadAggregateId);
export const decodeLinkedThreadTargetResult = Schema.decodeUnknownSync(LinkedThreadTargetResult);
export const decodeLinkedThreadAggregate = Schema.decodeUnknownSync(LinkedThreadAggregate);
export const decodeLinkedThreadAggregateRecorded = Schema.decodeUnknownSync(
  LinkedThreadAggregateRecorded,
);
