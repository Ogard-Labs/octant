import { Schema } from "effect";
import { AppleActionRequest } from "./appleToolchain";
import {
  CodeAttachmentId,
  CodeAttachmentReference,
  CodeCheckoutId,
  CodeApprovalId,
  CodeCheckoutHead,
  CodeDeliveryOutcomeKind,
  CodeDigest,
  CodeEvidenceContentId,
  CodeFailure,
  CodeFileId,
  CodeFileMetadata,
  CodeFileSaveFailure,
  CodeGitOperationId,
  CodeRelativePath,
  CodeRepositoryId,
  CodeReviewFindingId,
  CodeTerminalId,
  CodeTestRunId,
  CodeThread,
  CodeThreadId,
  MAX_CODE_TURN_ATTACHMENTS,
  WorktreeReceiptId,
} from "./code";
import { CodeRepositoryTestDefinition, CodeRepositoryTestConcern } from "./codeTestDefinitions";
import { ScaffoldDirectoryName, ScaffoldId, ScaffoldRun, ScaffoldRunId } from "./scaffolds";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import {
  PermissionPersistence,
  ProviderInstanceId,
  ProviderModelId,
  ProviderSessionId,
} from "./providers";
import { MAX_THREAD_MENTIONS_PER_TURN, MentionableThreadId } from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );
const uniqueArray = <A, I, R>(schema: Schema.Schema<A, I, R>, maximum: number) =>
  Schema.Array(schema).pipe(
    Schema.filter((values) => values.length <= maximum && new Set(values).size === values.length),
  );

export const MAX_CODE_OPERATION_TERMINAL_INPUT_BYTES = 64 * 1024;
export const MAX_CODE_OPERATION_TEXT_BYTES = 64 * 1024;
export const MAX_CODE_OPERATION_PATHS = 10_000;
export const MAX_CODE_OPERATION_REPLAY_LIMIT = 1_000;
export const MAX_CODE_OPERATION_EVIDENCE_BYTES = 64 * 1024 * 1024;

export const CodeOperationId = Schema.UUID.pipe(Schema.brand("CodeOperationId"));
export type CodeOperationId = typeof CodeOperationId.Type;

export const CodeEvidenceReference = Schema.Struct({
  contentId: CodeEvidenceContentId,
  digest: CodeDigest,
  byteLength: Schema.Int.pipe(Schema.between(0, MAX_CODE_OPERATION_EVIDENCE_BYTES)),
  truncated: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type CodeEvidenceReference = typeof CodeEvidenceReference.Type;

/**
 * Public answer to opening a confined Code file for the editor surface. Every
 * variant carries the server-resolved file identity and never a root path; the
 * editable variant hands back a content reference the content route serves.
 */
export const CodeFileOpenPublicResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("editable"),
    fileId: CodeFileId,
    metadata: CodeFileMetadata,
    content: CodeEvidenceReference,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("read-only"),
    fileId: CodeFileId,
    metadata: CodeFileMetadata,
    reason: Schema.Literal("binary", "oversized"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("interrupted"),
    fileId: CodeFileId,
    rescanRequired: Schema.Literal(true),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("failed"),
    fileId: CodeFileId,
    failure: CodeFileSaveFailure,
  }).annotations(strict),
);
export type CodeFileOpenPublicResult = typeof CodeFileOpenPublicResult.Type;

export const CodeFileOpenResultEnvelope = Schema.Struct({
  kind: Schema.Literal("code-file-open-result"),
  result: CodeFileOpenPublicResult,
}).annotations(strict);
export type CodeFileOpenResultEnvelope = typeof CodeFileOpenResultEnvelope.Type;

const OperationScope = {
  operationId: CodeOperationId,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
} as const;
export const CodeTerminalInspectionRequest = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  terminalId: CodeTerminalId,
}).annotations(strict);
export type CodeTerminalInspectionRequest = typeof CodeTerminalInspectionRequest.Type;

export const CodeTerminalInspection = Schema.Struct({
  terminalId: CodeTerminalId,
  state: Schema.Literal("running", "exited", "interrupted"),
}).annotations(strict);
export type CodeTerminalInspection = typeof CodeTerminalInspection.Type;

const TerminalGeometry = {
  columns: Schema.Int.pipe(Schema.between(1, 500)),
  rows: Schema.Int.pipe(Schema.between(1, 500)),
} as const;
const CredentialReference = Schema.String.pipe(Schema.pattern(/^[A-Z_][A-Z0-9_]{0,127}$/));
const GitStateToken = CodeDigest;
const GitObjectId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));
const GitRemoteName = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._-]{1,255}$/));
const GitBranchName = Schema.String.pipe(
  Schema.maxLength(255),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  Schema.filter(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".lock"),
  ),
);
const GitBranchRef = Schema.String.pipe(
  Schema.pattern(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  Schema.filter(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".lock"),
  ),
);
const CodeOperationCheckoutHead = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("branch"),
    name: GitBranchName,
    oid: GitObjectId,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("detached"), oid: GitObjectId }).annotations(strict),
  // A checkout with no commits yet points HEAD at a branch that does not exist,
  // so it has a name but no object to identify.
  Schema.Struct({ kind: Schema.Literal("unborn"), name: GitBranchName }).annotations(strict),
);
const GitStatusCode = Schema.String.pipe(Schema.pattern(/^[ MADRCUT?!]$/));
const GitStatusEntry = Schema.Struct({
  path: CodeRelativePath,
  originalPath: Schema.optional(CodeRelativePath),
  index: GitStatusCode,
  worktree: GitStatusCode,
}).annotations(strict);
const GitStagePath = CodeRelativePath.pipe(Schema.filter((path) => !path.startsWith("-")));
const StagedGitStatusEntry = GitStatusEntry.pipe(
  Schema.filter((entry) => entry.index !== " " && entry.index !== "?"),
);
const GitAuthorization = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("approved"), approvalId: CodeApprovalId }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("full-access") }).annotations(strict),
);
const GitPushConfirmation = Schema.Struct({
  remote: GitRemoteName,
  refspec: boundedNonEmptyText(1_024).pipe(
    Schema.filter((value) => !value.startsWith("+") && !value.includes(" --")),
  ),
}).annotations(strict);
export const CodeReviewLocation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("line"),
    line: Schema.Int.pipe(Schema.positive()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("selection"),
    startLine: Schema.Int.pipe(Schema.positive()),
    startColumn: Schema.Int.pipe(Schema.positive()),
    endLine: Schema.Int.pipe(Schema.positive()),
    endColumn: Schema.Int.pipe(Schema.positive()),
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (value) =>
          value.endLine > value.startLine ||
          (value.endLine === value.startLine && value.endColumn >= value.startColumn),
      ),
    ),
);
export type CodeReviewLocation = typeof CodeReviewLocation.Type;

export const CodeReviewAuthor = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("local-user"),
    actorId: boundedNonEmptyText(255),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    providerInstanceId: ProviderInstanceId,
    sessionId: boundedNonEmptyText(512),
  }).annotations(strict),
);
export type CodeReviewAuthor = typeof CodeReviewAuthor.Type;

export const CodeReviewProvenance = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("manual") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider", "test", "git"),
    sourceId: boundedNonEmptyText(512),
  }).annotations(strict),
);
export type CodeReviewProvenance = typeof CodeReviewProvenance.Type;

