import { Schema } from "effect";
import { HubMemberId, OwnerUnlockPrincipal } from "./hubAndSpokes";
import { ProjectId } from "./projects";
import { ThreadRetentionThreadId } from "./threadRetention";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
import { OwnerApprovalAction } from "./providerApprovalAction";
export {
  OwnerApprovalAction,
  decodeOwnerApprovalAction,
  MAX_OWNER_APPROVAL_BYTES,
} from "./providerApprovalAction";
export const OwnerApprovalId = Schema.UUID.pipe(Schema.brand("OwnerApprovalId"));
export type OwnerApprovalId = typeof OwnerApprovalId.Type;
const TargetIdentity = {
  ownerMemberId: HubMemberId,
  hostMemberId: HubMemberId,
  mode: Schema.Literal("code", "work"),
  threadId: ThreadRetentionThreadId,
  projectId: ProjectId,
  requestId: OwnerApprovalId,
  targetVersion: digest,
  actionDigest: digest,
};
export const OwnerApprovalTarget = Schema.Struct({
  ...TargetIdentity,
  title: Schema.NonEmptyString.pipe(Schema.maxLength(512)),
  projectName: Schema.NonEmptyString.pipe(Schema.maxLength(512)),
  action: OwnerApprovalAction,
}).annotations(strict);
export type OwnerApprovalTarget = typeof OwnerApprovalTarget.Type;
export const OwnerApprovalReading = Schema.Struct({
  targets: Schema.Array(OwnerApprovalTarget).pipe(Schema.maxItems(32)),
  unavailable: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
}).annotations(strict);
export const decodeOwnerApprovalReading = Schema.decodeUnknownSync(OwnerApprovalReading);
export type OwnerApprovalReading = typeof OwnerApprovalReading.Type;
export const OwnerApprovalAnswer = Schema.Struct({
  ...TargetIdentity,
  approved: Schema.Boolean,
}).annotations(strict);
export const decodeOwnerApprovalAnswer = Schema.decodeUnknownSync(OwnerApprovalAnswer);
export type OwnerApprovalAnswer = typeof OwnerApprovalAnswer.Type;
export const OWNER_APPROVAL_AUDIT_EVENT = "owner.runtime-approval-recorded@1";
export const OWNER_APPROVAL_AUDIT_AGGREGATE = "owner-runtime-approval";
export const OwnerApprovalAuditRecord = Schema.Struct({
  ...TargetIdentity,
  approved: Schema.Boolean,
  actingPrincipal: OwnerUnlockPrincipal,
  phase: Schema.Literal("admitted", "delivered", "uncertain"),
}).annotations(strict);
export const decodeOwnerApprovalAuditRecord = Schema.decodeUnknownSync(OwnerApprovalAuditRecord);
export type OwnerApprovalAuditRecord = typeof OwnerApprovalAuditRecord.Type;
