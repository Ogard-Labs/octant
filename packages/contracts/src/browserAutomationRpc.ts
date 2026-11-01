import { personDecides } from "./hostAnswer";
import { Schema } from "effect";
import {
  BrowserActionRequest,
  BrowserAutomationFailure,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserContextRecord,
  BrowserObservation,
  BrowserThreadId,
  MAX_BROWSER_THREAD_CONTEXTS,
} from "./browserAutomation";
import { StoredBrowserProfile } from "./browserProfiles";
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
  /**
   * The Project or Personal profile the page lives in, when it is in one. A
   * signed-in page acts as the person's account, so the prompt names the profile
   * and a grant covers that (origin, profile) pair and nothing wider.
   */
  profile: Schema.optional(StoredBrowserProfile),
  /**
   * How many browser extensions are on in that profile, when any are. They can
   * read and change what the agent reads there, so the prompt says so.
   */
  extensionCount: Schema.optional(Schema.Int.pipe(Schema.between(1, 64))),
  /**
   * Set when the agent asks to upload files to the page rather than to open
   * it: the files, by name and size, that would leave this computer. Such an
   * approval covers those files once and is never remembered.
   */
  upload: Schema.optional(
    Schema.Struct({
      files: Schema.Array(
        Schema.Struct({
          name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
          sizeBytes: Schema.Int.pipe(Schema.nonNegative()),
        }).annotations(strict),
      ).pipe(Schema.minItems(1), Schema.maxItems(5)),
    }).annotations(strict),
  ),
  /**
   * Set when the agent asks the person to sign in on the page rather than to
   * open it: the agent waits, the person signs in themselves, and Continue
   * hands the page back. Never remembered.
   */
  signIn: Schema.optional(
    Schema.Struct({
      reason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(300))),
    }).annotations(strict),
  ),
  requestedAt: UtcTimestamp,
}).annotations({ ...strict, ...personDecides });
export type BrowserToolApproval = typeof BrowserToolApproval.Type;

export const BrowserToolApprovalList = Schema.Array(BrowserToolApproval);
export type BrowserToolApprovalList = typeof BrowserToolApprovalList.Type;

export const BrowserToolApprovalDecision = Schema.Struct({
  approvalId: ToolApprovalId,
  decision: Schema.Literal("approved", "denied"),
  /**
   * Set on an approval that should survive the prompt: the host remembers the
   * origin in shell settings and later requests for it settle approved without
   * asking again, until the person forgets it in Settings.
   */
  remember: Schema.optional(Schema.Boolean),
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

/**
 * A read of the thread's current Browser. The host takes a fresh picture of a
 * live page for it unless `freshPicture` is `false`; a preview that is not on
 * screen asks only whether the session still lives and spends no capture.
 */
export const BrowserThreadInspectCommand = Schema.Struct({
  threadId: BrowserThreadId,
  freshPicture: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type BrowserThreadInspectCommand = typeof BrowserThreadInspectCommand.Type;

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
  contexts: Schema.optional(
    Schema.Array(BrowserContextObservation).pipe(Schema.maxItems(MAX_BROWSER_THREAD_CONTEXTS)),
  ),
  evidence: Schema.Array(ToolEvidence),
  failure: Schema.optional(BrowserAutomationFailure),
  /**
   * The agent handed the page to the person and waits: for now only to sign
   * in. A window showing the thread brings its Browser forward.
   */
  waitingForPerson: Schema.optional(Schema.Literal("sign-in")),
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
export const decodeBrowserThreadInspectCommand = Schema.decodeUnknownSync(
  BrowserThreadInspectCommand,
);
export const decodeBrowserActionCommand = Schema.decodeUnknownSync(BrowserActionCommand);
export const decodeBrowserContextCancelCommand = Schema.decodeUnknownSync(
  BrowserContextCancelCommand,
);
export const decodeBrowserContextStopCommand = Schema.decodeUnknownSync(BrowserContextStopCommand);
export const decodeBrowserAutomationSnapshot = Schema.decodeUnknownSync(BrowserAutomationSnapshot);
