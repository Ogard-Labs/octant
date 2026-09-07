import {
  decodeCodeBoardView,
  type CodeBoardCard,
  type CodeBoardQuery,
  type CodeBoardStatus,
  type CodeBoardView,
  type CodeCheckoutIdentity,
  type CodeThread,
  type CodeThreadId,
  type CodeThreadOperationalMetadata,
  type ProjectId,
} from "@octant/contracts";
import {
  compareThreadBoardActivityDescending,
  deriveThreadBoardStatus,
} from "@octant/domain/thread-board-policy";
import type { ProjectedCodeRuntimeWork } from "../persistence/codeProjection";
import { joinCodeThreadBoardPullRequests } from "./threadBoardPullRequestJoin";
import type { ThreadBoardPullRequestSnapshot } from "./threadBoardPullRequestJoin";
import { CodeThreadMetadataService } from "./codeThreadMetadataService";
import { mapConcurrentOrdered } from "./boundedReads";

/**
 * Ceiling on in-flight runtime observations while hydrating one board. Matches
 * the GitHub read pool: both fan out over a list the user grows.
 */
const RUNTIME_OBSERVATION_CONCURRENCY = 4;

const ALL_BOARD_STATUSES: readonly CodeBoardStatus[] = ["ready", "in-progress", "waiting", "done"];

/**
 * A non-archived Code thread the board should resolve, plus the permission- and
 * projection-filtered context the card needs: its bound Project identity,
 * whether that Project projection is currently present, and the follow-up flag
 * (which never influences runtime status). Client unread is not a server card
 * field.
 */
export interface CodeBoardThread {
  readonly thread: CodeThread;
  readonly project: { readonly id: ProjectId; readonly name: string };
  readonly checkout: CodeCheckoutIdentity | undefined;
  readonly projectProjectionPresent: boolean;
  readonly followUp: boolean;
}

export interface CodeBoardThreadSource {
  list(): readonly CodeBoardThread[] | Promise<readonly CodeBoardThread[]>;
}

/**
 * Live runtime activity for a thread derived from the operation runtime works.
 * `executing` is true while a provider turn, tool, or subagent is actively
 * running. `waiting` covers runtime wait signals — pending approval or input, an
 * unresolved outcome, or an interrupted agent turn — that should surface a
 * Waiting status even when the delivery target is not itself waiting. The
 * delivery target's own satisfaction is evaluated separately by the metadata
 * projection and is not repeated here.
 */
export interface CodeBoardRuntimeActivity {
  readonly executing: boolean;
  readonly awaitingInput: boolean;
  readonly interrupted: boolean;
  readonly blockingReason?: string;
}

export interface CodeBoardRuntimeSource {
  observe(threadId: CodeThreadId): CodeBoardRuntimeActivity | Promise<CodeBoardRuntimeActivity>;
}

/**
 * Derive a thread's board activity from its runtime work records.
 *
 * Only the thread's latest provider turn speaks for provider activity. A newer
 * turn supersedes every older one whatever state it was frozen in, so a stale
 * `running` or `waiting` row cannot pin an idle thread in In progress or
 * Waiting. Non-provider work is aggregated across every record.
 *
 * `executing` is any contributing work still running. `waiting` is narrower
 * than "some record is not finished". A record in `waiting` or `ambiguous` is
 * an authoritative live wait whatever its kind: a Git push awaiting
 * credentials, a delivery or review step awaiting a decision, or an unresolved
 * file write all genuinely owe the person something. `interrupted` is
 * different — restart reconciliation marks every non-provider work interrupted
 * because its process is gone, so only the latest provider turn can hold the
 * thread in Waiting from that state.
 */
