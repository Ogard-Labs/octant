/**
 * Where a native-harness model call goes.
 *
 * Routing is configured by slot, not by job. A slot is an ordered list of
 * candidates, primary first, and every job the harness performs names one
 * slot. One configuration change therefore fixes every job on that slot, and
 * the slot vocabulary stays small while jobs multiply.
 *
 * Nothing here grants anything. A slot entry is a preference the server
 * filters through the same clamps as any other routing — mixed-vendor policy,
 * spend ceilings, parent and mode authority — before a call or a fallback, so
 * a list entry never widens what routing policy allows. Every decision the
 * resolver makes is journaled as a `NativeHarnessRouteDecision`; a model switch
 * is never silent.
 */

import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { MultiModelCandidateRejectionReason } from "./multiModelPool";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Same ceiling as a multi-model pool: these are the same candidate lists. */
export const MAX_NATIVE_HARNESS_SLOT_CANDIDATES = 16;
export const MAX_NATIVE_HARNESS_SLOTS = 32;

export const NATIVE_HARNESS_BUILT_IN_SLOT_IDS = [
  "default",
  "plan",
  "slow",
  "task",
  "smol",
  "vision",
  "advisor",
] as const;

export const NativeHarnessSlotId = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]{0,63}$/),
  Schema.brand("NativeHarnessSlotId"),
);
export type NativeHarnessSlotId = typeof NativeHarnessSlotId.Type;

const slotId = Schema.decodeSync(NativeHarnessSlotId);

export const NATIVE_HARNESS_BUILT_IN_SLOTS = {
  default: slotId("default"),
  plan: slotId("plan"),
  slow: slotId("slow"),
  task: slotId("task"),
  smol: slotId("smol"),
  vision: slotId("vision"),
  advisor: slotId("advisor"),
} as const satisfies Record<(typeof NATIVE_HARNESS_BUILT_IN_SLOT_IDS)[number], NativeHarnessSlotId>;

/**
 * The kinds of model call the harness makes. Jobs resolve to slots through an
 * editable mapping; a new job reuses an existing slot rather than growing the
 * configuration.
 */
export const NativeHarnessJob = Schema.Literal(
  "lead",
  "planner",
  "explorer",
  "researcher",
  "implementer",
  "reviewer",
  "title",
  "summary",
  "compaction",
  "image-understanding",
  "advisor",
  "custom",
);
export type NativeHarnessJob = typeof NativeHarnessJob.Type;

export const NativeHarnessSlotCandidate = Schema.Struct({
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  reasoning: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
}).annotations(strict);
export type NativeHarnessSlotCandidate = typeof NativeHarnessSlotCandidate.Type;

