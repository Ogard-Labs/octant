import { Schema } from "effect";
import {
  LINKED_THREAD_MAX_NESTING_DEPTH,
  LINKED_THREAD_NO_IMPLICIT_TRANSFERS,
  MAX_LINKED_THREAD_TARGETS,
  LinkedThreadContextSnapshotId,
  LinkedThreadCreationReceipt,
  LinkedThreadRequestFingerprint,
  LinkedThreadRequestId,
  LinkedThreadRoutingReceipt,
  LinkedThreadScope,
  LinkedThreadSourceThreadId,
  LinkedThreadTransferPolicy,
} from "./linkedThread";
import { LinkedThreadAggregate } from "./linkedThreadAggregation";
import { AgentRunAuthority } from "./agentRun";
import { AggregateVersion, EventActor, UtcTimestamp } from "./events";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const LinkedThreadPreviewId = brandedUuid("LinkedThreadPreviewId");
export type LinkedThreadPreviewId = typeof LinkedThreadPreviewId.Type;

export const LinkedThreadPromptText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8_000));
export type LinkedThreadPromptText = typeof LinkedThreadPromptText.Type;

export const LinkedThreadPromptDirective = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));
export type LinkedThreadPromptDirective = typeof LinkedThreadPromptDirective.Type;

export const LinkedThreadPromptReason = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024));
export type LinkedThreadPromptReason = typeof LinkedThreadPromptReason.Type;

export const LinkedThreadPromptLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));
export type LinkedThreadPromptLabel = typeof LinkedThreadPromptLabel.Type;

export const LinkedThreadRequestedCount = Schema.Int.pipe(
  Schema.positive(),
  Schema.lessThanOrEqualTo(MAX_LINKED_THREAD_TARGETS),
);
export type LinkedThreadRequestedCount = typeof LinkedThreadRequestedCount.Type;

/**
 * Structured prompt intent produced by the pure prompt parser. `prompt` is the
 * task instruction applied to every spawned thread with the multi-thread
 * directive removed; `matchedDirective` records the exact directive matched so
 * the preview can surface what drove the fan-out. The intent never selects a
 * route itself; routing and authority resolution stays server-authoritative.
 */
export const LinkedThreadPromptIntent = Schema.Struct({
  kind: Schema.Literal("spawn-linked-threads"),
  requestedCount: LinkedThreadRequestedCount,
  prompt: LinkedThreadPromptText,
  matchedDirective: LinkedThreadPromptDirective,
}).annotations(strict);
export type LinkedThreadPromptIntent = typeof LinkedThreadPromptIntent.Type;

export const LinkedThreadPreviewFallbackCandidate = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  rejectedReason: Schema.optional(LinkedThreadPromptReason),
}).annotations(strict);
export type LinkedThreadPreviewFallbackCandidate = typeof LinkedThreadPreviewFallbackCandidate.Type;

export const LinkedThreadPreviewSelectedFallback = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  reason: LinkedThreadPromptReason,
}).annotations(strict);
export type LinkedThreadPreviewSelectedFallback = typeof LinkedThreadPreviewSelectedFallback.Type;

/**
 * One planned linked thread in the preview. Carries its visible primary route,
 * capability-checked fallback candidates, capability degradations, and the
 * clamped effective authority. A selected fallback must differ from the
 * primary route so a preview can never silently collapse onto the same model.
 */
export const LinkedThreadPreviewThread = Schema.Struct({
  targetIndex: PositiveInt,
  label: LinkedThreadPromptLabel,
  prompt: LinkedThreadPromptText,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  effectiveAuthority: AgentRunAuthority,
  fallbackCandidates: Schema.Array(LinkedThreadPreviewFallbackCandidate).pipe(Schema.maxItems(8)),
  capabilityDegradations: Schema.Array(LinkedThreadPromptReason).pipe(Schema.maxItems(16)),
  selectedFallback: Schema.optional(LinkedThreadPreviewSelectedFallback),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (thread) =>
        thread.selectedFallback === undefined ||
        thread.selectedFallback.providerInstanceId !== thread.providerInstanceId ||
        thread.selectedFallback.modelId !== thread.modelId,
    ),
  );
export type LinkedThreadPreviewThread = typeof LinkedThreadPreviewThread.Type;

export const LinkedThreadPreviewStatus = Schema.Literal(
  "proposed",
  "confirmed",
  "denied",
  "expired",
);
export type LinkedThreadPreviewStatus = typeof LinkedThreadPreviewStatus.Type;

/**
 * Structured multi-thread creation preview. A `proposed` preview is inert:
 * creating nothing, carrying no thread ids, and recording only the bounded
 * plan plus the explicit no-implicit-transfer policy. The server requires an
 * explicit confirmation (a distinct command) before any thread is created, and
 * a confirmed or denied preview never reverts to `proposed`.
 */
