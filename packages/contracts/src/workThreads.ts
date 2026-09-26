import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ThreadRestFields } from "./threadRest";
import { GithubIssueContextRequest } from "./githubIssueContext";
import { LinearIssueContextRequest } from "./linearIssueContext";
import { HostId } from "./host";
import { ThreadWorkingDirectory } from "./workingDirectory";
import { ProjectId } from "./projects";
import { BindingRevisionId } from "./projects";
import { WorkStatusDatedItem } from "./workProjectStatus";
import {
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
  ThreadProviderHandoff,
} from "./providers";

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

/**
 * What an agent in a Work thread may do to files inside the Project folder
 * without asking. `ask-first` raises every edit for approval, which is what
 * Work always did. `auto-accept-edits` lets edits inside the confined folder
 * land without a prompt; reaching outside the folder stays refused, and the
 * rest of the turn's posture is unchanged. Providers without an auto-accept
 * path keep asking.
 */
export const WorkAccess = Schema.Literal("ask-first", "auto-accept-edits");
export type WorkAccess = typeof WorkAccess.Type;

/** The access a Work thread starts with when nothing else is set. */
export const DEFAULT_WORK_ACCESS: WorkAccess = "ask-first";

export const WorkThread = Schema.Struct({
  id: WorkThreadId,
  projectId: ProjectId,
  title: Schema.NonEmptyTrimmedString,
  lifecycle: Schema.Literal("active", "archived", "deleting", "deleted"),
  completionConfirmed: Schema.optional(Schema.Boolean),
  completionEvidence: Schema.optional(WorkThreadCompletionEvidence),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  modelOptionValues: Schema.optional(ProviderModelOptionValues),
  providerHandoff: Schema.optional(ThreadProviderHandoff),
  bindingRevisionId: Schema.optional(BindingRevisionId),
  workingDirectory: Schema.optional(ThreadWorkingDirectory),
  /**
   * The access this thread started with, taken from Work settings when it was
   * created. A thread journaled before access existed decodes as ask-first,
   * which is what it had.
   */
  access: Schema.optionalWith(WorkAccess, { default: () => DEFAULT_WORK_ACCESS }),
  /** Completed and snoozed rest, shared with Chat and Code; see {@link ThreadRestFields}. */
  ...ThreadRestFields,
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
  modelOptionValues: Schema.optional(ProviderModelOptionValues),
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

/**
 * Put a finished thread away without archiving it. The host refuses while a
 * turn is running or the thread waits on the person, so a thread never
 * disappears with work in flight.
 */
export const CompleteWorkThreadCommand = Schema.Struct({
  kind: Schema.Literal("complete-work-thread"),
  ...WorkThreadCommandFields,
}).annotations(strict);
export type CompleteWorkThreadCommand = typeof CompleteWorkThreadCommand.Type;
export const ReopenWorkThreadCommand = Schema.Struct({
  kind: Schema.Literal("reopen-work-thread"),
  ...WorkThreadCommandFields,
}).annotations(strict);
export type ReopenWorkThreadCommand = typeof ReopenWorkThreadCommand.Type;
/** Hide the thread until `until`; the host refuses a wake time that is not ahead. */
export const SnoozeWorkThreadCommand = Schema.Struct({
  kind: Schema.Literal("snooze-work-thread"),
  ...WorkThreadCommandFields,
  until: UtcTimestamp,
}).annotations(strict);
export type SnoozeWorkThreadCommand = typeof SnoozeWorkThreadCommand.Type;
export const WakeWorkThreadCommand = Schema.Struct({
  kind: Schema.Literal("wake-work-thread"),
  ...WorkThreadCommandFields,
}).annotations(strict);
export type WakeWorkThreadCommand = typeof WakeWorkThreadCommand.Type;

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
  modelOptionValues: Schema.optional(ProviderModelOptionValues),
}).annotations(strict);
export type ChangeWorkThreadProviderCommand = typeof ChangeWorkThreadProviderCommand.Type;

/**
 * Defaults for new Work threads: the model a new thread starts on and the
 * access it starts with. A thread keeps what it started with; changing these
 * never changes a thread that already exists.
 */
export const WorkSettings = Schema.Struct({
  defaultProviderInstanceId: Schema.optional(ProviderInstanceId),
  defaultModelId: Schema.optional(ProviderModelId),
  defaultAccess: WorkAccess,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (settings) =>
        (settings.defaultProviderInstanceId === undefined) ===
        (settings.defaultModelId === undefined),
    ),
  );
export type WorkSettings = typeof WorkSettings.Type;

