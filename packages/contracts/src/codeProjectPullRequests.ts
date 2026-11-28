import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import {
  CodePullRequestReviewChangedFile,
  CodePullRequestReviewCheck,
  CodePullRequestReviewComment,
  CodePullRequestReviewCommit,
  CodePullRequestReviewOpinion,
  CodePullRequestReviewSection,
  MAX_CODE_PULL_REQUEST_REVIEW_ITEMS,
} from "./codeOperations";
import { UtcTimestamp } from "./events";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { HubMemberId } from "./hubAndSpokes";
import { ProjectId } from "./projects";
import { PullRequestLinkId } from "./pullRequestIdentity";
import {
  PullRequestCheckCounts,
  PullRequestLineCount,
  PullRequestMerging,
} from "./threadBoardPullRequests";

const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );
const githubUpdatedAt = Schema.String.check(
  Schema.makeFilter((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)),
);
const branchName = boundedNonEmptyText(255).check(
  Schema.makeFilter((value) => !/\s/.test(value) && !value.includes("..")),
);
const boundedText = (maximumBytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );
const uniqueArray = <S extends Schema.Top>(schema: S, maximum: number) =>
  Schema.Array(schema).check(
    Schema.makeFilter(
      (values) =>
        values.length <= maximum &&
        new Set(values.map((value) => String(value))).size === values.length,
    ),
  );
const PullRequestUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }),
);
const boundedReviewArray = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).check(
    Schema.makeFilter((values) => values.length <= MAX_CODE_PULL_REQUEST_REVIEW_ITEMS),
  );

export const MAX_CODE_PROJECT_PULL_REQUEST_ROWS = 100;
export const MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DESCRIPTION_BYTES = 256 * 1024;
export const MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES = 1024 * 1024;
export const MAX_CODE_PROJECT_PULL_REQUEST_PROJECTS = 1_000;
export const MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS = 32;
export const MAX_CODE_PROJECT_PULL_REQUEST_REVIEW_REQUESTS = 32;
/** Failing checks kept from one pull request's already-fetched rollup. */
export const MAX_CODE_PROJECT_PULL_REQUEST_FAILING_CHECKS = 8;

/**
 * Cached read of the host-local Project-scoped active pull-request projection.
 * There is no refresh flag: GitHub is reached only by an explicit refresh
 * command or, for Projects that opted in, the bounded background refresh
 * cadence.
 */
export const CodeProjectPullRequestQuery = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.optional(CodeThreadId),
});
export type CodeProjectPullRequestQuery = typeof CodeProjectPullRequestQuery.Type;

export const CodeProjectPullRequestRefreshCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("refresh-all"),
  }),
  Schema.Struct({
    kind: Schema.Literal("refresh-project"),
    projectId: ProjectId,
  }),
]);
export type CodeProjectPullRequestRefreshCommand = typeof CodeProjectPullRequestRefreshCommand.Type;

export const CodeProjectPullRequestStaleReason = Schema.Literals([
  "rate-limited",
  "timeout",
  "malformed",
  "disconnected",
  "refresh-failed",
]);
export type CodeProjectPullRequestStaleReason = typeof CodeProjectPullRequestStaleReason.Type;

export const CodeProjectPullRequestFreshness = Schema.Struct({
  status: Schema.Literals(["fresh", "stale", "empty"]),
  staleReason: Schema.optional(CodeProjectPullRequestStaleReason),
  lastSuccessfulRefreshAt: Schema.optional(UtcTimestamp),
  retryAfter: Schema.optional(UtcTimestamp),
});
export type CodeProjectPullRequestFreshness = typeof CodeProjectPullRequestFreshness.Type;

export const CodeProjectPullRequestConnection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("connected"),
    projectId: ProjectId,
    projectName: boundedNonEmptyText(512),
    repositoryOwner: GithubRepositoryOwner,
    repositoryName: GithubRepositoryName,
  }),
  Schema.Struct({
    kind: Schema.Literal("unconnected"),
    projectId: ProjectId,
    projectName: boundedNonEmptyText(512),
  }),
]);
export type CodeProjectPullRequestConnection = typeof CodeProjectPullRequestConnection.Type;

/**
 * Freshness is tracked per connected Project. A global snapshot timestamp is
 * not enough: refreshing one repository must not make an untouched repository
 * look like an authoritative empty result.
 */
