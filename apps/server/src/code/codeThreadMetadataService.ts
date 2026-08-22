import {
  decodeCodeThreadOperationalMetadata,
  decodeCodeThreadOperationalMetadataView,
  type CodeCheckoutHead,
  type CodeCheckoutId,
  type CodeDeliveryTarget,
  type CodeMetadataFreshness,
  type CodeOperationEventFrame,
  type CodeOperationResult,
  type CodeThread,
  type CodeThreadCheckState,
  type CodeThreadChangedFileState,
  type CodeThreadChildAgentSummary,
  type CodeThreadId,
  type CodeThreadLinkedPullRequest,
  type CodeThreadMetadataRecovery,
  type CodeThreadMetadataRecoveryReason,
  type CodeThreadOperationalMetadata,
  type CodeThreadOperationalMetadataView,
  type CodeThreadPullRequestState,
  type CodeThreadReviewState,
  type CodeThreadWorktreeMetadata,
  type WorktreeReceiptId,
} from "@octant/contracts";
import {
  evaluateCodeDeliverySatisfaction,
  type CodeDeliverySatisfaction,
  type DeliveryPullRequestEvidence,
  type DeliveryTargetEvidence,
} from "@octant/domain/delivery-target-policy";

/**
 * A non-archived Code thread plus whether its bound Project projection is
 * currently present. A temporarily missing Project projection does not drop the
 * card; it keeps the thread visible with an actionable recovery reason.
 */
export interface CodeThreadMetadataInput {
  readonly thread: CodeThread;
  readonly projectProjectionPresent: boolean;
}

/**
 * The bounded operation-journal history for a single thread. `rebuild-required`
 * means the journal could not be replayed cleanly (a gap, an invalid frame, or
 * an interruption); the projection then keeps the thread visible with a
 * recovery reason and preserves the last-known runtime summary.
 */
export type CodeThreadOperationHistory =
  | { readonly status: "ok"; readonly frames: readonly CodeOperationEventFrame[] }
  | { readonly status: "rebuild-required" };

export interface CodeThreadOperationHistorySource {
  read(threadId: CodeThreadId): CodeThreadOperationHistory | Promise<CodeThreadOperationHistory>;
}

/**
 * A live observation of the thread's managed worktree. `unavailable` means the
 * worktree could not be observed this projection; its Git-derived metadata is
 * treated as stale (carried forward from the last projection when possible).
 */
export type CodeGitWorktreeObservation =
  | {
      readonly status: "observed";
      readonly path: string;
      readonly head: CodeCheckoutHead;
      readonly receiptId?: WorktreeReceiptId;
      readonly changedPathCount: number;
      readonly stagedCount: number;
      readonly committedAhead: number;
      readonly workingTreeClean: boolean;
    }
  | { readonly status: "unavailable" };

export interface CodeGitWorktreeSource {
  observe(input: {
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly deliveryTarget: CodeDeliveryTarget;
  }): CodeGitWorktreeObservation | Promise<CodeGitWorktreeObservation>;
}

/**
 * A live observation of the thread's linked pull request, checks, and review
 * state. `unavailable` means GitHub could not be refreshed; the projection then
 * labels the GitHub-derived metadata stale, and stale GitHub metadata can never
 * independently satisfy a delivery target. `freshness` is `stale` when the
 * observation was reconstructed from already-cached journal evidence rather
 * than a live GitHub read.
 */
export type CodeGithubMetadataObservation =
  | {
      readonly status: "observed";
      readonly freshness?: CodeMetadataFreshness;
      readonly pullRequest: {
        readonly number: number;
        readonly url: string;
        readonly baseRepository: string;
        readonly baseBranch: string;
        readonly headBranch: string;
        readonly state: CodeThreadPullRequestState;
      } | null;
      readonly checks: CodeThreadCheckState["state"];
      readonly review: CodeThreadReviewState["state"];
    }
  | { readonly status: "unavailable" };

