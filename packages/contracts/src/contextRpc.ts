import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  CapacityReservation,
  ContextCapabilityCounts,
  ContextCompactionAvailability,
  ContextCompactionExecutor,
  ContextCompactionId,
  ContextCompactionReceipt,
  ContextCompactionRecord,
  ContextCompactionRefusalReason,
  ContextManifest,
  ContextManifestId,
  ContextPlan,
  ContextSubjectRef,
  ContextSummary,
  ContextTurnOverrides,
  ModelContextLimits,
  ProviderServiceLimits,
  UsageReconciliation,
} from "./context";
import { GlobalSequence, UtcTimestamp } from "./events";

export const ContextInspectorRequest = Schema.Struct({
  subject: ContextSubjectRef,
  afterSequence: Schema.optional(GlobalSequence),
});
export type ContextInspectorRequest = typeof ContextInspectorRequest.Type;

export const ContextPlanSnapshot = Schema.Struct({
  manifest: ContextManifest,
  plan: ContextPlan,
}).check(
  Schema.makeFilter((value) => {
    const manifestEntryIds = new Set(value.manifest.entries.map((entry) => entry.id));
    const planEntryIds = value.plan.entries.map((entry) => entry.entryId);
    return (
      value.plan.manifestId === value.manifest.id &&
      (value.plan.inspection === undefined ||
        (value.plan.inspection.modelLimits.providerInstanceId ===
          value.manifest.providerInstanceId &&
          value.plan.inspection.modelLimits.modelId === value.manifest.modelId &&
          value.plan.inspection.serviceLimits.providerInstanceId ===
            value.manifest.providerInstanceId)) &&
      planEntryIds.length === manifestEntryIds.size &&
      new Set(planEntryIds).size === planEntryIds.length &&
      planEntryIds.every((entryId) => manifestEntryIds.has(entryId))
    );
  }),
);
export type ContextPlanSnapshot = typeof ContextPlanSnapshot.Type;

export const ContextInspectorSnapshot = Schema.Struct({
  subject: ContextSubjectRef,
  sequence: GlobalSequence,
  displayLabel: NonEmptyTrimmedString,
  snapshotAt: UtcTimestamp,
  modelLimits: ModelContextLimits,
  serviceLimits: ProviderServiceLimits,
  next: ContextPlanSnapshot,
  latestSent: Schema.optional(ContextPlanSnapshot),
  summaries: Schema.Array(ContextSummary),
  latestUsage: Schema.optional(UsageReconciliation),
  capacity: Schema.optional(CapacityReservation),
  capabilities: ContextCapabilityCounts,
  /** Whether the server offers compaction for this thread; the window never decides it. */
  compaction: Schema.optional(ContextCompactionAvailability),
  latestCompaction: Schema.optional(ContextCompactionRecord),
}).check(
  Schema.makeFilter((snapshot) => {
    const subjectMatches = (candidate: ContextSubjectRef) =>
      candidate.aggregateType === snapshot.subject.aggregateType &&
      candidate.aggregateId === snapshot.subject.aggregateId;
    const providerMatches = (providerInstanceId: string, modelId: string) =>
      providerInstanceId === snapshot.modelLimits.providerInstanceId &&
      modelId === snapshot.modelLimits.modelId;
    return (
      subjectMatches(snapshot.next.manifest.subject) &&
      providerMatches(snapshot.next.manifest.providerInstanceId, snapshot.next.manifest.modelId) &&
      snapshot.serviceLimits.providerInstanceId === snapshot.modelLimits.providerInstanceId &&
      (snapshot.latestSent === undefined ||
        (subjectMatches(snapshot.latestSent.manifest.subject) &&
          providerMatches(
            snapshot.latestSent.manifest.providerInstanceId,
            snapshot.latestSent.manifest.modelId,
          ))) &&
      (snapshot.latestUsage === undefined ||
        (snapshot.latestSent !== undefined &&
          snapshot.latestUsage.planId === snapshot.latestSent.plan.id &&
          providerMatches(
            snapshot.latestUsage.providerInstanceId,
            snapshot.latestUsage.modelId,
          ))) &&
      (snapshot.capacity === undefined ||
        (subjectMatches(snapshot.capacity.subject) &&
          providerMatches(snapshot.capacity.providerInstanceId, snapshot.capacity.modelId))) &&
      (snapshot.latestCompaction?.status !== "completed" ||
        subjectMatches(snapshot.latestCompaction.receipt.subject))
    );
  }),
);
export type ContextInspectorSnapshot = typeof ContextInspectorSnapshot.Type;

export const ContextInspectorResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: ContextInspectorSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("not-planned"),
    subject: ContextSubjectRef,
  }),
]);
export type ContextInspectorResult = typeof ContextInspectorResult.Type;