export const CodeProjectPullRequestProjectFreshness = Schema.Struct({
  projectId: ProjectId,
  freshness: CodeProjectPullRequestFreshness,
});
export type CodeProjectPullRequestProjectFreshness =
  typeof CodeProjectPullRequestProjectFreshness.Type;

/**
 * Honest per-Project state of the opt-in background refresh cadence.
 * `unavailable` is a full stop — `gh` is missing or unauthenticated — that
 * only a successful explicit refresh or a re-enable can clear. `backing-off`
 * keeps the last sync position: a failed observation never advances it.
 */
export const CodeProjectPullRequestBackgroundRefreshState = Schema.Struct({
  projectId: ProjectId,
  state: Schema.Literals(["disabled", "scheduled", "backing-off", "unavailable"]),
  nextObservationAt: Schema.optional(UtcTimestamp),
});
export type CodeProjectPullRequestBackgroundRefreshState =
  typeof CodeProjectPullRequestBackgroundRefreshState.Type;

export const CodeProjectPullRequestChecksSummary = Schema.Literals([
  "unknown",
  "pending",
  "passing",
  "failing",
]);
export type CodeProjectPullRequestChecksSummary = typeof CodeProjectPullRequestChecksSummary.Type;

export const CodeProjectPullRequestReviewSummary = Schema.Literals([
  "unknown",
  "none",
  "pending",
  "approved",
  "changes-requested",
]);
export type CodeProjectPullRequestReviewSummary = typeof CodeProjectPullRequestReviewSummary.Type;

export const CodeProjectPullRequestState = Schema.Literals(["unknown", "open", "merged", "closed"]);
export type CodeProjectPullRequestState = typeof CodeProjectPullRequestState.Type;

export const CodeProjectPullRequestMergeability = Schema.Literals([
  "mergeable",
  "conflicting",
  "unknown",
]);
export type CodeProjectPullRequestMergeability = typeof CodeProjectPullRequestMergeability.Type;

export const CodeProjectPullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type CodeProjectPullRequestMergeMethod = typeof CodeProjectPullRequestMergeMethod.Type;

export const CodeProjectPullRequestMergeCommand = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
  method: CodeProjectPullRequestMergeMethod,
  /**
   * The head commit the person reviewed. The server refuses with `stale`
   * when the pull request's head no longer matches, so an approval cannot
   * merge a revision that was never on screen.
   */
  headSha: boundedNonEmptyText(64),
  /**
   * The person's confirmation of the head they reviewed and of the checks
   * the repository requires. A paired phone or web client must send it; the
   * local window's own confirmation step stands in for it there.
   */
  confirmed: Schema.optional(Schema.Literal(true)),
  /**
   * The branch the person confirmed this lands on. Pointing a pull request at
   * another base leaves its head as it was, so the head alone does not show it;
   * the server refuses with `stale` when the base is another one. Absent when
   * the caller confirmed a head alone.
   */
  baseBranch: Schema.optional(branchName),
});
export type CodeProjectPullRequestMergeCommand = typeof CodeProjectPullRequestMergeCommand.Type;

const CodeProjectPullRequestMergeRefusal = Schema.Literals([
  "not-authorized",
  "not-open",
  "not-mergeable",
  "stale",
  "conflict",
  "failed",
  "not-confirmed",
  "checks-not-passing",
  "checks-unknown",
]);
export type CodeProjectPullRequestMergeRefusal = typeof CodeProjectPullRequestMergeRefusal.Type;

const CodeProjectPullRequestMergeUnavailable = Schema.Literals([
  "disconnected",
  "unauthenticated",
  "unavailable",
]);
export type CodeProjectPullRequestMergeUnavailable =
  typeof CodeProjectPullRequestMergeUnavailable.Type;

/** The merge routes a host can ask an owner unlock for, before a paired client's merge. */
export const CODE_OWNER_UNLOCKED_MERGE_PATHS = [
  "/api/code/project-pull-requests/merge",
  "/api/code/project-pull-requests/merge-stack",
  "/api/code/project-pull-requests/merge-when-ready",
] as const;

/**
 * Why a host that asks for an owner unlock before a paired client's merge
 * refused this one. `missing`: no unlock came with it. `no-owner-list`: the
 * host is in no hub, or its hub grant leaves owners out, so it has no owner who
 * could give one. The rest repeat the host's check of the owner and the unlock.
 */