export const CodeReviewFinding = Schema.Struct({
  id: CodeReviewFindingId,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  fileId: CodeFileId,
  path: CodeRelativePath,
  fileDigest: CodeDigest,
  location: CodeReviewLocation,
  severity: Schema.Literal("note", "warning", "error"),
  author: CodeReviewAuthor,
  provenance: CodeReviewProvenance,
  summary: boundedNonEmptyText(4_096),
  state: Schema.Literal("open", "resolved", "dismissed"),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeReviewFinding = typeof CodeReviewFinding.Type;

export const CodeReviewFindingUpdated = Schema.Struct({
  kind: Schema.Literal("review-finding-updated"),
  finding: CodeReviewFinding,
}).annotations(strict);
export type CodeReviewFindingUpdated = typeof CodeReviewFindingUpdated.Type;

const ProviderRequestId = boundedNonEmptyText(255);
export const CodeOperationFailure = CodeFailure.pipe(
  Schema.filter((failure) => encoder.encode(failure.message).byteLength <= 8 * 1024),
);
export type CodeOperationFailure = typeof CodeOperationFailure.Type;

const StartTerminal = Schema.Struct({
  kind: Schema.Literal("start-terminal"),
  ...OperationScope,
  terminalId: CodeTerminalId,
  ...TerminalGeometry,
  credentialRefs: uniqueArray(CredentialReference, 64),
}).annotations(strict);
const AttachTerminal = Schema.Struct({
  kind: Schema.Literal("attach-terminal"),
  ...OperationScope,
  terminalId: CodeTerminalId,
}).annotations(strict);
const WriteTerminal = Schema.Struct({
  kind: Schema.Literal("write-terminal"),
  ...OperationScope,
  terminalId: CodeTerminalId,
  data: boundedText(MAX_CODE_OPERATION_TERMINAL_INPUT_BYTES).pipe(
    Schema.filter((value) => !value.includes("\0")),
  ),
}).annotations(strict);
const ResizeTerminal = Schema.Struct({
  kind: Schema.Literal("resize-terminal"),
  ...OperationScope,
  terminalId: CodeTerminalId,
  ...TerminalGeometry,
}).annotations(strict);
const StopTerminal = Schema.Struct({
  kind: Schema.Literal("stop-terminal"),
  ...OperationScope,
  terminalId: CodeTerminalId,
}).annotations(strict);
const RunRepositoryTest = Schema.Struct({
  kind: Schema.Literal("run-repository-test"),
  ...OperationScope,
  testRunId: CodeTestRunId,
  definition: CodeRepositoryTestDefinition,
}).annotations(strict);
const CancelRepositoryTest = Schema.Struct({
  kind: Schema.Literal("cancel-repository-test"),
  ...OperationScope,
  testRunId: CodeTestRunId,
}).annotations(strict);
/**
 * Start a curated scaffold in this checkout.
 *
 * The command names an entry and a directory; it carries no command line. The
 * host resolves the entry from its own catalog and composes the argv, so a
 * caller cannot reach a generator the host does not offer.
 */
const RunScaffold = Schema.Struct({
  kind: Schema.Literal("run-scaffold"),
  ...OperationScope,
  scaffoldRunId: ScaffoldRunId,
  scaffoldId: ScaffoldId,
  directoryName: ScaffoldDirectoryName,
}).annotations(strict);
const ObserveGit = Schema.Struct({
  kind: Schema.Literal("observe-git"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  maxDiffBytes: Schema.Int.pipe(Schema.between(1, 1024 * 1024)),
}).annotations(strict);
const StageGit = Schema.Struct({
  kind: Schema.Literal("stage-git"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  paths: Schema.NonEmptyArray(GitStagePath).pipe(
    Schema.filter(
      (paths) => paths.length <= MAX_CODE_OPERATION_PATHS && new Set(paths).size === paths.length,
    ),
  ),
  expectedStateToken: GitStateToken,
}).annotations(strict);
/**
 * Take listed paths back out of the index, leaving the files themselves
 * exactly as they are. Nothing is lost, so this is an ordinary index write
 * rather than a destructive operation.
 */
const UnstageGit = Schema.Struct({
  kind: Schema.Literal("unstage-git"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  paths: Schema.NonEmptyArray(GitStagePath).pipe(
    Schema.filter(
      (paths) => paths.length <= MAX_CODE_OPERATION_PATHS && new Set(paths).size === paths.length,
    ),
  ),
  expectedStateToken: GitStateToken,
}).annotations(strict);
/**
 * Ask this thread's own provider to draft delivery text from the change the
 * checkout already shows.
 *
 * Reading a diff and writing a sentence changes nothing, so this needs no
 * approval and never touches the checkout. The draft is a suggestion the user
 * edits and sends themselves; nothing here commits, pushes, or opens anything.
 */
const DraftGitText = Schema.Struct({
  kind: Schema.Literal("draft-git-text"),
  ...OperationScope,
  purpose: Schema.Literal("commit-message", "pull-request"),
}).annotations(strict);
/**
 * Throw away uncommitted work in the checkout. This is the one Git command
 * here that destroys content instead of recording it: what it removes was
 * never committed, so nothing in the repository can bring it back. It is
 * therefore an approval-class `destructive-or-irreversible` operation, carries
 * the exact paths in the receipt, and is never covered by a posture that
 * auto-accepts edits.
 */
const DiscardGitChanges = Schema.Struct({
  kind: Schema.Literal("discard-git-changes"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  paths: Schema.NonEmptyArray(GitStagePath).pipe(
    Schema.filter(
      (paths) => paths.length <= MAX_CODE_OPERATION_PATHS && new Set(paths).size === paths.length,
    ),
  ),
  expectedStateToken: GitStateToken,
}).annotations(strict);
const CommitGit = Schema.Struct({
  kind: Schema.Literal("commit-git"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  message: boundedNonEmptyText(MAX_CODE_OPERATION_TEXT_BYTES).pipe(
    Schema.filter((value) => !value.includes("\0")),
  ),
  stagedSummary: Schema.NonEmptyArray(StagedGitStatusEntry).pipe(
    Schema.filter((entries) => entries.length <= MAX_CODE_OPERATION_PATHS),
  ),
  expectedStateToken: GitStateToken,
}).annotations(strict);
const PushGit = Schema.Struct({
  kind: Schema.Literal("push-git"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  remote: GitRemoteName,
  localRef: GitBranchRef,
  remoteRef: GitBranchRef,
  expectedHeadOid: GitObjectId,
  expectedStateToken: GitStateToken,
  confirmation: GitPushConfirmation,
  authorization: GitAuthorization,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (command) =>
        command.confirmation.remote === command.remote &&
        command.confirmation.refspec === `${command.localRef}:${command.remoteRef}`,
    ),
  );
/**
 * The state of a checkout at one moment, recorded as ordinary Git objects so
 * nothing outside the repository has to hold the content.
 *
 * `worktree` is every tracked and untracked-but-not-ignored file as it stood;
 * `index` is what was staged at the same moment, so restoring puts back the
 * same staged/unstaged split the user had. Ignored files are not captured and
 * are never touched by a restore.
 */
export const CodeCheckpoint = Schema.Struct({
  worktree: GitObjectId,
  index: GitObjectId,
  /** The commit the checkout was on. Absent in a repository with no commits. */
  head: Schema.optional(GitObjectId),
}).annotations(strict);
export type CodeCheckpoint = typeof CodeCheckpoint.Type;
/**
 * Put the checkout's files back the way a checkpoint recorded them.
 *
 * This overwrites uncommitted work with older content, so it is an
 * approval-class `destructive-or-irreversible` operation like discarding. What
 * it replaces is not lost: the host records a checkpoint of the current state
 * first, and reports it back, so the restore is itself undoable.
 *
 * Unlike the other Git mutations this carries no state token. It does not
 * apply a change to the state the caller was looking at; it names an exact
 * recorded state to return to, which stays well defined however far the
 * checkout has moved since — and moving on is precisely when a restore is
 * wanted.
 */
const RestoreGitCheckpoint = Schema.Struct({
  kind: Schema.Literal("restore-git-checkpoint"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  checkpoint: CodeCheckpoint,
}).annotations(strict);
/**
 * What a finished run amounts to, measured against the branch it is meant to
 * come home to.
 *
 * This is the same Git the diff pane already renders, scoped to the branch
 * rather than the working tree: the commits this run added, the files it
 * touched, and whether the base could take them as they stand. Nothing here
 * mutates anything — reviewing a run is a read.
 */
export const CodeRunOutcome = Schema.Struct({
  branch: GitBranchName,
  baseRef: boundedNonEmptyText(512),
  head: GitObjectId,
  /** Absent when the base ref cannot be resolved in this repository. */
  base: Schema.optional(GitObjectId),
  ahead: Schema.Int.pipe(Schema.nonNegative()),
  behind: Schema.Int.pipe(Schema.nonNegative()),
  changedPaths: Schema.Array(CodeRelativePath).pipe(
    Schema.filter((paths) => paths.length <= MAX_CODE_OPERATION_PATHS),
  ),
  diff: CodeEvidenceReference,
  /** Files still uncommitted in the run's own worktree, which no merge carries. */
  uncommittedPaths: Schema.Array(CodeRelativePath).pipe(
    Schema.filter((paths) => paths.length <= MAX_CODE_OPERATION_PATHS),
  ),
  /**
   * Whether the base could take this run as it stands. `unknown` is an honest
   * answer from a Git that could not be asked, never an optimistic one.
   */
  mergeability: Schema.Literal("clean", "conflicts", "nothing-to-merge", "unknown"),
}).annotations(strict);
export type CodeRunOutcome = typeof CodeRunOutcome.Type;

/**
 * Read what a run produced, against the branch it targets. Read-only, so it
 * runs under the ordinary read gate and never needs an approval.
 */
const ReviewRun = Schema.Struct({
  kind: Schema.Literal("review-run"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  maxDiffBytes: Schema.Int.pipe(Schema.between(1, 1024 * 1024)),
}).annotations(strict);

/**
 * Bring a finished run home: merge its branch into the base, in the base
 * checkout.
 *
 * This mutates the checkout the person works in, so it carries the same
 * explicit confirmation a push does — the branch and base named here must match
 * what the host resolves — and the same approval class. The host records what
 * the checkout looked like first, so the merge can be put back.
 */
const MergeRun = Schema.Struct({
  kind: Schema.Literal("merge-run"),
  ...OperationScope,
  gitOperationId: CodeGitOperationId,
  confirmation: Schema.Struct({
    branch: GitBranchName,
    baseBranch: GitBranchName,
    expectedHeadOid: GitObjectId,
  }).annotations(strict),
  authorization: GitAuthorization,
}).annotations(strict);

const CreatePullRequest = Schema.Struct({
  kind: Schema.Literal("create-pull-request"),
  ...OperationScope,
  title: boundedNonEmptyText(512),
  body: boundedText(MAX_CODE_OPERATION_TEXT_BYTES),
  idempotencyKey: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._:-]{1,255}$/)),
  authorization: GitAuthorization,
}).annotations(strict);
const ObservePullRequest = Schema.Struct({
  kind: Schema.Literal("observe-pull-request"),
  ...OperationScope,
  maxDiffBytes: Schema.Int.pipe(Schema.between(1, 1024 * 1024)),
}).annotations(strict);
const PullRequestMergeMethod = Schema.Literal("merge", "squash", "rebase");
export type CodePullRequestMergeMethod = typeof PullRequestMergeMethod.Type;
const MergePullRequestConfirmation = Schema.Struct({
  number: Schema.Int.pipe(Schema.positive()),
  baseRepository: boundedNonEmptyText(512),
  baseBranch: GitBranchName,
  headBranch: GitBranchName,
  mergeMethod: PullRequestMergeMethod,
  expectedHeadSha: GitObjectId,
}).annotations(strict);
/** Host-advertised merge facts for clean mobile/desktop merge sheets. */
export const CodePullRequestMergePreview = Schema.Struct({
  headSha: GitObjectId,
  mergeable: Schema.NullOr(Schema.Boolean),
  requiredChecksPassing: Schema.Boolean,
  advertisedMergeMethods: Schema.Array(PullRequestMergeMethod).pipe(
    Schema.filter((values) => values.length <= 3 && new Set(values).size === values.length),
  ),
}).annotations(strict);
export type CodePullRequestMergePreview = typeof CodePullRequestMergePreview.Type;
const MergePullRequest = Schema.Struct({
  kind: Schema.Literal("merge-pull-request"),
  ...OperationScope,
  idempotencyKey: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._:-]{1,255}$/)),
  expectedHeadSha: GitObjectId,
  mergeMethod: PullRequestMergeMethod,
  confirmation: MergePullRequestConfirmation,
  authorization: GitAuthorization,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (command) =>
        command.confirmation.mergeMethod === command.mergeMethod &&
        command.confirmation.expectedHeadSha === command.expectedHeadSha,
    ),
  );
const CreateReviewFinding = Schema.Struct({
  kind: Schema.Literal("create-review-finding"),
  ...OperationScope,
  findingId: CodeReviewFindingId,
  fileId: CodeFileId,
  path: CodeRelativePath,
  fileDigest: CodeDigest,
  location: CodeReviewLocation,
  severity: Schema.Literal("note", "warning", "error"),
  summary: boundedNonEmptyText(4_096),
}).annotations(strict);
const UpdateReviewFinding = Schema.Struct({
  kind: Schema.Literal("update-review-finding"),
  ...OperationScope,
  findingId: CodeReviewFindingId,
  expectedVersion: AggregateVersion,
  state: Schema.Literal("open", "resolved", "dismissed"),
}).annotations(strict);
const StartProviderTurn = Schema.Struct({
  kind: Schema.Literal("start-provider-turn"),
  ...OperationScope,
  sessionId: ProviderSessionId,
  prompt: CodeEvidenceReference,
  /**
   * `#thread` mentions this turn points at. Ids only: the host
   * re-derives the sender's Open authority over each thread and reads its
   * bounded transcript at turn time, so a mention contributes read-only
   * context to this turn alone and never enters the prompt evidence the
   * journal records as the user's message. A transcript the browser resolved
   * is never trusted, and never sent.
   */
  /**
   * Images already staged for this thread. Ids only: the host reads the bytes
   * it staged itself, so a renderer cannot send the provider an image the host
   * never accepted, and the journal records the attachment by name and digest
   * rather than by content.
   */
  attachmentIds: Schema.optional(
    Schema.Array(CodeAttachmentId).pipe(Schema.maxItems(MAX_CODE_TURN_ATTACHMENTS)),
  ),
  threadMentionIds: Schema.optional(
    Schema.Array(MentionableThreadId).pipe(Schema.maxItems(MAX_THREAD_MENTIONS_PER_TURN)),
  ),
}).annotations(strict);
const AnswerProviderInput = Schema.Struct({
  kind: Schema.Literal("answer-provider-input"),
  ...OperationScope,
  requestId: ProviderRequestId,
  response: CodeEvidenceReference,
}).annotations(strict);
const AnswerProviderApproval = Schema.Struct({
  kind: Schema.Literal("answer-provider-approval"),
  ...OperationScope,
  approvalId: CodeApprovalId,
  decision: Schema.Literal("approved", "denied"),
}).annotations(strict);
const CancelProviderTurn = Schema.Struct({
  kind: Schema.Literal("cancel-provider-turn"),
  ...OperationScope,
}).annotations(strict);
export const CODE_OPERATION_COMMAND_KINDS = [
  "start-terminal",
  "attach-terminal",
  "write-terminal",
  "resize-terminal",
  "stop-terminal",
  "run-repository-test",
  "cancel-repository-test",
  "run-scaffold",
  "observe-git",
  "review-run",
  "merge-run",
  "stage-git",
  "commit-git",
  "push-git",
  "create-pull-request",
  "observe-pull-request",
  "merge-pull-request",
  "create-review-finding",
  "update-review-finding",
  "start-provider-turn",
  "answer-provider-input",
  "answer-provider-approval",
  "cancel-provider-turn",
] as const;

export const CodeOperationCommand = Schema.Union(
  ReviewRun,
  MergeRun,
  StartTerminal,
  AttachTerminal,
  WriteTerminal,
  ResizeTerminal,
  StopTerminal,
  RunRepositoryTest,
  CancelRepositoryTest,
  RunScaffold,
  ObserveGit,
  StageGit,
  DiscardGitChanges,
  CommitGit,
  PushGit,
  UnstageGit,
  DraftGitText,
  RestoreGitCheckpoint,
  CreatePullRequest,
  ObservePullRequest,
  MergePullRequest,
  CreateReviewFinding,
  UpdateReviewFinding,
  StartProviderTurn,
  AnswerProviderInput,
  AnswerProviderApproval,
  CancelProviderTurn,
);
export type CodeOperationCommand = typeof CodeOperationCommand.Type;

const GitRemoteUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "ssh:") &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        (url.protocol !== "https:" || url.username === "")
      );
    } catch {
      return false;
    }
  }),
);
const GitRemoteEndpoint = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("network"), url: GitRemoteUrl }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("local") }).annotations(strict),
);
const GitObservation = Schema.Struct({
  kind: Schema.Literal("git-observed"),
  operationId: CodeOperationId,
  gitOperationId: CodeGitOperationId,
  head: CodeOperationCheckoutHead,
  stateToken: GitStateToken,
  status: Schema.Array(GitStatusEntry).pipe(
    Schema.filter((entries) => entries.length <= MAX_CODE_OPERATION_PATHS),
  ),
  changedPaths: uniqueArray(CodeRelativePath, MAX_CODE_OPERATION_PATHS),
  diff: CodeEvidenceReference,
  remotes: Schema.Array(
    Schema.Struct({
      name: GitRemoteName,
      fetch: GitRemoteEndpoint,
      push: GitRemoteEndpoint,
    }).annotations(strict),
  ).pipe(Schema.filter((remotes) => remotes.length <= 64)),
  upstream: Schema.NullOr(
    Schema.Struct({ remote: GitRemoteName, mergeRef: GitBranchRef }).annotations(strict),
  ),
  worktrees: Schema.Array(
    Schema.Struct({
      checkoutId: CodeCheckoutId,
      head: CodeOperationCheckoutHead,
      state: Schema.Literal("active", "locked", "prunable", "unavailable"),
    }).annotations(strict),
  ).pipe(Schema.filter((worktrees) => worktrees.length <= 1_000)),
}).annotations(strict);
const TerminalStateFields = {
  operationId: CodeOperationId,
  terminalId: CodeTerminalId,
  transcript: Schema.optional(CodeEvidenceReference),
} as const;
const TerminalStateResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("terminal-state"),
    ...TerminalStateFields,
    state: Schema.Literal("running"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("terminal-state"),
    ...TerminalStateFields,
    state: Schema.Literal("exited"),
    exitCode: Schema.NullOr(Schema.Int),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("terminal-state"),
    ...TerminalStateFields,
    state: Schema.Literal("interrupted", "unavailable", "failed"),
  }).annotations(strict),
);
const RepositoryTestStateFields = {
  operationId: CodeOperationId,
  testRunId: CodeTestRunId,
  evidence: Schema.optional(CodeEvidenceReference),
  concerns: Schema.Array(CodeRepositoryTestConcern).pipe(
    Schema.filter((concerns) => new Set(concerns).size === concerns.length),
  ),
} as const;
const RepositoryTestResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("repository-test-state"),
    ...RepositoryTestStateFields,
    state: Schema.Literal("completed"),
    verdict: Schema.Literal("passed", "failed", "cancelled", "inconclusive", "unavailable"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("repository-test-state"),
    ...RepositoryTestStateFields,
    state: Schema.Literal("running", "interrupted", "unavailable", "failed"),
  }).annotations(strict),
);
const ScaffoldResult = Schema.Struct({
  kind: Schema.Literal("scaffold-run"),
  operationId: CodeOperationId,
  run: ScaffoldRun,
}).annotations(strict);
const GitMutationResult = Schema.Struct({
  kind: Schema.Literal("git-mutation-state"),
  operationId: CodeOperationId,
  gitOperationId: CodeGitOperationId,
  mutation: Schema.Literal(
    "stage",
    "unstage",
    "discard",
    "commit",
    "push",
    "revert",
    "restore-checkpoint",
    "merge-run",
  ),
  state: Schema.Literal("completed", "rejected", "failed"),
  headOid: Schema.optional(GitObjectId),
  /**
   * The state this mutation replaced, recorded before it ran. Present on a
   * completed restore, which is what makes undoing one possible, and on a
   * failed one, which may have moved files before it stopped.
   */
  undo: Schema.optional(CodeCheckpoint),
}).annotations(strict);
const PullRequestUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }),
);
const PullRequestResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("pull-request-state"),
    operationId: CodeOperationId,
    state: Schema.Literal("created", "existing", "merged"),
    number: Schema.Int.pipe(Schema.positive()),
    url: PullRequestUrl,
    headRepository: boundedNonEmptyText(512),
    headBranch: GitBranchName,
    baseRepository: boundedNonEmptyText(512),
    baseBranch: GitBranchName,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pull-request-state"),
    operationId: CodeOperationId,
    state: Schema.Literal("unavailable", "failed"),
    failureCode: Schema.optional(
      Schema.Literal(
        "conflict",
        "checks",
        "auth",
        "not-found",
        "sha-mismatch",
        "dirty",
        "not-mergeable",
      ),
    ),
  }).annotations(strict),
);
export const MAX_CODE_PULL_REQUEST_REVIEW_ITEMS = 500;