/**
 * What a window shows about compacting a thread: whether the server offers it
 * now, the thread's latest compaction, and who would compact it. Every thread
 * kind answers, including a Code thread, whose context the host never plans
 * and whose inspector read therefore answers `not-planned`.
 */
export const ContextCompactionState = Schema.Struct({
  subject: ContextSubjectRef,
  compaction: ContextCompactionAvailability,
  latestCompaction: Schema.optional(ContextCompactionRecord),
  // Every completed compaction, oldest first, so a window can mark each point
  // the session was compacted. Absent when the thread has had none.
  completedCompactions: Schema.optional(Schema.Array(ContextCompactionReceipt)),
  // Named only while the server offers compaction, so the confirm can say
  // where the conversation goes before the person agrees.
  executor: Schema.optional(ContextCompactionExecutor),
}).check(
  Schema.makeFilter(
    (state) =>
      (state.executor !== undefined) === (state.compaction.status === "available") &&
      (state.latestCompaction?.status !== "completed" ||
        (state.latestCompaction.receipt.subject.aggregateType === state.subject.aggregateType &&
          state.latestCompaction.receipt.subject.aggregateId === state.subject.aggregateId)) &&
      (state.completedCompactions ?? []).every(
        (receipt) =>
          receipt.subject.aggregateType === state.subject.aggregateType &&
          receipt.subject.aggregateId === state.subject.aggregateId,
      ),
  ),
);
export type ContextCompactionState = typeof ContextCompactionState.Type;

export const ContextCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("update-context-overrides"),
    subject: ContextSubjectRef,
    expectedManifestId: ContextManifestId,
    overrides: ContextTurnOverrides,
  }),
  Schema.Struct({
    kind: Schema.Literal("rebuild-context-plan"),
    subject: ContextSubjectRef,
    expectedManifestId: ContextManifestId,
  }),
  Schema.Struct({
    kind: Schema.Literal("compact-session"),
    subject: ContextSubjectRef,
    // Chosen by the window when the person confirms. Repeating it returns the
    // same compaction rather than compacting twice.
    compactionId: ContextCompactionId,
  }),
]);
export type ContextCommand = typeof ContextCommand.Type;

export const ContextCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("context-updated"),
    snapshot: ContextInspectorSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("context-rebuilt"),
    snapshot: ContextInspectorSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("compaction-started"),
    compactionId: ContextCompactionId,
    executor: ContextCompactionExecutor,
  }),
]);
export type ContextCommandResult = typeof ContextCommandResult.Type;

export const ContextFailure = Schema.Struct({
  category: Schema.Literals([
    "unauthorized",
    "stale",
    "invalid",
    "unavailable",
    "blocked",
    "not-planned",
    "compaction-refused",
  ]),
  message: NonEmptyTrimmedString,
  reason: Schema.optional(ContextCompactionRefusalReason),
}).check(
  Schema.makeFilter(
    (failure) => (failure.category === "compaction-refused") === (failure.reason !== undefined),
  ),
);
export type ContextFailure = typeof ContextFailure.Type;

export const decodeContextInspectorRequest = Schema.decodeUnknownSync(
  ContextInspectorRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextPlanSnapshot = Schema.decodeUnknownSync(
  ContextPlanSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextCapabilityCounts = Schema.decodeUnknownSync(
  ContextCapabilityCounts,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextInspectorSnapshot = Schema.decodeUnknownSync(
  ContextInspectorSnapshot,
  STRICT_DECODE_OPTIONS,
);
export function decodeContextInspectorResult(input: unknown): ContextInspectorResult {
  if (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    (input as { kind?: unknown }).kind === "not-planned"
  ) {
    return Schema.decodeUnknownSync(ContextInspectorResult, STRICT_DECODE_OPTIONS)(input);
  }
  if (typeof input === "object" && input !== null && "kind" in input) {
    return Schema.decodeUnknownSync(ContextInspectorResult, STRICT_DECODE_OPTIONS)(input);
  }
  return { kind: "snapshot", snapshot: decodeContextInspectorSnapshot(input) };
}
export const decodeContextCommand = Schema.decodeUnknownSync(ContextCommand, STRICT_DECODE_OPTIONS);
export const decodeContextCommandResult = Schema.decodeUnknownSync(
  ContextCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeContextFailure = Schema.decodeUnknownSync(ContextFailure, STRICT_DECODE_OPTIONS);
export const decodeContextCompactionState = Schema.decodeUnknownSync(
  ContextCompactionState,
  STRICT_DECODE_OPTIONS,
);

export { ContextCapabilityCounts } from "./context";