export const CodeOwnerMergeUnlockReason = Schema.Literals([
  "missing",
  "invalid",
  "no-owner-list",
  "not-an-owner",
  "owners-not-honored",
  "device-revoked",
  "hub-principal",
  "no-such-challenge",
  "expired",
  "wrong-owner",
  "action-mismatch",
  "signature-invalid",
  "user-verification-missing",
]);
export type CodeOwnerMergeUnlockReason = typeof CodeOwnerMergeUnlockReason.Type;

/**
 * Nothing merged: the host asks a paired client's merge for a fresh unlock on
 * one of its owner devices first. `hostMemberId` names this host on the hub, so
 * the owner device asks this host for the challenge; it is absent when the host
 * has no owner list.
 */
export const CodeOwnerMergeUnlockRefusal = Schema.Struct({
  status: Schema.Literal("owner-unlock-required"),
  reason: CodeOwnerMergeUnlockReason,
  hostMemberId: Schema.optional(HubMemberId),
});
export type CodeOwnerMergeUnlockRefusal = typeof CodeOwnerMergeUnlockRefusal.Type;

export const CodeProjectPullRequestMergeOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("merged"),
    number: PositiveInt,
    method: CodeProjectPullRequestMergeMethod,
    mergedAt: UtcTimestamp,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodeProjectPullRequestMergeRefusal,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: CodeProjectPullRequestMergeUnavailable,
  }),
  CodeOwnerMergeUnlockRefusal,
]);
export type CodeProjectPullRequestMergeOutcome = typeof CodeProjectPullRequestMergeOutcome.Type;

export const CODE_PROJECT_PULL_REQUEST_MERGE_RECORDED =
  "code.project-pull-request-merge-recorded@1";

/**
 * Journal record of one merge attempt that reached the server merge path:
 * which pull request, the head the person approved, the method, and how it
 * ended. The envelope's actor names the local user. It carries no
 * credential, title, or body; GitHub's history stays the record of what the
 * merge changed.
 */
export const CodeProjectPullRequestMergeRecorded = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
  method: CodeProjectPullRequestMergeMethod,
  headSha: boundedNonEmptyText(64),
  /** Set for a merge confirmed on a paired phone or web client; absent for the local window. */
  caller: Schema.optional(Schema.Literals(["local-window", "remote-device"])),
  result: Schema.Union([
    Schema.Struct({ status: Schema.Literal("merged") }),
    Schema.Struct({
      status: Schema.Literal("refused"),
      reason: CodeProjectPullRequestMergeRefusal,
    }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: CodeProjectPullRequestMergeUnavailable,
    }),
    Schema.Struct({
      status: Schema.Literal("failed"),
      reason: Schema.Literals(["aborted", "error"]),
    }),
  ]),
});
export type CodeProjectPullRequestMergeRecorded = typeof CodeProjectPullRequestMergeRecorded.Type;
export const decodeCodeProjectPullRequestMergeRecorded = Schema.decodeUnknownSync(
  CodeProjectPullRequestMergeRecorded,
  STRICT_DECODE_OPTIONS,
);

export const MAX_CODE_PROJECT_PULL_REQUEST_STACK_MERGE = 10;

/**
 * Merge a whole stack in one step, from the bottom. The server reads every
 * pull request first and refuses the stack whole unless each one's base is the
 * head branch of the one before it; it then merges one at a time and stops at
 * the first that does not merge.
 */
export const CodeProjectPullRequestStackMergeCommand = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  method: CodeProjectPullRequestMergeMethod,
  confirmed: Schema.Literal(true),
  /** The branch the person confirmed the whole stack lands on. */
  baseBranch: Schema.optional(branchName),
  items: Schema.Array(
    Schema.Struct({
      number: PositiveInt,
      headSha: boundedNonEmptyText(64),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_STACK_MERGE)),
});
export type CodeProjectPullRequestStackMergeCommand =
  typeof CodeProjectPullRequestStackMergeCommand.Type;

export const CodeProjectPullRequestStackMergeOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("merged"),
    merged: Schema.Array(PositiveInt),
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals([
      "not-authorized",
      "not-confirmed",
      "empty",
      "too-long",
      "duplicate",
      "not-a-chain",
      "unreadable",
      "base-changed",
      "stale",
    ]),
  }),
  Schema.Struct({
    status: Schema.Literal("stopped"),
    merged: Schema.Array(PositiveInt),
    stoppedAt: PositiveInt,
    /**
     * The branch the layer it stopped at was pointed at for its merge, and
     * stays pointed at: the layer below has landed there, so its old base
     * would strand it.
     */
    retargetedTo: Schema.optional(branchName),
    outcome: Schema.Union([
      Schema.Struct({ status: Schema.Literal("not-landed") }),
      Schema.Struct({
        status: Schema.Literal("refused"),
        reason: CodeProjectPullRequestMergeRefusal,
      }),
      Schema.Struct({
        status: Schema.Literal("unavailable"),
        reason: CodeProjectPullRequestMergeUnavailable,
      }),
    ]),
  }),
  CodeOwnerMergeUnlockRefusal,
]);
export type CodeProjectPullRequestStackMergeOutcome =
  typeof CodeProjectPullRequestStackMergeOutcome.Type;

const CodeProjectPullRequestActionTarget = {
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
} as const;

export const CodeProjectPullRequestLabel = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= 50 &&
      !value.includes("\0") &&
      !/[\n\r,]/.test(value) &&
      value.trim() === value,
  ),
);

/**
 * The person's own pull-request actions: labels, a comment, a reply in one
 * review thread, close, and reopen. The person's click is the approval; the
 * text of a comment or reply is posted under their name and is never journaled.
 */
export const CodeProjectPullRequestActionCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("labels"),
    ...CodeProjectPullRequestActionTarget,
    add: Schema.Array(CodeProjectPullRequestLabel).check(Schema.isMaxLength(20)),
    remove: Schema.Array(CodeProjectPullRequestLabel).check(Schema.isMaxLength(20)),
  }).check(Schema.makeFilter((command) => command.add.length + command.remove.length > 0)),
  Schema.Struct({
    kind: Schema.Literal("comment"),
    ...CodeProjectPullRequestActionTarget,
    body: boundedNonEmptyText(65_536),
  }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    ...CodeProjectPullRequestActionTarget,
    reviewThreadId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_=-]{1,128}$/)),
    body: boundedNonEmptyText(65_536),
  }),
  Schema.Struct({
    kind: Schema.Literal("approve"),
    ...CodeProjectPullRequestActionTarget,
    headSha: boundedNonEmptyText(64),
    body: Schema.optional(boundedNonEmptyText(65_536)),
  }),
  Schema.Struct({
    kind: Schema.Literal("request-changes"),
    ...CodeProjectPullRequestActionTarget,
    headSha: boundedNonEmptyText(64),
    body: boundedNonEmptyText(65_536),
  }),
  Schema.Struct({
    kind: Schema.Literal("close"),
    ...CodeProjectPullRequestActionTarget,
  }),
  Schema.Struct({
    kind: Schema.Literal("reopen"),
    ...CodeProjectPullRequestActionTarget,
  }),
]);
export type CodeProjectPullRequestActionCommand = typeof CodeProjectPullRequestActionCommand.Type;
export type CodeProjectPullRequestActionKind = CodeProjectPullRequestActionCommand["kind"];

const CodeProjectPullRequestActionRefusal = Schema.Literals([
  "not-authorized",
  "invalid",
  "not-open",
  "not-closed",
  "merged",
  "label-not-found",
  "stale",
  "own-pull-request",
  "failed",
]);

export const CodeProjectPullRequestActionOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("done") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodeProjectPullRequestActionRefusal,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: CodeProjectPullRequestMergeUnavailable,
  }),
]);
export type CodeProjectPullRequestActionOutcome = typeof CodeProjectPullRequestActionOutcome.Type;

export const MAX_CODE_PROJECT_PULL_REQUEST_REPOSITORY_LABELS = 100;
export const MAX_CODE_PROJECT_PULL_REQUEST_REVIEW_THREADS = 50;

/** The one pull request whose labels and review threads the person's controls read. */
export const CodeProjectPullRequestActionContextQuery = Schema.Struct({
  ...CodeProjectPullRequestActionTarget,
});
export type CodeProjectPullRequestActionContextQuery =
  typeof CodeProjectPullRequestActionContextQuery.Type;

/**
 * What the person's controls need to name: the labels on the pull request, the
 * labels the repository already has (the host never creates one), and the
 * review threads a reply can go to. Read-only and never journaled; the thread
 * excerpt is the first comment's start, shown so the person knows which thread
 * a reply answers.
 */