/**
 * The seven read-only sections of the linked-PR review window. When GitHub could
 * not refresh a section its identifier appears in `staleSections`; a stale
 * section is labeled in the UI and can never independently satisfy a delivery
 * target (see the delivery-target policy).
 */
export const CodePullRequestReviewSection = Schema.Literal(
  "description",
  "commits",
  "files",
  "diff",
  "checks",
  "reviews",
  "comments",
);
export type CodePullRequestReviewSection = typeof CodePullRequestReviewSection.Type;

export const CodePullRequestReviewCommit = Schema.Struct({
  oid: boundedNonEmptyText(64),
  messageHeadline: boundedText(1_024),
  author: boundedText(255),
}).annotations(strict);
export type CodePullRequestReviewCommit = typeof CodePullRequestReviewCommit.Type;

export const CodePullRequestReviewChangedFile = Schema.Struct({
  path: boundedNonEmptyText(4_096),
  additions: Schema.Int.pipe(Schema.nonNegative()),
  deletions: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type CodePullRequestReviewChangedFile = typeof CodePullRequestReviewChangedFile.Type;

export const CodePullRequestReviewCheck = Schema.Struct({
  name: boundedNonEmptyText(512),
  state: Schema.Literal("success", "failure", "pending", "neutral", "unknown"),
}).annotations(strict);
export type CodePullRequestReviewCheck = typeof CodePullRequestReviewCheck.Type;

export const CodePullRequestReviewOpinion = Schema.Struct({
  author: boundedText(255),
  state: Schema.Literal(
    "approved",
    "changes-requested",
    "commented",
    "dismissed",
    "pending",
    "unknown",
  ),
  body: boundedText(8_192),
}).annotations(strict);
export type CodePullRequestReviewOpinion = typeof CodePullRequestReviewOpinion.Type;

export const CodePullRequestReviewComment = Schema.Struct({
  author: boundedText(255),
  body: boundedText(16_384),
}).annotations(strict);
export type CodePullRequestReviewComment = typeof CodePullRequestReviewComment.Type;

const boundedReviewArray = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.Array(schema).pipe(
    Schema.filter((values) => values.length <= MAX_CODE_PULL_REQUEST_REVIEW_ITEMS),
  );

/**
 * The observation of the pull request linked to the thread's delivery branch.
 * `observed` carries every read-only review section; `none` means no matching PR
 * was found; `unavailable` means GitHub could not be observed at all. The
 * observation never mutates GitHub: commenting, approving, requesting changes,
 * merging, closing, and reopening remain on GitHub in v1. `ambiguous` is true
 * whenever the observation is stale or otherwise cannot be presented as a
 * settled result, so the window shows `Waiting` rather than `Done`.
 */
const PullRequestReviewResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("pull-request-review"),
    operationId: CodeOperationId,
    state: Schema.Literal("observed"),
    freshness: Schema.Literal("fresh", "stale"),
    ambiguous: Schema.Boolean,
    staleSections: uniqueArray(CodePullRequestReviewSection, 7),
    number: Schema.Int.pipe(Schema.positive()),
    url: PullRequestUrl,
    title: boundedText(1_024),
    pullRequestState: Schema.Literal("open", "merged", "closed", "draft"),
    baseRepository: boundedNonEmptyText(512),
    baseBranch: boundedNonEmptyText(255),
    headRepository: boundedText(512),
    headBranch: boundedNonEmptyText(255),
    author: boundedText(255),
    matchesDeliveryBranch: Schema.Boolean,
    description: CodeEvidenceReference,
    diff: CodeEvidenceReference,
    commits: boundedReviewArray(CodePullRequestReviewCommit),
    files: boundedReviewArray(CodePullRequestReviewChangedFile),
    checks: boundedReviewArray(CodePullRequestReviewCheck),
    reviews: boundedReviewArray(CodePullRequestReviewOpinion),
    comments: boundedReviewArray(CodePullRequestReviewComment),
    mergePreview: Schema.optional(CodePullRequestMergePreview),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pull-request-review"),
    operationId: CodeOperationId,
    state: Schema.Literal("none", "unavailable"),
    freshness: Schema.Literal("fresh", "stale"),
  }).annotations(strict),
);
const ReviewFindingResult = Schema.Struct({
  kind: Schema.Literal("review-finding-state"),
  operationId: CodeOperationId,
  finding: CodeReviewFinding,
}).annotations(strict);
const ProviderTurnResult = Schema.Struct({
  kind: Schema.Literal("provider-turn-state"),
  operationId: CodeOperationId,
  state: Schema.Literal("running", "waiting", "completed", "interrupted", "failed"),
  evidence: Schema.optional(CodeEvidenceReference),
}).annotations(strict);
const OperationAccepted = Schema.Struct({
  kind: Schema.Literal("operation-accepted"),
  operationId: CodeOperationId,
}).annotations(strict);
const OperationFailed = Schema.Struct({
  kind: Schema.Literal("operation-failed"),
  operationId: CodeOperationId,
  failure: CodeOperationFailure,
}).annotations(strict);