export interface CodeGithubMetadataSource {
  observe(input: {
    readonly threadId: CodeThreadId;
    readonly deliveryTarget: CodeDeliveryTarget;
  }): CodeGithubMetadataObservation | Promise<CodeGithubMetadataObservation>;
}

export interface CodeThreadMetadataServiceDependencies {
  readonly history: CodeThreadOperationHistorySource;
  readonly git: CodeGitWorktreeSource;
  /**
   * Live GitHub observation. Omit it to reconstruct PR evidence from already
   * journaled results only — board queries never call GitHub.
   */
  readonly github?: CodeGithubMetadataSource;
}

type PreviousProjection =
  | CodeThreadOperationalMetadataView
  | readonly CodeThreadOperationalMetadata[]
  | undefined;

export class CodeThreadMetadataService {
  readonly #history: CodeThreadOperationHistorySource;
  readonly #git: CodeGitWorktreeSource;
  readonly #github: CodeGithubMetadataSource | undefined;

  constructor(dependencies: CodeThreadMetadataServiceDependencies) {
    this.#history = dependencies.history;
    this.#git = dependencies.git;
    this.#github = dependencies.github;
  }

  /**
   * Rebuild the operational-metadata view for the supplied non-archived Code
   * threads. The projection is derived entirely from the operation journal, the
   * Git observation, the GitHub observation, and the last projection (used only
   * to carry forward last-known values marked stale); it therefore rebuilds
   * cleanly after an interruption without losing state.
   */
  async project(
    threads: readonly CodeThreadMetadataInput[],
    previous?: PreviousProjection,
  ): Promise<CodeThreadOperationalMetadataView> {
    const previousByThread = indexPrevious(previous);
    const projected: CodeThreadOperationalMetadata[] = [];
    for (const entry of threads) {
      if (entry.thread.lifecycle === "archived") continue;
      projected.push(
        await this.#projectThread(entry, previousByThread.get(String(entry.thread.id))),
      );
    }
    return decodeCodeThreadOperationalMetadataView({ version: 1, threads: projected });
  }

