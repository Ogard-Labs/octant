import { Schema } from "effect";
import {
  CausationId,
  CorrelationId,
  EventActor,
  EventActorDeviceId,
  EventVersion,
  UtcTimestamp,
} from "./events";
import { ToolActionId, ToolApprovalId, ToolCapabilityId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Bounded, redacted token for audit reason / step / class fields. Rejects path
 * separators and whitespace so absolute private paths and free-form tool output
 * cannot sneak into journaled audit payloads.
 */
export const AuditBoundedToken = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.pattern(/^[a-z][a-z0-9._:-]*$/),
  Schema.brand("AuditBoundedToken"),
);
export type AuditBoundedToken = typeof AuditBoundedToken.Type;

/**
 * Opaque reference identity only — never a filesystem path, secret, or raw
 * tool transcript. Caps length and rejects `/`, `\`, and NUL.
 */
export const AuditOpaqueReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.filter((value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"), {
    message: () => "Audit references must not contain filesystem path separators.",
  }),
  Schema.brand("AuditOpaqueReference"),
);
export type AuditOpaqueReference = typeof AuditOpaqueReference.Type;

/**
 * Server-resolved acting principal for authority decisions. Distinct from
 * `EventActor`: principals answer "which authenticated surface petitioned",
 * while actors answer "who is attributed on the journal envelope". Identity is
 * never client-supplied (`assertNoPrincipalIdentityInPayload`).
 */
export const AuditActingPrincipal = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    deviceId: EventActorDeviceId,
  }).annotations(strict),
);
export type AuditActingPrincipal = typeof AuditActingPrincipal.Type;

export const AUDIT_EVENT_NAMES = [
  "tool-call-requested",
  "tool-call-authorized",
  "tool-call-denied",
  "policy-decision-recorded",
  "approval-granted",
  "approval-denied",
  "approval-expired",
  "thread-elevation-changed",
  "authority-transition-recorded",
] as const;
export type AuditEventName = (typeof AUDIT_EVENT_NAMES)[number];

export const AuditEventNameSchema = Schema.Literal(...AUDIT_EVENT_NAMES).pipe(
  Schema.brand("AuditEventName"),
);
export type AuditEventNameSchema = typeof AuditEventNameSchema.Type;

const PolicyResolutionStep = Schema.Literal(
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
);

const ToolCallAuditFields = {
  actionId: ToolActionId,
  capabilityId: Schema.optional(ToolCapabilityId),
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  actingPrincipal: AuditActingPrincipal,
  /** Opaque turn / petition reference — never raw model or tool text. */
  turnReference: Schema.optional(AuditOpaqueReference),
};

export const ToolCallRequestedPayload = Schema.Struct({
  ...ToolCallAuditFields,
}).annotations(strict);
export type ToolCallRequestedPayload = typeof ToolCallRequestedPayload.Type;

export const ToolCallAuthorizedPayload = Schema.Struct({
  ...ToolCallAuditFields,
  resolutionStep: Schema.optional(PolicyResolutionStep),
}).annotations(strict);
export type ToolCallAuthorizedPayload = typeof ToolCallAuthorizedPayload.Type;

export const ToolCallDeniedPayload = Schema.Struct({
  ...ToolCallAuditFields,
  denialReason: AuditBoundedToken,
  resolutionStep: PolicyResolutionStep,
}).annotations(strict);
export type ToolCallDeniedPayload = typeof ToolCallDeniedPayload.Type;

export const PolicyDecisionRecordedPayload = Schema.Struct({
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  actingPrincipal: AuditActingPrincipal,
  decision: Schema.Literal("allow", "deny", "prompt"),
  denialReason: Schema.optional(AuditBoundedToken),
  resolutionStep: PolicyResolutionStep,
  /** Bounded policy surface name (e.g. tool-action, agent-run, remote-access). */
  policySurface: AuditBoundedToken,
  actionId: Schema.optional(ToolActionId),
}).annotations(strict);
export type PolicyDecisionRecordedPayload = typeof PolicyDecisionRecordedPayload.Type;

const ApprovalScope = Schema.Literal("action", "session", "project");
const ApprovalClass = AuditBoundedToken;