export const LinkedThreadPreview = Schema.Struct({
  previewId: LinkedThreadPreviewId,
  requestId: LinkedThreadRequestId,
  requestFingerprint: LinkedThreadRequestFingerprint,
  prompt: LinkedThreadPromptText,
  matchedDirective: LinkedThreadPromptDirective,
  sourceThreadId: LinkedThreadSourceThreadId,
  sourceScope: LinkedThreadScope,
  sourceVersion: AggregateVersion,
  contextSnapshotId: LinkedThreadContextSnapshotId,
  targetScope: LinkedThreadScope,
  requestedCount: LinkedThreadRequestedCount,
  threads: Schema.Array(LinkedThreadPreviewThread).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_LINKED_THREAD_TARGETS),
  ),
  requestedAuthority: AgentRunAuthority,
  effectiveAuthority: AgentRunAuthority,
  routingReceipt: LinkedThreadRoutingReceipt,
  transferPolicy: LinkedThreadTransferPolicy,
  status: LinkedThreadPreviewStatus,
  nestingDepth: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(LINKED_THREAD_MAX_NESTING_DEPTH),
  ),
  proposedBy: EventActor,
  proposedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  decidedAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
})
  .annotations(strict)
  .pipe(
    Schema.filter((entry) => {
      const indices = entry.threads.map((thread) => thread.targetIndex);
      if (
        new Set(indices).size !== indices.length ||
        indices.some((index) => index < 1 || index > entry.requestedCount)
      ) {
        return false;
      }
      if (entry.threads.length !== entry.requestedCount) return false;
      if (entry.routingReceipt.contextSnapshotId !== entry.contextSnapshotId) return false;
      if (entry.routingReceipt.hostId !== entry.targetScope.hostId) return false;
      if (entry.routingReceipt.mode !== entry.targetScope.mode) return false;
      if (entry.proposedAt >= entry.expiresAt) return false;
      if (entry.status === "proposed" && entry.decidedAt !== undefined) return false;
      if (entry.status !== "proposed" && entry.decidedAt === undefined) return false;
      return true;
    }),
  );
export type LinkedThreadPreview = typeof LinkedThreadPreview.Type;

/**
 * Renderer request to preview a prompt-driven multi-thread fan-out. The server
 * parses the prompt, resolves a capability-checked route, and returns a
 * structured preview with no side effects. The request carries no target
 * thread ids and no receipt semantics; those belong to creation.
 */
export const LinkedThreadPromptPreviewCommand = Schema.Struct({
  kind: Schema.Literal("linked-thread-prompt-preview"),
  requestId: LinkedThreadRequestId,
  requestFingerprint: LinkedThreadRequestFingerprint,
  prompt: LinkedThreadPromptText,
  sourceThreadId: LinkedThreadSourceThreadId,
  sourceScope: LinkedThreadScope,
  sourceVersion: AggregateVersion,
  contextSnapshotId: LinkedThreadContextSnapshotId,
  targetScope: LinkedThreadScope,
  requestedAuthority: AgentRunAuthority,
  requestedModelId: Schema.optional(ProviderModelId),
  requestedProviderInstanceId: Schema.optional(ProviderInstanceId),
  nestingDepth: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(LINKED_THREAD_MAX_NESTING_DEPTH),
  ),
}).annotations(strict);
export type LinkedThreadPromptPreviewCommand = typeof LinkedThreadPromptPreviewCommand.Type;

/**
 * Explicit user confirmation. `confirmed` is structurally `true`; the server
 * only creates linked threads through the creation gateway after this command
 * validates against the exact proposed preview.
 */
export const LinkedThreadPreviewConfirmCommand = Schema.Struct({
  kind: Schema.Literal("confirm-linked-thread-preview"),
  previewId: LinkedThreadPreviewId,
  expectedVersion: AggregateVersion,
  confirmed: Schema.Literal(true),
}).annotations(strict);
export type LinkedThreadPreviewConfirmCommand = typeof LinkedThreadPreviewConfirmCommand.Type;

/**
 * Explicit user denial. Denying a preview creates nothing and permanently
 * closes the proposal.
 */
export const LinkedThreadPreviewDenyCommand = Schema.Struct({
  kind: Schema.Literal("deny-linked-thread-preview"),
  previewId: LinkedThreadPreviewId,
  expectedVersion: AggregateVersion,
  denied: Schema.Literal(true),
}).annotations(strict);
export type LinkedThreadPreviewDenyCommand = typeof LinkedThreadPreviewDenyCommand.Type;

