import { Schema } from "effect";
import {
  CapacityReservation,
  ContextCapabilityCounts,
  ContextCompactionAvailability,
  ContextCompactionExecutor,
  ContextCompactionId,
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

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const ContextInspectorRequest = Schema.Struct({
  subject: ContextSubjectRef,
  afterSequence: Schema.optional(GlobalSequence),
}).annotations(strict);
export type ContextInspectorRequest = typeof ContextInspectorRequest.Type;

export const ContextPlanSnapshot = Schema.Struct({
  manifest: ContextManifest,
  plan: ContextPlan,
})
  .annotations(strict)
  .pipe(
    Schema.filter((value) => {
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
  displayLabel: Schema.NonEmptyTrimmedString,
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
})
  .annotations(strict)
  .pipe(
    Schema.filter((snapshot) => {
      const subjectMatches = (candidate: ContextSubjectRef) =>
        candidate.aggregateType === snapshot.subject.aggregateType &&
        candidate.aggregateId === snapshot.subject.aggregateId;
      const providerMatches = (providerInstanceId: string, modelId: string) =>
        providerInstanceId === snapshot.modelLimits.providerInstanceId &&
        modelId === snapshot.modelLimits.modelId;
      return (
        subjectMatches(snapshot.next.manifest.subject) &&
        providerMatches(
          snapshot.next.manifest.providerInstanceId,
          snapshot.next.manifest.modelId,
        ) &&
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

export const ContextInspectorResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: ContextInspectorSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("not-planned"),
    subject: ContextSubjectRef,
  }).annotations(strict),
);
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
  // Named only while the server offers compaction, so the confirm can say
  // where the conversation goes before the person agrees.
  executor: Schema.optional(ContextCompactionExecutor),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (state) =>
        (state.executor !== undefined) === (state.compaction.status === "available") &&
        (state.latestCompaction?.status !== "completed" ||
          (state.latestCompaction.receipt.subject.aggregateType === state.subject.aggregateType &&
            state.latestCompaction.receipt.subject.aggregateId === state.subject.aggregateId)),
    ),
  );
export type ContextCompactionState = typeof ContextCompactionState.Type;

export const ContextCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("update-context-overrides"),
    subject: ContextSubjectRef,
    expectedManifestId: ContextManifestId,
    overrides: ContextTurnOverrides,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rebuild-context-plan"),
    subject: ContextSubjectRef,
    expectedManifestId: ContextManifestId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("compact-session"),
    subject: ContextSubjectRef,
    // Chosen by the window when the person confirms. Repeating it returns the
    // same compaction rather than compacting twice.
    compactionId: ContextCompactionId,
  }).annotations(strict),
);
export type ContextCommand = typeof ContextCommand.Type;

export const ContextCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("context-updated"),
    snapshot: ContextInspectorSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("context-rebuilt"),
    snapshot: ContextInspectorSnapshot,
  }).annotations(strict),
  // A compaction is a model call that can outlast the request, so the command
  // answers once it is journaled and the receipt follows on the thread.
  Schema.Struct({
    kind: Schema.Literal("compaction-started"),
    compactionId: ContextCompactionId,
    executor: ContextCompactionExecutor,
  }).annotations(strict),
);
export type ContextCommandResult = typeof ContextCommandResult.Type;

export const ContextFailure = Schema.Struct({
  category: Schema.Literal(
    "unauthorized",
    "stale",
    "invalid",
    "unavailable",
    "blocked",
    // A subject nothing has planned yet is not a failed service. Collapsing the
    // two told a reader to retry a connection that was never down.
    "not-planned",
    "compaction-refused",
  ),
  message: Schema.NonEmptyTrimmedString,
  reason: Schema.optional(ContextCompactionRefusalReason),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (failure) => (failure.category === "compaction-refused") === (failure.reason !== undefined),
    ),
  );
export type ContextFailure = typeof ContextFailure.Type;

export const decodeContextInspectorRequest = Schema.decodeUnknownSync(ContextInspectorRequest);
export const decodeContextPlanSnapshot = Schema.decodeUnknownSync(ContextPlanSnapshot);
export const decodeContextCapabilityCounts = Schema.decodeUnknownSync(ContextCapabilityCounts);
export const decodeContextInspectorSnapshot = Schema.decodeUnknownSync(ContextInspectorSnapshot);
export function decodeContextInspectorResult(input: unknown): ContextInspectorResult {
  if (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    (input as { kind?: unknown }).kind === "not-planned"
  ) {
    return Schema.decodeUnknownSync(ContextInspectorResult)(input);
  }
  if (typeof input === "object" && input !== null && "kind" in input) {
    return Schema.decodeUnknownSync(ContextInspectorResult)(input);
  }
  return { kind: "snapshot", snapshot: decodeContextInspectorSnapshot(input) };
}
export const decodeContextCommand = Schema.decodeUnknownSync(ContextCommand);
export const decodeContextCommandResult = Schema.decodeUnknownSync(ContextCommandResult);
export const decodeContextFailure = Schema.decodeUnknownSync(ContextFailure);
export const decodeContextCompactionState = Schema.decodeUnknownSync(ContextCompactionState);

export { ContextCapabilityCounts } from "./context";
