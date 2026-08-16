import { Schema } from "effect";
import {
  CapacityReservation,
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
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

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
        planEntryIds.length === manifestEntryIds.size &&
        new Set(planEntryIds).size === planEntryIds.length &&
        planEntryIds.every((entryId) => manifestEntryIds.has(entryId))
      );
    }),
  );
export type ContextPlanSnapshot = typeof ContextPlanSnapshot.Type;

export const ContextCapabilityCounts = Schema.Struct({
  loadedTools: NonNegativeInt,
  availableTools: NonNegativeInt,
  loadedMcp: NonNegativeInt,
  availableMcp: NonNegativeInt,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (counts) =>
        counts.loadedTools <= counts.availableTools && counts.loadedMcp <= counts.availableMcp,
    ),
  );
export type ContextCapabilityCounts = typeof ContextCapabilityCounts.Type;

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
            providerMatches(snapshot.capacity.providerInstanceId, snapshot.capacity.modelId)))
      );
    }),
  );
export type ContextInspectorSnapshot = typeof ContextInspectorSnapshot.Type;

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
);
export type ContextCommandResult = typeof ContextCommandResult.Type;

export const ContextFailure = Schema.Struct({
  category: Schema.Literal("unauthorized", "stale", "invalid", "unavailable", "blocked"),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ContextFailure = typeof ContextFailure.Type;

export const decodeContextInspectorRequest = Schema.decodeUnknownSync(ContextInspectorRequest);
export const decodeContextPlanSnapshot = Schema.decodeUnknownSync(ContextPlanSnapshot);
export const decodeContextCapabilityCounts = Schema.decodeUnknownSync(ContextCapabilityCounts);
export const decodeContextInspectorSnapshot = Schema.decodeUnknownSync(ContextInspectorSnapshot);
export const decodeContextCommand = Schema.decodeUnknownSync(ContextCommand);
export const decodeContextCommandResult = Schema.decodeUnknownSync(ContextCommandResult);
export const decodeContextFailure = Schema.decodeUnknownSync(ContextFailure);
