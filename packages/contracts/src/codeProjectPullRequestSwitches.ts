import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { CodeProjectPullRequestMergeMethod } from "./codeProjectPullRequests";
import { UtcTimestamp } from "./events";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );

/**
 * Automatic attempts Auto-fix makes on one distinct failure before it stops
 * and hands the pull request back to the person.
 */
export const CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS = 3;
/** Failures one Auto-fix observation or wake names. */
export const MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES = 32;

/** The one pull request a switch belongs to. */
export const CodeProjectPullRequestSwitchTarget = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CodeProjectPullRequestSwitchTarget = typeof CodeProjectPullRequestSwitchTarget.Type;

/**
 * Turns the forge's own auto-merge on or off. Turning it on names the head
 * the person saw, so the forge refuses if the branch moved in between; the
 * method is optional and, when absent, the host picks the first one the
 * repository allows (squash, merge, rebase).
 */
export const CodeProjectPullRequestMergeWhenReadyCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("enable"),
    target: CodeProjectPullRequestSwitchTarget,
    headSha: boundedNonEmptyText(64),
    method: Schema.optional(CodeProjectPullRequestMergeMethod),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("disable"),
    target: CodeProjectPullRequestSwitchTarget,
  }).annotations(strict),
);
export type CodeProjectPullRequestMergeWhenReadyCommand =
  typeof CodeProjectPullRequestMergeWhenReadyCommand.Type;

/**
 * Turns Auto-fix on for one thread linked to the pull request, or off. The
 * host refuses a thread that is not linked to that pull request.
 */
export const CodeProjectPullRequestAutoFixCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("enable"),
    target: CodeProjectPullRequestSwitchTarget,
    threadId: CodeThreadId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("disable"),
    target: CodeProjectPullRequestSwitchTarget,
  }).annotations(strict),
);
export type CodeProjectPullRequestAutoFixCommand = typeof CodeProjectPullRequestAutoFixCommand.Type;

/** What a pull request is waiting on before the forge merges it. */
export const CodeProjectPullRequestMergeWait = Schema.Literal("checks", "reviews", "conflicts");
export type CodeProjectPullRequestMergeWait = typeof CodeProjectPullRequestMergeWait.Type;

export const CodeProjectPullRequestMergeWhenReadyState = Schema.Union(
  Schema.Struct({ status: Schema.Literal("off") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("on"),
    method: CodeProjectPullRequestMergeMethod,
    enabledAt: UtcTimestamp,
    /** Empty until the host has observed the pull request since it was turned on. */
    waitingOn: Schema.Array(CodeProjectPullRequestMergeWait).pipe(Schema.maxItems(3)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("merged"),
    observedAt: UtcTimestamp,
  }).annotations(strict),
  /**
   * The forge dropped auto-merge on its own: a push by someone without merge
   * rights, a closed pull request, or a repository setting change.
   */
  Schema.Struct({
    status: Schema.Literal("turned-off-by-forge"),
    observedAt: UtcTimestamp,
  }).annotations(strict),
);
export type CodeProjectPullRequestMergeWhenReadyState =
  typeof CodeProjectPullRequestMergeWhenReadyState.Type;

/** Why Auto-fix stopped on its own. */
export const CodeProjectPullRequestAutoFixStopReason = Schema.Literal(
  "attempt-limit",
  "merged",
  "closed",
  "thread-unavailable",
  "authority-lost",
);
export type CodeProjectPullRequestAutoFixStopReason =
  typeof CodeProjectPullRequestAutoFixStopReason.Type;

/** Why Auto-fix is holding a wake back right now. Never journaled. */
export const CodeProjectPullRequestAutoFixPauseReason = Schema.Literal(
  "person-typing",
  "turn-active",
);
export type CodeProjectPullRequestAutoFixPauseReason =
  typeof CodeProjectPullRequestAutoFixPauseReason.Type;

/** One failure Auto-fix watches for, by kind and a short opaque identity. */
export const CodeProjectPullRequestAutoFixFailure = Schema.Struct({
  kind: Schema.Literal("check", "review-thread", "conflict"),
  /** Check name, review thread id, or `base` for a merge conflict. */
  key: boundedNonEmptyText(512),
}).annotations(strict);
export type CodeProjectPullRequestAutoFixFailure = typeof CodeProjectPullRequestAutoFixFailure.Type;

export const CodeProjectPullRequestAutoFixWakeResult = Schema.Literal(
  "started",
  "refused",
  "unmarked",
);
export type CodeProjectPullRequestAutoFixWakeResult =
  typeof CodeProjectPullRequestAutoFixWakeResult.Type;

export const CodeProjectPullRequestAutoFixState = Schema.Union(
  Schema.Struct({ status: Schema.Literal("off") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("on"),
    threadId: CodeThreadId,
    enabledAt: UtcTimestamp,
    pausedFor: Schema.optional(CodeProjectPullRequestAutoFixPauseReason),
    lastWake: Schema.optional(
      Schema.Struct({
        at: UtcTimestamp,
        attempt: Schema.Int.pipe(
          Schema.between(1, CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS),
        ),
        result: CodeProjectPullRequestAutoFixWakeResult,
        failures: Schema.Array(CodeProjectPullRequestAutoFixFailure).pipe(
          Schema.maxItems(MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES),
        ),
      }).annotations(strict),
    ),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("stopped"),
    threadId: CodeThreadId,
    reason: CodeProjectPullRequestAutoFixStopReason,
    stoppedAt: UtcTimestamp,
  }).annotations(strict),
);
export type CodeProjectPullRequestAutoFixState = typeof CodeProjectPullRequestAutoFixState.Type;

export const CodeProjectPullRequestSwitchesView = Schema.Struct({
  version: Schema.Literal(1),
  target: CodeProjectPullRequestSwitchTarget,
  mergeWhenReady: CodeProjectPullRequestMergeWhenReadyState,
  autoFix: CodeProjectPullRequestAutoFixState,
  generatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeProjectPullRequestSwitchesView = typeof CodeProjectPullRequestSwitchesView.Type;

/**
 * The answer to a switch command. Refusals and an unsupported forge are
 * values, so the pane can say exactly why a switch did not move.
 */
export const CodeProjectPullRequestSwitchOutcome = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("applied"),
    view: CodeProjectPullRequestSwitchesView,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal(
      "not-authorized",
      "not-open",
      "stale",
      "thread-not-linked",
      "method-not-allowed",
      "failed",
    ),
  }).annotations(strict),
  /** The repository does not allow auto-merge; the host never imitates it. */
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    reason: Schema.Literal("auto-merge-not-allowed"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literal("disconnected", "unauthenticated", "unavailable"),
  }).annotations(strict),
);
export type CodeProjectPullRequestSwitchOutcome = typeof CodeProjectPullRequestSwitchOutcome.Type;

