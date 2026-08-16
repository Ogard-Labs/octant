import { Schema } from "effect";
import { CorrelationId, EventActor, UtcTimestamp } from "./events";
import { ToolActionAuthority, ToolActionId, ToolApprovalId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const ComputerUseSessionId = brandedUuid("ComputerUseSessionId");
export type ComputerUseSessionId = typeof ComputerUseSessionId.Type;

export const ComputerUseActionKind = Schema.Literal(
  "click",
  "type-text",
  "key-press",
  "scroll",
  "screenshot",
  "observe-window",
  "move-cursor",
  "drag",
);
export type ComputerUseActionKind = typeof ComputerUseActionKind.Type;

export const ComputerUseActionVisibility = Schema.Literal("visible", "background");
export type ComputerUseActionVisibility = typeof ComputerUseActionVisibility.Type;

export const ComputerUseApprovalState = Schema.Literal(
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
);
export type ComputerUseApprovalState = typeof ComputerUseApprovalState.Type;

export const ComputerUseSensitiveFieldKind = Schema.Literal(
  "password",
  "credit-card",
  "ssn",
  "otp",
  "private-key",
  "api-key",
);
export type ComputerUseSensitiveFieldKind = typeof ComputerUseSensitiveFieldKind.Type;

export const ComputerUseAllowlistEntry = Schema.Struct({
  actionKind: ComputerUseActionKind,
  targetApp: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  requiresApproval: Schema.Boolean,
}).annotations(strict);
export type ComputerUseAllowlistEntry = typeof ComputerUseAllowlistEntry.Type;

export const ComputerUsePolicy = Schema.Struct({
  allowlist: Schema.Array(ComputerUseAllowlistEntry),
  sensitiveFieldProtection: Schema.Boolean,
  visibleStopControl: Schema.Boolean,
  maxSessionDurationMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(3_600_000)),
  processOwnershipRequired: Schema.Boolean,
}).annotations(strict);
export type ComputerUsePolicy = typeof ComputerUsePolicy.Type;

export const ComputerUseSessionState = Schema.Literal(
  "requesting-approval",
  "active",
  "waiting-for-approval",
  "running",
  "stopping",
  "stopped",
  "expired",
  "interrupted",
  "failed",
  "completed",
);
export type ComputerUseSessionState = typeof ComputerUseSessionState.Type;

export const ComputerUseSessionRecord = Schema.Struct({
  sessionId: ComputerUseSessionId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  policy: ComputerUsePolicy,
  state: ComputerUseSessionState,
  approvalId: Schema.optional(ToolApprovalId),
  createdAt: UtcTimestamp,
  stoppedAt: Schema.optional(UtcTimestamp),
  stopReason: Schema.optional(
    Schema.Literal("user-requested", "timeout", "authority-revoked", "shutdown", "error"),
  ),
}).annotations(strict);
export type ComputerUseSessionRecord = typeof ComputerUseSessionRecord.Type;

/** Action request for computer-use automation. The `target` field carries
 *  a selector string (e.g. Accessibility element identifier or CSS selector)
 *  resolved by the platform adapter. Pixel coordinates for click/move-cursor/drag
 *  are derived by the adapter from the selector at execution time, not provided
 *  in the contract. */
export const ComputerUseActionRequest = Schema.Struct({
  actionId: ToolActionId,
  sessionId: ComputerUseSessionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: ComputerUseActionKind,
  visibility: ComputerUseActionVisibility,
  target: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  value: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(65_536))),
}).annotations(strict);
export type ComputerUseActionRequest = typeof ComputerUseActionRequest.Type;

export const ComputerUseObservation = Schema.Struct({
  sessionId: ComputerUseSessionId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  windowTitle: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  appName: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  observedAt: UtcTimestamp,
  stale: Schema.Boolean,
}).annotations(strict);
export type ComputerUseObservation = typeof ComputerUseObservation.Type;

