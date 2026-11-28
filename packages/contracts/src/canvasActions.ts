import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AgentRunAuthority } from "./agentRun";
import { CanvasActor, CanvasBlockId, CanvasId, CanvasSourceId } from "./canvasIdentity";
import { CanvasCardSchemaVersion, CanvasOriginThreadId, CanvasWorkspaceScope } from "./canvasCards";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { CanvasActionBlock, CanvasActionReference, CanvasCommandId } from "./canvasActionBlock";

export * from "./canvasActionBlock";

const boundedNonEmptyText = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));

// ── Action execution (D2) ───────────────────────────────────────────────────
//
// D1 established the declarative action block and its command allowlist. D2
// executes an admitted action through ordinary Octant authority: the server
// reauthorizes the request against the immutable Canvas provenance, gates
// mutating commands that create user-visible threads behind an explicit
// approval, and journals an auditable receipt. Every wire shape here is
// versioned independently and mirrors the Canvas refresh (C2) lifecycle so an
// action request is idempotent, cancellable, and rebuildable after a reconnect
// or restart (design §7 Typed actions).

export const CANVAS_ACTION_MESSAGE_MAX_CHARS = 1_024;

const brandedActionUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const CanvasActionRequestId = brandedActionUuid("CanvasActionRequestId");
export type CanvasActionRequestId = typeof CanvasActionRequestId.Type;
/** Correlates a rendered approval decision with the request it authorizes. */
export const CanvasActionApprovalId = brandedActionUuid("CanvasActionApprovalId");
export type CanvasActionApprovalId = typeof CanvasActionApprovalId.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

// A renderer never mints authority: it forwards the approval decision the host
// obtained. Read-only commands are `not-required`; a mutating command that
// creates a user-visible thread must arrive `approved` before any side effect.
export const CanvasActionApproval = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-required") }),
  Schema.Struct({ kind: Schema.Literal("pending") }),
  Schema.Struct({
    kind: Schema.Literal("approved"),
    approvalId: CanvasActionApprovalId,
  }),
  Schema.Struct({ kind: Schema.Literal("denied") }),
]);
export type CanvasActionApproval = typeof CanvasActionApproval.Type;

export const CanvasActionRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-action"),
  requestId: CanvasActionRequestId,
  canvasId: CanvasId,
  /** The declarative block whose command is reauthorized before any effect. */
  block: CanvasActionBlock,
  /** Optimistic head the renderer observed; a stale value fails closed. */
  expectedSequence: PositiveInt,
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
  originThreadId: CanvasOriginThreadId,
  actor: CanvasActor,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.check(Schema.isMaxLength(200)),
  requestedAuthority: AgentRunAuthority,
  approval: CanvasActionApproval,
});
export type CanvasActionRequest = typeof CanvasActionRequest.Type;

export const CanvasActionCancelRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-action-cancel"),
  requestId: CanvasActionRequestId,
  canvasId: CanvasId,
  blockId: CanvasBlockId,
});
export type CanvasActionCancelRequest = typeof CanvasActionCancelRequest.Type;

/**
 * The classified authority a command carries, reported back on every receipt
 * so an audit can see whether an action was a read, a mutation, and whether it
 * was approval-gated.
 */
export const CanvasActionCapabilityReport = Schema.Struct({
  command: CanvasCommandId,
  effect: Schema.Literals(["read", "mutate"]),
  requiresApproval: Schema.Boolean,
});
export type CanvasActionCapabilityReport = typeof CanvasActionCapabilityReport.Type;

// The honest, typed record of what an executed command produced. Read commands
// surface an already-authorized navigation/selection; `request-refresh` and
// `propose-thread` are handed off to their own subsystems rather than faking a
// completed side effect here.
export const CanvasActionReport = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("source-opened"), sourceId: CanvasSourceId }),
  Schema.Struct({
    kind: Schema.Literal("opened"),
    reference: CanvasActionReference,
  }),
  Schema.Struct({
    kind: Schema.Literal("data-filtered"),
    target: CanvasBlockId,
    filterCount: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("selection-attached"),
    selectionCount: PositiveInt,
  }),
  Schema.Struct({ kind: Schema.Literal("refresh-requested"), canvasId: CanvasId }),
  Schema.Struct({
    kind: Schema.Literal("thread-proposed"),
    approvalId: CanvasActionApprovalId,
  }),
]);
export type CanvasActionReport = typeof CanvasActionReport.Type;

export const CanvasActionOutcome = Schema.Literals([
  "completed",
  "requested",
  "cancelled",
  "failed",
]);
export type CanvasActionOutcome = typeof CanvasActionOutcome.Type;

export const CanvasActionReceipt = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-action-receipt"),
  requestId: CanvasActionRequestId,
  canvasId: CanvasId,
  blockId: CanvasBlockId,
  capability: CanvasActionCapabilityReport,
  outcome: CanvasActionOutcome,
  report: Schema.optional(CanvasActionReport),
  completedAt: UtcTimestamp,
  recoveryReason: Schema.optional(boundedNonEmptyText(CANVAS_ACTION_MESSAGE_MAX_CHARS)),
});
export type CanvasActionReceipt = typeof CanvasActionReceipt.Type;

/** Durable journal payload for action idempotency and cancellation replay. */
export const CanvasActionReceiptRecorded = Schema.Struct({
  receipt: CanvasActionReceipt,
});
export type CanvasActionReceiptRecorded = typeof CanvasActionReceiptRecorded.Type;

export const CANVAS_ACTION_RECEIPT_RECORDED = "canvas.action-receipt-recorded@1";

export const CanvasActionDenialCode = Schema.Literals([
  "malformed-request",
  "unavailable",
  "unauthorized",
  "scope-mismatch",
  "mode-mismatch",
  "origin-thread-mismatch",
  "stale-version",
  "revoked",
  "unknown-command",
  "unsupported-schema",
  "approval-required",
  "approval-denied",
  "cancelled",
]);
export type CanvasActionDenialCode = typeof CanvasActionDenialCode.Type;

export const CanvasActionResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("accepted"), receipt: CanvasActionReceipt }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasActionDenialCode,
    message: boundedNonEmptyText(CANVAS_ACTION_MESSAGE_MAX_CHARS),
  }),
]);
export type CanvasActionResult = typeof CanvasActionResult.Type;

export const decodeCanvasActionRequestId = Schema.decodeUnknownSync(
  CanvasActionRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasActionRequest = Schema.decodeUnknownSync(
  CanvasActionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasActionCancelRequest = Schema.decodeUnknownSync(
  CanvasActionCancelRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasActionReceipt = Schema.decodeUnknownSync(
  CanvasActionReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasActionReceiptRecorded = Schema.decodeUnknownSync(
  CanvasActionReceiptRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasActionResult = Schema.decodeUnknownSync(
  CanvasActionResult,
  STRICT_DECODE_OPTIONS,
);