export function boardRuntimeActivityFromWorks(
  works: ReadonlyArray<ProjectedCodeRuntimeWork>,
): CodeBoardRuntimeActivity {
  // The latest turn is the one that started last, read from the durable
  // chronology the projection assigns each record. `updatedAt` cannot answer
  // this: two turns can share a millisecond, and a record keeps the time it
  // last moved rather than the time it began, so an older turn that a restart
  // rewrote would otherwise outrank the turn that ran after it.
  let latestTurn: ProjectedCodeRuntimeWork | undefined;
  for (const entry of works) {
    if (entry.work.kind !== "provider-turn") continue;
    if (latestTurn === undefined || entry.firstSequence > latestTurn.firstSequence) {
      latestTurn = entry;
    }
  }
  const contributing = works.filter(
    (entry) => entry.work.kind !== "provider-turn" || entry === latestTurn,
  );
  const executing = contributing.some((entry) => entry.work.state === "running");
  const awaitingInput = contributing.some(
    (entry) => entry.work.state === "waiting" || entry.work.state === "ambiguous",
  );
  const interrupted = latestTurn !== undefined && latestTurn.work.state === "interrupted";
  const waiting = awaitingInput || interrupted;
  return {
    executing,
    awaitingInput,
    interrupted,
    ...(waiting && !executing
      ? {
          blockingReason: awaitingInput
            ? "Runtime work is waiting for a decision or input."
            : "The last agent turn was interrupted.",
        }
      : {}),
  };
}

export interface CodeBoardPullRequestSource {
  snapshot(): ThreadBoardPullRequestSnapshot | Promise<ThreadBoardPullRequestSnapshot>;
}

/**
 * Reads a thread's live plan (0027) and reduces it to the board's
 * step-completion count (0051). A dropped step leaves the plan's own record
 * but no longer counts toward either side of the fraction, so a plan that
 * dropped a step can still read as fully done.
 */
export interface CodeBoardPlanProgressSource {
  read(threadId: CodeThreadId): CodeBoardCard["planProgress"];
}

export interface CodeThreadBoardServiceDependencies {
  readonly threads: CodeBoardThreadSource;
  readonly metadata: CodeThreadMetadataService;
  readonly runtime: CodeBoardRuntimeSource;
  readonly pullRequests: CodeBoardPullRequestSource;
  readonly planProgress?: CodeBoardPlanProgressSource;
  readonly clock?: () => string;
}

/**
 * Resolves the shared, runtime-derived Code Thread Board read model. It composes
 * the journal-rebuildable {@link CodeThreadMetadataService} projection with the
 * live operation runtime and the domain status derivation to produce one ordered
 * card per non-archived Code thread that matches the active query. The server
 * stays authoritative for status, delivery satisfaction, and Project membership;
 * grouping is a pure client projection over this ordered result.
 */
export class CodeThreadBoardService {
  readonly #threads: CodeBoardThreadSource;
  readonly #metadata: CodeThreadMetadataService;
  readonly #runtime: CodeBoardRuntimeSource;
  readonly #pullRequests: CodeBoardPullRequestSource;
  readonly #planProgress: CodeBoardPlanProgressSource;
  readonly #clock: () => string;

