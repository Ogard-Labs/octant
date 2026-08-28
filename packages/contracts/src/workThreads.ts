import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { GithubIssueContextRequest } from "./githubIssueContext";
import { LinearIssueContextRequest } from "./linearIssueContext";
import { HostId } from "./host";
import { ThreadWorkingDirectory } from "./workingDirectory";
import { ProjectId } from "./projects";
import { BindingRevisionId } from "./projects";
import { ProviderInstanceId, ProviderModelId, ThreadProviderHandoff } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const WorkThreadId = brandedUuid("WorkThreadId");
export type WorkThreadId = typeof WorkThreadId.Type;

/** Durable user evidence for a completed, named Work delivery target. */
export const WorkThreadCompletionEvidence = Schema.Struct({
  deliveryTarget: Schema.NonEmptyTrimmedString,
  satisfactionEvidence: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
}).annotations(strict);
export type WorkThreadCompletionEvidence = typeof WorkThreadCompletionEvidence.Type;

export const WorkThread = Schema.Struct({
  id: WorkThreadId,
  projectId: ProjectId,
  title: Schema.NonEmptyTrimmedString,
  lifecycle: Schema.Literal("active", "archived", "deleting", "deleted"),
  completionConfirmed: Schema.optional(Schema.Boolean),
  completionEvidence: Schema.optional(WorkThreadCompletionEvidence),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  providerHandoff: Schema.optional(ThreadProviderHandoff),
  bindingRevisionId: Schema.optional(BindingRevisionId),
  workingDirectory: Schema.optional(ThreadWorkingDirectory),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type WorkThread = typeof WorkThread.Type;

const WorkThreadCommandFields = {
  threadId: WorkThreadId,
  expectedVersion: AggregateVersion,
} as const;

export const CreateWorkThreadCommand = Schema.Struct({
  kind: Schema.Literal("create-work-thread"),
  threadId: WorkThreadId,
  projectId: ProjectId,
  title: Schema.NonEmptyTrimmedString,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  hostId: HostId,
  /** Exact Project binding revision the renderer observed before create. */
  bindingRevisionId: BindingRevisionId,
  /** Confined working directory relative to the Project root; defaults to `.`. */
  workingDirectory: Schema.optional(ThreadWorkingDirectory),
  issueContext: Schema.optional(GithubIssueContextRequest),
  linearIssueContext: Schema.optional(LinearIssueContextRequest),
}).annotations(strict);
export type CreateWorkThreadCommand = typeof CreateWorkThreadCommand.Type;

export const RenameWorkThreadCommand = Schema.Struct({
  kind: Schema.Literal("rename-work-thread"),
  ...WorkThreadCommandFields,
  title: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type RenameWorkThreadCommand = typeof RenameWorkThreadCommand.Type;

export const ChangeWorkThreadLifecycleCommand = Schema.Struct({
  kind: Schema.Literal("change-work-thread-lifecycle"),
  ...WorkThreadCommandFields,
  lifecycle: Schema.Literal("active", "archived"),
}).annotations(strict);
export type ChangeWorkThreadLifecycleCommand = typeof ChangeWorkThreadLifecycleCommand.Type;

export const ConfirmWorkThreadCompletionCommand = Schema.Struct({
  kind: Schema.Literal("confirm-work-thread-completion"),
  ...WorkThreadCommandFields,
  /** Must exactly identify the authoritative current delivery target. */
  deliveryTarget: Schema.NonEmptyTrimmedString,
  /** User-supplied evidence that the named delivery target was satisfied. */
  satisfactionEvidence: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
}).annotations(strict);
export type ConfirmWorkThreadCompletionCommand = typeof ConfirmWorkThreadCompletionCommand.Type;

export const ChangeWorkThreadWorkingDirectoryCommand = Schema.Struct({
  kind: Schema.Literal("change-work-thread-working-directory"),
  ...WorkThreadCommandFields,
  workingDirectory: ThreadWorkingDirectory,
}).annotations(strict);
export type ChangeWorkThreadWorkingDirectoryCommand =
  typeof ChangeWorkThreadWorkingDirectoryCommand.Type;

export const ChangeWorkThreadProviderCommand = Schema.Struct({
  kind: Schema.Literal("change-work-thread-provider"),
  ...WorkThreadCommandFields,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type ChangeWorkThreadProviderCommand = typeof ChangeWorkThreadProviderCommand.Type;

export const WorkThreadCommand = Schema.Union(
  CreateWorkThreadCommand,
  RenameWorkThreadCommand,
  ChangeWorkThreadLifecycleCommand,
  ConfirmWorkThreadCompletionCommand,
  ChangeWorkThreadWorkingDirectoryCommand,
  ChangeWorkThreadProviderCommand,
);
export type WorkThreadCommand = typeof WorkThreadCommand.Type;

export const WorkThreadFailureCategory = Schema.Literal(
  "unavailable",
  "unauthorized",
  "unsupported",
  "waiting",
  "interrupted",
  "failed",
  "disconnected",
  "stale",
  "invalid",
);
export type WorkThreadFailureCategory = typeof WorkThreadFailureCategory.Type;

export const WorkThreadFailure = Schema.Struct({
  category: WorkThreadFailureCategory,
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type WorkThreadFailure = typeof WorkThreadFailure.Type;

export const WorkThreadCreated = Schema.Struct({
  kind: Schema.Literal("thread-created"),
  thread: WorkThread,
}).annotations(strict);
export type WorkThreadCreated = typeof WorkThreadCreated.Type;

export const WorkThreadUpdated = Schema.Struct({
  kind: Schema.Literal("thread-updated"),
  thread: WorkThread,
}).annotations(strict);
export type WorkThreadUpdated = typeof WorkThreadUpdated.Type;

export const WorkThreadCompletionConfirmed = Schema.Struct({
  kind: Schema.Literal("thread-completion-confirmed"),
  thread: WorkThread,
}).annotations(strict);
export type WorkThreadCompletionConfirmed = typeof WorkThreadCompletionConfirmed.Type;

export const WorkThreadCommandResult = Schema.Union(
  WorkThreadCreated,
  WorkThreadUpdated,
  WorkThreadCompletionConfirmed,
  WorkThreadFailure,
);
export type WorkThreadCommandResult = typeof WorkThreadCommandResult.Type;

export const WorkThreadBootstrap = Schema.Struct({
  threads: Schema.Array(WorkThread),
}).annotations(strict);
export type WorkThreadBootstrap = typeof WorkThreadBootstrap.Type;

export const WORK_THREAD_EVENT_NAMES = [
  "work.thread-created@1",
  "work.thread-updated@1",
  "work.thread-completion-confirmed@1",
] as const;

export const decodeWorkThreadId = Schema.decodeUnknownSync(WorkThreadId);
export const decodeWorkThread = Schema.decodeUnknownSync(WorkThread);
export const decodeWorkThreadCommand = Schema.decodeUnknownSync(WorkThreadCommand);
export const decodeWorkThreadCommandResult = Schema.decodeUnknownSync(WorkThreadCommandResult);
export const decodeWorkThreadBootstrap = Schema.decodeUnknownSync(WorkThreadBootstrap);