export const CodeProjectPullRequestActionContext = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("read"),
    labels: Schema.Array(CodeProjectPullRequestLabel).check(Schema.isMaxLength(50)),
    repositoryLabels: Schema.Array(CodeProjectPullRequestLabel).check(
      Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_REPOSITORY_LABELS),
    ),
    reviewThreads: Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_=-]{1,128}$/)),
        resolved: Schema.Boolean,
        outdated: Schema.Boolean,
        path: boundedText(1_024),
        author: boundedText(255),
        excerpt: boundedText(400),
      }),
    ).check(Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_REVIEW_THREADS)),
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("not-authorized"),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: CodeProjectPullRequestMergeUnavailable,
  }),
]);
export type CodeProjectPullRequestActionContext = typeof CodeProjectPullRequestActionContext.Type;

export const CODE_PROJECT_PULL_REQUEST_ACTION_RECORDED =
  "code.project-pull-request-action-recorded@1";

/**
 * Journal record of one pull-request action that reached the server. The
 * envelope's actor is the local user. A comment or reply keeps only its length,
 * never its text, and no record carries a credential.
 */
export const CodeProjectPullRequestActionRecorded = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
  action: Schema.Literals([
    "labels",
    "comment",
    "reply",
    "approve",
    "request-changes",
    "close",
    "reopen",
  ]),
  labels: Schema.optional(
    Schema.Struct({
      add: Schema.Array(CodeProjectPullRequestLabel),
      remove: Schema.Array(CodeProjectPullRequestLabel),
    }),
  ),
  bodyBytes: Schema.optional(NonNegativeInt),
  result: Schema.Union([
    Schema.Struct({ status: Schema.Literal("done") }),
    Schema.Struct({
      status: Schema.Literal("refused"),
      reason: CodeProjectPullRequestActionRefusal,
    }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: CodeProjectPullRequestMergeUnavailable,
    }),
  ]),
});
export type CodeProjectPullRequestActionRecorded = typeof CodeProjectPullRequestActionRecorded.Type;

export const CodeProjectPullRequestLinkedThread = Schema.Struct({
  threadId: CodeThreadId,
  title: boundedNonEmptyText(512),
});
export type CodeProjectPullRequestLinkedThread = typeof CodeProjectPullRequestLinkedThread.Type;

/**
 * One failing check from the rollup the pull-request list already fetched.
 * That rollup names the check and when it finished; it carries no failure text
 * or log, so none is kept here and none is fetched.
 */
export const CodeProjectPullRequestFailingCheck = Schema.Struct({
  name: boundedNonEmptyText(512),
  completedAt: Schema.optional(githubUpdatedAt),
});
export type CodeProjectPullRequestFailingCheck = typeof CodeProjectPullRequestFailingCheck.Type;