  constructor(dependencies: CodeThreadBoardServiceDependencies) {
    this.#threads = dependencies.threads;
    this.#metadata = dependencies.metadata;
    this.#runtime = dependencies.runtime;
    this.#pullRequests = dependencies.pullRequests;
    this.#planProgress = dependencies.planProgress ?? { read: () => ({ kind: "none" }) };
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async query(query: CodeBoardQuery): Promise<CodeBoardView> {
    const boardThreadsPromise = this.#threads.list();
    const pullRequestSnapshotPromise = this.#pullRequests.snapshot();
    const boardThreads = await boardThreadsPromise;

    // A runtime observation needs only the thread id, so it does not have to
    // wait on the pull-request snapshot or the metadata projection. Starting
    // all three together keeps one slow GitHub read from holding back every
    // card's activity. The pool is bounded because a board's thread count is
    // the user's to grow — unbounded, a large Project opened one provider
    // read per thread at once.
    //
    // An archived or completed thread has no card, so observing its runtime
    // buys nothing; a Project with a long archive would otherwise spend the
    // whole pool on threads the board is about to drop.
    const observable = boardThreads.filter(
      (entry) => entry.thread.lifecycle !== "archived" && entry.thread.completedAt === undefined,
    );
    const runtimePromise = mapConcurrentOrdered(
      observable,
      RUNTIME_OBSERVATION_CONCURRENCY,
      (entry) => this.#observeRuntime(entry.thread.id),
    );
    const [pullRequestSnapshot, view, runtimeByIndex] = await Promise.all([
      pullRequestSnapshotPromise,
      this.#metadata.project(
        boardThreads.map((entry) => ({
          thread: entry.thread,
          projectProjectionPresent: entry.projectProjectionPresent,
        })),
      ),
      runtimePromise,
    ]);
    const metadataByThread = new Map<string, CodeThreadOperationalMetadata>();
    for (const metadata of view.threads) {
      metadataByThread.set(String(metadata.threadId), metadata);
    }

    const runtimeByThread = new Map<string, (typeof runtimeByIndex)[number]>();
    observable.forEach((entry, index) => {
      const activity = runtimeByIndex[index];
      if (activity !== undefined) runtimeByThread.set(String(entry.thread.id), activity);
    });

    const cards = boardThreads
      .map((entry): CodeBoardCard | undefined => {
        const metadata = metadataByThread.get(String(entry.thread.id));
        // Archived threads are dropped by the metadata projection; skip them here.
        if (metadata === undefined) return undefined;
        // A thread the person completed rests in its shelf until they reopen
        // it; the board is for work in play (decision 0088).
        if (entry.thread.completedAt !== undefined) return undefined;
        const activity = runtimeByThread.get(String(entry.thread.id));
        if (activity === undefined) return undefined;
        const planProgress = this.#planProgress.read(entry.thread.id);
        return buildCard(entry, metadata, activity, pullRequestSnapshot, planProgress);
      })
      .filter((card): card is CodeBoardCard => card !== undefined);

    const appliedStatuses = query.statuses ?? ALL_BOARD_STATUSES;
    const filtered = cards.filter((card) => matchesQuery(card, query, appliedStatuses));
    filtered.sort((a, b) =>
      compareThreadBoardActivityDescending(
        { lastMeaningfulActivityAtMs: activityMs(a) },
        { lastMeaningfulActivityAtMs: activityMs(b) },
      ),
    );

    return decodeCodeBoardView({
      version: 1,
      query: { ...query, statuses: [...appliedStatuses] },
      cards: filtered,
      generatedAt: this.#clock(),
    });
  }

  async #observeRuntime(threadId: CodeThreadId): Promise<CodeBoardRuntimeActivity> {
    try {
      return await this.#runtime.observe(threadId);
    } catch {
      // A runtime that cannot be observed keeps the thread visible; its status
      // still reflects delivery, recovery, and metadata evidence.
      return { executing: false, awaitingInput: false, interrupted: false };
    }
  }
}

function buildCard(
  entry: CodeBoardThread,
  metadata: CodeThreadOperationalMetadata,
  activity: CodeBoardRuntimeActivity,
  pullRequestSnapshot: ThreadBoardPullRequestSnapshot,
  planProgress: CodeBoardCard["planProgress"],
): CodeBoardCard {
  const pullRequestSummaries = joinCodeThreadBoardPullRequests({
    threadId: entry.thread.id,
    snapshot: pullRequestSnapshot,
  });
  const derivation = deriveThreadBoardStatus({
    deliverySatisfaction: metadata.deliverySatisfaction,
    executing: activity.executing,
    awaitingInput: activity.awaitingInput,
    interrupted: activity.interrupted,
    recovering: metadata.recovery.kind === "recovering",
  });
  const blockingReason = activity.blockingReason ?? waitingReasonLabel(derivation.reason);
  return {
    threadId: entry.thread.id,
    projectId: entry.project.id,
    checkoutId: entry.thread.checkoutId,
    checkoutKind: entry.checkout?.kind ?? "existing-worktree",
    title: entry.thread.title,
    status: derivation.status,
    statusReason: derivation.reason,
    outcomeKind: metadata.outcomeKind,
    deliverySatisfaction: metadata.deliverySatisfaction,
    providerInstanceId: entry.thread.providerInstanceId,
    modelId: entry.thread.modelId,
    executing: activity.executing,
    worktree: overlayCheckoutWorktree(metadata.worktree, entry.checkout),
    changedFiles: metadata.changedFiles,
    linkedPullRequest: metadata.linkedPullRequest,
    pullRequestSummaries,
    checks: metadata.checks,
    reviewState: metadata.reviewState,
    childAgents: metadata.childAgents,
    planProgress,
    recovery: metadata.recovery,
    githubFreshness: metadata.githubFreshness,
    ...(blockingReason === undefined ? {} : { blockingReason }),
    followUp: entry.followUp,
    lastMeaningfulActivityAt: metadata.lastMeaningfulActivityAt,
  };
}

