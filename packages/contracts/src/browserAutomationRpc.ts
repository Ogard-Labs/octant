import { Schema } from "effect";
import {
  BrowserActionRequest,
  BrowserAutomationFailure,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserContextRecord,
  BrowserObservation,
  BrowserThreadId,
} from "./browserAutomation";
import {
  ToolActionAuthority,
  ToolActionCancellation,
  ToolActionRequest,
  ToolApprovalId,
  ToolEvidence,
} from "./toolActions";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const BrowserWorkspaceStatus = Schema.Literal(
  "ready",
  "running",
  "waiting",
  "unavailable",
  "interrupted",
  "failed",
  "stale",
);
export type BrowserWorkspaceStatus = typeof BrowserWorkspaceStatus.Type;

export const BrowserThreadScopeRequest = Schema.Struct({
  threadId: BrowserThreadId,
  mode: Schema.Literal("chat", "work", "code"),
}).annotations(strict);
export type BrowserThreadScopeRequest = typeof BrowserThreadScopeRequest.Type;

export const BrowserThreadScope = Schema.Struct({
  threadId: BrowserThreadId,
  authority: ToolActionAuthority,
}).annotations(strict);
export type BrowserThreadScope = typeof BrowserThreadScope.Type;

/** A one origin, one window approval shown while a managed turn is waiting. */
export const BrowserToolApproval = Schema.Struct({
  approvalId: ToolApprovalId,
  threadId: BrowserThreadId,
  mode: Schema.Literal("chat", "work", "code"),
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type BrowserToolApproval = typeof BrowserToolApproval.Type;

export const BrowserToolApprovalList = Schema.Array(BrowserToolApproval);
export type BrowserToolApprovalList = typeof BrowserToolApprovalList.Type;

export const BrowserToolApprovalDecision = Schema.Struct({
  approvalId: ToolApprovalId,
  decision: Schema.Literal("approved", "denied"),
}).annotations(strict);
export type BrowserToolApprovalDecision = typeof BrowserToolApprovalDecision.Type;

export const BrowserContextCreateCommand = Schema.Struct({
  threadId: BrowserThreadId,
  action: ToolActionRequest,
  policy: BrowserContextPolicy,
  /**
   * Ask for a context of this Open's own rather than the thread's shared one.
   * The Browser surface keeps exactly one context per thread; a
   * Local servers Open needs its own, because a second classified server must
   * neither take over nor destroy the first server's session.
   */
  dedicated: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type BrowserContextCreateCommand = typeof BrowserContextCreateCommand.Type;

export const BrowserContextInspectCommand = Schema.Struct({
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
}).annotations(strict);
export type BrowserContextInspectCommand = typeof BrowserContextInspectCommand.Type;

export const BrowserThreadContextCommand = Schema.Struct({
  threadId: BrowserThreadId,
}).annotations(strict);
export type BrowserThreadContextCommand = typeof BrowserThreadContextCommand.Type;

export const BrowserActionCommand = BrowserActionRequest;
export type BrowserActionCommand = typeof BrowserActionCommand.Type;

export const BrowserContextCancelCommand = Schema.Struct({
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
  cancellation: ToolActionCancellation,
}).annotations(strict);
export type BrowserContextCancelCommand = typeof BrowserContextCancelCommand.Type;

export const BrowserContextStopCommand = Schema.Struct({
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
}).annotations(strict);
export type BrowserContextStopCommand = typeof BrowserContextStopCommand.Type;

export const BrowserContextObservation = Schema.Struct({
  context: BrowserContextRecord,
  observation: Schema.optional(BrowserObservation),
}).annotations(strict);
export type BrowserContextObservation = typeof BrowserContextObservation.Type;

export const BrowserAutomationSnapshot = Schema.Struct({
  status: BrowserWorkspaceStatus,
  threadId: BrowserThreadId,
  context: Schema.optional(BrowserContextRecord),
  observation: Schema.optional(BrowserObservation),
  contexts: Schema.optional(Schema.Array(BrowserContextObservation).pipe(Schema.maxItems(8))),
  evidence: Schema.Array(ToolEvidence),
  failure: Schema.optional(BrowserAutomationFailure),
}).annotations(strict);
export type BrowserAutomationSnapshot = typeof BrowserAutomationSnapshot.Type;

export const decodeBrowserThreadScopeRequest = Schema.decodeUnknownSync(BrowserThreadScopeRequest);
export const decodeBrowserThreadScope = Schema.decodeUnknownSync(BrowserThreadScope);
export const decodeBrowserToolApproval = Schema.decodeUnknownSync(BrowserToolApproval);
export const decodeBrowserToolApprovalList = Schema.decodeUnknownSync(BrowserToolApprovalList);
export const decodeBrowserToolApprovalDecision = Schema.decodeUnknownSync(
  BrowserToolApprovalDecision,
);
export const decodeBrowserContextCreateCommand = Schema.decodeUnknownSync(
  BrowserContextCreateCommand,
);
export const decodeBrowserContextInspectCommand = Schema.decodeUnknownSync(
  BrowserContextInspectCommand,
);
export const decodeBrowserThreadContextCommand = Schema.decodeUnknownSync(
  BrowserThreadContextCommand,
);
export const decodeBrowserActionCommand = Schema.decodeUnknownSync(BrowserActionCommand);
export const decodeBrowserContextCancelCommand = Schema.decodeUnknownSync(
  BrowserContextCancelCommand,
);
export const decodeBrowserContextStopCommand = Schema.decodeUnknownSync(BrowserContextStopCommand);
export const decodeBrowserAutomationSnapshot = Schema.decodeUnknownSync(BrowserAutomationSnapshot);