/** A local watch's latest observation, joined only onto a row this window may read. */
export const PullRequestBabysitStatus = Schema.Literals([
  "checking",
  "connection",
  "draft",
  "approval",
  "label",
  "checks",
  "repair-check",
  "repair-review",
  "outside-review",
  "repair-branch",
  "repository",
  "ready",
  "attempt-limit",
  "feedback-limit",
  "needs-help",
  "thread-unavailable",
  "authority-lost",
]);
export type PullRequestBabysitStatus = typeof PullRequestBabysitStatus.Type;
export const CodeProjectPullRequestRow = Schema.Struct({
  babysit: Schema.optional(
    Schema.Struct({
      threadId: CodeThreadId,
      status: PullRequestBabysitStatus,
      checks: Schema.optional(Schema.Literals(["all", "required"])),
      stoppedAt: Schema.optional(UtcTimestamp),
      feedbackTurns: Schema.optional(NonNegativeInt),
      feedbackLimit: Schema.optional(PositiveInt),
      blockerDetail: Schema.optional(boundedNonEmptyText(512)),
      requiredLabel: Schema.optional(CodeProjectPullRequestLabel),
      readyHeadSha: Schema.optional(boundedNonEmptyText(64)),
    }),
  ),
  projectId: ProjectId,
  projectName: boundedNonEmptyText(512),
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
  title: boundedNonEmptyText(256),
  draft: Schema.Boolean,
  state: CodeProjectPullRequestState,
  mergeability: CodeProjectPullRequestMergeability,
  author: boundedNonEmptyText(128),
  baseBranch: branchName,
  headBranch: branchName,
  updatedAt: githubUpdatedAt,
  /**
   * When the pull request was opened, from the same list read. Absent on a
   * snapshot taken before that fact was recorded, and on a pull request known
   * only from a thread.
   */
  createdAt: Schema.optional(githubUpdatedAt),
  checks: CodeProjectPullRequestChecksSummary,
  review: CodeProjectPullRequestReviewSummary,
  /**
   * Logins asked to review, from the same list read as the rest of the row.
   * Absent on a snapshot taken before that fact was recorded; that is not a
   * request.
   */
  reviewRequestedFrom: Schema.optional(
    Schema.Array(boundedNonEmptyText(128)).check(
      Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_REVIEW_REQUESTS),
      Schema.makeFilter(
        (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
      ),
    ),
  ),
  /**
   * Failing checks from the same list read as the summary. Absent on a
   * snapshot taken before that fact was recorded; that is not a failure.
   */
  failingChecks: Schema.optional(
    Schema.Array(CodeProjectPullRequestFailingCheck).check(
      Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_FAILING_CHECKS),
    ),
  ),
  /**
   * Present, and true, only when the head branch lives in a fork: `headBranch`
   * then names a branch of another repository, so it says nothing about this
   * Project's checkouts. Absent on a same-repository row and on a snapshot
   * taken before that fact was recorded.
   */
  crossRepository: Schema.optional(Schema.Literal(true)),
  /**
   * Added and removed lines of the whole pull request. Absent when the host has
   * not read them (a snapshot from before they were recorded, or a pull request
   * known only from a thread); absent is not zero.
   */
  additions: Schema.optional(PullRequestLineCount),
  deletions: Schema.optional(PullRequestLineCount),
  /**
   * Checks passed out of counted, from the same rollup as `checks`. Absent when
   * the rollup named no check the host counts, or was not read.
   */
  checkCounts: Schema.optional(PullRequestCheckCounts),
  /**
   * Set only on an open pull request that is on its way in: auto-merge is on
   * (`auto-merge`) or it sits in the merge queue (`queued`; absent when the
   * queue could not be read). Absent otherwise, and on a snapshot from before
   * this was recorded.
   */
  merging: Schema.optional(PullRequestMerging),
  /**
   * Stable host-local pull-request link identity when the pull request is known
   * to the forge identity owner. Absent on snapshots recorded before link
   * identity existed or for unlinked repository pull requests.
   */
  linkId: Schema.optional(PullRequestLinkId),
  linkedThreads: Schema.Array(CodeProjectPullRequestLinkedThread).check(
    Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS),
  ),
});
export type CodeProjectPullRequestRow = typeof CodeProjectPullRequestRow.Type;

/**
 * Current authorized active-row projection. The private bounded cache may also
 * contain merged and closed rows for board summaries.
 */
export const CodeProjectPullRequestView = Schema.Struct({
  version: Schema.Literal(1),
  query: CodeProjectPullRequestQuery,
  projects: Schema.Array(CodeProjectPullRequestConnection).check(
    Schema.makeFilter(
      (projects) =>
        projects.length <= MAX_CODE_PROJECT_PULL_REQUEST_PROJECTS &&
        new Set(projects.map((project) => String(project.projectId))).size === projects.length,
    ),
  ),
  rows: Schema.Array(CodeProjectPullRequestRow).check(
    Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_ROWS),
  ),
  repositoriesTruncated: Schema.Boolean,
  pullRequestsTruncated: Schema.Boolean,
  freshness: CodeProjectPullRequestFreshness,
  projectFreshness: Schema.optional(
    Schema.Array(CodeProjectPullRequestProjectFreshness).check(
      Schema.makeFilter(
        (entries) =>
          entries.length <= MAX_CODE_PROJECT_PULL_REQUEST_PROJECTS &&
          new Set(entries.map((entry) => String(entry.projectId))).size === entries.length,
      ),
    ),
  ),
  backgroundRefresh: Schema.optional(
    Schema.Array(CodeProjectPullRequestBackgroundRefreshState).check(
      Schema.makeFilter(
        (entries) =>
          entries.length <= MAX_CODE_PROJECT_PULL_REQUEST_PROJECTS &&
          new Set(entries.map((entry) => String(entry.projectId))).size === entries.length,
      ),
    ),
  ),
  generatedAt: UtcTimestamp,
});
export type CodeProjectPullRequestView = typeof CodeProjectPullRequestView.Type;