/**
 * Delivery text a provider drafted from the checkout's own change. Plain
 * suggestion: the user reads it, edits it, and decides whether to use it, so
 * nothing here has been committed, pushed, or opened.
 */
const GitDraftResult = Schema.Struct({
  kind: Schema.Literal("git-draft-state"),
  operationId: CodeOperationId,
  purpose: Schema.Literal("commit-message", "pull-request"),
  state: Schema.Literal("completed", "unavailable", "failed"),
  /** The one-line subject. Absent unless the draft completed. */
  title: Schema.optional(boundedNonEmptyText(512)),
  /** The longer body, when the provider wrote one. */
  body: Schema.optional(boundedNonEmptyText(MAX_CODE_OPERATION_TEXT_BYTES)),
}).annotations(strict);

const RunReviewResult = Schema.Struct({
  kind: Schema.Literal("run-reviewed"),
  operationId: CodeOperationId,
  gitOperationId: CodeGitOperationId,
  outcome: CodeRunOutcome,
}).annotations(strict);

export const CodeOperationResult = Schema.Union(
  RunReviewResult,
  OperationAccepted,
  TerminalStateResult,
  RepositoryTestResult,
  ScaffoldResult,
  GitObservation,
  GitMutationResult,
  GitDraftResult,
  PullRequestResult,
  PullRequestReviewResult,
  ReviewFindingResult,
  ProviderTurnResult,
  OperationFailed,
);
export type CodeOperationResult = typeof CodeOperationResult.Type;