export const UpdateWorkSettingsCommand = Schema.Struct({
  kind: Schema.Literal("update-work-settings"),
  expectedVersion: AggregateVersion,
  defaultProviderInstanceId: Schema.optional(ProviderInstanceId),
  defaultModelId: Schema.optional(ProviderModelId),
  defaultAccess: WorkAccess,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (command) =>
        (command.defaultProviderInstanceId === undefined) ===
        (command.defaultModelId === undefined),
    ),
  );
export type UpdateWorkSettingsCommand = typeof UpdateWorkSettingsCommand.Type;

export const WorkThreadCommand = Schema.Union(
  CreateWorkThreadCommand,
  RenameWorkThreadCommand,
  ChangeWorkThreadLifecycleCommand,
  CompleteWorkThreadCommand,
  ReopenWorkThreadCommand,
  SnoozeWorkThreadCommand,
  WakeWorkThreadCommand,
  ConfirmWorkThreadCompletionCommand,
  ChangeWorkThreadWorkingDirectoryCommand,
  ChangeWorkThreadProviderCommand,
  UpdateWorkSettingsCommand,
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

export const WorkSettingsUpdated = Schema.Struct({
  kind: Schema.Literal("settings-updated"),
  settings: WorkSettings,
}).annotations(strict);
export type WorkSettingsUpdated = typeof WorkSettingsUpdated.Type;

export const WorkThreadCommandResult = Schema.Union(
  WorkThreadCreated,
  WorkThreadUpdated,
  WorkThreadCompletionConfirmed,
  WorkSettingsUpdated,
  WorkThreadFailure,
);
export type WorkThreadCommandResult = typeof WorkThreadCommandResult.Type;

/**
 * Live run state for one Work sidebar row. Kept off durable {@link WorkThread}:
 * executing is runtime-derived the same way board reasons are.
 */
export const WorkThreadNavigationRuntime = Schema.Struct({
  threadId: WorkThreadId,
  executing: Schema.Boolean,
  /**
   * The agent is waiting on the person: a pending approval or question. Lets
   * the sidebar wake a snoozed row early. Optional so an older host's payload
   * still decodes; absent reads as not waiting.
   */
  awaitingInput: Schema.optional(Schema.Boolean),
  /**
   * The kind of request currently waiting on the person. Optional so older
   * hosts decode; absent means the request kind is unknown.
   */
  awaitingKind: Schema.optional(Schema.Literal("approval", "user-input")),
  /**
   * A dated line in the Project's `STATUS.md` that has passed or is near,
   * carried on the Project's newest open thread so the inbox can surface the
   * reminder (decision 0119). Optional so an older host's payload still
   * decodes; absent reads as nothing due.
   */
  followUpDue: Schema.optional(WorkStatusDatedItem),
}).annotations(strict);
export type WorkThreadNavigationRuntime = typeof WorkThreadNavigationRuntime.Type;

export const WorkThreadBootstrap = Schema.Struct({
  threads: Schema.Array(WorkThread),
  /**
   * Optional so a remote client talking to an older host still bootstraps; an
   * empty list means no thread is reported executing.
   */
  runtime: Schema.optionalWith(Schema.Array(WorkThreadNavigationRuntime), {
    default: () => [],
  }),
  /** Optional so a remote client talking to an older host still bootstraps. */
  settings: Schema.optional(WorkSettings),
}).annotations(strict);
export type WorkThreadBootstrap = typeof WorkThreadBootstrap.Type;

/**
 * Projection-only Work sidebar state. Unlike bootstrap, this read never
 * validates Project roots or observes repositories.
 */
export const WorkThreadNavigation = Schema.Struct({
  threads: Schema.Array(WorkThread),
  runtime: Schema.Array(WorkThreadNavigationRuntime),
}).annotations(strict);
export type WorkThreadNavigation = typeof WorkThreadNavigation.Type;

export const WORK_THREAD_EVENT_NAMES = [
  "work.thread-created@1",
  "work.thread-updated@1",
  "work.thread-completion-confirmed@1",
] as const;

export const WORK_SETTINGS_EVENT_NAME = "work.settings-updated@1";
export const decodeWorkSettingsUpdated = Schema.decodeUnknownSync(WorkSettingsUpdated);

export const decodeWorkThreadId = Schema.decodeUnknownSync(WorkThreadId);
export const decodeWorkThread = Schema.decodeUnknownSync(WorkThread);
export const decodeWorkThreadCommand = Schema.decodeUnknownSync(WorkThreadCommand);
export const decodeWorkThreadCommandResult = Schema.decodeUnknownSync(WorkThreadCommandResult);
export const decodeWorkThreadBootstrap = Schema.decodeUnknownSync(WorkThreadBootstrap);
export const decodeWorkThreadNavigation = Schema.decodeUnknownSync(WorkThreadNavigation);
export const decodeWorkThreadNavigationRuntime = Schema.decodeUnknownSync(
  WorkThreadNavigationRuntime,
);