export function nativeHarnessSlotCandidateKey(candidate: NativeHarnessSlotCandidate): string {
  return `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
}

function uniqueCandidates(candidates: ReadonlyArray<NativeHarnessSlotCandidate>): boolean {
  return new Set(candidates.map(nativeHarnessSlotCandidateKey)).size === candidates.length;
}

/**
 * An ordered candidate list. The first entry is the primary; the rest are
 * failure fallbacks. `overflowPromotion` is the one explicitly configured
 * larger-context model an oversized request promotes to; it is never walked by
 * the failure chain, because same-sized siblings fail an overflow identically.
 */
export const NativeHarnessSlot = Schema.Struct({
  id: NativeHarnessSlotId,
  candidates: Schema.Array(NativeHarnessSlotCandidate).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_NATIVE_HARNESS_SLOT_CANDIDATES),
    Schema.filter(uniqueCandidates),
  ),
  overflowPromotion: Schema.optional(NativeHarnessSlotCandidate),
})
  .annotations(strict)
  // A promotion target that already sits in the chain has the same window as
  // the entry that overflowed, so it cannot be the answer to an overflow.
  .pipe(
    Schema.filter(
      (slot) =>
        slot.overflowPromotion === undefined ||
        !slot.candidates.some(
          (candidate) =>
            nativeHarnessSlotCandidateKey(candidate) ===
            nativeHarnessSlotCandidateKey(slot.overflowPromotion!),
        ),
    ),
  );
export type NativeHarnessSlot = typeof NativeHarnessSlot.Type;

export const NativeHarnessSlotTable = Schema.Array(NativeHarnessSlot).pipe(
  Schema.maxItems(MAX_NATIVE_HARNESS_SLOTS),
  Schema.filter((slots) => new Set(slots.map((slot) => slot.id)).size === slots.length),
);
export type NativeHarnessSlotTable = typeof NativeHarnessSlotTable.Type;

export const NativeHarnessJobSlotBinding = Schema.Struct({
  job: NativeHarnessJob,
  slotId: NativeHarnessSlotId,
}).annotations(strict);
export type NativeHarnessJobSlotBinding = typeof NativeHarnessJobSlotBinding.Type;

export const NativeHarnessJobSlotMap = Schema.Array(NativeHarnessJobSlotBinding).pipe(
  Schema.filter(
    (bindings) => new Set(bindings.map((binding) => binding.job)).size === bindings.length,
  ),
);
export type NativeHarnessJobSlotMap = typeof NativeHarnessJobSlotMap.Type;

/**
 * A binding may name a slot the table does not configure. That is not a
 * configuration error: resolution routes the job to `default` and journals an
 * `unconfigured-slot` decision so the warning is visible where it matters.
 */
export const NativeHarnessRoutingConfiguration = Schema.Struct({
  slots: NativeHarnessSlotTable,
  jobSlots: NativeHarnessJobSlotMap,
}).annotations(strict);
export type NativeHarnessRoutingConfiguration = typeof NativeHarnessRoutingConfiguration.Type;

export const DEFAULT_NATIVE_HARNESS_JOB_SLOTS: ReadonlyArray<NativeHarnessJobSlotBinding> = [
  { job: "lead", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.default },
  { job: "planner", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.plan },
  { job: "explorer", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.task },
  { job: "researcher", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.task },
  { job: "implementer", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.default },
  { job: "reviewer", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.slow },
  { job: "title", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.smol },
  { job: "summary", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.smol },
  { job: "compaction", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.smol },
  { job: "image-understanding", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.vision },
  { job: "advisor", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.advisor },
  { job: "custom", slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.default },
];

/** The host default. A Project override may narrow it but never exceed it. */
export const NativeHarnessRoutingSettings = Schema.Struct({
  configuration: NativeHarnessRoutingConfiguration,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type NativeHarnessRoutingSettings = typeof NativeHarnessRoutingSettings.Type;

/**
 * A fresh host configures no slots. Every job still has a binding, so the
 * first resolution reports `unconfigured-slot` rather than failing silently
 * or inventing a vendor list.
 */
export const DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS: Omit<
  NativeHarnessRoutingSettings,
  "updatedAt"
> = {
  configuration: { slots: [], jobSlots: DEFAULT_NATIVE_HARNESS_JOB_SLOTS },
  version: 0 as AggregateVersion,
};

export const NativeHarnessProjectRoutingOverride = Schema.Struct({
  projectId: ProjectId,
  configuration: NativeHarnessRoutingConfiguration,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type NativeHarnessProjectRoutingOverride = typeof NativeHarnessProjectRoutingOverride.Type;

export const UpdateNativeHarnessRoutingSettings = Schema.Struct({
  configuration: NativeHarnessRoutingConfiguration,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type UpdateNativeHarnessRoutingSettings = typeof UpdateNativeHarnessRoutingSettings.Type;

export const NativeHarnessProjectRoutingCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("set-project-routing-override"),
    projectId: ProjectId,
    configuration: NativeHarnessRoutingConfiguration,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear-project-routing-override"),
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type NativeHarnessProjectRoutingCommand = typeof NativeHarnessProjectRoutingCommand.Type;

export const NativeHarnessRoutingCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("routing-settings"),
    settings: NativeHarnessRoutingSettings,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-routing-override"),
    override: NativeHarnessProjectRoutingOverride,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-routing-override-cleared"),
    projectId: ProjectId,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("routing-refused"),
    reason: Schema.Literal("stale-version", "not-authorized", "project-not-found", "not-a-subset"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type NativeHarnessRoutingCommandResult = typeof NativeHarnessRoutingCommandResult.Type;

/** What makes the failure chain step to the next candidate. */
export const NativeHarnessRouteFailureReason = Schema.Literal(
  "rate-limited",
  "endpoint-unavailable",
  "authentication-failed",
  "server-error",
  "timeout",
);
export type NativeHarnessRouteFailureReason = typeof NativeHarnessRouteFailureReason.Type;

export const NativeHarnessRejectedCandidate = Schema.Struct({
  candidate: NativeHarnessSlotCandidate,
  reasons: Schema.Array(MultiModelCandidateRejectionReason).pipe(Schema.minItems(1)),
}).annotations(strict);
export type NativeHarnessRejectedCandidate = typeof NativeHarnessRejectedCandidate.Type;

const RouteDecisionFields = {
  job: NativeHarnessJob,
  decidedAt: UtcTimestamp,
  /** Every candidate the clamps refused before this decision, with why. */
  rejected: Schema.Array(NativeHarnessRejectedCandidate),
} as const;

const PositiveTokens = Schema.Int.pipe(Schema.positive());

function differentCandidates(decision: {
  readonly candidate: NativeHarnessSlotCandidate;
  readonly from: NativeHarnessSlotCandidate;
}): boolean {
  return (
    nativeHarnessSlotCandidateKey(decision.candidate) !==
    nativeHarnessSlotCandidateKey(decision.from)
  );
}

/**
 * One journaled routing decision. The failure chain and overflow promotion
 * are separate kinds on purpose: an oversized request that walked the failure
 * chain would fail at full price on every same-sized entry.
 */
export const NativeHarnessRouteDecision = Schema.Union(
  Schema.Struct({
    ...RouteDecisionFields,
    kind: Schema.Literal("primary"),
    slotId: NativeHarnessSlotId,
    candidate: NativeHarnessSlotCandidate,
  }).annotations(strict),
  Schema.Struct({
    ...RouteDecisionFields,
    kind: Schema.Literal("failure-fallback"),
    slotId: NativeHarnessSlotId,
    candidate: NativeHarnessSlotCandidate,
    from: NativeHarnessSlotCandidate,
    reason: NativeHarnessRouteFailureReason,
    /** When `from` may be tried again; the chain reverts to the primary then. */
    cooldownUntil: UtcTimestamp,
  })
    .annotations(strict)
    .pipe(Schema.filter(differentCandidates)),
  Schema.Struct({
    ...RouteDecisionFields,
    kind: Schema.Literal("reverted-to-primary"),
    slotId: NativeHarnessSlotId,
    candidate: NativeHarnessSlotCandidate,
    from: NativeHarnessSlotCandidate,
  })
    .annotations(strict)
    .pipe(Schema.filter(differentCandidates)),
  Schema.Struct({
    ...RouteDecisionFields,
    kind: Schema.Literal("overflow-promotion"),
    slotId: NativeHarnessSlotId,
    candidate: NativeHarnessSlotCandidate,
    from: NativeHarnessSlotCandidate,
    requiredTokens: PositiveTokens,
    windowTokens: PositiveTokens,
  })
    .annotations(strict)
    // Promotion is only honest when the request really did not fit.
    .pipe(
      Schema.filter(
        (decision) =>
          differentCandidates(decision) && decision.requiredTokens > decision.windowTokens,
      ),
    ),
  Schema.Struct({
    ...RouteDecisionFields,
    kind: Schema.Literal("unconfigured-slot"),
    requestedSlotId: NativeHarnessSlotId,
    slotId: NativeHarnessSlotId,
    candidate: NativeHarnessSlotCandidate,
  })
    .annotations(strict)
    // The only sanctioned fallback for a slot nobody configured is `default`;
    // a `default` with no ready candidate is an `unroutable` decision instead.
    .pipe(
      Schema.filter(
        (decision) =>
          decision.requestedSlotId !== decision.slotId && String(decision.slotId) === "default",
      ),
    ),
  Schema.Struct({
    ...RouteDecisionFields,
    kind: Schema.Literal("unroutable"),
    slotId: NativeHarnessSlotId,
    reason: Schema.Literal("no-eligible-candidate", "slot-empty", "circuit-open"),
  })
    .annotations(strict)
    // "No eligible candidate" is a claim about candidates that were seen.
    .pipe(
      Schema.filter(
        (decision) => decision.reason !== "no-eligible-candidate" || decision.rejected.length > 0,
      ),
    ),
);
export type NativeHarnessRouteDecision = typeof NativeHarnessRouteDecision.Type;

export const NATIVE_HARNESS_ROUTING_AGGREGATE_TYPE = "native-harness-routing";
export const NATIVE_HARNESS_ROUTING_EVENT_NAMES = {
  settingsUpdated: "native-harness-routing-settings-updated@1",
  projectOverrideSet: "native-harness-routing-project-override-set@1",
  projectOverrideCleared: "native-harness-routing-project-override-cleared@1",
} as const;

export const decodeNativeHarnessSlotId = Schema.decodeUnknownSync(NativeHarnessSlotId);
export const decodeNativeHarnessJob = Schema.decodeUnknownSync(NativeHarnessJob);
export const decodeNativeHarnessSlotCandidate = Schema.decodeUnknownSync(
  NativeHarnessSlotCandidate,
);
export const decodeNativeHarnessSlot = Schema.decodeUnknownSync(NativeHarnessSlot);
export const decodeNativeHarnessRoutingConfiguration = Schema.decodeUnknownSync(
  NativeHarnessRoutingConfiguration,
);
export const decodeNativeHarnessRoutingSettings = Schema.decodeUnknownSync(
  NativeHarnessRoutingSettings,
);
export const decodeNativeHarnessProjectRoutingOverride = Schema.decodeUnknownSync(
  NativeHarnessProjectRoutingOverride,
);
export const decodeUpdateNativeHarnessRoutingSettings = Schema.decodeUnknownSync(
  UpdateNativeHarnessRoutingSettings,
);
export const decodeNativeHarnessProjectRoutingCommand = Schema.decodeUnknownSync(
  NativeHarnessProjectRoutingCommand,
);
export const decodeNativeHarnessRoutingCommandResult = Schema.decodeUnknownSync(
  NativeHarnessRoutingCommandResult,
);
export const decodeNativeHarnessRouteDecision = Schema.decodeUnknownSync(
  NativeHarnessRouteDecision,
);