export type CodePullRequestReview = Extract<
  CodeOperationResult,
  { readonly kind: "pull-request-review" }
>;
export type CodePullRequestReviewObserved = Extract<
  CodePullRequestReview,
  { readonly state: "observed" }
>;

const OperationStateEvent = Schema.Struct({
  kind: Schema.Literal("operation-state"),
  state: Schema.Literal("running", "waiting", "completed", "interrupted", "failed"),
  failure: Schema.optional(CodeOperationFailure),
}).annotations(strict);
const ConversationTurnStartedEvent = Schema.Struct({
  kind: Schema.Literal("conversation-turn-started"),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  sessionId: ProviderSessionId,
  prompt: CodeEvidenceReference,
  /** Images sent with this turn. Absent when the turn attached none. */
  attachments: Schema.optional(
    Schema.Array(CodeAttachmentReference).pipe(Schema.maxItems(MAX_CODE_TURN_ATTACHMENTS)),
  ),
  /**
   * The checkout as it stood just before the provider was asked, so the user
   * can put the files back the way they were at any message. Absent when the
   * checkout could not be read, and on turns journaled before checkpoints
   * existed.
   */
  checkpoint: Schema.optional(CodeCheckpoint),
}).annotations(strict);
const ContentEvent = Schema.Struct({
  kind: Schema.Literal("provider-content"),
  channel: Schema.Literal("reasoning", "message"),
  content: CodeEvidenceReference,
}).annotations(strict);
const TerminalOutputEvent = Schema.Struct({
  kind: Schema.Literal("terminal-output"),
  terminalId: CodeTerminalId,
  content: CodeEvidenceReference,
  replace: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}).annotations(strict);
const TerminalStateChangedEvent = Schema.Struct({
  kind: Schema.Literal("terminal-state-changed"),
  terminalId: CodeTerminalId,
  state: Schema.Literal("running", "exited", "interrupted"),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
}).annotations(strict);
const ToolEvent = Schema.Struct({
  kind: Schema.Literal("tool-activity"),
  toolCallId: ProviderRequestId,
  toolName: boundedNonEmptyText(255),
  state: Schema.Literal("started", "running", "completed", "failed"),
  summary: Schema.optional(boundedNonEmptyText(2_048)),
}).annotations(strict);
const ApprovalEvent = Schema.Struct({
  kind: Schema.Literal("approval-requested"),
  approvalId: CodeApprovalId,
  action: Schema.Literal(
    "file-mutation",
    "terminal",
    "test",
    "git-stage",
    "git-commit",
    "git-push",
    "pull-request-create",
    "pull-request-merge",
    "provider-tool",
  ),
  summary: boundedNonEmptyText(2_048),
}).annotations(strict);
const QuestionEvent = Schema.Struct({
  kind: Schema.Literal("input-requested"),
  requestId: ProviderRequestId,
  prompt: boundedNonEmptyText(8 * 1024),
  options: Schema.Array(boundedNonEmptyText(1_024)).pipe(
    Schema.filter((options) => options.length <= 32),
  ),
}).annotations(strict);
const FileChangeEvent = Schema.Struct({
  kind: Schema.Literal("file-change"),
  path: CodeRelativePath,
  change: Schema.Literal("created", "modified", "deleted"),
  reconciled: Schema.Boolean,
}).annotations(strict);
const DiffEvent = Schema.Struct({
  kind: Schema.Literal("diff"),
  content: CodeEvidenceReference,
  reconciled: Schema.Boolean,
}).annotations(strict);
const TaskProgressEvent = Schema.Struct({
  kind: Schema.Literal("task-progress"),
  taskId: boundedNonEmptyText(255),
  state: Schema.Literal("pending", "running", "waiting", "completed", "failed"),
  summary: boundedNonEmptyText(2_048),
}).annotations(strict);
const UsageEvent = Schema.Struct({
  kind: Schema.Literal("usage"),
  inputTokens: Schema.Int.pipe(Schema.nonNegative()),
  outputTokens: Schema.Int.pipe(Schema.nonNegative()),
  /**
   * What the provider says this turn cost, in US dollars. Absent whenever the
   * provider reports no cost: the host never derives one from a price list of
   * its own.
   */
  costUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
}).annotations(strict);
/**
 * How much of a provider usage window this account has spent, as the provider
 * reported it during the turn. Recording it lets a thread show the window
 * closing in before a turn fails against it.
 */
const ProviderLimitEvent = Schema.Struct({
  kind: Schema.Literal("provider-limit"),
  window: boundedNonEmptyText(64),
  status: Schema.Literal("allowed", "warning", "exhausted"),
  utilization: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
  resetsAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
const ChildActivityEvent = Schema.Struct({
  kind: Schema.Literal("child-activity"),
  childId: boundedNonEmptyText(255),
  state: Schema.Literal("starting", "running", "waiting", "completed", "failed"),
  summary: boundedNonEmptyText(2_048),
}).annotations(strict);
const ResultEvent = Schema.Struct({
  kind: Schema.Literal("operation-result"),
  result: CodeOperationResult,
}).annotations(strict);

export const CodeOperationEvent = Schema.Union(
  ConversationTurnStartedEvent,
  OperationStateEvent,
  ContentEvent,
  TerminalOutputEvent,
  TerminalStateChangedEvent,
  ToolEvent,
  ApprovalEvent,
  QuestionEvent,
  FileChangeEvent,
  DiffEvent,
  TaskProgressEvent,
  UsageEvent,
  ProviderLimitEvent,
  ChildActivityEvent,
  ResultEvent,
);
export type CodeOperationEvent = typeof CodeOperationEvent.Type;

export const CodeOperationEventFrame = Schema.Struct({
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  cursor: Schema.Int.pipe(Schema.positive()),
  occurredAt: UtcTimestamp,
  event: CodeOperationEvent,
}).annotations(strict);
export type CodeOperationEventFrame = typeof CodeOperationEventFrame.Type;

export const MAX_CODE_CONVERSATION_PAGE_SIZE = 100;
export const MAX_CODE_CONVERSATION_ASSISTANT_PARTS = 256;
/**
 * How much of a turn's work the durable conversation carries back.
 *
 * A single turn can journal thousands of tool events; replaying all of them
 * would make reopening a thread as expensive as running it. The projection
 * keeps the first steps in arrival order and stops, so the transcript is
 * honest about the shape of the turn without pretending to be its journal —
 * the full record stays in the operation event stream.
 */
export const MAX_CODE_CONVERSATION_TURN_STEPS = 64;

/**
 * One thing a turn did besides writing its message: a tool call, or a stretch
 * of reasoning-channel output. Steps are what the live transcript already
 * shows; recording them on the turn is what lets a reopened thread show the
 * same rows instead of a bare message.
 */
export const CodeConversationStep = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("tool"),
    toolCallId: ProviderRequestId,
    toolName: boundedNonEmptyText(255),
    state: Schema.Literal("started", "running", "completed", "failed"),
    summary: Schema.optional(boundedNonEmptyText(2_048)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("reasoning"),
    content: CodeEvidenceReference,
  }).annotations(strict),
);
export type CodeConversationStep = typeof CodeConversationStep.Type;

export const CodeConversationTurnUsage = Schema.Struct({
  inputTokens: Schema.Int.pipe(Schema.nonNegative()),
  outputTokens: Schema.Int.pipe(Schema.nonNegative()),
  /** The provider's own price for the turn. Never one the host derived. */
  costUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
}).annotations(strict);
export type CodeConversationTurnUsage = typeof CodeConversationTurnUsage.Type;

/**
 * How much of a provider usage window this account has spent, as last
 * reported. Account state rather than turn state, so it belongs to the page.
 */