  async #projectThread(
    entry: CodeThreadMetadataInput,
    previous: CodeThreadOperationalMetadata | undefined,
  ): Promise<CodeThreadOperationalMetadata> {
    const { thread } = entry;
    const deliveryTarget = thread.deliveryTarget;

    const history = await this.#readHistory(thread.id);
    const historyFresh = history.status === "ok";

    const git = await this.#observeGit(thread);
    const github = await this.#observeGithub(thread, history);

    const worktree = buildWorktree(git, thread.checkoutId);
    const changedFiles = buildChangedFiles(git, previous, history);

    const githubFreshness: CodeMetadataFreshness =
      github.status === "observed" ? (github.freshness ?? "fresh") : "stale";
    const linkedPullRequest = buildLinkedPullRequest(github, deliveryTarget, previous);
    const checks = buildCheckState(github, previous);
    const reviewState = buildReviewState(github, previous);

    const childAgents = historyFresh
      ? summarizeChildAgents(history.frames)
      : (previous?.childAgents ?? emptyChildAgents());
    const lastMeaningfulActivityAt = historyFresh
      ? latestActivity(history.frames)
      : (previous?.lastMeaningfulActivityAt ?? null);
    const investigationDelivered = historyFresh ? hasCompletedProviderTurn(history.frames) : false;

    const satisfaction = this.#evaluateSatisfaction({
      outcomeKind: deliveryTarget.outcomeKind,
      changedFiles,
      linkedPullRequest,
      childAgents,
      githubFreshness,
      historyFresh,
      investigationDelivered,
    });

    const recovery = buildRecovery({
      projectProjectionPresent: entry.projectProjectionPresent,
      historyFresh,
    });

    return decodeCodeThreadOperationalMetadata({
      threadId: thread.id,
      checkoutId: thread.checkoutId,
      outcomeKind: deliveryTarget.outcomeKind,
      worktree,
      changedFiles,
      linkedPullRequest,
      checks,
      reviewState,
      childAgents,
      lastMeaningfulActivityAt,
      githubFreshness,
      deliverySatisfaction: satisfaction,
      recovery,
      rebuiltFromJournal: previous === undefined,
    });
  }

  async #readHistory(threadId: CodeThreadId): Promise<CodeThreadOperationHistory> {
    try {
      return await this.#history.read(threadId);
    } catch {
      return { status: "rebuild-required" };
    }
  }

  async #observeGit(thread: CodeThread): Promise<CodeGitWorktreeObservation> {
    try {
      return await this.#git.observe({
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        deliveryTarget: thread.deliveryTarget,
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async #observeGithub(
    thread: CodeThread,
    history: CodeThreadOperationHistory,
  ): Promise<CodeGithubMetadataObservation> {
    if (this.#github === undefined) {
      return cachedGithubObservationFromHistory(history);
    }
    try {
      return await this.#github.observe({
        threadId: thread.id,
        deliveryTarget: thread.deliveryTarget,
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  #evaluateSatisfaction(input: {
    readonly outcomeKind: CodeThreadOperationalMetadata["outcomeKind"];
    readonly changedFiles: CodeThreadChangedFileState;
    readonly linkedPullRequest: CodeThreadLinkedPullRequest;
    readonly childAgents: CodeThreadChildAgentSummary;
    readonly githubFreshness: CodeMetadataFreshness;
    readonly historyFresh: boolean;
    readonly investigationDelivered: boolean;
  }): CodeDeliverySatisfaction {
    const evidence: DeliveryTargetEvidence = {
      investigation: {
        resultDelivered: input.investigationDelivered,
        freshness: input.historyFresh ? "fresh" : "stale",
      },
      pullRequest: pullRequestEvidence(input.linkedPullRequest),
      childAgents: {
        active: input.childAgents.active,
        unacknowledgedResults: input.childAgents.unacknowledgedResults,
      },
      ...(input.changedFiles.kind === "observed"
        ? {
            localChanges: {
              committedAhead: input.changedFiles.committedAhead,
              workingTreeClean: input.changedFiles.workingTreeClean,
              freshness: input.changedFiles.freshness,
            },
          }
        : {}),
    };

    const base = evaluateCodeDeliverySatisfaction(input.outcomeKind, evidence);

    // Ambiguity is always resolved to `waiting`, never `done`. Stale or
    // unrefreshable evidence for the target's own outcome dimension makes the
    // target ambiguous even when the base policy would otherwise report
    // `pending` because it cannot see the missing evidence.
    if (
      (input.outcomeKind === "opened-pr" || input.outcomeKind === "merged-pr") &&
      input.githubFreshness === "stale"
    ) {
      return "waiting";
    }
    if (input.outcomeKind === "local-implementation" && input.changedFiles.kind === "unavailable") {
      return "waiting";
    }
    if (input.outcomeKind === "investigation-result" && !input.historyFresh) {
      return "waiting";
    }
    return base;
  }
}

function indexPrevious(previous: PreviousProjection): Map<string, CodeThreadOperationalMetadata> {
  const entries =
    previous === undefined
      ? []
      : Array.isArray(previous)
        ? (previous as readonly CodeThreadOperationalMetadata[])
        : (previous as CodeThreadOperationalMetadataView).threads;
  const map = new Map<string, CodeThreadOperationalMetadata>();
  for (const candidate of entries) {
    let decoded: CodeThreadOperationalMetadata;
    try {
      decoded = decodeCodeThreadOperationalMetadata(candidate);
    } catch {
      continue;
    }
    map.set(String(decoded.threadId), decoded);
  }
  return map;
}

function buildWorktree(
  git: CodeGitWorktreeObservation,
  checkoutId: CodeCheckoutId,
): CodeThreadWorktreeMetadata {
  if (git.status !== "observed") return { kind: "unavailable", checkoutId };
  return {
    kind: "available",
    checkoutId,
    path: git.path,
    head: git.head,
    ...(git.receiptId === undefined ? {} : { receiptId: git.receiptId }),
  };
}