function overlayCheckoutWorktree(
  worktree: CodeBoardCard["worktree"],
  checkout: CodeCheckoutIdentity | undefined,
): CodeBoardCard["worktree"] {
  if (worktree.kind === "available" || checkout === undefined) return worktree;
  if (checkout.availability !== "available") return worktree;
  return {
    kind: "available",
    checkoutId: checkout.id,
    path: checkout.kind === "managed-worktree" ? "Managed worktree" : "Current checkout",
    head: checkout.head,
    ...(checkout.kind === "managed-worktree" ? { receiptId: checkout.ownershipReceiptId } : {}),
  };
}

function waitingReasonLabel(reason: CodeBoardCard["statusReason"]): string | undefined {
  switch (reason) {
    case "recovering":
      return "This thread is recovering its Project or operation history.";
    case "awaiting-input":
      return "Runtime work is waiting for a decision or input.";
    case "interrupted":
      return "The last agent turn was interrupted.";
    case "delivery-waiting":
      return "Delivery evidence is stale or ambiguous.";
    default:
      return undefined;
  }
}

function matchesQuery(
  card: CodeBoardCard,
  query: CodeBoardQuery,
  appliedStatuses: readonly CodeBoardStatus[],
): boolean {
  if (!appliedStatuses.includes(card.status)) return false;
  if (query.projectIds !== undefined && !query.projectIds.includes(card.projectId)) return false;
  if (
    query.providerInstanceIds !== undefined &&
    !query.providerInstanceIds.includes(card.providerInstanceId)
  ) {
    return false;
  }
  if (query.deliveryTargets !== undefined && !query.deliveryTargets.includes(card.outcomeKind)) {
    return false;
  }
  if (!matchesPullRequest(card, query.pullRequest)) return false;
  if (!matchesChecks(card, query.checks)) return false;
  if (!matchesFollowUp(card, query.followUp)) return false;
  if (query.text !== undefined && !matchesText(card, query.text)) return false;
  return true;
}

function matchesPullRequest(card: CodeBoardCard, filter: CodeBoardQuery["pullRequest"]): boolean {
  if (filter === undefined || filter === "any") return true;
  const pr = card.linkedPullRequest;
  if (filter === "none") return pr.kind === "none";
  if (filter === "linked") return pr.kind === "linked";
  return pr.kind === "linked" && pr.state === filter;
}

function matchesChecks(card: CodeBoardCard, filter: CodeBoardQuery["checks"]): boolean {
  if (filter === undefined || filter === "any") return true;
  return card.checks.state === filter;
}

function matchesFollowUp(card: CodeBoardCard, filter: CodeBoardQuery["followUp"]): boolean {
  if (filter === undefined || filter === "any") return true;
  return filter === "only" ? card.followUp : !card.followUp;
}

function matchesText(card: CodeBoardCard, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  const haystacks = [card.title];
  if (card.worktree.kind === "available" && card.worktree.head.kind === "branch") {
    haystacks.push(card.worktree.head.name);
  }
  if (card.linkedPullRequest.kind === "linked") {
    haystacks.push(card.linkedPullRequest.headBranch);
    haystacks.push(card.linkedPullRequest.baseBranch);
  }
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

function activityMs(card: CodeBoardCard): number | null {
  if (card.lastMeaningfulActivityAt === null) return null;
  const parsed = Date.parse(card.lastMeaningfulActivityAt);
  return Number.isFinite(parsed) ? parsed : null;
}
