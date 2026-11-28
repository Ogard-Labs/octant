import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";
import { WindowId } from "./shell";
import { UtcTimestamp } from "./events";
const BindingId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("CommandCredentialBindingId"),
);
const RequestId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("CommandCredentialRequestId"),
);
const OperationId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("CommandCredentialOperationId"),
);
const Text = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(1024)), // eslint-disable-next-line no-control-regex -- References cannot carry terminal control characters.
  Schema.check(Schema.makeFilter((value) => !/[\x00-\x1f\x7f]/.test(value))),
);
const ImmutableId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{26}$/i));
const FieldId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));
export const CommandCredentialField = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]{0,63}$/)),
  vaultId: ImmutableId,
  itemId: ImmutableId,
  sectionId: Schema.optional(FieldId),
  fieldId: FieldId,
});
export const CommandCredentialDefinition = Schema.Struct({
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  projectId: ProjectId,
  executable: Text.check(Schema.isMinLength(1)),
  args: Schema.Array(Text).check(Schema.isMaxLength(32)),
  directory: Text,
  accountId: ImmutableId,
  environment: Schema.Array(CommandCredentialField).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 300_000 })),
});
export type CommandCredentialDefinition = typeof CommandCredentialDefinition.Type;
export const CommandCredentialBinding = Schema.Struct({
  kind: Schema.Literal("command-credential-binding"),
  bindingId: BindingId,
  revision: PositiveInt,
  credentialExecutable: Text.check(Schema.isMinLength(1)),
  credentialExecutableDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  credentialVersion: Schema.String.check(Schema.isPattern(/^2\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/)),
  definition: CommandCredentialDefinition,
  executableDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type CommandCredentialBinding = typeof CommandCredentialBinding.Type;
export const CommandCredentialRequest = Schema.Struct({
  requestId: RequestId,
  binding: CommandCredentialBinding,
  threadId: CodeThreadId,
  expiresAt: UtcTimestamp,
  executionPolicy: Schema.Literals(["full-access", "approval-gated", "auto-accept-edits"]),
  strict: Schema.optional(Schema.Boolean),
  legacySandbox: Schema.optional(Schema.Boolean),
  state: Schema.Literals(["pending", "running", "settled"]),
});
export type CommandCredentialRequest = typeof CommandCredentialRequest.Type;
export const CommandCredentialReceipt = Schema.Struct({
  kind: Schema.Literal("command-credential-receipt"),
  requestId: RequestId,
  status: Schema.Literals([
    "exited",
    "cancelled",
    "timed-out",
    "unavailable",
    "failed",
    "refused",
    "expired",
    "denied",
  ]),
  effect: Schema.Literals(["none", "possible", "completed"]),
  exitCode: Schema.optional(Schema.Int),
  output: Schema.String.check(Schema.isMaxLength(24 * 1024)),
  truncated: Schema.Boolean,
});
export type CommandCredentialReceipt = typeof CommandCredentialReceipt.Type;
export const CommandCredentialCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("save"),
    definition: CommandCredentialDefinition,
    bindingId: Schema.optional(BindingId),
    expectedRevision: Schema.optional(PositiveInt),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    bindingId: BindingId,
    expectedRevision: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    bindingId: BindingId,
    threadId: CodeThreadId,
    operationId: OperationId,
  }),
  Schema.Struct({
    kind: Schema.Literals(["approve", "deny", "cancel"]),
    requestId: RequestId,
  }),
]);
export type CommandCredentialCommand = typeof CommandCredentialCommand.Type;
export const CommandCredentialView = Schema.Struct({
  kind: Schema.Literal("command-credential-view"),
  bindings: Schema.Array(CommandCredentialBinding).check(Schema.isMaxLength(64)),
  requests: Schema.Array(CommandCredentialRequest).check(Schema.isMaxLength(64)),
  receipts: Schema.Array(CommandCredentialReceipt).check(Schema.isMaxLength(64)),
});
export type CommandCredentialView = typeof CommandCredentialView.Type;
export const CommandCredentialResult = Schema.Union([
  CommandCredentialView,
  CommandCredentialReceipt,
  Schema.Struct({
    kind: Schema.Literal("command-credential-refused"),
    reason: Schema.Literals([
      "unauthorized",
      "posture-unsupported",
      "invalid",
      "stale",
      "not-linked",
      "unavailable",
      "limit",
      "journal-unavailable",
    ]),
    message: Schema.String.check(Schema.isMaxLength(512)),
  }),
]);
export type CommandCredentialResult = typeof CommandCredentialResult.Type;
export const CommandCredentialJournalRecord = Schema.Union([
  Schema.Struct({
    name: Schema.Literal("command-binding.saved"),
    binding: CommandCredentialBinding,
    windowId: WindowId,
  }),
  Schema.Struct({
    name: Schema.Literal("command-binding.removed"),
    bindingId: BindingId,
    revision: PositiveInt,
    windowId: WindowId,
  }),
  Schema.Struct({
    name: Schema.Literal("command-binding.run"),
    requestId: RequestId,
    bindingId: BindingId,
    revision: PositiveInt,
    threadId: CodeThreadId,
    windowId: WindowId,
    status: Schema.Literals([
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
    ]),
    effect: Schema.Literals(["none", "possible", "completed"]),
    exitCode: Schema.optional(Schema.Int),
  }),
]);
export type CommandCredentialJournalRecord = typeof CommandCredentialJournalRecord.Type;
export const decodeCommandCredentialDefinition = Schema.decodeUnknownSync(
  CommandCredentialDefinition,
  STRICT_DECODE_OPTIONS,
);
export const decodeCommandCredentialBinding = Schema.decodeUnknownSync(
  CommandCredentialBinding,
  STRICT_DECODE_OPTIONS,
);
export const decodeCommandCredentialCommand = Schema.decodeUnknownSync(
  CommandCredentialCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCommandCredentialResult = Schema.decodeUnknownSync(
  CommandCredentialResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCommandCredentialJournalRecord = Schema.decodeUnknownSync(
  CommandCredentialJournalRecord,
  STRICT_DECODE_OPTIONS,
);

export const decodeCommandCredentialRequest = Schema.decodeUnknownSync(
  CommandCredentialRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCommandCredentialReceipt = Schema.decodeUnknownSync(
  CommandCredentialReceipt,
  STRICT_DECODE_OPTIONS,
);

export const CommandCredentialHostRequest = Schema.Struct({
  requestId: RequestId,
  bindingId: BindingId,
  accountId: ImmutableId,
  environment: Schema.Array(CommandCredentialField).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  expectedRevision: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
});
export type CommandCredentialHostRequest = typeof CommandCredentialHostRequest.Type;
export const CommandCredentialHostResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("authorized"),
    revision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    status: Schema.Literals(["not-linked", "changed", "invalid", "unavailable"]),
  }),
]);
export type CommandCredentialHostResult = typeof CommandCredentialHostResult.Type;
export const decodeCommandCredentialHostRequest = Schema.decodeUnknownSync(
  CommandCredentialHostRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCommandCredentialHostResult = Schema.decodeUnknownSync(
  CommandCredentialHostResult,
  STRICT_DECODE_OPTIONS,
);