function buildChangedFiles(
  git: CodeGitWorktreeObservation,
  previous: CodeThreadOperationalMetadata | undefined,
  history: CodeThreadOperationHistory,
): CodeThreadChangedFileState {
  if (git.status === "observed") {
    return {
      kind: "observed",
      freshness: "fresh",
      changedPathCount: git.changedPathCount,
      stagedCount: git.stagedCount,
      committedAhead: git.committedAhead,
      workingTreeClean: git.workingTreeClean,
    };
  }
  const journaled = cachedChangedFilesFromHistory(history);
  if (journaled !== undefined) return journaled;
  if (previous?.changedFiles.kind === "observed") {
    return { ...previous.changedFiles, freshness: "stale" };
  }
  return { kind: "unavailable" };
}

function buildLinkedPullRequest(
  github: CodeGithubMetadataObservation,
  deliveryTarget: CodeDeliveryTarget,
  previous: CodeThreadOperationalMetadata | undefined,
): CodeThreadLinkedPullRequest {
  if (github.status === "observed") {
    const freshness = github.freshness ?? "fresh";
    if (github.pullRequest === null) return { kind: "none", freshness };
    const pr = github.pullRequest;
    return {
      kind: "linked",
      freshness,
      number: pr.number,
      url: pr.url,
      baseRepository: pr.baseRepository,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      state: pr.state,
      matchesDeliveryBranch:
        pr.baseRepository === deliveryTarget.proposedBaseRepository &&
        pr.baseBranch === deliveryTarget.proposedBaseBranch &&
        pr.headBranch === deliveryTarget.branchIntent,
    };
  }
  if (previous?.linkedPullRequest !== undefined) {
    return { ...previous.linkedPullRequest, freshness: "stale" };
  }
  return { kind: "none", freshness: "stale" };
}

function buildCheckState(
  github: CodeGithubMetadataObservation,
  previous: CodeThreadOperationalMetadata | undefined,
): CodeThreadCheckState {
  if (github.status === "observed") {
    return { freshness: github.freshness ?? "fresh", state: github.checks };
  }
  if (previous?.checks !== undefined) return { ...previous.checks, freshness: "stale" };
  return { freshness: "stale", state: "unknown" };
}

function buildReviewState(
  github: CodeGithubMetadataObservation,
  previous: CodeThreadOperationalMetadata | undefined,
): CodeThreadReviewState {
  if (github.status === "observed") {
    return { freshness: github.freshness ?? "fresh", state: github.review };
  }
  if (previous?.reviewState !== undefined) return { ...previous.reviewState, freshness: "stale" };
  return { freshness: "stale", state: "unknown" };
}

function pullRequestEvidence(
  linkedPullRequest: CodeThreadLinkedPullRequest,
): DeliveryPullRequestEvidence {
  if (linkedPullRequest.kind === "none") {
    return {
      presence: "none",
      matchesDeliveryBranch: false,
      freshness: linkedPullRequest.freshness,
    };
  }
  return {
    presence: linkedPullRequest.state,
    matchesDeliveryBranch: linkedPullRequest.matchesDeliveryBranch,
    freshness: linkedPullRequest.freshness,
  };
}

type ChildActivityEvent = Extract<CodeOperationEventFrame["event"], { kind: "child-activity" }>;
type ChildSummaryText = NonNullable<CodeThreadChildAgentSummary["latestSummary"]>;
type ActivityTimestamp = CodeOperationEventFrame["occurredAt"];

