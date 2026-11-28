import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  CausationId,
  CorrelationId,
  EventActor,
  EventActorDeviceId,
  EventVersion,
  UtcTimestamp,
} from "./events";
import { HubPrincipal, OwnerUnlockPrincipal, PeerPrincipal } from "./hubAndSpokes";
import { ToolActionId, ToolApprovalId, ToolCapabilityId } from "./toolActions";

/**
 * Bounded, redacted token for audit reason / step / class fields. Rejects path
 * separators and whitespace so absolute private paths and free-form tool output
 * cannot sneak into journaled audit payloads.
 */
export const AuditBoundedToken = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z][a-z0-9._:-]*$/),
  ),
  Schema.brand("AuditBoundedToken"),
);
export type AuditBoundedToken = typeof AuditBoundedToken.Type;

/**
 * Opaque reference identity only — never a filesystem path, secret, or raw
 * tool transcript. Caps length and rejects `/`, `\`, and NUL.
 */
export const AuditOpaqueReference = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(512),
    Schema.makeFilter(
      (value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
      { message: "Audit references must not contain filesystem path separators." },
    ),
  ),
  Schema.brand("AuditOpaqueReference"),
);
export type AuditOpaqueReference = typeof AuditOpaqueReference.Type;

/**
 * Server-resolved acting principal for authority decisions. Distinct from
 * `EventActor`: principals answer "which authenticated surface petitioned",
 * while actors answer "who is attributed on the journal envelope". Identity is
 * never client-supplied (`assertNoPrincipalIdentityInPayload`).
 */
export const AuditActingPrincipal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-window") }),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    deviceId: EventActorDeviceId,
  }),
  HubPrincipal,
  PeerPrincipal,
  OwnerUnlockPrincipal,
]);
export type AuditActingPrincipal = typeof AuditActingPrincipal.Type;

export const AUDIT_EVENT_NAMES = [
  "tool-call-denied",
  "policy-decision-recorded",
  "approval-denied",
  "authority-transition-recorded",
] as const;
export type AuditEventName = (typeof AUDIT_EVENT_NAMES)[number];

export const AuditEventNameSchema = Schema.Literals(AUDIT_EVENT_NAMES).pipe(
  Schema.brand("AuditEventName"),
);
export type AuditEventNameSchema = typeof AuditEventNameSchema.Type;

const PolicyResolutionStep = Schema.Literals([
  "catalog",
  "schema",
  "mode",
  "host",
  "project",
  "provider",
  "extension-capability",
  "approval",
  "taint",
  "confinement",
  "remote-principal",
  "child-clamp",
  "activation",
]);

const ToolCallAuditFields = {
  actionId: ToolActionId,
  capabilityId: Schema.optional(ToolCapabilityId),
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  actingPrincipal: AuditActingPrincipal,
  /** Opaque turn / petition reference — never raw model or tool text. */
  turnReference: Schema.optional(AuditOpaqueReference),
};

export const ToolCallDeniedPayload = Schema.Struct({
  ...ToolCallAuditFields,
  denialReason: AuditBoundedToken,
  resolutionStep: PolicyResolutionStep,
});
export type ToolCallDeniedPayload = typeof ToolCallDeniedPayload.Type;

export const PolicyDecisionRecordedPayload = Schema.Struct({
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  actingPrincipal: AuditActingPrincipal,
  decision: Schema.Literals(["allow", "deny", "prompt"]),
  denialReason: Schema.optional(AuditBoundedToken),
  resolutionStep: PolicyResolutionStep,
  /** Bounded policy surface name (e.g. tool-action, agent-run, remote-access). */
  policySurface: AuditBoundedToken,
  actionId: Schema.optional(ToolActionId),
});
export type PolicyDecisionRecordedPayload = typeof PolicyDecisionRecordedPayload.Type;

const ApprovalScope = Schema.Literals(["action", "session", "project"]);
const ApprovalClass = AuditBoundedToken;

export const ApprovalDeniedPayload = Schema.Struct({
  approvalId: Schema.optional(ToolApprovalId),
  approvalClass: ApprovalClass,
  scope: ApprovalScope,
  promptingActionId: Schema.optional(ToolActionId),
  correlationId: CorrelationId,
  actingPrincipal: AuditActingPrincipal,
  denialReason: AuditBoundedToken,
});
export type ApprovalDeniedPayload = typeof ApprovalDeniedPayload.Type;

export const AuthorityTransitionRecordedPayload = Schema.Struct({
  correlationId: CorrelationId,
  actingPrincipal: AuditActingPrincipal,
  /** e.g. project-attach, worktree-bind, child-clamp */
  transitionKind: AuditBoundedToken,
  outcome: Schema.Literals(["applied", "denied", "clamped"]),
  denialReason: Schema.optional(AuditBoundedToken),
  /** Opaque bound-root / worktree / project reference — never an absolute path. */
  scopeReference: Schema.optional(AuditOpaqueReference),
});
export type AuthorityTransitionRecordedPayload = typeof AuthorityTransitionRecordedPayload.Type;

export const AuditEventPayload = Schema.Union([
  Schema.Struct({
    eventName: Schema.Literal("tool-call-denied"),
    payload: ToolCallDeniedPayload,
  }),
  Schema.Struct({
    eventName: Schema.Literal("policy-decision-recorded"),
    payload: PolicyDecisionRecordedPayload,
  }),
  Schema.Struct({
    eventName: Schema.Literal("approval-denied"),
    payload: ApprovalDeniedPayload,
  }),
  Schema.Struct({
    eventName: Schema.Literal("authority-transition-recorded"),
    payload: AuthorityTransitionRecordedPayload,
  }),
]);
export type AuditEventPayload = typeof AuditEventPayload.Type;

/**
 * Versioned audit event contract. Envelope actor carries attribution
 * (`EventActor`); payload carries the acting principal and redacted decision
 * facts. Secrets, absolute private paths, and raw tool output are unrepresentable.
 */
export const AuditEvent = Schema.Struct({
  eventVersion: EventVersion.check(Schema.makeFilter((version) => version === 1)),
  eventName: Schema.Literals(AUDIT_EVENT_NAMES),
  actor: EventActor,
  occurredAt: UtcTimestamp,
  body: AuditEventPayload,
}).check(
  Schema.makeFilter((event) => event.eventName === event.body.eventName, {
    message: "Audit eventName must match body.eventName.",
  }),
);
export type AuditEvent = typeof AuditEvent.Type;

export const decodeAuditEvent = Schema.decodeUnknownSync(AuditEvent, STRICT_DECODE_OPTIONS);
export const decodeAuditEventPayload = Schema.decodeUnknownSync(
  AuditEventPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeAuditActingPrincipal = Schema.decodeUnknownSync(
  AuditActingPrincipal,
  STRICT_DECODE_OPTIONS,
);
export const decodeAuditBoundedToken = Schema.decodeUnknownSync(
  AuditBoundedToken,
  STRICT_DECODE_OPTIONS,
);
export const decodeAuditOpaqueReference = Schema.decodeUnknownSync(
  AuditOpaqueReference,
  STRICT_DECODE_OPTIONS,
);

/** Convenience cast when journaling audit event names into EventName-branded fields. */
export function auditEventName(name: AuditEventName): string {
  return name;
}