export const ApprovalGrantedPayload = Schema.Struct({
  approvalId: ToolApprovalId,
  approvalClass: ApprovalClass,
  scope: ApprovalScope,
  ttlMs: Schema.optional(Schema.Int.pipe(Schema.positive())),
  promptingActionId: Schema.optional(ToolActionId),
  correlationId: CorrelationId,
  actingPrincipal: AuditActingPrincipal,
  expiresAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ApprovalGrantedPayload = typeof ApprovalGrantedPayload.Type;

export const ApprovalDeniedPayload = Schema.Struct({
  approvalId: Schema.optional(ToolApprovalId),
  approvalClass: ApprovalClass,
  scope: ApprovalScope,
  promptingActionId: Schema.optional(ToolActionId),
  correlationId: CorrelationId,
  actingPrincipal: AuditActingPrincipal,
  denialReason: AuditBoundedToken,
}).annotations(strict);
export type ApprovalDeniedPayload = typeof ApprovalDeniedPayload.Type;

export const ApprovalExpiredPayload = Schema.Struct({
  approvalId: ToolApprovalId,
  approvalClass: ApprovalClass,
  scope: ApprovalScope,
  promptingActionId: Schema.optional(ToolActionId),
  correlationId: CorrelationId,
  actingPrincipal: AuditActingPrincipal,
  expiredAt: UtcTimestamp,
}).annotations(strict);
export type ApprovalExpiredPayload = typeof ApprovalExpiredPayload.Type;

export const ThreadElevationChangedPayload = Schema.Struct({
  correlationId: CorrelationId,
  actingPrincipal: AuditActingPrincipal,
  threadReference: AuditOpaqueReference,
  fromPosture: AuditBoundedToken,
  toPosture: AuditBoundedToken,
  /** e.g. remembered-full-access, plan-to-execution, session-elevation */
  changeKind: AuditBoundedToken,
}).annotations(strict);
export type ThreadElevationChangedPayload = typeof ThreadElevationChangedPayload.Type;

export const AuthorityTransitionRecordedPayload = Schema.Struct({
  correlationId: CorrelationId,
  actingPrincipal: AuditActingPrincipal,
  /** e.g. project-attach, worktree-bind, child-clamp */
  transitionKind: AuditBoundedToken,
  outcome: Schema.Literal("applied", "denied", "clamped"),
  denialReason: Schema.optional(AuditBoundedToken),
  /** Opaque bound-root / worktree / project reference — never an absolute path. */
  scopeReference: Schema.optional(AuditOpaqueReference),
}).annotations(strict);
export type AuthorityTransitionRecordedPayload = typeof AuthorityTransitionRecordedPayload.Type;

export const AuditEventPayload = Schema.Union(
  Schema.Struct({
    eventName: Schema.Literal("tool-call-requested"),
    payload: ToolCallRequestedPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("tool-call-authorized"),
    payload: ToolCallAuthorizedPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("tool-call-denied"),
    payload: ToolCallDeniedPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("policy-decision-recorded"),
    payload: PolicyDecisionRecordedPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("approval-granted"),
    payload: ApprovalGrantedPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("approval-denied"),
    payload: ApprovalDeniedPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("approval-expired"),
    payload: ApprovalExpiredPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("thread-elevation-changed"),
    payload: ThreadElevationChangedPayload,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("authority-transition-recorded"),
    payload: AuthorityTransitionRecordedPayload,
  }).annotations(strict),
);
export type AuditEventPayload = typeof AuditEventPayload.Type;

/**
 * Versioned audit event contract. Envelope actor carries attribution
 * (`EventActor`); payload carries the acting principal and redacted decision
 * facts. Secrets, absolute private paths, and raw tool output are unrepresentable.
 */
export const AuditEvent = Schema.Struct({
  eventVersion: EventVersion.pipe(Schema.filter((version) => version === 1)),
  eventName: Schema.Literal(...AUDIT_EVENT_NAMES),
  actor: EventActor,
  occurredAt: UtcTimestamp,
  body: AuditEventPayload,
})
  .annotations(strict)
  .pipe(
    Schema.filter((event) => event.eventName === event.body.eventName, {
      message: () => "Audit eventName must match body.eventName.",
    }),
  );
export type AuditEvent = typeof AuditEvent.Type;

export const decodeAuditEvent = Schema.decodeUnknownSync(AuditEvent);
export const decodeAuditEventPayload = Schema.decodeUnknownSync(AuditEventPayload);
export const decodeAuditActingPrincipal = Schema.decodeUnknownSync(AuditActingPrincipal);
export const decodeAuditBoundedToken = Schema.decodeUnknownSync(AuditBoundedToken);
export const decodeAuditOpaqueReference = Schema.decodeUnknownSync(AuditOpaqueReference);

const FORBIDDEN_AUDIT_IDENTITY_KEYS = [
  "windowId",
  "deviceId",
  "sessionId",
  "hostId",
  "capability",
] as const;

/**
 * Fail closed when a caller attempts to smuggle principal identity into an
 * audit *request* payload. Server-resolved `actingPrincipal` / `EventActor`
 * fields are set after this check, never from client input.
 *
 * Mirrors `assertNoPrincipalIdentityInPayload` for the audit write path.
 */
export function assertNoPrincipalIdentityInAuditInput(input: unknown): void {
  if (!isRecord(input)) return;
  for (const key of FORBIDDEN_AUDIT_IDENTITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new AuditPrincipalIdentityRejected(
        `Audit inputs cannot supply principal identity field "${key}".`,
      );
    }
  }
}

export class AuditPrincipalIdentityRejected extends Error {
  override readonly name = "AuditPrincipalIdentityRejected";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Structural redaction gate for audit payloads after schema decode. Rejects
 * values that look like secrets, absolute private paths, or raw tool dumps
 * even if they somehow passed a looser string field.
 */
export function assertAuditPayloadRedacted(value: unknown, path = "payload"): void {
  if (typeof value === "string") {
    if (value.includes("BEGIN ") && /PRIVATE KEY|CERTIFICATE/i.test(value)) {
      throw new AuditRedactionRejected(`${path} contains key material.`);
    }
    if (/\/(?:Users|home|private|var\/folders)\//i.test(value) || /^[A-Za-z]:\\/.test(value)) {
      throw new AuditRedactionRejected(`${path} contains an absolute private path.`);
    }
    if (value.length > 4_096) {
      throw new AuditRedactionRejected(`${path} exceeds redacted audit length bound.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAuditPayloadRedacted(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "rawToolOutput" || key === "secret" || key === "password" || key === "token") {
        throw new AuditRedactionRejected(`${path}.${key} is forbidden in audit payloads.`);
      }
      assertAuditPayloadRedacted(entry, `${path}.${key}`);
    }
  }
}

export class AuditRedactionRejected extends Error {
  override readonly name = "AuditRedactionRejected";
  constructor(message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convenience cast when journaling audit event names into EventName-branded fields. */
export function auditEventName(name: AuditEventName): string {
  return name;
}
