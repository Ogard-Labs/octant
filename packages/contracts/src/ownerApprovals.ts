import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { HubMemberId, OwnerUnlockPrincipal } from "./hubAndSpokes";
import { ProjectId } from "./projects";
import { ThreadRetentionThreadId } from "./threadRetention";

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
import { OwnerApprovalAction } from "./providerApprovalAction";
export {
  OwnerApprovalAction,
  decodeOwnerApprovalAction,
  MAX_OWNER_APPROVAL_BYTES,
} from "./providerApprovalAction";
export const OwnerApprovalId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("OwnerApprovalId"),
);
export type OwnerApprovalId = typeof OwnerApprovalId.Type;
const TargetIdentity = {
  ownerMemberId: HubMemberId,
  hostMemberId: HubMemberId,
  mode: Schema.Literals(["code", "work"]),
  threadId: ThreadRetentionThreadId,
  projectId: ProjectId,
  requestId: OwnerApprovalId,
  targetVersion: digest,
  actionDigest: digest,
};
export const OwnerApprovalTarget = Schema.Struct({
  ...TargetIdentity,
  title: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  projectName: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  action: OwnerApprovalAction,
});
export type OwnerApprovalTarget = typeof OwnerApprovalTarget.Type;
export const OwnerApprovalReading = Schema.Struct({
  targets: Schema.Array(OwnerApprovalTarget).check(Schema.isMaxLength(32)),
  unavailable: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const decodeOwnerApprovalReading = Schema.decodeUnknownSync(
  OwnerApprovalReading,
  STRICT_DECODE_OPTIONS,
);
export type OwnerApprovalReading = typeof OwnerApprovalReading.Type;
export const OwnerApprovalAnswer = Schema.Struct({
  ...TargetIdentity,
  approved: Schema.Boolean,
});
export const decodeOwnerApprovalAnswer = Schema.decodeUnknownSync(
  OwnerApprovalAnswer,
  STRICT_DECODE_OPTIONS,
);
export type OwnerApprovalAnswer = typeof OwnerApprovalAnswer.Type;
export const OWNER_APPROVAL_AUDIT_EVENT = "owner.runtime-approval-recorded@1";
export const OWNER_APPROVAL_AUDIT_AGGREGATE = "owner-runtime-approval";
export const OwnerApprovalAuditRecord = Schema.Struct({
  ...TargetIdentity,
  approved: Schema.Boolean,
  actingPrincipal: OwnerUnlockPrincipal,
  phase: Schema.Literals(["admitted", "delivered", "uncertain"]),
});
export const decodeOwnerApprovalAuditRecord = Schema.decodeUnknownSync(
  OwnerApprovalAuditRecord,
  STRICT_DECODE_OPTIONS,
);
export type OwnerApprovalAuditRecord = typeof OwnerApprovalAuditRecord.Type;