function summarizeChildAgents(
  frames: readonly CodeOperationEventFrame[],
): CodeThreadChildAgentSummary {
  const latestByChild = new Map<string, ChildActivityEvent["state"]>();
  let latest: { summary: ChildSummaryText; occurredAt: ActivityTimestamp } | undefined;
  for (const frame of frames) {
    if (frame.event.kind !== "child-activity") continue;
    latestByChild.set(frame.event.childId, frame.event.state);
    if (latest === undefined || frame.occurredAt >= latest.occurredAt) {
      latest = { summary: frame.event.summary, occurredAt: frame.occurredAt };
    }
  }
  let active = 0;
  let completed = 0;
  let failed = 0;
  for (const state of latestByChild.values()) {
    if (state === "starting" || state === "running" || state === "waiting") {
      active += 1;
    } else if (state === "completed") {
      completed += 1;
    } else if (state === "failed") {
      failed += 1;
    }
  }
  return {
    active,
    completed,
    failed,
    // A child that reached a terminal state (completed or failed) carries a
    // result the user has not acknowledged. The operation journal has no
    // acknowledgement signal yet, so a terminal child result must stay
    // unacknowledged rather than being cleared on the terminal frame — otherwise
    // a PR/local target would report `done` before the user ever saw the child's
    // result. Keeping it blocking holds the target in `waiting` until then.
    unacknowledgedResults: completed + failed,
    ...(latest === undefined
      ? {}
      : { latestSummary: latest.summary, latestActivityAt: latest.occurredAt }),
  };
}

function emptyChildAgents(): CodeThreadChildAgentSummary {
  return { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 };
}

function latestActivity(frames: readonly CodeOperationEventFrame[]): ActivityTimestamp | null {
  let latest: ActivityTimestamp | null = null;
  for (const frame of frames) {
    if (latest === null || frame.occurredAt > latest) latest = frame.occurredAt;
  }
  return latest;
}

/**
 * An `investigation-result` outcome is only delivered by a completed provider
 * conversation turn — never by a completed terminal/test/git operation. A
 * generic `operation-state: completed` frame is ambiguous (it can report a
 * terminal command, test run, or Git operation finishing), so it may only count
 * when it is correlated with a provider turn: the same `operationId` also
 * carries a `conversation-turn-started` event or a `provider-turn-state` result.
 */
function hasCompletedProviderTurn(frames: readonly CodeOperationEventFrame[]): boolean {
  const providerTurnOperations = new Set<string>();
  for (const frame of frames) {
    if (frame.event.kind === "conversation-turn-started") {
      providerTurnOperations.add(String(frame.operationId));
    } else if (
      frame.event.kind === "operation-result" &&
      frame.event.result.kind === "provider-turn-state"
    ) {
      providerTurnOperations.add(String(frame.event.result.operationId));
    }
  }

  return frames.some((frame) => {
    if (
      frame.event.kind === "operation-result" &&
      frame.event.result.kind === "provider-turn-state" &&
      frame.event.result.state === "completed"
    ) {
      return true;
    }
    return (
      frame.event.kind === "operation-state" &&
      frame.event.state === "completed" &&
      providerTurnOperations.has(String(frame.operationId))
    );
  });
}

function buildRecovery(input: {
  readonly projectProjectionPresent: boolean;
  readonly historyFresh: boolean;
}): CodeThreadMetadataRecovery {
  const reasons: CodeThreadMetadataRecoveryReason[] = [];
  if (!input.projectProjectionPresent) reasons.push("project-projection-missing");
  if (!input.historyFresh) reasons.push("operation-journal-rebuild-required");
  if (reasons.length === 0) return { kind: "ok" };
  return {
    kind: "recovering",
    reasons: reasons as [CodeThreadMetadataRecoveryReason, ...CodeThreadMetadataRecoveryReason[]],
  };
}

type PullRequestReviewResult = Extract<CodeOperationResult, { kind: "pull-request-review" }>;
type ObservedPullRequestReview = Extract<PullRequestReviewResult, { state: "observed" }>;
type PullRequestStateResult = Extract<CodeOperationResult, { kind: "pull-request-state" }>;