export const decodeCodeProjectPullRequestQuery = Schema.decodeUnknownSync(
  CodeProjectPullRequestQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestRefreshCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestRefreshCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestMergeCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestMergeCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestMergeOutcome = Schema.decodeUnknownSync(
  CodeProjectPullRequestMergeOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestView = Schema.decodeUnknownSync(
  CodeProjectPullRequestView,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestRow = Schema.decodeUnknownSync(
  CodeProjectPullRequestRow,
  STRICT_DECODE_OPTIONS,
);

/**
 * Cached read of one in-memory Project-scoped pull-request detail snapshot.
 * There is no refresh flag: GitHub is reached only by an explicit refresh
 * command.
 */
export const CodeProjectPullRequestDetailQuery = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
});
export type CodeProjectPullRequestDetailQuery = typeof CodeProjectPullRequestDetailQuery.Type;

export const CodeProjectPullRequestDetailRefreshCommand = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
});
export type CodeProjectPullRequestDetailRefreshCommand =
  typeof CodeProjectPullRequestDetailRefreshCommand.Type;

export const CodeProjectPullRequestDetailSection = CodePullRequestReviewSection;
export type CodeProjectPullRequestDetailSection = typeof CodeProjectPullRequestDetailSection.Type;

export const CodeProjectPullRequestDetailObserved = Schema.Struct({
  state: Schema.Literal("observed"),
  freshness: Schema.Literals(["fresh", "stale"]),
  ambiguous: Schema.Boolean,
  staleSections: uniqueArray(CodeProjectPullRequestDetailSection, 7),
  number: PositiveInt,
  url: PullRequestUrl,
  title: boundedText(1_024),
  pullRequestState: Schema.Literals(["open", "merged", "closed", "draft"]),
  baseRepository: boundedNonEmptyText(512),
  baseBranch: branchName,
  headRepository: boundedText(512),
  headBranch: branchName,
  /** Empty when the read carried no head commit; a merge then refuses as stale. */
  headSha: Schema.String.check(Schema.isMaxLength(64)),
  author: boundedText(255),
  mergeability: Schema.optional(CodeProjectPullRequestMergeability),
  matchesDeliveryBranch: Schema.Literal(false),
  description: boundedText(MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DESCRIPTION_BYTES),
  diff: boundedText(MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES),
  diffTruncated: Schema.Boolean,
  commits: boundedReviewArray(CodePullRequestReviewCommit),
  files: boundedReviewArray(CodePullRequestReviewChangedFile),
  checks: boundedReviewArray(CodePullRequestReviewCheck),
  reviews: boundedReviewArray(CodePullRequestReviewOpinion),
  comments: boundedReviewArray(CodePullRequestReviewComment),
});
export type CodeProjectPullRequestDetailObserved = typeof CodeProjectPullRequestDetailObserved.Type;

export const CodeProjectPullRequestDetail = Schema.Union([
  CodeProjectPullRequestDetailObserved,
  Schema.Struct({
    state: Schema.Literal("unavailable"),
  }),
  Schema.Struct({
    state: Schema.Literal("empty"),
  }),
]);
export type CodeProjectPullRequestDetail = typeof CodeProjectPullRequestDetail.Type;

/**
 * Current authorized detail snapshot. Process-local only: never journaled.
 */
export const CodeProjectPullRequestDetailView = Schema.Struct({
  version: Schema.Literal(1),
  query: CodeProjectPullRequestDetailQuery,
  detail: CodeProjectPullRequestDetail,
  freshness: CodeProjectPullRequestFreshness,
  linkedThreads: Schema.Array(CodeProjectPullRequestLinkedThread).check(
    Schema.isMaxLength(MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS),
  ),
  generatedAt: UtcTimestamp,
});
export type CodeProjectPullRequestDetailView = typeof CodeProjectPullRequestDetailView.Type;

export const decodeCodeProjectPullRequestDetailQuery = Schema.decodeUnknownSync(
  CodeProjectPullRequestDetailQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestDetailRefreshCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestDetailRefreshCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestDetailView = Schema.decodeUnknownSync(
  CodeProjectPullRequestDetailView,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestStackMergeCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestStackMergeCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestStackMergeOutcome = Schema.decodeUnknownSync(
  CodeProjectPullRequestStackMergeOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestActionCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestActionCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestActionContextQuery = Schema.decodeUnknownSync(
  CodeProjectPullRequestActionContextQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestActionContext = Schema.decodeUnknownSync(
  CodeProjectPullRequestActionContext,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestActionOutcome = Schema.decodeUnknownSync(
  CodeProjectPullRequestActionOutcome,
  STRICT_DECODE_OPTIONS,
);
