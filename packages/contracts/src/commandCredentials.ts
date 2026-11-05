import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";
import { WindowId } from "./shell";
import { UtcTimestamp } from "./events";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const BindingId = Schema.UUID.pipe(Schema.brand("CommandCredentialBindingId"));
const RequestId = Schema.UUID.pipe(Schema.brand("CommandCredentialRequestId"));
const OperationId = Schema.UUID.pipe(Schema.brand("CommandCredentialOperationId"));
const Text = Schema.String.pipe(
  Schema.maxLength(1024),
  // eslint-disable-next-line no-control-regex -- References cannot carry terminal control characters.
  Schema.filter((value) => !/[\x00-\x1f\x7f]/.test(value)),
);
const ImmutableId = Schema.String.pipe(Schema.pattern(/^[a-z0-9]{26}$/i));
const FieldId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,128}$/));
export const CommandCredentialField = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[A-Z_][A-Z0-9_]{0,63}$/)),
  vaultId: ImmutableId,
  itemId: ImmutableId,
  sectionId: Schema.optional(FieldId),
  fieldId: FieldId,
}).annotations(strict);
export const CommandCredentialDefinition = Schema.Struct({
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(80)),
  projectId: ProjectId,
  executable: Text.pipe(Schema.minLength(1)),
  args: Schema.Array(Text).pipe(Schema.maxItems(32)),
  directory: Text,
  accountId: ImmutableId,
  environment: Schema.Array(CommandCredentialField).pipe(Schema.minItems(1), Schema.maxItems(8)),
  timeoutMs: Schema.Int.pipe(Schema.between(100, 300_000)),
}).annotations(strict);
export type CommandCredentialDefinition = typeof CommandCredentialDefinition.Type;
export const CommandCredentialBinding = Schema.Struct({
  kind: Schema.Literal("command-credential-binding"),
  bindingId: BindingId,
  revision: Schema.Int.pipe(Schema.positive()),
  credentialExecutable: Text.pipe(Schema.minLength(1)),
  credentialExecutableDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  credentialVersion: Schema.String.pipe(Schema.pattern(/^2\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/)),
  definition: CommandCredentialDefinition,
  executableDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
}).annotations(strict);
export type CommandCredentialBinding = typeof CommandCredentialBinding.Type;
export const CommandCredentialRequest = Schema.Struct({
  requestId: RequestId,
  binding: CommandCredentialBinding,
  threadId: CodeThreadId,
  expiresAt: UtcTimestamp,
  state: Schema.Literal("pending", "running", "settled"),
}).annotations(strict);
export type CommandCredentialRequest = typeof CommandCredentialRequest.Type;
export const CommandCredentialReceipt = Schema.Struct({
  kind: Schema.Literal("command-credential-receipt"),
  requestId: RequestId,
  status: Schema.Literal(
    "exited",
    "cancelled",
    "timed-out",
    "unavailable",
    "failed",
    "refused",
    "expired",
    "denied",
  ),
  effect: Schema.Literal("none", "possible", "completed"),
  exitCode: Schema.optional(Schema.Int),
  output: Schema.String.pipe(Schema.maxLength(24 * 1024)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type CommandCredentialReceipt = typeof CommandCredentialReceipt.Type;
export const CommandCredentialCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("save"),
    definition: CommandCredentialDefinition,
    bindingId: Schema.optional(BindingId),
    expectedRevision: Schema.optional(Schema.Int.pipe(Schema.positive())),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    bindingId: BindingId,
    expectedRevision: Schema.Int.pipe(Schema.positive()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("review"),
    bindingId: BindingId,
    threadId: CodeThreadId,
    operationId: OperationId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("approve", "deny", "cancel"),
    requestId: RequestId,
  }).annotations(strict),
);
export type CommandCredentialCommand = typeof CommandCredentialCommand.Type;
export const CommandCredentialView = Schema.Struct({
  kind: Schema.Literal("command-credential-view"),
  bindings: Schema.Array(CommandCredentialBinding).pipe(Schema.maxItems(64)),
  requests: Schema.Array(CommandCredentialRequest).pipe(Schema.maxItems(64)),
  receipts: Schema.Array(CommandCredentialReceipt).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type CommandCredentialView = typeof CommandCredentialView.Type;
export const CommandCredentialResult = Schema.Union(
  CommandCredentialView,
  CommandCredentialReceipt,
  Schema.Struct({
    kind: Schema.Literal("command-credential-refused"),
    reason: Schema.Literal(
      "unauthorized",
      "full-access-required",
      "invalid",
      "stale",
      "not-linked",
      "unavailable",
      "limit",
      "journal-unavailable",
    ),
    message: Schema.String.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type CommandCredentialResult = typeof CommandCredentialResult.Type;
export const CommandCredentialJournalRecord = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("command-binding.saved"),
    binding: CommandCredentialBinding,
    windowId: WindowId,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("command-binding.removed"),
    bindingId: BindingId,
    revision: Schema.Int.pipe(Schema.positive()),
    windowId: WindowId,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("command-binding.run"),
    requestId: RequestId,
    bindingId: BindingId,
    revision: Schema.Int.pipe(Schema.positive()),
    threadId: CodeThreadId,
    windowId: WindowId,
    status: Schema.Literal(
      "approved",
      "started",
      "exited",
      "cancelled",
      "timed-out",
      "unavailable",
      "failed",
      "refused",
      "expired",
      "denied",
    ),
    effect: Schema.Literal("none", "possible", "completed"),
    exitCode: Schema.optional(Schema.Int),
  }).annotations(strict),
);
export type CommandCredentialJournalRecord = typeof CommandCredentialJournalRecord.Type;
export const decodeCommandCredentialDefinition = Schema.decodeUnknownSync(
  CommandCredentialDefinition,
);
export const decodeCommandCredentialBinding = Schema.decodeUnknownSync(CommandCredentialBinding);
export const decodeCommandCredentialCommand = Schema.decodeUnknownSync(CommandCredentialCommand);
export const decodeCommandCredentialResult = Schema.decodeUnknownSync(CommandCredentialResult);
export const decodeCommandCredentialJournalRecord = Schema.decodeUnknownSync(
  CommandCredentialJournalRecord,
);

export const decodeCommandCredentialRequest = Schema.decodeUnknownSync(CommandCredentialRequest);
export const decodeCommandCredentialReceipt = Schema.decodeUnknownSync(CommandCredentialReceipt);

export const CommandCredentialHostRequest = Schema.Struct({
  requestId: RequestId,
  bindingId: BindingId,
  accountId: ImmutableId,
  environment: Schema.Array(CommandCredentialField).pipe(Schema.minItems(1), Schema.maxItems(8)),
  expectedRevision: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))),
}).annotations(strict);
export type CommandCredentialHostRequest = typeof CommandCredentialHostRequest.Type;
export const CommandCredentialHostResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("authorized"),
    revision: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("not-linked", "changed", "invalid", "unavailable"),
  }).annotations(strict),
);
export type CommandCredentialHostResult = typeof CommandCredentialHostResult.Type;
export const decodeCommandCredentialHostRequest = Schema.decodeUnknownSync(
  CommandCredentialHostRequest,
);
export const decodeCommandCredentialHostResult = Schema.decodeUnknownSync(
  CommandCredentialHostResult,
);