/**
 * A window saying its person is composing in a Code thread. Auto-fix holds
 * its wake back while this is recent, so it never talks over the person.
 */
export const CodeThreadComposerActivity = Schema.Struct({
  threadId: CodeThreadId,
}).annotations(strict);
export type CodeThreadComposerActivity = typeof CodeThreadComposerActivity.Type;

export const CODE_PROJECT_PULL_REQUEST_MERGE_WHEN_READY_RECORDED =
  "code.project-pull-request-merge-when-ready-recorded@1";
export const CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED =
  "code.project-pull-request-auto-fix-recorded@1";
/** Both switch events share one aggregate per pull request. */
export const CODE_PROJECT_PULL_REQUEST_SWITCHES_AGGREGATE = "code-project-pull-request-switches";

/**
 * One change to a pull request's Merge when ready switch. `enabled` and
 * `disabled` are the person's clicks from a local window; `merged` and
 * `turned-off-by-forge` are what the host later observed.
 */
export const CodeProjectPullRequestMergeWhenReadyRecorded = Schema.Struct({
  target: CodeProjectPullRequestSwitchTarget,
  change: Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("enabled"),
      method: CodeProjectPullRequestMergeMethod,
      headSha: boundedNonEmptyText(64),
    }).annotations(strict),
    Schema.Struct({ kind: Schema.Literal("disabled") }).annotations(strict),
    Schema.Struct({ kind: Schema.Literal("merged") }).annotations(strict),
    Schema.Struct({ kind: Schema.Literal("turned-off-by-forge") }).annotations(strict),
  ),
}).annotations(strict);
export type CodeProjectPullRequestMergeWhenReadyRecorded =
  typeof CodeProjectPullRequestMergeWhenReadyRecorded.Type;

/**
 * One change to a pull request's Auto-fix switch, or one wake it made. A wake
 * records which failures it carried, so the attempt count per failure is
 * rebuilt from the journal alone. Failure text never enters the journal.
 */
export const CodeProjectPullRequestAutoFixRecorded = Schema.Struct({
  target: CodeProjectPullRequestSwitchTarget,
  threadId: CodeThreadId,
  change: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("enabled") }).annotations(strict),
    Schema.Struct({ kind: Schema.Literal("disabled") }).annotations(strict),
    Schema.Struct({
      kind: Schema.Literal("woke"),
      /** The head the failures were observed on. */
      headSha: boundedNonEmptyText(64),
      failures: Schema.Array(CodeProjectPullRequestAutoFixFailure).pipe(
        Schema.minItems(1),
        Schema.maxItems(MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES),
      ),
      attempt: Schema.Int.pipe(Schema.between(1, CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS)),
      result: CodeProjectPullRequestAutoFixWakeResult,
    }).annotations(strict),
    Schema.Struct({
      kind: Schema.Literal("stopped"),
      reason: CodeProjectPullRequestAutoFixStopReason,
    }).annotations(strict),
  ),
}).annotations(strict);
export type CodeProjectPullRequestAutoFixRecorded =
  typeof CodeProjectPullRequestAutoFixRecorded.Type;

export const decodeCodeProjectPullRequestSwitchTarget = Schema.decodeUnknownSync(
  CodeProjectPullRequestSwitchTarget,
);
export const decodeCodeProjectPullRequestMergeWhenReadyCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestMergeWhenReadyCommand,
);
export const decodeCodeProjectPullRequestAutoFixCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestAutoFixCommand,
);
export const decodeCodeProjectPullRequestSwitchesView = Schema.decodeUnknownSync(
  CodeProjectPullRequestSwitchesView,
);
export const decodeCodeProjectPullRequestSwitchOutcome = Schema.decodeUnknownSync(
  CodeProjectPullRequestSwitchOutcome,
);
export const decodeCodeThreadComposerActivity = Schema.decodeUnknownSync(
  CodeThreadComposerActivity,
);
export const decodeCodeProjectPullRequestMergeWhenReadyRecorded = Schema.decodeUnknownSync(
  CodeProjectPullRequestMergeWhenReadyRecorded,
);
export const decodeCodeProjectPullRequestAutoFixRecorded = Schema.decodeUnknownSync(
  CodeProjectPullRequestAutoFixRecorded,
);