export const CodeProviderLimit = Schema.Struct({
  window: boundedNonEmptyText(64),
  status: Schema.Literal("allowed", "warning", "exhausted"),
  utilization: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
  resetsAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CodeProviderLimit = typeof CodeProviderLimit.Type;

export const CodeConversationTurn = Schema.Struct({
  operationId: CodeOperationId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  sessionId: ProviderSessionId,
  prompt: CodeEvidenceReference,
  /** Images the user attached to this turn. Absent when it attached none. */
  attachments: Schema.optional(
    Schema.Array(CodeAttachmentReference).pipe(Schema.maxItems(MAX_CODE_TURN_ATTACHMENTS)),
  ),
  /** The checkout as it stood before this turn ran, when the host caught it. */
  checkpoint: Schema.optional(CodeCheckpoint),
  /**
   * What this turn consumed, as the provider reported it. Absent on a turn
   * whose provider reported nothing, which is not the same as zero.
   */
  usage: Schema.optional(CodeConversationTurnUsage),
  assistant: Schema.Array(CodeEvidenceReference).pipe(
    Schema.filter((parts) => parts.length <= MAX_CODE_CONVERSATION_ASSISTANT_PARTS),
  ),
  /** Bounded, in arrival order. Absent on a turn that recorded no steps. */
  steps: Schema.optional(
    Schema.Array(CodeConversationStep).pipe(
      Schema.filter((steps) => steps.length <= MAX_CODE_CONVERSATION_TURN_STEPS),
    ),
  ),
  /** Whether the turn journaled more steps than `steps` carries. */
  stepsTruncated: Schema.optional(Schema.Boolean),
  status: Schema.Literal("waiting", "completed", "interrupted", "failed", "incomplete"),
  startedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeConversationTurn = typeof CodeConversationTurn.Type;

export const CodeConversationPage = Schema.Struct({
  /**
   * Version 2 added the images a turn carried. A client that only knows
   * version 1 refuses the page outright rather than rendering a message
   * while silently dropping the pictures the user attached to it.
   */
  version: Schema.Literal(2),
  threadId: CodeThreadId,
  turns: Schema.Array(CodeConversationTurn).pipe(
    Schema.filter((turns) => turns.length <= MAX_CODE_CONVERSATION_PAGE_SIZE),
  ),
  nextCursor: Schema.Int.pipe(Schema.nonNegative()),
  hasMore: Schema.Boolean,
  /**
   * The provider usage windows this thread last heard about, most recent
   * report per window. Absent when the provider reported none.
   */
  limits: Schema.optional(Schema.Array(CodeProviderLimit).pipe(Schema.maxItems(8))),
  /**
   * What this thread's most recent restore replaced, as the host recorded it
   * before overwriting the checkout. Thread state rather than turn state, so it
   * belongs to the page: the surface that ran the restore is gone as soon as the
   * user opens another tab, and the way back must outlive it. Absent when the
   * thread has never restored, or when its last restore was rejected and so
   * replaced nothing.
   */
  restoreUndo: Schema.optional(CodeCheckpoint),
}).annotations(strict);
export type CodeConversationPage = typeof CodeConversationPage.Type;

export const MAX_CODE_THREAD_METADATA_VIEW_SIZE = 5_000;
export const MAX_CODE_THREAD_METADATA_RECOVERY_REASONS = 8;

/**
 * Whether a piece of derived Code-thread metadata reflects a successful live
 * observation (`fresh`) or a last-known value that could not be refreshed
 * (`stale`). Stale GitHub metadata is surfaced to the user but can never
 * independently satisfy a delivery target (see the delivery-target policy).
 */
export const CodeMetadataFreshness = Schema.Literal("fresh", "stale");
export type CodeMetadataFreshness = typeof CodeMetadataFreshness.Type;

/**
 * The checkout/worktree a Code thread operates in. `unavailable` means the
 * managed worktree could not be observed this projection; its Git-derived
 * metadata is therefore treated as stale.
 */
export const CodeThreadWorktreeMetadata = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("available"),
    checkoutId: CodeCheckoutId,
    path: boundedNonEmptyText(4_096),
    head: CodeCheckoutHead,
    receiptId: Schema.optional(WorktreeReceiptId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    checkoutId: CodeCheckoutId,
  }).annotations(strict),
);
export type CodeThreadWorktreeMetadata = typeof CodeThreadWorktreeMetadata.Type;

/**
 * Changed-file state for the thread's worktree. `observed` carries the counts
 * and the committed-ahead/working-tree signals the delivery-target policy needs
 * to classify a local implementation; `unavailable` means the worktree could
 * not be observed.
 */
export const CodeThreadChangedFileState = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("observed"),
    freshness: CodeMetadataFreshness,
    changedPathCount: Schema.Int.pipe(Schema.nonNegative()),
    stagedCount: Schema.Int.pipe(Schema.nonNegative()),
    committedAhead: Schema.Int.pipe(Schema.nonNegative()),
    workingTreeClean: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
  }).annotations(strict),
);
export type CodeThreadChangedFileState = typeof CodeThreadChangedFileState.Type;

export const CodeThreadPullRequestState = Schema.Literal("open", "merged", "closed");
export type CodeThreadPullRequestState = typeof CodeThreadPullRequestState.Type;

/**
 * The pull request linked to the thread's delivery branch, or `none` when no
 * matching pull request was observed. `freshness` reflects whether the GitHub
 * observation succeeded; a `stale` linked PR is shown but cannot satisfy a
 * delivery target on its own.
 */
export const CodeThreadLinkedPullRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("linked"),
    freshness: CodeMetadataFreshness,
    number: Schema.Int.pipe(Schema.positive()),
    url: PullRequestUrl,
    baseRepository: boundedNonEmptyText(512),
    baseBranch: boundedNonEmptyText(255),
    headBranch: boundedNonEmptyText(255),
    state: CodeThreadPullRequestState,
    matchesDeliveryBranch: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("none"),
    freshness: CodeMetadataFreshness,
  }).annotations(strict),
);
export type CodeThreadLinkedPullRequest = typeof CodeThreadLinkedPullRequest.Type;

export const CodeThreadCheckState = Schema.Struct({
  freshness: CodeMetadataFreshness,
  state: Schema.Literal("unknown", "pending", "passing", "failing"),
}).annotations(strict);
export type CodeThreadCheckState = typeof CodeThreadCheckState.Type;

export const CodeThreadReviewState = Schema.Struct({
  freshness: CodeMetadataFreshness,
  state: Schema.Literal("unknown", "none", "pending", "approved", "changes-requested"),
}).annotations(strict);
export type CodeThreadReviewState = typeof CodeThreadReviewState.Type;

/**
 * A summary of the thread's child agents derived from operation-journal
 * activity. `active` counts non-terminal child runs; `unacknowledgedResults`
 * counts terminal child runs whose required result the user has not yet
 * acknowledged. Either being non-zero keeps an otherwise-satisfied delivery
 * target in `waiting`.
 */
export const CodeThreadChildAgentSummary = Schema.Struct({
  active: Schema.Int.pipe(Schema.nonNegative()),
  completed: Schema.Int.pipe(Schema.nonNegative()),
  failed: Schema.Int.pipe(Schema.nonNegative()),
  unacknowledgedResults: Schema.Int.pipe(Schema.nonNegative()),
  latestSummary: Schema.optional(boundedNonEmptyText(2_048)),
  latestActivityAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CodeThreadChildAgentSummary = typeof CodeThreadChildAgentSummary.Type;

export const CodeThreadMetadataRecoveryReason = Schema.Literal(
  "project-projection-missing",
  "operation-journal-rebuild-required",
);
export type CodeThreadMetadataRecoveryReason = typeof CodeThreadMetadataRecoveryReason.Type;

/**
 * Recovery status for a thread's metadata card. `ok` means the projection is
 * whole. `recovering` keeps the thread visible with one or more actionable
 * reasons (e.g. a temporarily missing Project projection) instead of dropping
 * the card.
 */
export const CodeThreadMetadataRecovery = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("ok") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("recovering"),
    reasons: Schema.NonEmptyArray(CodeThreadMetadataRecoveryReason).pipe(
      Schema.filter(
        (reasons) =>
          reasons.length <= MAX_CODE_THREAD_METADATA_RECOVERY_REASONS &&
          new Set(reasons).size === reasons.length,
      ),
    ),
  }).annotations(strict),
);
export type CodeThreadMetadataRecovery = typeof CodeThreadMetadataRecovery.Type;

/**
 * The server-authoritative satisfaction of a thread's confirmed delivery
 * target. Mirrors the delivery-target policy's `pending`/`waiting`/`done`:
 * ambiguous or stale evidence resolves to `waiting`, never `done`.
 */
export const CodeThreadDeliverySatisfaction = Schema.Literal("pending", "waiting", "done");
export type CodeThreadDeliverySatisfaction = typeof CodeThreadDeliverySatisfaction.Type;

