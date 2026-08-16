import {
  decodeCodeBoardView,
  type CodeBoardCard,
  type CodeBoardQuery,
  type CodeBoardStatus,
  type CodeBoardView,
  type CodeThread,
  type CodeThreadId,
  type CodeThreadOperationalMetadata,
  type ProjectId,
} from "@octant/contracts";
import {
  compareCodeBoardActivityDescending,
  deriveCodeBoardStatus,
} from "@octant/domain/code-policy";
import { CodeThreadMetadataService } from "./codeThreadMetadataService";

const ALL_BOARD_STATUSES: readonly CodeBoardStatus[] = ["ready", "in-progress", "waiting", "done"];

/**
 * A non-archived Code thread the board should resolve, plus the permission- and
 * projection-filtered context the card needs: its bound Project identity,
 * whether that Project projection is currently present, and the unread and
 * follow-up flags (which never influence runtime status).
 */
export interface CodeBoardThread {
  readonly thread: CodeThread;
  readonly project: { readonly id: ProjectId; readonly name: string };
  readonly projectProjectionPresent: boolean;
  readonly unread: boolean;
  readonly followUp: boolean;
}

export interface CodeBoardThreadSource {
  list(): readonly CodeBoardThread[] | Promise<readonly CodeBoardThread[]>;
}

/**
 * Live runtime activity for a thread derived from the operation runtime works.
 * `executing` is true while a provider turn, tool, or subagent is actively
 * running. `waiting` covers non-delivery wait signals — pending approval or
 * input, or provider recovery — that should surface a Waiting status even when
 * the delivery target is not itself waiting. Delivery-, CI-, and review-based
 * waiting is already captured by the metadata projection's delivery
 * satisfaction and does not need to be repeated here.
 */
export interface CodeBoardRuntimeActivity {
  readonly executing: boolean;
  readonly waiting: boolean;
  readonly blockingReason?: string;
}

export interface CodeBoardRuntimeSource {
  observe(threadId: CodeThreadId): CodeBoardRuntimeActivity | Promise<CodeBoardRuntimeActivity>;
}

export interface CodeThreadBoardServiceDependencies {
  readonly threads: CodeBoardThreadSource;
  readonly metadata: CodeThreadMetadataService;
  readonly runtime: CodeBoardRuntimeSource;
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
  readonly #clock: () => string;

  constructor(dependencies: CodeThreadBoardServiceDependencies) {
    this.#threads = dependencies.threads;
    this.#metadata = dependencies.metadata;
    this.#runtime = dependencies.runtime;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async query(query: CodeBoardQuery): Promise<CodeBoardView> {
    const boardThreads = await this.#threads.list();
    const view = await this.#metadata.project(
      boardThreads.map((entry) => ({
        thread: entry.thread,
        projectProjectionPresent: entry.projectProjectionPresent,
      })),
    );
    const metadataByThread = new Map<string, CodeThreadOperationalMetadata>();
    for (const metadata of view.threads) {
      metadataByThread.set(String(metadata.threadId), metadata);
    }

    const cards: CodeBoardCard[] = [];
    for (const entry of boardThreads) {
      const metadata = metadataByThread.get(String(entry.thread.id));
      // Archived threads are dropped by the metadata projection; skip them here.
      if (metadata === undefined) continue;
      const activity = await this.#observeRuntime(entry.thread.id);
      cards.push(buildCard(entry, metadata, activity));
    }

    const appliedStatuses = query.statuses ?? ALL_BOARD_STATUSES;
    const filtered = cards.filter((card) => matchesQuery(card, query, appliedStatuses));
    filtered.sort((a, b) =>
      compareCodeBoardActivityDescending(
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
      return { executing: false, waiting: false };
    }
  }
}

function buildCard(
  entry: CodeBoardThread,
  metadata: CodeThreadOperationalMetadata,
  activity: CodeBoardRuntimeActivity,
): CodeBoardCard {
  const status = deriveCodeBoardStatus({
    deliverySatisfaction: metadata.deliverySatisfaction,
    executing: activity.executing,
    waiting: activity.waiting,
    recovering: metadata.recovery.kind === "recovering",
  });
  return {
    threadId: entry.thread.id,
    projectId: entry.project.id,
    checkoutId: entry.thread.checkoutId,
    title: entry.thread.title,
    status,
    outcomeKind: metadata.outcomeKind,
    deliverySatisfaction: metadata.deliverySatisfaction,
    providerInstanceId: entry.thread.providerInstanceId,
    modelId: entry.thread.modelId,
    executing: activity.executing,
    worktree: metadata.worktree,
    changedFiles: metadata.changedFiles,
    linkedPullRequest: metadata.linkedPullRequest,
    checks: metadata.checks,
    reviewState: metadata.reviewState,
    childAgents: metadata.childAgents,
    recovery: metadata.recovery,
    githubFreshness: metadata.githubFreshness,
    ...(activity.blockingReason === undefined ? {} : { blockingReason: activity.blockingReason }),
    unread: entry.unread,
    followUp: entry.followUp,
    lastMeaningfulActivityAt: metadata.lastMeaningfulActivityAt,
  };
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