export const LinkedThreadPreviewCommand = Schema.Union(
  LinkedThreadPromptPreviewCommand,
  LinkedThreadPreviewConfirmCommand,
  LinkedThreadPreviewDenyCommand,
);
export type LinkedThreadPreviewCommand = typeof LinkedThreadPreviewCommand.Type;

/**
 * Server reply to a prompt preview request. `ready` exposes the structured
 * preview; `limited` exposes it with a visible notice that a capability-checked
 * fallback or clamp was applied; `unsupported` means the prompt did not request
 * multi-thread creation; `denied` means no capability-checked non-privileged
 * route exists and no thread was created; `unavailable` and `unauthorized` fail
 * closed without side effects.
 */
export const LinkedThreadPreviewOutcome = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("ready"), preview: LinkedThreadPreview })
    .annotations(strict)
    .pipe(Schema.filter((outcome) => outcome.preview.status === "proposed")),
  Schema.Struct({
    kind: Schema.Literal("limited"),
    preview: LinkedThreadPreview,
    notice: LinkedThreadPromptReason,
  })
    .annotations(strict)
    .pipe(Schema.filter((outcome) => outcome.preview.status === "proposed")),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    reason: LinkedThreadPromptReason,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("denied"), reason: LinkedThreadPromptReason }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: LinkedThreadPromptReason,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unauthorized") }).annotations(strict),
);
export type LinkedThreadPreviewOutcome = typeof LinkedThreadPreviewOutcome.Type;

/**
 * Server reply to a confirmation or denial command. `confirmed` carries the
 * authoritative creation receipt produced by the narrow creation gateway;
 * `denied` and `expired` confirm no threads were created.
 */
export const LinkedThreadPreviewCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("linked-thread-preview-proposed"),
    preview: LinkedThreadPreview,
  })
    .annotations(strict)
    .pipe(Schema.filter((result) => result.preview.status === "proposed")),
  Schema.Struct({
    kind: Schema.Literal("linked-thread-preview-confirmed"),
    preview: LinkedThreadPreview,
    receipt: LinkedThreadCreationReceipt,
    aggregate: LinkedThreadAggregate,
  })
    .annotations(strict)
    .pipe(Schema.filter((result) => result.preview.status === "confirmed")),
  Schema.Struct({
    kind: Schema.Literal("linked-thread-preview-denied"),
    preview: LinkedThreadPreview,
  })
    .annotations(strict)
    .pipe(Schema.filter((result) => result.preview.status === "denied")),
  Schema.Struct({
    kind: Schema.Literal("linked-thread-preview-expired"),
    preview: LinkedThreadPreview,
  })
    .annotations(strict)
    .pipe(Schema.filter((result) => result.preview.status === "expired")),
);
export type LinkedThreadPreviewCommandResult = typeof LinkedThreadPreviewCommandResult.Type;

export const LinkedThreadPreviewFailureCode = Schema.Literal(
  "invalid",
  "unauthorized",
  "stale",
  "not-found",
  "unsupported",
  "conflict",
  "unavailable",
);
export type LinkedThreadPreviewFailureCode = typeof LinkedThreadPreviewFailureCode.Type;

export const LinkedThreadPreviewFailure = Schema.Struct({
  code: LinkedThreadPreviewFailureCode,
  message: Schema.NonEmptyTrimmedString,
  retryAfterMs: Schema.optional(Schema.Int.pipe(Schema.positive())),
}).annotations(strict);
export type LinkedThreadPreviewFailure = typeof LinkedThreadPreviewFailure.Type;

/**
 * The only transfer policy a prompt-driven preview may propose. Spawned
 * threads never inherit approvals, credentials, authority, completion,
 * handles, roots, or worktrees without explicit scope change.
 */
export const LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS: LinkedThreadTransferPolicy =
  LINKED_THREAD_NO_IMPLICIT_TRANSFERS;

export const decodeLinkedThreadPreviewId = Schema.decodeUnknownSync(LinkedThreadPreviewId);
export const decodeLinkedThreadPromptIntent = Schema.decodeUnknownSync(LinkedThreadPromptIntent);
export const decodeLinkedThreadPromptPreviewCommand = Schema.decodeUnknownSync(
  LinkedThreadPromptPreviewCommand,
);
export const decodeLinkedThreadPreviewCommand = Schema.decodeUnknownSync(
  LinkedThreadPreviewCommand,
);
export const decodeLinkedThreadPreview = Schema.decodeUnknownSync(LinkedThreadPreview);
export const decodeLinkedThreadPreviewOutcome = Schema.decodeUnknownSync(
  LinkedThreadPreviewOutcome,
);
export const decodeLinkedThreadPreviewCommandResult = Schema.decodeUnknownSync(
  LinkedThreadPreviewCommandResult,
);
export const decodeLinkedThreadPreviewFailure = Schema.decodeUnknownSync(
  LinkedThreadPreviewFailure,
);