/**
 * The journal-rebuildable operational metadata projection for a single
 * non-archived Code thread: worktree/branch, changed-file state, linked pull
 * request, checks, review state, active child-agent summary, and last
 * meaningful activity, plus the derived delivery satisfaction and recovery
 * status. Every field is a projection over the operation journal, the Git
 * observation, the GitHub observation, and managed-worktree receipts; nothing
 * here is independently mutable.
 */
export const CodeThreadOperationalMetadata = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  outcomeKind: CodeDeliveryOutcomeKind,
  worktree: CodeThreadWorktreeMetadata,
  changedFiles: CodeThreadChangedFileState,
  linkedPullRequest: CodeThreadLinkedPullRequest,
  checks: CodeThreadCheckState,
  reviewState: CodeThreadReviewState,
  childAgents: CodeThreadChildAgentSummary,
  lastMeaningfulActivityAt: Schema.NullOr(UtcTimestamp),
  githubFreshness: CodeMetadataFreshness,
  deliverySatisfaction: CodeThreadDeliverySatisfaction,
  recovery: CodeThreadMetadataRecovery,
  rebuiltFromJournal: Schema.Boolean,
}).annotations(strict);
export type CodeThreadOperationalMetadata = typeof CodeThreadOperationalMetadata.Type;

export const CodeThreadOperationalMetadataView = Schema.Struct({
  version: Schema.Literal(1),
  threads: Schema.Array(CodeThreadOperationalMetadata).pipe(
    Schema.filter(
      (threads) =>
        threads.length <= MAX_CODE_THREAD_METADATA_VIEW_SIZE &&
        new Set(threads.map((thread) => thread.threadId)).size === threads.length,
    ),
  ),
}).annotations(strict);
export type CodeThreadOperationalMetadataView = typeof CodeThreadOperationalMetadataView.Type;

const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

/**
 * Persistent follow-up marker for a single Code thread. It is a user obligation
 * to revisit the thread, deliberately independent of unread, runtime status, and
 * work-item state: viewing the thread, completing every task, or a runtime status
 * change never clears it. Only an explicit `complete-code-follow-up` command
 * acknowledges the current trigger. It shares the normalized `ThreadFollowUp`
 * shape used by Chat/Work so a single durable model spans every mode.
 */