export const ComputerUseFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("approval-denied"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("session-expired"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("sensitive-field-protected"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("action-not-allowed"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type ComputerUseFailure = typeof ComputerUseFailure.Type;

export const ComputerUseRuntimeEventKind = Schema.Literal(
  "session-started",
  "observation-recorded",
  "approval-requested",
  "approval-approved",
  "approval-denied",
  "action-started",
  "action-completed",
  "stop-requested",
  "cleanup-completed",
  "cleanup-failed",
  "session-interrupted",
  "session-failed",
);
export type ComputerUseRuntimeEventKind = typeof ComputerUseRuntimeEventKind.Type;

export const ComputerUseRuntimeEvent = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.positive()),
  kind: ComputerUseRuntimeEventKind,
  occurredAt: UtcTimestamp,
  detail: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
}).annotations(strict);
export type ComputerUseRuntimeEvent = typeof ComputerUseRuntimeEvent.Type;

export const ComputerUsePendingApproval = Schema.Struct({
  approvalId: ToolApprovalId,
  actionId: ToolActionId,
  expiresAt: UtcTimestamp,
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);
export type ComputerUsePendingApproval = typeof ComputerUsePendingApproval.Type;

export const ComputerUseSessionView = Schema.Struct({
  sessionId: ComputerUseSessionId,
  threadId: Schema.UUID,
  requestedBy: EventActor,
  authority: ToolActionAuthority,
  state: ComputerUseSessionState,
  sequence: Schema.Int.pipe(Schema.nonNegative()),
  pendingApproval: Schema.optional(ComputerUsePendingApproval),
  events: Schema.Array(ComputerUseRuntimeEvent),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (view) =>
        view.events.length === view.sequence &&
        view.events.every((event, index) => event.sequence === index + 1) &&
        (view.state === "waiting-for-approval") === (view.pendingApproval !== undefined),
    ),
  );
export type ComputerUseSessionView = typeof ComputerUseSessionView.Type;

export const ComputerUseSessionList = Schema.Array(ComputerUseSessionView);
export type ComputerUseSessionList = typeof ComputerUseSessionList.Type;

export const ComputerUseSessionScope = Schema.Struct({
  sessionId: ComputerUseSessionId,
  threadId: Schema.UUID,
  authority: ToolActionAuthority,
}).annotations(strict);
export type ComputerUseSessionScope = typeof ComputerUseSessionScope.Type;

export const ComputerUseApprovalDecisionRequest = Schema.Struct({
  ...ComputerUseSessionScope.fields,
  actionId: ToolActionId,
  approvalId: ToolApprovalId,
  decision: Schema.Literal("approved", "denied"),
}).annotations(strict);
export type ComputerUseApprovalDecisionRequest = typeof ComputerUseApprovalDecisionRequest.Type;

export const ComputerUseStopRequest = ComputerUseSessionScope;
export type ComputerUseStopRequest = typeof ComputerUseStopRequest.Type;

export const decodeComputerUseSessionId = Schema.decodeUnknownSync(ComputerUseSessionId);
export const decodeComputerUseActionKind = Schema.decodeUnknownSync(ComputerUseActionKind);
export const decodeComputerUseApprovalState = Schema.decodeUnknownSync(ComputerUseApprovalState);
export const decodeComputerUsePolicy = Schema.decodeUnknownSync(ComputerUsePolicy);
export const decodeComputerUseSessionState = Schema.decodeUnknownSync(ComputerUseSessionState);
export const decodeComputerUseSessionRecord = Schema.decodeUnknownSync(ComputerUseSessionRecord);
export const decodeComputerUseActionRequest = Schema.decodeUnknownSync(ComputerUseActionRequest);
export const decodeComputerUseObservation = Schema.decodeUnknownSync(ComputerUseObservation);
export const decodeComputerUseFailure = Schema.decodeUnknownSync(ComputerUseFailure);
export const decodeComputerUseSensitiveFieldKind = Schema.decodeUnknownSync(
  ComputerUseSensitiveFieldKind,
);
export const decodeComputerUseRuntimeEvent = Schema.decodeUnknownSync(ComputerUseRuntimeEvent);
export const decodeComputerUsePendingApproval = Schema.decodeUnknownSync(
  ComputerUsePendingApproval,
);
export const decodeComputerUseSessionView = Schema.decodeUnknownSync(ComputerUseSessionView);
export const decodeComputerUseSessionList = Schema.decodeUnknownSync(ComputerUseSessionList);
export const decodeComputerUseSessionScope = Schema.decodeUnknownSync(ComputerUseSessionScope);
export const decodeComputerUseApprovalDecisionRequest = Schema.decodeUnknownSync(
  ComputerUseApprovalDecisionRequest,
);
export const decodeComputerUseStopRequest = Schema.decodeUnknownSync(ComputerUseStopRequest);
