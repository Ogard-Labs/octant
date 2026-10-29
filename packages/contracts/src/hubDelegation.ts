import { Schema } from "effect";
import { AuditActingPrincipal } from "./auditEvents";
import {
  DelegatedAuthority,
  DelegatingThreadReference,
  DelegationRequestId,
  DelegationResult,
  HubMemberId,
  PeerDelegationMode,
} from "./hubAndSpokes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const bounded = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));

/**
 * Every delegation a host sends or receives is journaled as one of these, with
 * the principal that petitioned. It keeps who, what changed, and which request
 * it concerned; the task text, the result, and keys stay out.
 */
export const HUB_DELEGATION_RECORDED = "hub-and-spokes.delegation-recorded@1" as const;

export const HubDelegationChange = Schema.Literal(
  // On the receiving spoke.
  "received",
  "cancel-requested",
  // On the delegating spoke.
  "sent",
  "result-recorded",
  "cancel-sent",
);
export type HubDelegationChange = typeof HubDelegationChange.Type;

export const HubDelegationRecordedPayload = Schema.Struct({
  change: HubDelegationChange,
  actingPrincipal: AuditActingPrincipal,
  requestId: DelegationRequestId,
  /** The other member: the sender on the receiver, the target on the sender. */
  memberId: HubMemberId,
  projectId: Schema.optional(ProjectId),
  delegatedFrom: Schema.optional(DelegatingThreadReference),
  /** The thread the delegation runs as on the receiving spoke. */
  threadId: Schema.optional(bounded(64)),
}).annotations(strict);
export type HubDelegationRecordedPayload = typeof HubDelegationRecordedPayload.Type;
export const decodeHubDelegationRecordedPayload = Schema.decodeUnknownSync(
  HubDelegationRecordedPayload,
);

/** A delegation the receiving spoke accepted, with the authority it clamped the request to. */
export const DelegationAccepted = Schema.Struct({
  status: Schema.Literal("accepted"),
  requestId: DelegationRequestId,
  authority: DelegatedAuthority,
}).annotations(strict);
export type DelegationAccepted = typeof DelegationAccepted.Type;

/** The status read and the cancel name one delegation and nothing else. */
export const DelegationReference = Schema.Struct({
  requestId: DelegationRequestId,
}).annotations(strict);
export type DelegationReference = typeof DelegationReference.Type;

export const DelegationChildState = Schema.Literal(
  "running",
  "waiting-for-approval",
  "completed",
  "failed",
  "cancelled",
);
export type DelegationChildState = typeof DelegationChildState.Type;

/**
 * The remote child's state as its spoke reads it. `result` is present only once
 * the child completed, and it is data for the delegating thread.
 */
export const DelegationStatus = Schema.Struct({
  requestId: DelegationRequestId,
  state: DelegationChildState,
  result: Schema.optional(DelegationResult),
}).annotations(strict);
export type DelegationStatus = typeof DelegationStatus.Type;

export const DelegationCancelAnswer = Schema.Struct({
  status: Schema.Literal("cancelled", "already-finished"),
  requestId: DelegationRequestId,
}).annotations(strict);
export type DelegationCancelAnswer = typeof DelegationCancelAnswer.Type;

/** What a person at a window on the delegating spoke asks for: a remote child run for a parent thread. */
export const DelegationStartCommand = Schema.Struct({
  parent: Schema.Struct({
    mode: PeerDelegationMode,
    threadId: Schema.UUID,
  }).annotations(strict),
  targetMemberId: HubMemberId,
  projectId: ProjectId,
  task: bounded(32_768),
  authority: DelegatedAuthority,
}).annotations(strict);
export type DelegationStartCommand = typeof DelegationStartCommand.Type;

export const decodeDelegationAccepted = Schema.decodeUnknownSync(DelegationAccepted);
export const decodeDelegationReference = Schema.decodeUnknownSync(DelegationReference);
export const decodeDelegationStatus = Schema.decodeUnknownSync(DelegationStatus);
export const decodeDelegationCancelAnswer = Schema.decodeUnknownSync(DelegationCancelAnswer);
export const decodeDelegationStartCommand = Schema.decodeUnknownSync(DelegationStartCommand);