export const CodeThreadFollowUp = Schema.Struct({
  threadId: CodeThreadId,
  state: Schema.Literal("open", "completed"),
  origin: Schema.Literal("manual", "automatic"),
  reason: Schema.NonEmptyTrimmedString,
  triggerSequence: NonNegativeInt,
  acknowledgedThroughSequence: NonNegativeInt,
  createdAt: UtcTimestamp,
  completedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CodeThreadFollowUp = typeof CodeThreadFollowUp.Type;

/**
 * Opens (or re-triggers) follow-up on a Code thread. `manual` origin is a direct
 * user `Mark for follow-up`; `automatic` origin is an edge-derived trigger (a new
 * approval, question, waiting task, or failed operation). `triggerSequence` is the
 * monotonic source sequence used for edge-based, idempotent, replay-safe
 * evaluation: a strictly newer sequence than the acknowledged one reopens an
 * acknowledged marker exactly once.
 */
export const OpenCodeFollowUpCommand = Schema.Struct({
  kind: Schema.Literal("open-code-follow-up"),
  threadId: CodeThreadId,
  expectedVersion: AggregateVersion,
  reason: Schema.NonEmptyTrimmedString,
  origin: Schema.Literal("manual", "automatic"),
  triggerSequence: NonNegativeInt,
}).annotations(strict);
export type OpenCodeFollowUpCommand = typeof OpenCodeFollowUpCommand.Type;

/**
 * Acknowledges the current follow-up obligation. `acknowledgedThroughSequence`
 * must match the open marker's current `triggerSequence`; a later trigger can
 * reopen it, but a previously acknowledged sequence never does.
 */
export const CompleteCodeFollowUpCommand = Schema.Struct({
  kind: Schema.Literal("complete-code-follow-up"),
  threadId: CodeThreadId,
  expectedVersion: AggregateVersion,
  acknowledgedThroughSequence: NonNegativeInt,
}).annotations(strict);
export type CompleteCodeFollowUpCommand = typeof CompleteCodeFollowUpCommand.Type;

export const CodeFollowUpCommand = Schema.Union(
  OpenCodeFollowUpCommand,
  CompleteCodeFollowUpCommand,
);
export type CodeFollowUpCommand = typeof CodeFollowUpCommand.Type;

export const CodeThreadFollowUpUpdated = Schema.Struct({
  kind: Schema.Literal("code-follow-up-updated"),
  followUp: CodeThreadFollowUp,
}).annotations(strict);
export type CodeThreadFollowUpUpdated = typeof CodeThreadFollowUpUpdated.Type;

/**
 * The follow-up projection for one Code thread. `followUpVersion` is the
 * authoritative aggregate version callers echo back as `expectedVersion`;
 * `followUp` is absent until the marker is first opened.
 */
export const CodeThreadFollowUpView = Schema.Struct({
  threadId: CodeThreadId,
  followUpVersion: AggregateVersion,
  followUp: Schema.optional(CodeThreadFollowUp),
}).annotations(strict);
export type CodeThreadFollowUpView = typeof CodeThreadFollowUpView.Type;

export const MAX_CODE_BOARD_SEARCH_BYTES = 1_024;
export const MAX_CODE_BOARD_QUERY_PROJECTS = 1_000;
export const MAX_CODE_BOARD_QUERY_PROVIDERS = 256;
export const MAX_CODE_BOARD_CARDS = 5_000;
export const MAX_CODE_BOARD_CARD_BLOCKING_REASON_BYTES = 2_048;

/**
 * The runtime-derived status of a Code thread on the board. It mirrors the
 * domain `deriveCodeBoardStatus` result: it is always projected from
 * authoritative runtime, Git, GitHub, and delivery-target evidence, never
 * manually assigned. Ambiguous or stale evidence can never produce `done`.
 */
export const CodeBoardStatus = Schema.Literal("ready", "in-progress", "waiting", "done");
export type CodeBoardStatus = typeof CodeBoardStatus.Type;

/**
 * The pull-request filter on the board toolbar. `any` disables the filter;
 * `linked` matches any linked PR; `none` matches threads with no linked PR; the
 * remaining values match a linked PR in that GitHub state.
 */
export const CodeBoardPullRequestFilter = Schema.Literal(
  "any",
  "linked",
  "none",
  "open",
  "merged",
  "closed",
);
export type CodeBoardPullRequestFilter = typeof CodeBoardPullRequestFilter.Type;

export const CodeBoardCheckFilter = Schema.Literal(
  "any",
  "unknown",
  "pending",
  "passing",
  "failing",
);
export type CodeBoardCheckFilter = typeof CodeBoardCheckFilter.Type;

/**
 * The follow-up filter. `any` disables it; `only` keeps threads flagged for
 * follow-up; `excluded` hides them. Follow-up remains independent of runtime
 * status (a Done card may still carry follow-up).
 */
export const CodeBoardFollowUpFilter = Schema.Literal("any", "only", "excluded");
export type CodeBoardFollowUpFilter = typeof CodeBoardFollowUpFilter.Type;

/**
 * The server-side board query. Every filter is optional; an omitted `statuses`
 * filter means the default all-status board (`ready`, `in-progress`, `waiting`,
 * and `done`), so completed threads are never implicitly suppressed. Grouping is
 * a client concern and is deliberately not part of the query: switching between
 * Status and Project grouping issues no command and changes no server state.
 */
export const CodeBoardQuery = Schema.Struct({
  version: Schema.Literal(1),
  text: Schema.optional(boundedText(MAX_CODE_BOARD_SEARCH_BYTES)),
  statuses: Schema.optional(uniqueArray(CodeBoardStatus, 4)),
  projectIds: Schema.optional(uniqueArray(ProjectId, MAX_CODE_BOARD_QUERY_PROJECTS)),
  providerInstanceIds: Schema.optional(
    uniqueArray(ProviderInstanceId, MAX_CODE_BOARD_QUERY_PROVIDERS),
  ),
  deliveryTargets: Schema.optional(uniqueArray(CodeDeliveryOutcomeKind, 4)),
  pullRequest: Schema.optional(CodeBoardPullRequestFilter),
  checks: Schema.optional(CodeBoardCheckFilter),
  followUp: Schema.optional(CodeBoardFollowUpFilter),
}).annotations(strict);
export type CodeBoardQuery = typeof CodeBoardQuery.Type;

/**
 * One normalized, server-resolved board card per non-archived Code thread that
 * matches the active query. It composes the journal-rebuildable operational
 * metadata (worktree/branch, changed files, linked PR, checks, review, child
 * agents, recovery, delivery satisfaction, activity) with the derived board
 * `status`, live `executing` activity, and permission-filtered thread identity.
 * Unread and follow-up are carried but never influence `status`.
 */
export const CodeBoardCard = Schema.Struct({
  threadId: CodeThreadId,
  projectId: ProjectId,
  checkoutId: CodeCheckoutId,
  title: boundedNonEmptyText(512),
  status: CodeBoardStatus,
  outcomeKind: CodeDeliveryOutcomeKind,
  deliverySatisfaction: CodeThreadDeliverySatisfaction,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  executing: Schema.Boolean,
  worktree: CodeThreadWorktreeMetadata,
  changedFiles: CodeThreadChangedFileState,
  linkedPullRequest: CodeThreadLinkedPullRequest,
  checks: CodeThreadCheckState,
  reviewState: CodeThreadReviewState,
  childAgents: CodeThreadChildAgentSummary,
  recovery: CodeThreadMetadataRecovery,
  githubFreshness: CodeMetadataFreshness,
  blockingReason: Schema.optional(boundedNonEmptyText(MAX_CODE_BOARD_CARD_BLOCKING_REASON_BYTES)),
  unread: Schema.Boolean,
  followUp: Schema.Boolean,
  lastMeaningfulActivityAt: Schema.NullOr(UtcTimestamp),
}).annotations(strict);
export type CodeBoardCard = typeof CodeBoardCard.Type;

/**
 * One ordered, runtime-derived board result. `query` echoes the effective query
 * (with any applied status filter) so the client can summarize which filters are
 * active. `cards` is a single ordered set; both Status and Project grouping are
 * pure client projections over it and can never reclassify or duplicate a card.
 */
export const CodeBoardView = Schema.Struct({
  version: Schema.Literal(1),
  query: CodeBoardQuery,
  cards: Schema.Array(CodeBoardCard).pipe(
    Schema.filter(
      (cards) =>
        cards.length <= MAX_CODE_BOARD_CARDS &&
        new Set(cards.map((card) => card.threadId)).size === cards.length,
    ),
  ),
  generatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeBoardView = typeof CodeBoardView.Type;

/**
 * The effects a thread may seek an approval for.
 *
 * A command absent here cannot be approved at all, so in the approval-gated and
 * auto-accept-edits postures it is not merely unprompted: the request fails to
 * decode and the command never reaches the service. Every Git effect the
 * renderer gates therefore has to appear, including the three that take work
 * back out of the index or off the disk.
 */
const APPROVAL_GATED_OPERATION_KINDS = new Set([
  "start-terminal",
  "run-repository-test",
  "cancel-repository-test",
  "run-scaffold",
  "stage-git",
  "unstage-git",
  "discard-git-changes",
  "restore-git-checkpoint",
  "commit-git",
  "push-git",
  "create-pull-request",
  "merge-pull-request",
  "create-review-finding",
  "update-review-finding",
]);

export const CodeApprovalEffect = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("operation"),
    command: CodeOperationCommand.pipe(
      Schema.filter((command) => APPROVAL_GATED_OPERATION_KINDS.has(command.kind)),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("apple-action"),
    request: AppleActionRequest,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-thread-full-access"),
    thread: CodeThread.pipe(Schema.filter((thread) => thread.executionPolicy === "full-access")),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-thread-full-access"),
    threadId: CodeThreadId,
    expectedVersion: AggregateVersion,
    permissionPersistence: PermissionPersistence,
  }).annotations(strict),
);
export type CodeApprovalEffect = typeof CodeApprovalEffect.Type;

export const CodeOperationApprovalRequest = Schema.Struct({
  effect: CodeApprovalEffect,
}).annotations(strict);
export type CodeOperationApprovalRequest = typeof CodeOperationApprovalRequest.Type;

export const CodeOperationApprovalReceipt = Schema.Struct({
  approvalId: CodeApprovalId,
}).annotations(strict);
export type CodeOperationApprovalReceipt = typeof CodeOperationApprovalReceipt.Type;

export const CodeOperationApprovalChallenge = Schema.Struct({
  challengeId: CodeApprovalId,
  effectDigest: CodeDigest,
  contextDigest: CodeDigest,
  projectId: ProjectId,
  threadId: CodeThreadId,
  threadTitle: boundedNonEmptyText(512),
  checkoutId: CodeCheckoutId,
  repositoryId: CodeRepositoryId,
  checkoutHead: CodeCheckoutHead,
  pullRequestTarget: Schema.optional(
    Schema.Struct({
      baseRepository: boundedNonEmptyText(512),
      baseBranch: boundedNonEmptyText(255),
      head: boundedNonEmptyText(255),
    }).annotations(strict),
  ),
  message: boundedNonEmptyText(512),
  // A challenge includes the full bounded effect plus authoritative scope metadata.
  detail: boundedNonEmptyText(MAX_CODE_OPERATION_TEXT_BYTES + 4_096),
}).annotations(strict);
export type CodeOperationApprovalChallenge = typeof CodeOperationApprovalChallenge.Type;

export const CodeOperationApprovalConfirmation = Schema.Struct({
  challengeId: CodeApprovalId,
}).annotations(strict);
export type CodeOperationApprovalConfirmation = typeof CodeOperationApprovalConfirmation.Type;

export const decodeCodeOperationId = Schema.decodeUnknownSync(CodeOperationId);
export const decodeCodeTerminalInspectionRequest = Schema.decodeUnknownSync(
  CodeTerminalInspectionRequest,
);
export const decodeCodeTerminalInspection = Schema.decodeUnknownSync(CodeTerminalInspection);
export const decodeCodeApprovalId = Schema.decodeUnknownSync(CodeApprovalId);
export const decodeCodeEvidenceReference = Schema.decodeUnknownSync(CodeEvidenceReference);
export const decodeCodeFileOpenResultEnvelope = Schema.decodeUnknownSync(
  CodeFileOpenResultEnvelope,
);
export const decodeCodeOperationCommand = Schema.decodeUnknownSync(CodeOperationCommand);
export const decodeCodeRunOutcome = Schema.decodeUnknownSync(CodeRunOutcome);
export const decodeCodeOperationResult = Schema.decodeUnknownSync(CodeOperationResult);
export const decodeCodeOperationEvent = Schema.decodeUnknownSync(CodeOperationEvent);
export const decodeCodeOperationEventFrame = Schema.decodeUnknownSync(CodeOperationEventFrame);
export const decodeCodeConversationTurn = Schema.decodeUnknownSync(CodeConversationTurn);
export const decodeCodeConversationPage = Schema.decodeUnknownSync(CodeConversationPage);
export const decodeCodeOperationApprovalRequest = Schema.decodeUnknownSync(
  CodeOperationApprovalRequest,
);
export const decodeCodeOperationApprovalReceipt = Schema.decodeUnknownSync(
  CodeOperationApprovalReceipt,
);
export const decodeCodeOperationApprovalChallenge = Schema.decodeUnknownSync(
  CodeOperationApprovalChallenge,
);
export const decodeCodeOperationApprovalConfirmation = Schema.decodeUnknownSync(
  CodeOperationApprovalConfirmation,
);
export const decodeCodeThreadOperationalMetadata = Schema.decodeUnknownSync(
  CodeThreadOperationalMetadata,
);
export const decodeCodeThreadOperationalMetadataView = Schema.decodeUnknownSync(
  CodeThreadOperationalMetadataView,
);
export const decodeCodeBoardStatus = Schema.decodeUnknownSync(CodeBoardStatus);
export const decodeCodeBoardQuery = Schema.decodeUnknownSync(CodeBoardQuery);
export const decodeCodeBoardCard = Schema.decodeUnknownSync(CodeBoardCard);
export const decodeCodeBoardView = Schema.decodeUnknownSync(CodeBoardView);
export const decodeCodeReviewLocation = Schema.decodeUnknownSync(CodeReviewLocation);
export const decodeCodeReviewAuthor = Schema.decodeUnknownSync(CodeReviewAuthor);
export const decodeCodeReviewProvenance = Schema.decodeUnknownSync(CodeReviewProvenance);
export const decodeCodeReviewFinding = Schema.decodeUnknownSync(CodeReviewFinding);
export const decodeCodeReviewFindingUpdated = Schema.decodeUnknownSync(CodeReviewFindingUpdated);
export const decodeCodeThreadFollowUp = Schema.decodeUnknownSync(CodeThreadFollowUp);
export const decodeCodeFollowUpCommand = Schema.decodeUnknownSync(CodeFollowUpCommand);
export const decodeCodeThreadFollowUpUpdated = Schema.decodeUnknownSync(CodeThreadFollowUpUpdated);
export const decodeCodeThreadFollowUpView = Schema.decodeUnknownSync(CodeThreadFollowUpView);
