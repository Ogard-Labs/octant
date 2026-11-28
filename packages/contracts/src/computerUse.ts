import { ApprovalOutsideContent } from "./contentProvenance";
import {
  GuidString,
  NonEmptyTrimmedString,
  NonNegativeInt,
  PositiveInt,
  STRICT_DECODE_OPTIONS,
} from "./schemaPrimitives";
import { personDecides } from "./hostAnswer";
import { Schema } from "effect";
import { CorrelationId, EventActor, UtcTimestamp } from "./events";
import { ToolActionAuthority, ToolActionId, ToolApprovalId } from "./toolActions";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const ComputerUseSessionId = brandedUuid("ComputerUseSessionId");
export type ComputerUseSessionId = typeof ComputerUseSessionId.Type;

export const ComputerUseActionKind = Schema.Literals([
  "click",
  "type-text",
  "key-press",
  "scroll",
  "screenshot",
  "observe-window",
  "move-cursor",
  "drag",
]);
export type ComputerUseActionKind = typeof ComputerUseActionKind.Type;

export const ComputerUseActionVisibility = Schema.Literals(["visible", "background"]);
export type ComputerUseActionVisibility = typeof ComputerUseActionVisibility.Type;

export const ComputerUseApprovalState = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type ComputerUseApprovalState = typeof ComputerUseApprovalState.Type;

export const ComputerUseSensitiveFieldKind = Schema.Literals([
  "password",
  "credit-card",
  "ssn",
  "otp",
  "private-key",
  "api-key",
]);
export type ComputerUseSensitiveFieldKind = typeof ComputerUseSensitiveFieldKind.Type;

export const ComputerUseAllowlistEntry = Schema.Struct({
  actionKind: ComputerUseActionKind,
  targetApp: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  requiresApproval: Schema.Boolean,
});
export type ComputerUseAllowlistEntry = typeof ComputerUseAllowlistEntry.Type;

export const ComputerUsePolicy = Schema.Struct({
  allowlist: Schema.Array(ComputerUseAllowlistEntry),
  sensitiveFieldProtection: Schema.Boolean,
  visibleStopControl: Schema.Boolean,
  maxSessionDurationMs: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(3_600_000),
  ),
  processOwnershipRequired: Schema.Boolean,
});
export type ComputerUsePolicy = typeof ComputerUsePolicy.Type;

export const ComputerUseSessionState = Schema.Literals([
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
]);
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
    Schema.Literals(["user-requested", "timeout", "authority-revoked", "shutdown", "error"]),
  ),
});
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
  target: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096))),
  value: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536))),
});
export type ComputerUseActionRequest = typeof ComputerUseActionRequest.Type;

export const ComputerUseObservation = Schema.Struct({
  sessionId: ComputerUseSessionId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  windowTitle: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
  appName: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  observedAt: UtcTimestamp,
  stale: Schema.Boolean,
});
export type ComputerUseObservation = typeof ComputerUseObservation.Type;

export const ComputerUseFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("approval-denied"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("session-expired"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("sensitive-field-protected"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("action-not-allowed"),
    message: NonEmptyTrimmedString,
  }),
]);
export type ComputerUseFailure = typeof ComputerUseFailure.Type;

export const ComputerUseRuntimeEventKind = Schema.Literals([
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
]);
export type ComputerUseRuntimeEventKind = typeof ComputerUseRuntimeEventKind.Type;

export const ComputerUseRuntimeEvent = Schema.Struct({
  sequence: PositiveInt,
  kind: ComputerUseRuntimeEventKind,
  occurredAt: UtcTimestamp,
  detail: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
});
export type ComputerUseRuntimeEvent = typeof ComputerUseRuntimeEvent.Type;

export const ComputerUsePendingApproval = Schema.Struct({
  approvalId: ToolApprovalId,
  actionId: ToolActionId,
  expiresAt: UtcTimestamp,
  summary: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  scope: Schema.optional(Schema.Literal("application-session")),
  /** Whether the person may remember this application grant for the thread's Project. */
  canRememberForProject: Schema.optional(Schema.Boolean),
  /** Present when the thread has taken in outside content; see `ApprovalOutsideContent`. */
  outsideContent: Schema.optional(ApprovalOutsideContent),
}).annotate(personDecides);
export type ComputerUsePendingApproval = typeof ComputerUsePendingApproval.Type;

export const ComputerUseSessionView = Schema.Struct({
  sessionId: ComputerUseSessionId,
  threadId: GuidString,
  requestedBy: EventActor,
  authority: ToolActionAuthority,
  state: ComputerUseSessionState,
  sequence: NonNegativeInt,
  pendingApproval: Schema.optional(ComputerUsePendingApproval),
  events: Schema.Array(ComputerUseRuntimeEvent),
}).check(
  Schema.makeFilter(
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
  threadId: GuidString,
  authority: ToolActionAuthority,
});
export type ComputerUseSessionScope = typeof ComputerUseSessionScope.Type;

export const ComputerUseApprovalDecisionRequest = Schema.Struct({
  ...ComputerUseSessionScope.fields,
  actionId: ToolActionId,
  approvalId: ToolApprovalId,
  decision: Schema.Literals(["approved", "denied"]),
  rememberForProject: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (request) => request.decision === "approved" || request.rememberForProject !== true,
  ),
);
export type ComputerUseApprovalDecisionRequest = typeof ComputerUseApprovalDecisionRequest.Type;

export const ComputerUseStopRequest = ComputerUseSessionScope;
export type ComputerUseStopRequest = typeof ComputerUseStopRequest.Type;

export const decodeComputerUseSessionId = Schema.decodeUnknownSync(
  ComputerUseSessionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseActionKind = Schema.decodeUnknownSync(
  ComputerUseActionKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseApprovalState = Schema.decodeUnknownSync(
  ComputerUseApprovalState,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUsePolicy = Schema.decodeUnknownSync(
  ComputerUsePolicy,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseSessionState = Schema.decodeUnknownSync(
  ComputerUseSessionState,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseSessionRecord = Schema.decodeUnknownSync(
  ComputerUseSessionRecord,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseActionRequest = Schema.decodeUnknownSync(
  ComputerUseActionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseObservation = Schema.decodeUnknownSync(
  ComputerUseObservation,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseFailure = Schema.decodeUnknownSync(
  ComputerUseFailure,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseSensitiveFieldKind = Schema.decodeUnknownSync(
  ComputerUseSensitiveFieldKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseRuntimeEvent = Schema.decodeUnknownSync(
  ComputerUseRuntimeEvent,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUsePendingApproval = Schema.decodeUnknownSync(
  ComputerUsePendingApproval,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseSessionView = Schema.decodeUnknownSync(
  ComputerUseSessionView,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseSessionList = Schema.decodeUnknownSync(
  ComputerUseSessionList,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseSessionScope = Schema.decodeUnknownSync(
  ComputerUseSessionScope,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseApprovalDecisionRequest = Schema.decodeUnknownSync(
  ComputerUseApprovalDecisionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseStopRequest = Schema.decodeUnknownSync(
  ComputerUseStopRequest,
  STRICT_DECODE_OPTIONS,
);