/**
 * Reconstruct PR, checks, and review evidence from already-journaled operation
 * results. This is the only GitHub-shaped input a board query is allowed to
 * use: it never talks to GitHub.
 */
export function cachedGithubObservationFromHistory(
  history: CodeThreadOperationHistory,
): CodeGithubMetadataObservation {
  if (history.status !== "ok") return { status: "unavailable" };
  let latestReview: PullRequestReviewResult | undefined;
  let latestState: PullRequestStateResult | undefined;
  for (const frame of history.frames) {
    if (frame.event.kind !== "operation-result") continue;
    const result = frame.event.result;
    if (result.kind === "pull-request-review") latestReview = result;
    else if (result.kind === "pull-request-state") latestState = result;
  }
  if (latestReview !== undefined) return observationFromReview(latestReview);
  if (latestState !== undefined) return observationFromPullRequestState(latestState);
  return { status: "unavailable" };
}

function observationFromReview(review: PullRequestReviewResult): CodeGithubMetadataObservation {
  if (review.state !== "observed") {
    return {
      status: "observed",
      freshness: review.freshness,
      pullRequest: null,
      checks: "unknown",
      review: "unknown",
    };
  }
  return {
    status: "observed",
    freshness: review.freshness,
    pullRequest: {
      number: review.number,
      url: review.url,
      baseRepository: review.baseRepository,
      baseBranch: review.baseBranch,
      headBranch: review.headBranch,
      state: review.pullRequestState === "draft" ? "open" : review.pullRequestState,
    },
    checks: summarizeCachedChecks(review.checks),
    review: summarizeCachedReviews(review.reviews),
  };
}

function observationFromPullRequestState(
  state: PullRequestStateResult,
): CodeGithubMetadataObservation {
  if (state.state !== "created" && state.state !== "existing" && state.state !== "merged") {
    return { status: "unavailable" };
  }
  return {
    status: "observed",
    // A mutation receipt is cached evidence, not a live GitHub read.
    freshness: "stale",
    pullRequest: {
      number: state.number,
      url: state.url,
      baseRepository: state.baseRepository,
      baseBranch: state.baseBranch,
      headBranch: state.headBranch,
      state: state.state === "merged" ? "merged" : "open",
    },
    checks: "unknown",
    review: "unknown",
  };
}

function summarizeCachedChecks(
  checks: ObservedPullRequestReview["checks"],
): CodeThreadCheckState["state"] {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.state === "failure")) return "failing";
  if (checks.some((check) => check.state === "pending")) return "pending";
  if (checks.every((check) => check.state === "success" || check.state === "neutral")) {
    return "passing";
  }
  return "unknown";
}

function summarizeCachedReviews(
  reviews: ObservedPullRequestReview["reviews"],
): CodeThreadReviewState["state"] {
  if (reviews.length === 0) return "none";
  if (reviews.some((entry) => entry.state === "changes-requested")) return "changes-requested";
  if (reviews.some((entry) => entry.state === "approved")) return "approved";
  if (reviews.some((entry) => entry.state === "pending")) return "pending";
  return "unknown";
}

type GitObservedResult = Extract<CodeOperationResult, { kind: "git-observed" }>;

function cachedChangedFilesFromHistory(
  history: CodeThreadOperationHistory,
): Extract<CodeThreadChangedFileState, { kind: "observed" }> | undefined {
  if (history.status !== "ok") return undefined;
  let latest: GitObservedResult | undefined;
  for (const frame of history.frames) {
    if (frame.event.kind !== "operation-result") continue;
    if (frame.event.result.kind === "git-observed") latest = frame.event.result;
  }
  if (latest === undefined) return undefined;
  const stagedCount = latest.status.filter(
    (entry) => entry.index !== " " && entry.index !== "?",
  ).length;
  return {
    kind: "observed",
    freshness: "stale",
    changedPathCount: latest.changedPaths.length,
    stagedCount,
    committedAhead: 0,
    workingTreeClean: latest.changedPaths.length === 0 && stagedCount === 0,
  };
}
