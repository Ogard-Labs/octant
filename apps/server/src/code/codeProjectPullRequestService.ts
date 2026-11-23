import type { EventActor } from "@octant/contracts";
import {
  decodeActivityDeliveryObserved,
  type ActivityDeliveryObserved,
} from "@octant/contracts/code-home-activity";

import {
  decideRemotePullRequestMerge,
  type RequiredChecksState,
} from "@octant/domain/code-pull-request-action-policy";
import type {
  CodeProjectPullRequestBackgroundRefreshState,
  CodeProjectPullRequestConnection,
  CodeProjectPullRequestDetail,
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestDetailQuery,
  CodeProjectPullRequestDetailRefreshCommand,
  CodeProjectPullRequestDetailView,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestMergeCommand,
  CodeProjectPullRequestMergeOutcome,
  CodeProjectPullRequestMergeRecorded,
  CodeProjectPullRequestQuery,
  CodeProjectPullRequestRefreshCommand,
  CodeProjectPullRequestRow,
  CodeProjectPullRequestStaleReason,
  CodeProjectPullRequestSwitchTarget,
  CodeProjectPullRequestView,
  CodeThreadId,
  ConnectedGitHubRepository,
  ProjectId,
  UtcTimestamp,
  WindowId,
} from "@octant/contracts";
import {
  CODE_PROJECT_PULL_REQUEST_MERGE_RECORDED,
  decodeCodeProjectPullRequestDetailView,
  decodeCodeProjectPullRequestView,
  GithubRepositoryName,
  GithubRepositoryOwner,
  MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES,
  MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS,
  MAX_CODE_PROJECT_PULL_REQUEST_ROWS,
  UtcTimestamp as UtcTimestampSchema,
} from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import {
  boundActivePullRequestRefresh,
  CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS,
  matchLinkedThreadsToPullRequest,
  type CodeProjectLinkedThreadFact,
} from "@octant/domain/code-project-pull-request-policy";
import type { PullRequestLinkRecord } from "@octant/domain/pull-request-identity-policy";
import { Schema } from "effect";
import type { CacheStatsRecorder } from "../cacheStatsProjection";
import type { Journal } from "../persistence/journal";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { parseConnectedGitHubRemotes } from "./connectedRepository";
import type {
  GhActivePullRequestListResult,
  GhActivePullRequestRow,
  GhPullRequestMergeResult,
  GhPullRequestReviewResult,
} from "./ghPullRequestPort";
import { mapConcurrentOrdered } from "./boundedReads";
import type {
  CodeProjectPullRequestSnapshotStore,
  StoredCodeProjectPullRequestSnapshot,
} from "./codeProjectPullRequestSnapshotStore";
import {
  splitRepositoryName,
  type PullRequestLinkReader,
  type PullRequestLinkRecorder,
} from "./pullRequestLinkService";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestampSchema);
const decodeRepositoryOwner = Schema.decodeUnknownSync(GithubRepositoryOwner);
const decodeRepositoryName = Schema.decodeUnknownSync(GithubRepositoryName);
const GITHUB_READ_CONCURRENCY = 4;
/**
 * How long a sidebar navigation tick may reuse the last board join. The
 * sidebar re-reads navigation every two seconds, and a fresh board snapshot
 * resolves every Project's Git remotes and replays each thread's operation
 * history; doing that on every tick would contend with the thread switching
 * the tick exists to keep cheap. A refresh or revocation drops the memo at
 * once, so the sidebar is never older than the board by more than this.
 */
const NAVIGATION_SNAPSHOT_MAX_AGE_MS = 10_000;

/**
 * How long one Project's Git remotes answer is reused across reads. Only a
 * Project without a connected repository is asked at all, and that answer
 * changes when its folder gains or loses a remote, not between two reads of
 * the board. Without this, every board, list, and detail read ran `git` under
 * a seatbelt for each such Project: an idle host with two of them spawned
 * five sandboxed git processes a second, each first walking the home folder
 * to build its profile.
 */
const REMOTES_MAX_AGE_MS = 60_000;

export interface CodeProjectPullRequestAuthorizedProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly type: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
  readonly binding?: { readonly canonicalRoot: string };
  readonly connectedRepository?: ConnectedGitHubRepository | undefined;
}

export interface CodeProjectPullRequestProjectSource {
  bootstrap(
    windowId: WindowId,
  ): Promise<{ readonly active: ReadonlyArray<CodeProjectPullRequestAuthorizedProject> }>;
}

export interface CodeProjectPullRequestRemoteSource {
  remotes(root: string): Promise<
    | ReadonlyArray<{
        readonly name: string;
        readonly fetchUrl: string;
        readonly pushUrl: string;
        readonly credentialed?: boolean;
      }>
    | undefined
  >;
}

export interface CodeProjectPullRequestListPort {
  listActive(
    request: { readonly owner: string; readonly name: string; readonly limit: number },
    signal: AbortSignal,
  ): Promise<GhActivePullRequestListResult>;
  observeBaseRepository?(
    request: { readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<{ readonly nodeId: string; readonly repository?: string } | undefined>;
}

export interface CodeProjectPullRequestDetailPort {
  observeReviewByIdentity(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
      readonly maxDiffBytes: number;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestReviewResult>;
  /**
   * Confirms an issue's `ClosedEvent` closer is this exact pull request, when
   * the port supports the read; absent, closure candidates stay unrecorded.
   */
  observeIssueClosure?(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly issueNumber: number;
      readonly closerNumber: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly closedAt: string; readonly title: string } | undefined>;
  observeViewerLogin?(signal: AbortSignal): Promise<string | undefined>;
}

export interface CodeProjectPullRequestMergePort {
  mergeByIdentity(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
      readonly method: CodeProjectPullRequestMergeCommand["method"];
      /** The head commit the reviewer approved. */
      readonly headSha: string;
      readonly expectedPullRequestNodeId?: string;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestMergeResult>;
}

/**
 * Appends one merge attempt as its own single-event aggregate. Attempts are
 * independent facts, so none waits on another's version, and the local user
 * is the actor because only a local window reaches the merge route.
 */
export function journalPullRequestMerge(
  journal: Pick<Journal, "append">,
  record: CodeProjectPullRequestMergeRecorded,
  options: {
    readonly uuid: () => string;
    readonly clock: () => string;
    /**
     * Who asked, as the route resolved it from the authenticated principal: a
     * paired device's act is journaled as that device. Absent means the
     * person at this host.
     */
    readonly actor?: EventActor;
  },
): void {
  journal.append({
    aggregate: { aggregateType: "code-project-pull-request-merge", aggregateId: options.uuid() },
    expectedVersion: 0,
    events: [
      {
        eventId: options.uuid(),
        eventName: CODE_PROJECT_PULL_REQUEST_MERGE_RECORDED,
        eventVersion: 1,
        correlationId: options.uuid(),
        actor: options.actor ?? { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        occurredAt: options.clock(),
        payload: record,
      },
    ],
  });
}

/**
 * Host-wide linked-thread facts, deliberately not window-scoped. The snapshot
 * cache is shared by every window and by background refreshes, so building it
 * from one window's visible threads let a refresh from a window with disjoint
 * Code-project visibility erase the other windows' linked (thread, pull
 * request) pairs until a window that could see them refreshed again.
 * Per-window authority stays where threads are read: boards and thread views
 * filter by their own window-visible thread lists before joining these rows.
 */
export interface CodeProjectLinkedThreadSource {
  list(): Promise<ReadonlyArray<CodeProjectLinkedThreadFact>>;
}

interface CachedSnapshot {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly lastSuccessfulRefreshAt: UtcTimestamp;
  readonly repositoriesTruncated: boolean;
  readonly pullRequestsTruncated: boolean;
}

interface CachedDetail {
  readonly detail: Extract<CodeProjectPullRequestDetail, { readonly state: "observed" }>;
  readonly lastSuccessfulRefreshAt: UtcTimestamp;
}

/** The read-only join input a Work, Code, or sidebar read composes summaries from. */
export interface BoardSnapshot {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly freshness: CodeProjectPullRequestFreshness;
  readonly githubRevoked: boolean;
}

/**
 * What one background observation of a Project reported, as a value the
 * cadence can pace on. `unconnected` means there was nothing to observe;
 * `unauthorized` is the full stop that only an explicit signal clears.
 */
export type CodeProjectPullRequestCadenceObservation =
  | { readonly status: "fresh" }
  | { readonly status: "empty" }
  | { readonly status: "unconnected" }
  | {
      readonly status: "failed";
      readonly reason: CodeProjectPullRequestStaleReason;
      readonly retryAfter?: UtcTimestamp;
    }
  | { readonly status: "unauthorized" };

/**
 * Private Project-scoped pull-request snapshot. Manual refresh — or, for
 * Projects that opted in, the bounded background cadence driving
 * `observeForCadence` — reconstructs the bounded open, draft, merged, and
 * closed history and stores the bounded list cache outside the journal. Detail
 * rows remain process-local; the journal never sees either observation path.
 */
export class CodeProjectPullRequestService {
  readonly #projects: CodeProjectPullRequestProjectSource;
  readonly #remotes: CodeProjectPullRequestRemoteSource;
  readonly #list: CodeProjectPullRequestListPort;
  readonly #detail: CodeProjectPullRequestDetailPort;
  readonly #merge: CodeProjectPullRequestMergePort;
  readonly #recordDelivery: ((observation: ActivityDeliveryObserved) => void) | undefined;
  readonly #recordMerge:
    | ((record: CodeProjectPullRequestMergeRecorded, actor?: EventActor) => void)
    | undefined;
  readonly #requiredChecks:
    | ((
        request: { readonly owner: string; readonly name: string; readonly number: number },
        signal: AbortSignal,
      ) => Promise<RequiredChecksState>)
    | undefined;
  readonly #threads: CodeProjectLinkedThreadSource;
  readonly #clock: () => string;
  readonly #cacheStats: CacheStatsRecorder | undefined;
  readonly #snapshotStore: CodeProjectPullRequestSnapshotStore | undefined;
  readonly #pullRequestLinks:
    | (PullRequestLinkRecorder & Partial<PullRequestLinkReader>)
    | undefined;
  readonly #onSnapshotRefreshed:
    | ((rows: ReadonlyArray<CodeProjectPullRequestRow>) => void)
    | undefined;
  #cache: CachedSnapshot | undefined;
  readonly #projectFreshness = new Map<string, CodeProjectPullRequestFreshness>();
  readonly #detailCache = new Map<string, CachedDetail>();
  #freshness: CodeProjectPullRequestFreshness = { status: "empty" };
  readonly #detailFreshness = new Map<string, CodeProjectPullRequestFreshness>();
  readonly #backgroundRefresh = new Map<string, CodeProjectPullRequestBackgroundRefreshState>();
  /** Tail of the serialized refresh chain; see `#refreshCore`. */
  #refreshQueue: Promise<unknown> = Promise.resolve();
  #githubRevoked = false;
  /**
   * The last board join handed to a navigation read, by window, with the
   * time it was computed. See `NAVIGATION_SNAPSHOT_MAX_AGE_MS`.
   */
  readonly #navigationSnapshots = new Map<
    string,
    { readonly computedAtMs: number; readonly snapshot: Promise<BoardSnapshot> }
  >();
  /** Each unconnected Project's remotes answer, by root. See `REMOTES_MAX_AGE_MS`. */
  readonly #remotesByRoot = new Map<
    string,
    {
      readonly computedAtMs: number;
      readonly remotes: ReturnType<CodeProjectPullRequestRemoteSource["remotes"]>;
    }
  >();
  /**
   * Bumped by every revocation. A refresh captures it before its GitHub reads
   * and refuses to commit if it changed, so a revocation that lands while
   * reads are in flight cannot be undone by the resuming refresh.
   */
  #revocationGeneration = 0;

  constructor(options: {
    readonly projects: CodeProjectPullRequestProjectSource;
    readonly remotes: CodeProjectPullRequestRemoteSource;
    readonly list: CodeProjectPullRequestListPort;
    readonly detail: CodeProjectPullRequestDetailPort;
    readonly merge?: CodeProjectPullRequestMergePort;
    /**
     * Reads the required checks of a pull request. A merge the person confirmed
     * (from a paired client, or as part of a stack) is refused unless they pass.
     */
    readonly requiredChecks?: (
      request: { readonly owner: string; readonly name: string; readonly number: number },
      signal: AbortSignal,
    ) => Promise<RequiredChecksState>;
    /**
     * Journals each merge attempt's outcome. The merge is a user-confirmed
     * mutation of the person's repository, so Octant keeps its own record of
     * which head was approved and how the attempt ended, beside GitHub's.
     */
    readonly recordMerge?: (
      record: CodeProjectPullRequestMergeRecorded,
      actor?: EventActor,
    ) => void;
    /**
     * Journals a confirmed forge delivery the journal's own observers proved:
     * a merged pull request, or an issue this pull request is confirmed to
     * have closed. Absent, observations are shown but not recorded.
     */
    readonly recordDelivery?: (observation: ActivityDeliveryObserved) => void;
    readonly threads: CodeProjectLinkedThreadSource;
    readonly clock?: () => string;
    readonly cacheStats?: CacheStatsRecorder;
    readonly snapshotStore?: CodeProjectPullRequestSnapshotStore;
    /**
     * Authoritative pull-request link identity registry. Owns canonical
     * pull-request identity, forge node IDs, and renamed repository display
     * fields across list, board, detail, switch, and merge readers.
     */
    readonly pullRequestLinks?: PullRequestLinkRecorder & Partial<PullRequestLinkReader>;
    /**
     * Observes every replacement of the row snapshot, however a refresh was
     * initiated. This is the seam that turns snapshot facts (for example a
     * linked pull request's checks turning red) into thread obligations
     * without the observer ever reaching GitHub itself.
     */
    readonly onSnapshotRefreshed?: (rows: ReadonlyArray<CodeProjectPullRequestRow>) => void;
  }) {
    this.#projects = options.projects;
    this.#remotes = options.remotes;
    this.#list = options.list;
    this.#detail = options.detail;
    this.#merge =
      options.merge ??
      ({
        mergeByIdentity: async () => ({ status: "unavailable", reason: "unavailable" }),
      } satisfies CodeProjectPullRequestMergePort);
    this.#requiredChecks = options.requiredChecks;
    this.#recordMerge = options.recordMerge;
    this.#recordDelivery = options.recordDelivery;
    this.#threads = options.threads;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#cacheStats = options.cacheStats;
    this.#snapshotStore = options.snapshotStore;
    this.#pullRequestLinks = options.pullRequestLinks;
    this.#onSnapshotRefreshed = options.onSnapshotRefreshed;
    const restored = this.#snapshotStore?.load();
    if (restored !== undefined) this.#restoreSnapshot(restored);
  }

  revokeGithub(): void {
    this.#githubRevoked = true;
    this.#revocationGeneration += 1;
    this.#cache = undefined;
    this.#navigationSnapshots.clear();
    this.#detailCache.clear();
    this.#detailFreshness.clear();
    this.#freshness = { status: "stale", staleReason: "disconnected" };
    this.#snapshotStore?.clear();
  }

  /**
   * The cadence reports its per-Project state here so the list view can show
   * why cards are or are not moving. State flows one way — cadence into
   * service — and is never journaled.
   */
  recordBackgroundRefreshState(state: CodeProjectPullRequestBackgroundRefreshState): void {
    this.#backgroundRefresh.set(String(state.projectId), state);
  }

  async query(
    windowId: WindowId,
    query: CodeProjectPullRequestQuery,
  ): Promise<CodeProjectPullRequestView> {
    const [projects, threads] = await Promise.all([
      this.#resolveProjects(windowId),
      query.threadId === undefined ? undefined : this.#threads.list(),
    ]);
    this.#observeListRead();
    const board = threads === undefined ? undefined : this.#boardSnapshot(projects, threads);
    const rows =
      query.threadId !== undefined && board !== undefined
        ? openRowsForThread(board.rows, query.threadId)
        : this.#authorizedActiveRows(projects);
    return this.#view({
      query,
      projects,
      rows,
      repositoriesTruncated: this.#cache?.repositoriesTruncated ?? false,
      pullRequestsTruncated: this.#cache?.pullRequestsTruncated ?? false,
      freshness: board?.freshness ?? this.#queryFreshness(),
    });
  }

  /**
   * Read-only board join snapshot. Never reaches GitHub; it combines the
   * private refresh cache with bounded exact identities recovered by the
   * thread source from the operation journal.
   */
  async boardSnapshot(windowId: WindowId): Promise<BoardSnapshot> {
    const [projects, threads] = await Promise.all([
      this.#resolveProjects(windowId),
      this.#threads.list(),
    ]);
    this.#observeListRead();
    return this.#boardSnapshot(projects, threads);
  }

  #boardSnapshot(
    projects: ReadonlyArray<CodeProjectPullRequestConnection>,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
  ): BoardSnapshot {
    const cachedRows = this.#authorizedRows(projects);
    const rows = this.#boundRows(this.#mergeRows(cachedRows, this.#knownRows(projects, threads)));
    const freshness = this.#queryFreshness();
    const boardFreshness =
      rows.some((row) => row.state === "unknown") && freshness.status !== "stale"
        ? {
            status: "stale" as const,
            ...(freshness.lastSuccessfulRefreshAt === undefined
              ? {}
              : { lastSuccessfulRefreshAt: freshness.lastSuccessfulRefreshAt }),
          }
        : freshness;
    return {
      rows: this.#githubRevoked ? [] : rows,
      freshness: boardFreshness,
      githubRevoked: this.#githubRevoked,
    };
  }

  /**
   * The board join for a sidebar navigation read. Same rows and authority as
   * `boardSnapshot`, reused for a bounded time so the two-second navigation
   * tick does not pay the full join each time. A snapshot that failed to
   * compute is not memoized: the next tick tries again.
   */
  navigationSnapshot(windowId: WindowId): Promise<BoardSnapshot> {
    const key = String(windowId);
    const nowMs = Date.parse(this.#clock());
    const memo = this.#navigationSnapshots.get(key);
    if (memo !== undefined && nowMs - memo.computedAtMs < NAVIGATION_SNAPSHOT_MAX_AGE_MS) {
      return memo.snapshot;
    }
    const snapshot = this.boardSnapshot(windowId);
    this.#navigationSnapshots.set(key, { computedAtMs: nowMs, snapshot });
    snapshot.catch(() => {
      if (this.#navigationSnapshots.get(key)?.snapshot === snapshot) {
        this.#navigationSnapshots.delete(key);
      }
    });
    return snapshot;
  }

  async queryDetail(
    windowId: WindowId,
    query: CodeProjectPullRequestDetailQuery,
  ): Promise<CodeProjectPullRequestDetailView> {
    const projects = await this.#resolveProjects(windowId);
    const authorized = this.#authorizedConnection(projects, query);
    if (authorized === undefined) {
      return this.#detailView({
        query,
        detail: { state: "empty" },
        freshness: { status: "empty" },
        linkedThreads: [],
      });
    }
    if (this.#githubRevoked) {
      return this.#detailView({
        query,
        detail: { state: "unavailable" },
        freshness: this.#detailQueryFreshness(query),
        linkedThreads: [],
      });
    }
    const key = this.#detailCacheKey(query);
    const cached = this.#detailCache.get(key) ?? this.#detailCache.get(detailKey(query));
    if (cached === undefined) {
      this.#cacheStats?.recordMiss("pull-request-detail");
      return this.#detailView({
        query,
        detail: { state: "empty" },
        freshness: this.#detailFreshness.get(key) ??
          this.#detailFreshness.get(detailKey(query)) ?? { status: "empty" },
        linkedThreads: [],
      });
    }
    this.#cacheStats?.recordHit("pull-request-detail");
    const threads = await this.#threads.list();
    return this.#detailView({
      query,
      detail: cached.detail,
      freshness: this.#detailQueryFreshness(query),
      linkedThreads: this.#linkedThreads(authorized, cached.detail, threads),
    });
  }

  async refreshDetail(
    windowId: WindowId,
    command: CodeProjectPullRequestDetailRefreshCommand,
    signal: AbortSignal,
  ): Promise<CodeProjectPullRequestDetailView> {
    this.#remotesByRoot.clear();
    const projects = await this.#resolveProjects(windowId, { allowForgeLookup: true, signal });
    const authorized = this.#authorizedConnection(projects, command);
    if (authorized === undefined || this.#githubRevoked) {
      return this.queryDetail(windowId, command);
    }

    const canonical = this.#canonicalTarget(authorized, command);
    const observed = await this.#detail.observeReviewByIdentity(
      {
        owner: canonical.repositoryOwner,
        name: canonical.repositoryName,
        number: command.number,
        maxDiffBytes: MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES,
      },
      signal,
    );
    if (observed.status !== "observed" || observed.freshness !== "fresh" || observed.ambiguous) {
      this.#cacheStats?.recordRefreshFailed("pull-request-detail");
      return this.#staleDetailView({
        query: command,
        authorized,
        reason: "refresh-failed",
      });
    }

    const detail = this.#observedDetail(observed);
    this.#cacheStats?.recordRefreshSucceeded("pull-request-detail");
    const now = decodeUtcTimestamp(this.#clock());
    const threads = await this.#threads.list();
    const initialLinkedThreads = this.#linkedThreads(
      authorized,
      detail,
      threads,
      observed.pullRequest.pullRequestNodeId === undefined
        ? undefined
        : { pullRequestNodeId: observed.pullRequest.pullRequestNodeId },
    );
    const recordedLink = await this.#recordObservedLink(
      authorized,
      observed,
      initialLinkedThreads,
      threads,
      signal,
    );
    const linkedThreads = this.#linkedThreads(authorized, detail, threads, {
      ...(observed.pullRequest.pullRequestNodeId === undefined
        ? {}
        : { pullRequestNodeId: observed.pullRequest.pullRequestNodeId }),
      ...(recordedLink === undefined ? {} : { recordedLink }),
    });
    const key = this.#detailCacheKey(command, recordedLink);
    this.#detailCache.set(key, { detail, lastSuccessfulRefreshAt: now });
    this.#detailFreshness.set(key, { status: "fresh", lastSuccessfulRefreshAt: now });
    await this.#recordObservedDelivery(authorized, observed, linkedThreads, signal);
    return this.#detailView({
      query: command,
      detail,
      freshness: { status: "fresh", lastSuccessfulRefreshAt: now },
      linkedThreads,
    });
  }

  /**
   * Returns the last observed GitHub author login for this pull request from
   * host-local caches, or `undefined` when unobserved, revoked, or unknown.
   */
  observedAuthor(target: CodeProjectPullRequestDetailQuery): string | undefined {
    if (this.#githubRevoked) return undefined;
    const link = this.#resolveLink(target);
    const cached =
      this.#detailCache.get(this.#detailCacheKey(target, link))?.detail ??
      this.#detailCache.get(detailKey(target))?.detail;
    const detailAuthor = cached?.author.trim();
    if (
      detailAuthor !== undefined &&
      detailAuthor.length > 0 &&
      detailAuthor !== "Unknown author"
    ) {
      return detailAuthor;
    }
    const targetRowKey = this.#targetIdentityKey(target, link);
    const row = this.#cache?.rows.find((entry) => this.#rowIdentityKey(entry) === targetRowKey);
    const rowAuthor = row?.author.trim();
    if (rowAuthor !== undefined && rowAuthor.length > 0 && rowAuthor !== "Unknown author") {
      return rowAuthor;
    }
    return undefined;
  }

  /**
   * Reads the signed-in GitHub viewer login through the pull-request port,
   * failing closed to `undefined` when GitHub is revoked, aborted, or unreadable.
   */
  async observeViewerLogin(signal: AbortSignal): Promise<string | undefined> {
    if (this.#githubRevoked || this.#detail.observeViewerLogin === undefined || signal.aborted) {
      return undefined;
    }
    const revocationGeneration = this.#revocationGeneration;
    try {
      const login = await this.#detail.observeViewerLogin(signal);
      if (
        this.#githubRevoked ||
        this.#revocationGeneration !== revocationGeneration ||
        signal.aborted
      ) {
        return undefined;
      }
      const trimmed = login?.trim();
      return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether this window may act on one pull request, and which Code threads
   * are linked to it. The pull-request switches ask before every effect, with
   * the same Project-to-repository check the merge makes.
   */
  async authorizePullRequest(
    windowId: WindowId,
    target: CodeProjectPullRequestDetailQuery,
  ): Promise<
    | {
        readonly status: "authorized";
        readonly linkedThreadIds: ReadonlyArray<string>;
        readonly canonicalTarget?: CodeProjectPullRequestSwitchTarget;
        readonly pullRequestNodeId?: string;
      }
    | { readonly status: "not-authorized" }
    | { readonly status: "disconnected" }
  > {
    const projects = await this.#resolveProjects(windowId);
    const authorized = this.#authorizedConnection(projects, target);
    if (authorized === undefined) return { status: "not-authorized" };
    if (this.#githubRevoked) return { status: "disconnected" };
    const link = this.#resolveLink({
      projectId: target.projectId,
      repositoryOwner: target.repositoryOwner,
      repositoryName: target.repositoryName,
      number: target.number,
    });
    const canonicalTarget = this.#canonicalTarget(authorized, target, link);
    const cached =
      this.#detailCache.get(this.#detailCacheKey(target, link))?.detail ??
      this.#detailCache.get(detailKey(target))?.detail;
    const targetRowKey = this.#targetIdentityKey(target, link);
    const row = this.#cache?.rows.find((entry) => this.#rowIdentityKey(entry) === targetRowKey);
    const threads = await this.#threads.list();
    const linked = this.#matchThreads(
      authorized,
      {
        owner: canonicalTarget.repositoryOwner,
        name: canonicalTarget.repositoryName,
        number: target.number,
        headBranch: cached?.headBranch ?? row?.headBranch ?? link?.headBranch ?? "",
        title: cached?.title ?? row?.title ?? "",
        ...(link?.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: link.pullRequestNodeId }),
        ...(link === undefined ? {} : { recordedLink: link }),
      },
      threads,
    );
    const linkedThreadIds = uniqueStrings([
      ...(link?.threadIds.map((id) => String(id)) ?? []),
      ...linked.map((thread) => String(thread.threadId)),
    ]);
    return {
      status: "authorized",
      linkedThreadIds,
      canonicalTarget,
      ...(link?.pullRequestNodeId === undefined
        ? {}
        : { pullRequestNodeId: link.pullRequestNodeId }),
    };
  }

  /**
   * The pull requests this window can see that are linked to one Code thread
   * and not known to be merged or closed: the board's own join, so the thread
   * watches the pull request its card shows. Never reaches GitHub.
   */
  async linkedPullRequests(
    windowId: WindowId,
    threadId: CodeThreadId,
  ): Promise<ReadonlyArray<CodeProjectPullRequestSwitchTarget>> {
    const snapshot = await this.boardSnapshot(windowId);
    return openRowsForThread(snapshot.rows, threadId).map((row) => ({
      projectId: row.projectId,
      repositoryOwner: row.repositoryOwner,
      repositoryName: row.repositoryName,
      number: row.number,
    }));
  }

  async merge(
    windowId: WindowId,
    command: CodeProjectPullRequestMergeCommand,
    signal: AbortSignal,
    caller: "local-window" | "remote-device" = "local-window",
    // Who the journal names. A device the host's own person paired is judged
    // as a local window is, so `caller` alone does not tell the two apart.
    actor?: EventActor,
  ): Promise<CodeProjectPullRequestMergeOutcome> {
    const projects = await this.#resolveProjects(windowId);
    const authorized = this.#authorizedConnection(projects, command);
    const link =
      authorized === undefined
        ? undefined
        : this.#resolveLink({
            projectId: command.projectId,
            repositoryOwner: command.repositoryOwner,
            repositoryName: command.repositoryName,
            number: command.number,
          });
    const canonical =
      authorized === undefined ? command : this.#canonicalTarget(authorized, command, link);
    const record = (result: CodeProjectPullRequestMergeRecorded["result"]) =>
      this.#recordMerge?.(
        {
          projectId: command.projectId,
          repositoryOwner: canonical.repositoryOwner,
          repositoryName: canonical.repositoryName,
          number: command.number,
          method: command.method,
          headSha: command.headSha,
          // Absent means the local window, as every record was before paired
          // clients could merge.
          ...(caller === "remote-device" ? { caller } : {}),
          result,
        },
        actor,
      );
    // A paired client, or a merge that says the person confirmed it, is held
    // to the repository's required checks. The local window's own review
    // already shows them and its Confirm step is the person's choice.
    const confirmedRefusal =
      authorized !== undefined &&
      !this.#githubRevoked &&
      (caller === "remote-device" || command.confirmed === true)
        ? await this.#confirmedMergeRefusal(
            caller,
            {
              ...command,
              repositoryOwner: canonical.repositoryOwner,
              repositoryName: canonical.repositoryName,
            },
            signal,
          )
        : undefined;
    let result:
      | GhPullRequestMergeResult
      | {
          status: "refused";
          reason: "not-authorized" | "not-confirmed" | "checks-not-passing" | "checks-unknown";
        };
    if (authorized === undefined) {
      result = { status: "refused", reason: "not-authorized" };
    } else if (this.#githubRevoked) {
      result = { status: "unavailable", reason: "disconnected" };
    } else if (confirmedRefusal !== undefined) {
      result = confirmedRefusal;
    } else {
      try {
        result = await this.#merge.mergeByIdentity(
          {
            owner: canonical.repositoryOwner,
            name: canonical.repositoryName,
            number: command.number,
            method: command.method,
            headSha: command.headSha,
            ...(link?.pullRequestNodeId === undefined
              ? {}
              : { expectedPullRequestNodeId: link.pullRequestNodeId }),
          },
          signal,
        );
      } catch (error) {
        // The attempt still reached GitHub's merge path, so it is recorded;
        // the error itself is rethrown unchanged and never journaled.
        record({ status: "failed", reason: signal.aborted ? "aborted" : "error" });
        throw error;
      }
    }
    if (result.status === "merged") {
      // Dropped before the record is appended: if that append fails, GitHub
      // has still merged, and a cached row must not keep showing it open.
      const key = this.#detailCacheKey(command, link);
      const rawKey = detailKey(command);
      this.#detailCache.delete(key);
      this.#detailCache.delete(rawKey);
      this.#detailFreshness.delete(key);
      this.#detailFreshness.delete(rawKey);
      this.#navigationSnapshots.clear();
      // The list snapshot still holds the merged row as open until the next
      // refresh; drop it so a query cannot return a pull request that is gone.
      this.#cache = undefined;
    }
    // Recorded before the outcome returns, so no answer reaches the person
    // for an attempt the journal lacks. A failed local append surfaces as the
    // route's failure; GitHub's state is still observed on the next refresh.
    record(result);
    if (result.status === "merged") {
      // The merge answer itself names no merger or merge time, so it is
      // re-observed once: confirmed metadata records the delivery, and a
      // read that misses it leaves the next ordinary refresh to repair.
      const observed = await this.#detail.observeReviewByIdentity(
        {
          owner: canonical.repositoryOwner,
          name: canonical.repositoryName,
          number: command.number,
          maxDiffBytes: MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES,
        },
        signal,
      );
      if (
        authorized !== undefined &&
        observed.status === "observed" &&
        observed.freshness === "fresh" &&
        !observed.ambiguous
      ) {
        const threads = await this.#threads.list();
        const linkedThreads = this.#matchThreads(
          authorized,
          {
            owner: canonical.repositoryOwner,
            name: canonical.repositoryName,
            number: command.number,
            headBranch: observed.pullRequest.headBranch,
            title: observed.pullRequest.title,
            ...(observed.pullRequest.pullRequestNodeId === undefined
              ? {}
              : { pullRequestNodeId: observed.pullRequest.pullRequestNodeId }),
            ...(link === undefined ? {} : { recordedLink: link }),
          },
          threads,
        );
        await this.#recordObservedLink(authorized, observed, linkedThreads, threads, signal);
        await this.#recordObservedDelivery(authorized, observed, linkedThreads, signal);
      }
      return {
        status: "merged",
        number: command.number,
        method: command.method,
        mergedAt: decodeUtcTimestamp(this.#clock()),
      };
    }
    return result;
  }

  async #confirmedMergeRefusal(
    caller: "local-window" | "remote-device",
    command: CodeProjectPullRequestMergeCommand,
    signal: AbortSignal,
  ): Promise<
    | {
        status: "refused";
        reason: "not-confirmed" | "checks-not-passing" | "checks-unknown";
      }
    | undefined
  > {
    const decision = decideRemotePullRequestMerge({
      caller,
      confirmed: command.confirmed === true,
      requiredChecks:
        command.confirmed === true && this.#requiredChecks !== undefined
          ? await this.#requiredChecks(
              {
                owner: command.repositoryOwner,
                name: command.repositoryName,
                number: command.number,
              },
              signal,
            )
          : "unknown",
    });
    return decision.decision === "allow"
      ? undefined
      : {
          status: "refused",
          reason: decision.reason === "not-authorized" ? "not-confirmed" : decision.reason,
        };
  }

  async refresh(
    windowId: WindowId,
    command: CodeProjectPullRequestRefreshCommand,
    signal: AbortSignal,
  ): Promise<CodeProjectPullRequestView> {
    const { view } = await this.#refreshCore(windowId, command, signal, {
      skipSettledKnownIdentities: false,
    });
    return view;
  }

  /**
   * Background variant of an explicit per-Project refresh. It reuses the same
   * core so there is no second refresh semantics to keep honest, but it may
   * reuse cached merged/closed rows instead of re-observing them, and it
   * reports the outcome as a value the cadence can pace on.
   */
  async observeForCadence(
    windowId: WindowId,
    projectId: ProjectId,
    signal: AbortSignal,
  ): Promise<CodeProjectPullRequestCadenceObservation> {
    const { outcome } = await this.#refreshCore(
      windowId,
      { kind: "refresh-project", projectId },
      signal,
      { skipSettledKnownIdentities: true },
    );
    return outcome;
  }

  /**
   * Explicit and cadence refreshes commit to one shared cache. Running them
   * one at a time keeps commit order equal to start order, so a background
   * observation whose reads were still in flight can never overwrite the
   * result of an explicit refresh that started after it.
   */
  #refreshCore(
    windowId: WindowId,
    command: CodeProjectPullRequestRefreshCommand,
    signal: AbortSignal,
    options: { readonly skipSettledKnownIdentities: boolean },
  ): Promise<{
    readonly view: CodeProjectPullRequestView;
    readonly outcome: CodeProjectPullRequestCadenceObservation;
  }> {
    const run = this.#refreshQueue.then(() =>
      this.#refreshExclusive(windowId, command, signal, options),
    );
    this.#refreshQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #refreshExclusive(
    windowId: WindowId,
    command: CodeProjectPullRequestRefreshCommand,
    signal: AbortSignal,
    options: { readonly skipSettledKnownIdentities: boolean },
  ): Promise<{
    readonly view: CodeProjectPullRequestView;
    readonly outcome: CodeProjectPullRequestCadenceObservation;
  }> {
    if (!options.skipSettledKnownIdentities) {
      // Explicit refresh always observes current Git remotes so an updated
      // remote or stale second remote is never masked by the 60-second memo.
      this.#remotesByRoot.clear();
    }
    const projects = await this.#resolveProjects(windowId, { allowForgeLookup: true, signal });
    const revocationGeneration = this.#revocationGeneration;
    const selected =
      command.kind === "refresh-all"
        ? projects
        : projects.filter((project) => String(project.projectId) === String(command.projectId));
    if (command.kind === "refresh-project" && selected.length === 0) {
      return {
        view: this.#view({
          query: { version: 1 },
          projects,
          rows: this.#authorizedActiveRows(projects),
          repositoriesTruncated: this.#cache?.repositoriesTruncated ?? false,
          pullRequestsTruncated: this.#cache?.pullRequestsTruncated ?? false,
          freshness: this.#queryFreshness(),
        }),
        outcome: { status: "unconnected" },
      };
    }

    const connected = selected.filter(
      (project): project is Extract<CodeProjectPullRequestConnection, { kind: "connected" }> =>
        project.kind === "connected",
    );
    const bounded = boundActivePullRequestRefresh({
      repositories: connected,
      pullRequestsFor: () => [],
    });
    // The view keeps at most MAX pull requests across every repository, so the
    // read budget is global too. Asking each repository for the whole budget
    // requested up to MAX+1 rows per repository to keep MAX in total, which is
    // rate limit the user pays for and never sees. Workers claim repositories
    // in order, so by the time a later one starts, earlier rows are counted and
    // its request shrinks to what the budget can still hold.
    //
    // Repositories past the budget are still contacted, with a minimal request:
    // skipping them would hide an unauthorized or rate-limited repository until
    // some later refresh happened to reach it.
    const listBudget = CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS + 1;
    let listedRowCount = 0;
    const [threads, listedResults] = await Promise.all([
      this.#threads.list(),
      mapConcurrentOrdered(bounded.repositories, GITHUB_READ_CONCURRENCY, async (repository) => {
        const listed = await this.#list.listActive(
          {
            owner: repository.repositoryOwner,
            name: repository.repositoryName,
            limit: Math.max(1, listBudget - listedRowCount),
          },
          signal,
        );
        if (listed.status === "ok") listedRowCount += listed.rows.length;
        return { repository, listed };
      }),
    ]);
    const knownIdentityRefreshFailed = new Set<string>();
    if (this.#revocationGeneration !== revocationGeneration) {
      return this.#refusedAfterRevocation(projects);
    }

    // Inspect results in the policy's repository order so a concurrent
    // refresh has the same deterministic first-error semantics as the old
    // sequential refresh.
    for (const { repository, listed } of listedResults) {
      if (listed.status !== "ok") {
        this.#cacheStats?.recordRefreshFailed("pull-request-list");
        if (listed.status === "unauthorized") this.revokeGithub();
        const retryAfter =
          listed.status === "rate-limited" ? retryAfterTimestamp(listed, this.#clock) : undefined;
        this.#markProjectStale(
          repository,
          listed.status === "unauthorized" ? "disconnected" : listed.status,
          retryAfter,
        );
        const reason = listed.status === "unauthorized" ? "disconnected" : listed.status;
        return {
          view: this.#staleView({
            projects,
            reason,
            ...(retryAfter === undefined ? {} : { retryAfter }),
          }),
          outcome:
            listed.status === "unauthorized"
              ? { status: "unauthorized" }
              : {
                  status: "failed",
                  reason,
                  ...(retryAfter === undefined ? {} : { retryAfter }),
                },
        };
      }
    }

    const collected: CodeProjectPullRequestRow[] = [];
    let pullRequestsTruncated = false;
    const listedKeysByProject = new Map<string, Set<string>>();
    const listedNumbersByProject = new Map<string, Set<number>>();
    for (const { repository, listed } of listedResults) {
      if (listed.status !== "ok") continue;
      const remaining = CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS - collected.length;
      if (remaining <= 0) {
        if (listed.rows.length > 0) pullRequestsTruncated = true;
        continue;
      }
      const usable = listed.rows.length > remaining ? listed.rows.slice(0, remaining) : listed.rows;
      if (listed.rows.length > remaining) pullRequestsTruncated = true;
      const projectKey = String(repository.projectId);
      const listedKeys = listedKeysByProject.get(projectKey) ?? new Set<string>();
      const listedNumbers = listedNumbersByProject.get(projectKey) ?? new Set<number>();
      listedKeysByProject.set(projectKey, listedKeys);
      listedNumbersByProject.set(projectKey, listedNumbers);
      const observedBaseRepoNodeId = usable.find(
        (row) => row.baseRepositoryNodeId !== undefined,
      )?.baseRepositoryNodeId;
      const observedCanonicalRepo = usable.find(
        (row) => row.baseRepository !== undefined,
      )?.baseRepository;
      if (observedBaseRepoNodeId !== undefined) {
        const splitCanonical =
          observedCanonicalRepo === undefined
            ? undefined
            : splitRepositoryName(observedCanonicalRepo);
        await this.#reconcileRenamedProjectRepositories(
          repository.projectId,
          {
            nodeId: observedBaseRepoNodeId,
            owner: splitCanonical?.owner ?? repository.repositoryOwner,
            name: splitCanonical?.name ?? repository.repositoryName,
          },
          threads,
          signal,
        );
      }
      for (const row of usable) {
        const canonical =
          row.baseRepository === undefined ? undefined : splitRepositoryName(row.baseRepository);
        const canonicalOwner = canonical?.owner ?? repository.repositoryOwner;
        const canonicalName = canonical?.name ?? repository.repositoryName;
        if (
          row.baseRepositoryNodeId !== undefined &&
          (canonicalOwner.toLowerCase() !== repository.repositoryOwner.toLowerCase() ||
            canonicalName.toLowerCase() !== repository.repositoryName.toLowerCase())
        ) {
          this.#pullRequestLinks?.recordRepositoryAlias?.({
            projectId: repository.projectId,
            baseRepositoryNodeId: row.baseRepositoryNodeId,
            canonicalOwner,
            canonicalName,
            aliasOwner: repository.repositoryOwner,
            aliasName: repository.repositoryName,
          });
        }
        const initialLinkedThreads = this.#matchThreads(
          repository,
          {
            owner: canonicalOwner,
            name: canonicalName,
            number: row.number,
            headBranch: row.headBranch,
            title: row.title,
            ...(row.pullRequestNodeId === undefined
              ? {}
              : { pullRequestNodeId: row.pullRequestNodeId }),
          },
          threads,
        );
        const recordedLink = await this.#recordActiveRowLink(
          repository,
          row,
          initialLinkedThreads,
          threads,
          signal,
        );
        const built = this.#row(repository, row, threads, {
          owner: recordedLink?.repositoryOwner ?? canonicalOwner,
          name: recordedLink?.repositoryName ?? canonicalName,
          ...(recordedLink === undefined ? {} : { recordedLink }),
        });
        collected.push(built);
        listedKeys.add(this.#rowIdentityKey(built));
        listedNumbers.add(built.number);
      }
    }

    // Closed/merged identities are recovered from the journal after the
    // active list. Fetch the bounded set in parallel, then append results in
    // stable repository/identity order for deterministic snapshots.
    const remainingKnown = CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS - collected.length;
    const knownCandidates: Array<{
      readonly repository: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>;
      readonly knownRow: CodeProjectPullRequestRow;
    }> = [];
    if (remainingKnown > 0) {
      outer: for (const { repository } of listedResults) {
        const projectKey = String(repository.projectId);
        const listedKeys = listedKeysByProject.get(projectKey) ?? new Set<string>();
        const listedNumbers = listedNumbersByProject.get(projectKey) ?? new Set<number>();
        for (const knownRow of this.#knownRows([repository], threads)) {
          if (
            listedKeys.has(this.#rowIdentityKey(knownRow)) ||
            listedNumbers.has(knownRow.number)
          ) {
            continue;
          }
          knownCandidates.push({ repository, knownRow });
          if (knownCandidates.length >= remainingKnown) break outer;
        }
      }
    }
    const recoveredKnown = await mapConcurrentOrdered(
      knownCandidates,
      GITHUB_READ_CONCURRENCY,
      async ({
        repository,
        knownRow,
      }): Promise<
        | {
            readonly kind: "settled";
            readonly repository: (typeof knownCandidates)[number]["repository"];
            readonly row: CodeProjectPullRequestRow;
          }
        | {
            readonly kind: "observed";
            readonly repository: (typeof knownCandidates)[number]["repository"];
            readonly knownRow: CodeProjectPullRequestRow;
            readonly observed: GhPullRequestReviewResult;
          }
      > => {
        if (options.skipSettledKnownIdentities) {
          // Merged is terminal, and a closed pull request that reopens shows
          // up again in the active list above — so a cached merged/closed row
          // cannot silently change and the identity read can be skipped on
          // the background cadence. Explicit refresh still re-observes it.
          const settled = this.#cachedSettledRow(knownRow);
          if (settled !== undefined) return { kind: "settled", repository, row: settled };
        }
        const canonical = this.#canonicalTarget(repository, knownRow);
        const observed = await this.#detail.observeReviewByIdentity(
          {
            owner: canonical.repositoryOwner,
            name: canonical.repositoryName,
            number: knownRow.number,
            maxDiffBytes: MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES,
          },
          signal,
        );
        return { kind: "observed", repository, knownRow, observed };
      },
    );
    for (const entry of recoveredKnown) {
      if (entry.kind === "settled") {
        collected.push(this.#canonicalizeRow(entry.row));
        continue;
      }
      const { repository, knownRow, observed } = entry;
      if (observed.status === "observed" && observed.freshness === "fresh" && !observed.ambiguous) {
        const canonical = splitRepositoryName(
          observed.pullRequest.canonicalBaseRepository ?? observed.pullRequest.baseRepository,
        );
        const canonicalOwner = canonical?.owner ?? repository.repositoryOwner;
        const canonicalName = canonical?.name ?? repository.repositoryName;
        if (
          observed.pullRequest.baseRepositoryNodeId !== undefined &&
          (canonicalOwner.toLowerCase() !== repository.repositoryOwner.toLowerCase() ||
            canonicalName.toLowerCase() !== repository.repositoryName.toLowerCase())
        ) {
          this.#pullRequestLinks?.recordRepositoryAlias?.({
            projectId: repository.projectId,
            baseRepositoryNodeId: observed.pullRequest.baseRepositoryNodeId,
            canonicalOwner,
            canonicalName,
            aliasOwner: repository.repositoryOwner,
            aliasName: repository.repositoryName,
          });
        }
        const initialLinkedThreads = this.#matchThreads(
          repository,
          {
            owner: canonicalOwner,
            name: canonicalName,
            number: observed.pullRequest.number,
            headBranch: observed.pullRequest.headBranch,
            title: observed.pullRequest.title,
            ...(observed.pullRequest.pullRequestNodeId === undefined
              ? {}
              : { pullRequestNodeId: observed.pullRequest.pullRequestNodeId }),
          },
          threads,
        );
        const recordedLink = await this.#recordObservedLink(
          repository,
          observed,
          initialLinkedThreads,
          threads,
          signal,
        );
        const observedRow = this.#rowFromObserved(
          repository,
          observed,
          threads,
          knownRow.updatedAt,
          recordedLink,
        );
        await this.#recordObservedDelivery(repository, observed, observedRow.linkedThreads, signal);
        collected.push(observedRow);
      } else {
        knownIdentityRefreshFailed.add(String(repository.projectId));
        collected.push(this.#canonicalizeRow(knownRow));
      }
    }

    if (this.#revocationGeneration !== revocationGeneration) {
      return this.#refusedAfterRevocation(projects);
    }
    this.#githubRevoked = false;
    // Known-identity recovery that left rows stale is not a completed list
    // refresh; lastRefreshAt stays at the last fully fresh list.
    if (knownIdentityRefreshFailed.size === 0) {
      this.#cacheStats?.recordRefreshSucceeded("pull-request-list");
    }
    const now = decodeUtcTimestamp(this.#clock());
    const refreshedRows =
      command.kind === "refresh-project"
        ? this.#mergeRows(
            collected,
            this.#authorizedRows(projects).filter(
              (row) => String(row.projectId) !== String(command.projectId),
            ),
          )
        : this.#mergeRows(collected, []);
    const rows = this.#boundRows(refreshedRows);
    const updatedProjects = projects.map((project) => this.#canonicalizeConnection(project));
    if (rows.length < refreshedRows.length) pullRequestsTruncated = true;
    this.#cache = {
      rows,
      lastSuccessfulRefreshAt: now,
      repositoriesTruncated: bounded.repositoriesTruncated,
      pullRequestsTruncated,
    };
    this.#navigationSnapshots.clear();
    for (const repository of bounded.repositories) {
      const canonicalRepo = this.#canonicalizeConnection(repository);
      if (canonicalRepo.kind !== "connected") continue;
      const projectId = String(canonicalRepo.projectId);
      const projectRows = rows.filter((row) => String(row.projectId) === projectId);
      const failed = knownIdentityRefreshFailed.has(projectId);
      const nextFreshness: CodeProjectPullRequestFreshness = {
        status: failed ? "stale" : projectRows.length === 0 ? "empty" : "fresh",
        lastSuccessfulRefreshAt: now,
        ...(failed ? { staleReason: "refresh-failed" as const } : {}),
      };
      this.#projectFreshness.set(projectFreshnessKey(canonicalRepo), nextFreshness);
      if (
        canonicalRepo.repositoryOwner !== repository.repositoryOwner ||
        canonicalRepo.repositoryName !== repository.repositoryName
      ) {
        this.#projectFreshness.set(projectFreshnessKey(repository), nextFreshness);
      }
    }
    this.#freshness =
      knownIdentityRefreshFailed.size > 0
        ? { status: "stale", staleReason: "refresh-failed", lastSuccessfulRefreshAt: now }
        : { status: "fresh", lastSuccessfulRefreshAt: now };
    this.#persistSnapshot();
    // Fires for every path that replaces the snapshot — explicit refresh and
    // cadence observation alike — so downstream observers (for example the
    // failing-checks follow-ups) see cadence-driven facts too.
    this.#onSnapshotRefreshed?.(rows);
    const view = this.#view({
      query: { version: 1 },
      projects: updatedProjects,
      rows: rows.filter((row) => row.state === "open"),
      repositoriesTruncated: bounded.repositoriesTruncated,
      pullRequestsTruncated,
      freshness: this.#freshness,
    });
    if (command.kind === "refresh-project" && connected.length === 0) {
      return { view, outcome: { status: "unconnected" } };
    }
    const observedRows =
      command.kind === "refresh-project"
        ? rows.filter((row) => String(row.projectId) === String(command.projectId))
        : rows;
    const outcome: CodeProjectPullRequestCadenceObservation =
      knownIdentityRefreshFailed.size > 0
        ? { status: "failed", reason: "refresh-failed" }
        : observedRows.length === 0
          ? { status: "empty" }
          : { status: "fresh" };
    return { view, outcome };
  }

  /**
   * GitHub access was revoked while this refresh was reading. Its rows describe
   * access the user no longer has, so they are dropped rather than committed:
   * the revoked state, the emptied cache, and the cleared snapshot all stand.
   */
  #refusedAfterRevocation(projects: ReadonlyArray<CodeProjectPullRequestConnection>): {
    readonly view: CodeProjectPullRequestView;
    readonly outcome: CodeProjectPullRequestCadenceObservation;
  } {
    return {
      view: this.#staleView({ projects, reason: "disconnected" }),
      outcome: { status: "unauthorized" },
    };
  }

  /**
   * A cached row for this identity whose state can no longer drift while it
   * stays out of the active list: merged is terminal and a reopen re-enters
   * the list. Anything else must be re-observed.
   */
  #cachedSettledRow(knownRow: CodeProjectPullRequestRow): CodeProjectPullRequestRow | undefined {
    if (this.#githubRevoked || this.#cache === undefined) return undefined;
    const wantedKey = this.#rowIdentityKey(knownRow);
    return this.#cache.rows.find(
      (row) =>
        (row.state === "merged" || row.state === "closed") &&
        this.#rowIdentityKey(row) === wantedKey,
    );
  }

  /**
   * The connected GitHub repositories this window's admitted Code Projects
   * name, for reads that must stay inside what the window may see — never a
   * wider catalogue.
   */
  async listConnectedRepositories(windowId: WindowId): Promise<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
    }>
  > {
    return (await this.#resolveProjects(windowId))
      .filter(
        (project): project is Extract<CodeProjectPullRequestConnection, { kind: "connected" }> =>
          project.kind === "connected",
      )
      .map((project) => ({
        projectId: project.projectId,
        repositoryOwner: project.repositoryOwner,
        repositoryName: project.repositoryName,
      }));
  }

  async #resolveProjects(
    windowId: WindowId,
    options?: {
      readonly allowForgeLookup?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<ReadonlyArray<CodeProjectPullRequestConnection>> {
    const bootstrap = await this.#projects.bootstrap(windowId);
    const resolved = await mapConcurrentOrdered(
      bootstrap.active,
      GITHUB_READ_CONCURRENCY,
      async (project): Promise<CodeProjectPullRequestConnection | undefined> => {
        if (project.type !== "code" || project.lifecycle !== "active") return undefined;
        let identity: { readonly owner: string; readonly name: string } | undefined;
        if (project.connectedRepository !== undefined) {
          identity = {
            owner: project.connectedRepository.owner,
            name: project.connectedRepository.repository,
          };
        } else if (project.binding !== undefined) {
          const remotes = (await this.#rememberedRemotes(project.binding.canonicalRoot)) ?? [];
          identity = await this.#resolveRepositoryFromRemotes(project.id, remotes, options);
        }
        if (identity !== undefined) {
          const canonical = this.#pullRequestLinks?.canonicalRepository?.(project.id, identity);
          if (canonical !== undefined) {
            identity = { owner: canonical.owner, name: canonical.name };
          }
        }
        return identity === undefined
          ? { kind: "unconnected", projectId: project.id, projectName: project.name }
          : {
              kind: "connected",
              projectId: project.id,
              projectName: project.name,
              repositoryOwner: decodeRepositoryOwner(identity.owner),
              repositoryName: decodeRepositoryName(identity.name),
            };
      },
    );
    return resolved.filter(
      (connection): connection is CodeProjectPullRequestConnection => connection !== undefined,
    );
  }

  /**
   * Resolves one canonical GitHub repository from a checkout's observed remotes.
   * Multiple valid GitHub remotes collapse to one identity only when the forge
   * identity owner (or, during refresh, GitHub's base repository node ID) proves
   * every remote points at the same repository (for example a stale second remote
   * still pointing at a repository's pre-rename name). Distinct repositories or
   * any invalid/credentialed remote still fail closed.
   */
  async #resolveRepositoryFromRemotes(
    projectId: ProjectId,
    remotes: ReadonlyArray<{
      readonly name: string;
      readonly fetchUrl: string;
      readonly pushUrl: string;
      readonly credentialed?: boolean;
    }>,
    options?: {
      readonly allowForgeLookup?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<{ readonly owner: string; readonly name: string } | undefined> {
    const parsed = parseConnectedGitHubRemotes(remotes);
    if (parsed === undefined || parsed.length === 0) return undefined;
    if (parsed.length === 1) {
      const only = parsed[0];
      return only === undefined ? undefined : { owner: only.owner, name: only.repository };
    }
    const candidates = parsed.map((entry) => ({ owner: entry.owner, name: entry.repository }));
    const first = candidates[0];
    if (first === undefined) return undefined;
    if (candidates.every((candidate) => this.#areSameRepository(projectId, first, candidate))) {
      const canonical = this.#pullRequestLinks?.canonicalRepository?.(projectId, first);
      return canonical === undefined ? first : { owner: canonical.owner, name: canonical.name };
    }
    if (
      options?.allowForgeLookup === true &&
      options.signal !== undefined &&
      this.#list.observeBaseRepository !== undefined
    ) {
      const resolvedNodes: Array<{
        readonly candidate: { readonly owner: string; readonly name: string };
        readonly nodeId: string;
        readonly canonical?: { readonly owner: string; readonly name: string };
      }> = [];
      for (const candidate of candidates) {
        const observed = await this.#list.observeBaseRepository(candidate, options.signal);
        if (observed === undefined) return undefined;
        const split =
          observed.repository === undefined ? undefined : splitRepositoryName(observed.repository);
        resolvedNodes.push({
          candidate,
          nodeId: observed.nodeId,
          ...(split === undefined ? {} : { canonical: split }),
        });
      }
      const sharedNodeId = resolvedNodes[0]?.nodeId;
      if (
        sharedNodeId !== undefined &&
        resolvedNodes.every((entry) => entry.nodeId === sharedNodeId)
      ) {
        const canonical =
          resolvedNodes.find((entry) => entry.canonical !== undefined)?.canonical ??
          resolvedNodes[0]?.candidate;
        if (canonical === undefined) return undefined;
        for (const entry of resolvedNodes) {
          this.#pullRequestLinks?.recordRepositoryAlias?.({
            projectId,
            baseRepositoryNodeId: sharedNodeId,
            canonicalOwner: canonical.owner,
            canonicalName: canonical.name,
            aliasOwner: entry.candidate.owner,
            aliasName: entry.candidate.name,
          });
        }
        return canonical;
      }
    }
    return undefined;
  }

  #rememberedRemotes(root: string): ReturnType<CodeProjectPullRequestRemoteSource["remotes"]> {
    const nowMs = Date.parse(this.#clock());
    const remembered = this.#remotesByRoot.get(root);
    if (remembered !== undefined && nowMs - remembered.computedAtMs < REMOTES_MAX_AGE_MS) {
      return remembered.remotes;
    }
    const remotes = this.#remotes.remotes(root);
    this.#remotesByRoot.set(root, { computedAtMs: nowMs, remotes });
    // A read that failed is not an answer; the next read asks again.
    remotes.catch(() => {
      if (this.#remotesByRoot.get(root)?.remotes === remotes) this.#remotesByRoot.delete(root);
    });
    return remotes;
  }

  /**
   * A read is a hit when it can answer from the refresh snapshot. A revoked
   * connection is a miss, not a hit: the snapshot is gone and the reader is
   * being told to reconnect rather than being served cached rows.
   */
  #observeListRead(): void {
    if (this.#cache !== undefined && !this.#githubRevoked) {
      this.#cacheStats?.recordHit("pull-request-list");
      return;
    }
    this.#cacheStats?.recordMiss("pull-request-list");
  }

  #authorizedRows(
    projects: ReadonlyArray<CodeProjectPullRequestConnection>,
  ): ReadonlyArray<CodeProjectPullRequestRow> {
    if (this.#githubRevoked || this.#cache === undefined) return [];
    const connectedByProject = new Map<
      string,
      Extract<CodeProjectPullRequestConnection, { kind: "connected" }>
    >();
    for (const project of projects) {
      if (project.kind === "connected") {
        connectedByProject.set(String(project.projectId), project);
      }
    }
    const authorized = this.#cache.rows
      .filter((row) => {
        const project = connectedByProject.get(String(row.projectId));
        if (project === undefined) return false;
        return this.#areSameRepository(
          row.projectId,
          { owner: row.repositoryOwner, name: row.repositoryName },
          { owner: project.repositoryOwner, name: project.repositoryName },
        );
      })
      .map((row) => this.#canonicalizeRow(row));
    return this.#mergeRows(authorized, []);
  }

  #authorizedActiveRows(
    projects: ReadonlyArray<CodeProjectPullRequestConnection>,
  ): ReadonlyArray<CodeProjectPullRequestRow> {
    return this.#authorizedRows(projects).filter((row) => row.state === "open");
  }

  #queryFreshness(): CodeProjectPullRequestFreshness {
    if (this.#githubRevoked) {
      return {
        status: "stale",
        staleReason: "disconnected",
        ...(this.#freshness.lastSuccessfulRefreshAt === undefined
          ? {}
          : { lastSuccessfulRefreshAt: this.#freshness.lastSuccessfulRefreshAt }),
      };
    }
    return this.#freshness;
  }

  #staleView(input: {
    readonly projects: ReadonlyArray<CodeProjectPullRequestConnection>;
    readonly reason: CodeProjectPullRequestStaleReason;
    readonly retryAfter?: UtcTimestamp;
  }): CodeProjectPullRequestView {
    this.#freshness = {
      status: "stale",
      staleReason: input.reason,
      ...(this.#cache === undefined
        ? {}
        : { lastSuccessfulRefreshAt: this.#cache.lastSuccessfulRefreshAt }),
      ...(input.retryAfter === undefined ? {} : { retryAfter: input.retryAfter }),
    };
    return this.#view({
      query: { version: 1 },
      projects: input.projects,
      rows: this.#authorizedActiveRows(input.projects),
      repositoriesTruncated: this.#cache?.repositoriesTruncated ?? false,
      pullRequestsTruncated: this.#cache?.pullRequestsTruncated ?? false,
      freshness: this.#freshness,
    });
  }

  #row(
    project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    row: GhActivePullRequestRow,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
    resolved?: {
      readonly owner: string;
      readonly name: string;
      readonly recordedLink?: PullRequestLinkRecord;
    },
  ): CodeProjectPullRequestRow {
    const repositoryOwner = decodeRepositoryOwner(resolved?.owner ?? project.repositoryOwner);
    const repositoryName = decodeRepositoryName(resolved?.name ?? project.repositoryName);
    const link =
      resolved?.recordedLink ??
      this.#resolveLink({
        projectId: project.projectId,
        repositoryOwner,
        repositoryName,
        number: row.number,
        ...(row.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: row.pullRequestNodeId }),
      });
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      repositoryOwner,
      repositoryName,
      number: row.number,
      title: row.title,
      draft: row.draft,
      state: row.state,
      mergeability: row.mergeability,
      author: row.author,
      baseBranch: row.baseBranch,
      headBranch: row.headBranch,
      updatedAt: row.updatedAt,
      ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
      checks: row.checks,
      review: row.review,
      ...(row.reviewRequestedFrom.length === 0
        ? {}
        : { reviewRequestedFrom: row.reviewRequestedFrom }),
      ...(row.failingChecks.length === 0
        ? {}
        : {
            failingChecks: row.failingChecks.map((check) => ({
              name: check.name,
              ...(check.completedAt === undefined ? {} : { completedAt: check.completedAt }),
            })),
          }),
      ...(row.crossRepository ? { crossRepository: true } : {}),
      ...(row.additions === undefined ? {} : { additions: row.additions }),
      ...(row.deletions === undefined ? {} : { deletions: row.deletions }),
      ...(row.checkCounts === undefined ? {} : { checkCounts: row.checkCounts }),
      ...(row.merging === undefined ? {} : { merging: row.merging }),
      ...(link === undefined ? {} : { linkId: link.linkId }),
      linkedThreads: this.#matchThreads(
        project,
        {
          owner: repositoryOwner,
          name: repositoryName,
          number: row.number,
          headBranch: row.headBranch,
          title: row.title,
          ...(row.pullRequestNodeId === undefined
            ? {}
            : { pullRequestNodeId: row.pullRequestNodeId }),
          ...(link === undefined ? {} : { recordedLink: link }),
        },
        threads,
      ),
    };
  }

  #knownRows(
    projects: ReadonlyArray<CodeProjectPullRequestConnection>,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
  ): ReadonlyArray<CodeProjectPullRequestRow> {
    const rows: CodeProjectPullRequestRow[] = [];
    const threadById = new Map(threads.map((thread) => [thread.threadId, thread] as const));
    for (const project of projects) {
      if (project.kind !== "connected") continue;
      for (const link of this.#pullRequestLinks?.listForProject?.(project.projectId) ?? []) {
        if (
          !this.#areSameRepository(
            project.projectId,
            { owner: link.repositoryOwner, name: link.repositoryName },
            { owner: project.repositoryOwner, name: project.repositoryName },
          )
        ) {
          continue;
        }
        const linkedThreads = link.threadIds
          .flatMap((id) => {
            const fact = threadById.get(String(id));
            return fact === undefined
              ? []
              : [{ threadId: decodeCodeThreadId(fact.threadId), title: fact.title }];
          })
          .slice(0, MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS);
        if (linkedThreads.length === 0) continue;
        rows.push({
          projectId: project.projectId,
          projectName: project.projectName,
          repositoryOwner: decodeRepositoryOwner(link.repositoryOwner),
          repositoryName: decodeRepositoryName(link.repositoryName),
          number: link.number,
          title: `Pull request #${link.number}`,
          draft: false,
          state: "unknown",
          mergeability: "unknown",
          author: "Unknown author",
          baseBranch: link.baseBranch ?? "unknown",
          headBranch: link.headBranch ?? "unknown",
          updatedAt: link.linkedAt,
          checks: "unknown",
          review: "unknown",
          linkId: link.linkId,
          linkedThreads,
        });
      }
      for (const thread of threads) {
        if (thread.projectId !== String(project.projectId)) continue;
        if (
          !this.#areSameRepository(project.projectId, thread.repository, {
            owner: project.repositoryOwner,
            name: project.repositoryName,
          })
        ) {
          continue;
        }
        for (const identity of thread.pullRequestNumbers ?? []) {
          const link = this.#resolveLink({
            projectId: project.projectId,
            repositoryOwner: thread.repository.owner,
            repositoryName: thread.repository.name,
            number: identity.number,
          });
          rows.push({
            projectId: project.projectId,
            projectName: project.projectName,
            repositoryOwner: decodeRepositoryOwner(
              link?.repositoryOwner ?? project.repositoryOwner,
            ),
            repositoryName: decodeRepositoryName(link?.repositoryName ?? project.repositoryName),
            number: identity.number,
            title: `Pull request #${identity.number}`,
            draft: false,
            state: "unknown",
            mergeability: "unknown",
            author: "Unknown author",
            baseBranch: link?.baseBranch ?? "unknown",
            headBranch: link?.headBranch ?? thread.deliveryBranch ?? "unknown",
            updatedAt: identity.observedAt,
            checks: "unknown",
            review: "unknown",
            ...(link === undefined ? {} : { linkId: link.linkId }),
            linkedThreads: [{ threadId: decodeCodeThreadId(thread.threadId), title: thread.title }],
          });
        }
      }
    }
    return this.#boundRows(this.#mergeRows([], rows));
  }

  #rowFromObserved(
    project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    observed: Extract<GhPullRequestReviewResult, { readonly status: "observed" }>,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
    knownObservedAt: string,
    recordedLink?: PullRequestLinkRecord,
  ): CodeProjectPullRequestRow {
    const pullRequest = observed.pullRequest;
    const canonical = splitRepositoryName(
      pullRequest.canonicalBaseRepository ?? pullRequest.baseRepository,
    );
    const repositoryOwner = decodeRepositoryOwner(
      recordedLink?.repositoryOwner ?? canonical?.owner ?? project.repositoryOwner,
    );
    const repositoryName = decodeRepositoryName(
      recordedLink?.repositoryName ?? canonical?.name ?? project.repositoryName,
    );
    const link =
      recordedLink ??
      this.#resolveLink({
        projectId: project.projectId,
        repositoryOwner,
        repositoryName,
        number: pullRequest.number,
        ...(pullRequest.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: pullRequest.pullRequestNodeId }),
      });
    const state = pullRequest.state === "draft" ? "open" : pullRequest.state;
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      repositoryOwner,
      repositoryName,
      number: pullRequest.number,
      title: pullRequest.title === "" ? `Pull request #${pullRequest.number}` : pullRequest.title,
      draft: pullRequest.state === "draft",
      state,
      mergeability: pullRequest.mergeability ?? "unknown",
      author: pullRequest.author === "" ? "Unknown author" : pullRequest.author,
      baseBranch: pullRequest.baseBranch,
      headBranch: pullRequest.headBranch,
      updatedAt: pullRequest.updatedAt ?? knownObservedAt,
      checks: summarizeObservedChecks(observed.checks),
      review: summarizeObservedReviews(observed.reviews),
      ...(pullRequest.additions === undefined ? {} : { additions: pullRequest.additions }),
      ...(pullRequest.deletions === undefined ? {} : { deletions: pullRequest.deletions }),
      ...(pullRequest.checkCounts === undefined ? {} : { checkCounts: pullRequest.checkCounts }),
      ...(pullRequest.merging === undefined ? {} : { merging: pullRequest.merging }),
      ...(link === undefined ? {} : { linkId: link.linkId }),
      linkedThreads: this.#matchThreads(
        project,
        {
          owner: repositoryOwner,
          name: repositoryName,
          number: pullRequest.number,
          headBranch: pullRequest.headBranch,
          title: pullRequest.title,
          ...(pullRequest.pullRequestNodeId === undefined
            ? {}
            : { pullRequestNodeId: pullRequest.pullRequestNodeId }),
          ...(link === undefined ? {} : { recordedLink: link }),
        },
        threads,
      ),
    };
  }

  #view(input: {
    readonly query: CodeProjectPullRequestQuery;
    readonly projects: ReadonlyArray<CodeProjectPullRequestConnection>;
    readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
    readonly repositoriesTruncated: boolean;
    readonly pullRequestsTruncated: boolean;
    readonly freshness: CodeProjectPullRequestFreshness;
  }): CodeProjectPullRequestView {
    return decodeCodeProjectPullRequestView({
      version: 1,
      query: input.query,
      projects: input.projects,
      rows: input.rows,
      repositoriesTruncated: input.repositoriesTruncated,
      pullRequestsTruncated: input.pullRequestsTruncated,
      freshness: input.freshness,
      projectFreshness: input.projects.map((project) => ({
        projectId: project.projectId,
        freshness: this.#projectFreshnessFor(project),
      })),
      ...(this.#backgroundRefresh.size === 0
        ? {}
        : {
            backgroundRefresh: input.projects.flatMap((project) => {
              const state = this.#backgroundRefresh.get(String(project.projectId));
              return state === undefined ? [] : [state];
            }),
          }),
      generatedAt: decodeUtcTimestamp(this.#clock()),
    });
  }

  #projectFreshnessFor(project: CodeProjectPullRequestConnection): CodeProjectPullRequestFreshness {
    if (project.kind !== "connected") return { status: "empty" };
    if (this.#githubRevoked) {
      const previous = this.#projectFreshness.get(projectFreshnessKey(project));
      return {
        status: "stale",
        staleReason: "disconnected",
        ...(previous?.lastSuccessfulRefreshAt === undefined
          ? {}
          : { lastSuccessfulRefreshAt: previous.lastSuccessfulRefreshAt }),
      };
    }
    return this.#projectFreshness.get(projectFreshnessKey(project)) ?? { status: "empty" };
  }

  #markProjectStale(
    project: Extract<CodeProjectPullRequestConnection, { readonly kind: "connected" }>,
    reason: CodeProjectPullRequestStaleReason,
    retryAfter: UtcTimestamp | undefined,
  ): void {
    const key = projectFreshnessKey(project);
    const previous = this.#projectFreshness.get(key);
    this.#projectFreshness.set(key, {
      status: "stale",
      staleReason: reason,
      ...(previous?.lastSuccessfulRefreshAt === undefined
        ? {}
        : { lastSuccessfulRefreshAt: previous.lastSuccessfulRefreshAt }),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }

  #authorizedConnection(
    projects: ReadonlyArray<CodeProjectPullRequestConnection>,
    identity: {
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
    },
  ): Extract<CodeProjectPullRequestConnection, { kind: "connected" }> | undefined {
    const project = projects.find(
      (entry) => String(entry.projectId) === String(identity.projectId),
    );
    if (project === undefined || project.kind !== "connected") return undefined;
    if (
      !this.#areSameRepository(
        identity.projectId,
        { owner: project.repositoryOwner, name: project.repositoryName },
        { owner: identity.repositoryOwner, name: identity.repositoryName },
      )
    ) {
      return undefined;
    }
    return project;
  }

  #restoreSnapshot(snapshot: StoredCodeProjectPullRequestSnapshot): void {
    this.#cache = {
      rows: snapshot.rows,
      lastSuccessfulRefreshAt: decodeUtcTimestamp(snapshot.lastSuccessfulRefreshAt),
      repositoriesTruncated: snapshot.repositoriesTruncated,
      pullRequestsTruncated: snapshot.pullRequestsTruncated,
    };
    this.#freshness = snapshot.freshness;
    for (const entry of snapshot.projectFreshness) {
      this.#projectFreshness.set(entry.key, entry.freshness);
    }
  }

  #persistSnapshot(): void {
    if (this.#cache === undefined || this.#snapshotStore === undefined) return;
    this.#snapshotStore.save({
      rows: this.#cache.rows,
      lastSuccessfulRefreshAt: this.#cache.lastSuccessfulRefreshAt,
      repositoriesTruncated: this.#cache.repositoriesTruncated,
      pullRequestsTruncated: this.#cache.pullRequestsTruncated,
      freshness: this.#freshness,
      projectFreshness: [...this.#projectFreshness].map(([key, freshness]) => ({
        key,
        freshness,
      })),
    });
  }

  #detailQueryFreshness(query: CodeProjectPullRequestDetailQuery): CodeProjectPullRequestFreshness {
    const key = this.#detailCacheKey(query);
    const current = this.#detailFreshness.get(key) ?? this.#detailFreshness.get(detailKey(query));
    if (this.#githubRevoked) {
      return {
        status: "stale",
        staleReason: "disconnected",
        ...(current?.lastSuccessfulRefreshAt === undefined
          ? {}
          : { lastSuccessfulRefreshAt: current.lastSuccessfulRefreshAt }),
      };
    }
    return current ?? { status: "empty" };
  }

  #staleDetailView(input: {
    readonly query: CodeProjectPullRequestDetailQuery;
    readonly authorized: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>;
    readonly reason: CodeProjectPullRequestStaleReason;
  }): Promise<CodeProjectPullRequestDetailView> {
    const key = this.#detailCacheKey(input.query);
    const cached = this.#detailCache.get(key) ?? this.#detailCache.get(detailKey(input.query));
    this.#detailFreshness.set(key, {
      status: "stale",
      staleReason: input.reason,
      ...(cached === undefined ? {} : { lastSuccessfulRefreshAt: cached.lastSuccessfulRefreshAt }),
    });
    if (cached === undefined) {
      return Promise.resolve(
        this.#detailView({
          query: input.query,
          detail: { state: "unavailable" },
          freshness: this.#detailFreshness.get(key) ?? {
            status: "stale",
            staleReason: input.reason,
          },
          linkedThreads: [],
        }),
      );
    }
    return this.#threads.list().then((threads) =>
      this.#detailView({
        query: input.query,
        detail: cached.detail,
        freshness: this.#detailFreshness.get(key) ?? { status: "stale", staleReason: input.reason },
        linkedThreads: this.#linkedThreads(input.authorized, cached.detail, threads),
      }),
    );
  }

  #observedDetail(
    observed: Extract<GhPullRequestReviewResult, { readonly status: "observed" }>,
  ): CodeProjectPullRequestDetailObserved {
    return {
      state: "observed",
      freshness: observed.freshness,
      ambiguous: observed.ambiguous,
      staleSections: [...observed.staleSections],
      number: observed.pullRequest.number,
      url: observed.pullRequest.url,
      title: observed.pullRequest.title,
      pullRequestState: observed.pullRequest.state,
      baseRepository:
        observed.pullRequest.canonicalBaseRepository ?? observed.pullRequest.baseRepository,
      baseBranch: observed.pullRequest.baseBranch,
      headRepository: observed.pullRequest.headRepository,
      headBranch: observed.pullRequest.headBranch,
      headSha: observed.pullRequest.headSha,
      author: observed.pullRequest.author,
      ...(observed.pullRequest.mergeability === undefined
        ? {}
        : { mergeability: observed.pullRequest.mergeability }),
      matchesDeliveryBranch: false,
      description: observed.description,
      diff: observed.diff,
      diffTruncated: observed.diffTruncated,
      commits: observed.commits.map((commit) => ({ ...commit })),
      files: observed.files.map((file) => ({ ...file })),
      checks: observed.checks.map((check) => ({ ...check })),
      reviews: observed.reviews.map((review) => ({ ...review })),
      comments: observed.comments.map((comment) => ({ ...comment })),
    };
  }

  /**
   * Records a confirmed merge — and each issue closure the pull request is
   * proved to have caused — once per matched linked thread. The observation
   * is a fact the journal already watched; recording is best-effort so a
   * failed append never fails the refresh that surfaced it.
   */
  async #recordActiveRowLink(
    repository: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    row: GhActivePullRequestRow,
    linkedThreads: ReadonlyArray<{ readonly threadId: CodeThreadId; readonly title: string }>,
    allThreads: ReadonlyArray<CodeProjectLinkedThreadFact>,
    signal: AbortSignal,
  ): Promise<PullRequestLinkRecord | undefined> {
    if (this.#pullRequestLinks === undefined) return undefined;
    const canonical =
      row.baseRepository === undefined ? undefined : splitRepositoryName(row.baseRepository);
    const repositoryOwner = canonical?.owner ?? repository.repositoryOwner;
    const repositoryName = canonical?.name ?? repository.repositoryName;
    const lookupRepo = this.#lookupRepositoryForLink(
      repository,
      repositoryOwner,
      repositoryName,
      linkedThreads,
      allThreads,
    );
    const result = await this.#pullRequestLinks
      .recordObservation(
        {
          projectId: repository.projectId,
          repositoryOwner,
          repositoryName,
          ...(lookupRepo === undefined
            ? {}
            : {
                lookupRepositoryOwner: lookupRepo.owner,
                lookupRepositoryName: lookupRepo.name,
              }),
          number: row.number,
          url: row.url,
          baseBranch: row.baseBranch,
          headBranch: row.headBranch,
          ...(row.pullRequestNodeId === undefined
            ? {}
            : { pullRequestNodeId: row.pullRequestNodeId }),
          ...(row.baseRepositoryNodeId === undefined
            ? {}
            : { baseRepositoryNodeId: row.baseRepositoryNodeId }),
          threadIds: linkedThreads.map((thread) => thread.threadId),
          onlyIfKnown: linkedThreads.length === 0,
        },
        signal,
      )
      .catch(() => undefined);
    return result !== undefined && result.status !== "ignored" ? result.link : undefined;
  }

  async #recordObservedLink(
    repository: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    observed: Extract<GhPullRequestReviewResult, { status: "observed" }>,
    linkedThreads: ReadonlyArray<{ readonly threadId: CodeThreadId; readonly title: string }>,
    allThreads: ReadonlyArray<CodeProjectLinkedThreadFact>,
    signal: AbortSignal,
  ): Promise<PullRequestLinkRecord | undefined> {
    if (this.#pullRequestLinks === undefined) return undefined;
    const pullRequest = observed.pullRequest;
    const canonical = splitRepositoryName(
      pullRequest.canonicalBaseRepository ?? pullRequest.baseRepository,
    );
    const repositoryOwner = canonical?.owner ?? repository.repositoryOwner;
    const repositoryName = canonical?.name ?? repository.repositoryName;
    const lookupRepo = this.#lookupRepositoryForLink(
      repository,
      repositoryOwner,
      repositoryName,
      linkedThreads,
      allThreads,
    );
    const result = await this.#pullRequestLinks
      .recordObservation(
        {
          projectId: repository.projectId,
          repositoryOwner,
          repositoryName,
          ...(lookupRepo === undefined
            ? {}
            : {
                lookupRepositoryOwner: lookupRepo.owner,
                lookupRepositoryName: lookupRepo.name,
              }),
          number: pullRequest.number,
          url: pullRequest.url,
          baseBranch: pullRequest.baseBranch,
          ...(pullRequest.headRepository === "" ? {} : { headOwner: pullRequest.headRepository }),
          headBranch: pullRequest.headBranch,
          ...(pullRequest.pullRequestNodeId === undefined
            ? {}
            : { pullRequestNodeId: pullRequest.pullRequestNodeId }),
          ...(pullRequest.baseRepositoryNodeId === undefined
            ? {}
            : { baseRepositoryNodeId: pullRequest.baseRepositoryNodeId }),
          threadIds: linkedThreads.map((thread) => thread.threadId),
          onlyIfKnown: linkedThreads.length === 0,
        },
        signal,
      )
      .catch(() => undefined);
    return result !== undefined && result.status !== "ignored" ? result.link : undefined;
  }

  async #recordObservedDelivery(
    repository: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    observed: Extract<GhPullRequestReviewResult, { status: "observed" }>,
    linkedThreads: ReadonlyArray<{ readonly threadId: CodeThreadId; readonly title: string }>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#recordDelivery === undefined) return;
    const pullRequest = observed.pullRequest;
    if (
      pullRequest.state !== "merged" ||
      pullRequest.mergedAt === undefined ||
      pullRequest.mergedBy === undefined
    )
      return;
    // `gh` exports `…:00Z` without the milliseconds UtcTimestamp requires;
    // an unparseable stamp skips the observation rather than sinking it.
    const mergedAt = deliveryOccurredAt(pullRequest.mergedAt);
    if (mergedAt === undefined) return;
    const mergedTitle = deliveryTitleBytes(pullRequest.title);
    for (const thread of linkedThreads) {
      try {
        this.#recordDelivery(
          decodeActivityDeliveryObserved({
            kind: "prs-merged",
            projectId: repository.projectId,
            threadId: thread.threadId,
            repositoryOwner: repository.repositoryOwner,
            repositoryName: repository.repositoryName,
            number: pullRequest.number,
            ...(mergedTitle === undefined ? {} : { title: mergedTitle }),
            occurredAt: mergedAt,
            mergedBy: pullRequest.mergedBy,
          }),
        );
      } catch {
        // A malformed or rejected record must not fail the refresh.
      }
    }
    // One confirmation read per closing issue, bounded — not one per
    // thread×issue pair — then the same proven closure is journaled for
    // every linked thread that witnessed it.
    const issueNumbers = [...new Set(pullRequest.closingIssueNumbers ?? [])];
    if (issueNumbers.length === 0 || this.#detail.observeIssueClosure === undefined) return;
    const closures = await mapConcurrentOrdered(
      issueNumbers,
      GITHUB_READ_CONCURRENCY,
      (issueNumber) =>
        this.#confirmedIssueClosure(repository, pullRequest.number, issueNumber, signal),
    );
    for (const closure of closures) {
      if (closure === undefined) continue;
      const closedAt = deliveryOccurredAt(closure.closedAt);
      if (closedAt === undefined) continue;
      const title = deliveryTitleBytes(closure.title);
      for (const thread of linkedThreads) {
        try {
          this.#recordDelivery(
            decodeActivityDeliveryObserved({
              kind: "issues-closed",
              projectId: repository.projectId,
              threadId: thread.threadId,
              repositoryOwner: repository.repositoryOwner,
              repositoryName: repository.repositoryName,
              number: closure.issueNumber,
              ...(title === undefined ? {} : { title }),
              occurredAt: closedAt,
              closingPullRequest: {
                repositoryOwner: repository.repositoryOwner,
                repositoryName: repository.repositoryName,
                number: pullRequest.number,
              },
            }),
          );
        } catch {
          // A malformed or rejected record must not fail the refresh.
        }
      }
    }
  }

  /**
   * The issue's own `ClosedEvent` confirmation, or undefined when the port
   * cannot read it, the closer is not this pull request, or the read fails —
   * one failed confirmation never drops the others.
   */
  async #confirmedIssueClosure(
    repository: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    closerNumber: number,
    issueNumber: number,
    signal: AbortSignal,
  ): Promise<
    { readonly issueNumber: number; readonly closedAt: string; readonly title: string } | undefined
  > {
    try {
      const closure = await this.#detail.observeIssueClosure?.(
        {
          owner: repository.repositoryOwner,
          name: repository.repositoryName,
          issueNumber,
          closerNumber,
        },
        signal,
      );
      return closure === undefined ? undefined : { issueNumber, ...closure };
    } catch {
      return undefined;
    }
  }

  #linkedThreads(
    project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    detail: Extract<CodeProjectPullRequestDetail, { readonly state: "observed" }>,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
    extra?: {
      readonly pullRequestNodeId?: string;
      readonly recordedLink?: PullRequestLinkRecord;
    },
  ) {
    const canonical = splitRepositoryName(detail.baseRepository);
    return this.#matchThreads(
      project,
      {
        owner: canonical?.owner ?? project.repositoryOwner,
        name: canonical?.name ?? project.repositoryName,
        number: detail.number,
        headBranch: detail.headBranch,
        title: detail.title,
        ...(extra?.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: extra.pullRequestNodeId }),
        ...(extra?.recordedLink === undefined ? {} : { recordedLink: extra.recordedLink }),
      },
      threads,
    );
  }

  #matchThreads(
    project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    target: {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
      readonly headBranch: string;
      readonly title: string;
      readonly pullRequestNodeId?: string;
      readonly recordedLink?: PullRequestLinkRecord;
    },
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
  ): ReadonlyArray<{ readonly threadId: CodeThreadId; readonly title: string }> {
    const link =
      target.recordedLink ??
      this.#resolveLink({
        projectId: project.projectId,
        repositoryOwner: target.owner,
        repositoryName: target.name,
        number: target.number,
        ...(target.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: target.pullRequestNodeId }),
      }) ??
      this.#resolveLink({
        projectId: project.projectId,
        repositoryOwner: project.repositoryOwner,
        repositoryName: project.repositoryName,
        number: target.number,
        ...(target.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: target.pullRequestNodeId }),
      });
    const threadById = new Map(threads.map((thread) => [thread.threadId, thread] as const));
    const matched: Array<{ readonly threadId: CodeThreadId; readonly title: string }> = [];
    const seen = new Set<string>();
    const add = (threadId: string, title: string) => {
      if (seen.has(threadId) || matched.length >= MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS) {
        return;
      }
      seen.add(threadId);
      matched.push({ threadId: decodeCodeThreadId(threadId), title });
    };
    if (link !== undefined) {
      for (const id of link.threadIds) {
        const fact = threadById.get(String(id));
        if (fact !== undefined) add(fact.threadId, fact.title);
      }
    }
    const normalizedThreads = threads.map((thread) =>
      thread.projectId === String(project.projectId) &&
      this.#areSameRepository(project.projectId, thread.repository, {
        owner: target.owner,
        name: target.name,
      })
        ? { ...thread, repository: { owner: target.owner, name: target.name } }
        : thread,
    );
    for (const thread of matchLinkedThreadsToPullRequest({
      pullRequest: {
        repository: { owner: target.owner, name: target.name },
        projectId: String(project.projectId),
        number: target.number,
        headBranch: target.headBranch,
        title: target.title,
      },
      threads: normalizedThreads,
    })) {
      add(thread.threadId, thread.title);
    }
    return matched;
  }

  #lookupRepositoryForLink(
    repository: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    canonicalOwner: string,
    canonicalName: string,
    linkedThreads: ReadonlyArray<{ readonly threadId: CodeThreadId; readonly title: string }>,
    allThreads: ReadonlyArray<CodeProjectLinkedThreadFact>,
  ): { readonly owner: string; readonly name: string } | undefined {
    const differs = (owner: string, name: string) =>
      owner.toLowerCase() !== canonicalOwner.toLowerCase() ||
      name.toLowerCase() !== canonicalName.toLowerCase();
    if (differs(repository.repositoryOwner, repository.repositoryName)) {
      return { owner: repository.repositoryOwner, name: repository.repositoryName };
    }
    const linkedIds = new Set(linkedThreads.map((t) => String(t.threadId)));
    for (const thread of allThreads) {
      if (!linkedIds.has(thread.threadId)) continue;
      if (differs(thread.repository.owner, thread.repository.name)) {
        return thread.repository;
      }
    }
    return undefined;
  }

  async #reconcileRenamedProjectRepositories(
    projectId: ProjectId,
    canonical: { readonly nodeId: string; readonly owner: string; readonly name: string },
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      this.#pullRequestLinks?.recordRepositoryAlias === undefined ||
      this.#list.observeBaseRepository === undefined
    ) {
      return;
    }
    const candidates = new Map<string, { readonly owner: string; readonly name: string }>();
    const consider = (owner: string, name: string) => {
      if (this.#areSameRepository(projectId, { owner, name }, canonical)) return;
      const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
      if (!candidates.has(key)) candidates.set(key, { owner, name });
    };
    for (const link of this.#pullRequestLinks.listForProject?.(projectId) ?? []) {
      consider(link.repositoryOwner, link.repositoryName);
    }
    for (const thread of threads) {
      if (thread.projectId === String(projectId)) {
        consider(thread.repository.owner, thread.repository.name);
      }
    }
    for (const candidate of candidates.values()) {
      const observed = await this.#list.observeBaseRepository(candidate, signal);
      if (observed?.nodeId === canonical.nodeId) {
        this.#pullRequestLinks.recordRepositoryAlias({
          projectId,
          baseRepositoryNodeId: canonical.nodeId,
          canonicalOwner: canonical.owner,
          canonicalName: canonical.name,
          aliasOwner: candidate.owner,
          aliasName: candidate.name,
        });
      }
    }
  }

  #resolveLink(query: {
    readonly projectId: ProjectId;
    readonly repositoryOwner: string;
    readonly repositoryName: string;
    readonly number: number;
    readonly pullRequestNodeId?: string;
  }): PullRequestLinkRecord | undefined {
    return this.#pullRequestLinks?.resolveLink?.(query);
  }

  #areSameRepository(
    projectId: ProjectId,
    left: { readonly owner: string; readonly name: string },
    right: { readonly owner: string; readonly name: string },
  ): boolean {
    if (
      left.owner.toLowerCase() === right.owner.toLowerCase() &&
      left.name.toLowerCase() === right.name.toLowerCase()
    ) {
      return true;
    }
    return this.#pullRequestLinks?.areSameRepository?.(projectId, left, right) ?? false;
  }

  #canonicalizeConnection(
    project: CodeProjectPullRequestConnection,
  ): CodeProjectPullRequestConnection {
    if (project.kind !== "connected") return project;
    const canonical = this.#pullRequestLinks?.canonicalRepository?.(project.projectId, {
      owner: project.repositoryOwner,
      name: project.repositoryName,
    });
    if (canonical === undefined) return project;
    return {
      ...project,
      repositoryOwner: decodeRepositoryOwner(canonical.owner),
      repositoryName: decodeRepositoryName(canonical.name),
    };
  }

  #canonicalTarget(
    authorized: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    target: {
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
      readonly number: number;
    },
    knownLink?: PullRequestLinkRecord,
  ): CodeProjectPullRequestSwitchTarget {
    const link =
      knownLink ??
      this.#resolveLink({
        projectId: target.projectId,
        repositoryOwner: target.repositoryOwner,
        repositoryName: target.repositoryName,
        number: target.number,
      });
    if (link !== undefined) {
      return {
        projectId: link.projectId,
        repositoryOwner: decodeRepositoryOwner(link.repositoryOwner),
        repositoryName: decodeRepositoryName(link.repositoryName),
        number: link.number,
      };
    }
    const canonicalRepo = this.#pullRequestLinks?.canonicalRepository?.(target.projectId, {
      owner: authorized.repositoryOwner,
      name: authorized.repositoryName,
    });
    return {
      projectId: target.projectId,
      repositoryOwner: decodeRepositoryOwner(canonicalRepo?.owner ?? authorized.repositoryOwner),
      repositoryName: decodeRepositoryName(canonicalRepo?.name ?? authorized.repositoryName),
      number: target.number,
    };
  }

  #canonicalizeRow(row: CodeProjectPullRequestRow): CodeProjectPullRequestRow {
    const link =
      (row.linkId === undefined
        ? undefined
        : this.#pullRequestLinks?.resolveCanonical?.(row.linkId)) ??
      this.#resolveLink({
        projectId: row.projectId,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        number: row.number,
      });
    if (link === undefined) return row;
    const repositoryOwner = decodeRepositoryOwner(link.repositoryOwner);
    const repositoryName = decodeRepositoryName(link.repositoryName);
    if (
      row.repositoryOwner === repositoryOwner &&
      row.repositoryName === repositoryName &&
      row.linkId === link.linkId
    ) {
      return row;
    }
    return {
      ...row,
      repositoryOwner,
      repositoryName,
      linkId: link.linkId,
    };
  }

  #targetIdentityKey(
    target: {
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
      readonly number: number;
    },
    knownLink?: PullRequestLinkRecord,
  ): string {
    const link = knownLink ?? this.#resolveLink(target);
    if (link !== undefined) return `link:${String(link.linkId)}`;
    return `${String(target.projectId)}:${target.repositoryOwner.toLowerCase()}/${target.repositoryName.toLowerCase()}:${target.number}`;
  }

  #rowIdentityKey(row: CodeProjectPullRequestRow): string {
    if (row.linkId !== undefined) {
      const canonical = this.#pullRequestLinks?.resolveCanonical?.(row.linkId);
      return `link:${String(canonical?.linkId ?? row.linkId)}`;
    }
    return this.#targetIdentityKey(row);
  }

  #detailCacheKey(
    identity: {
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
      readonly number: number;
    },
    knownLink?: PullRequestLinkRecord,
  ): string {
    return this.#targetIdentityKey(identity, knownLink);
  }

  #mergeRows(
    primary: ReadonlyArray<CodeProjectPullRequestRow>,
    fallback: ReadonlyArray<CodeProjectPullRequestRow>,
  ): ReadonlyArray<CodeProjectPullRequestRow> {
    const rows: CodeProjectPullRequestRow[] = [];
    const indexByKey = new Map<string, number>();
    const add = (row: CodeProjectPullRequestRow) => {
      const canonical = this.#canonicalizeRow(row);
      const key = this.#rowIdentityKey(canonical);
      const existingIndex = indexByKey.get(key);
      if (existingIndex !== undefined) {
        const existing = rows[existingIndex];
        if (existing === undefined) return;
        const linkedThreads = [...existing.linkedThreads];
        const linkedIds = new Set(linkedThreads.map((thread) => String(thread.threadId)));
        for (const linked of canonical.linkedThreads) {
          if (linkedIds.has(String(linked.threadId))) continue;
          linkedIds.add(String(linked.threadId));
          linkedThreads.push(linked);
        }
        rows[existingIndex] = {
          ...existing,
          ...(existing.linkId === undefined && canonical.linkId !== undefined
            ? { linkId: canonical.linkId }
            : {}),
          linkedThreads: linkedThreads.slice(0, MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS),
        };
        return;
      }
      indexByKey.set(key, rows.length);
      rows.push(canonical);
    };
    for (const row of primary) add(row);
    for (const row of fallback) add(row);
    return rows;
  }

  #boundRows(
    rows: ReadonlyArray<CodeProjectPullRequestRow>,
  ): ReadonlyArray<CodeProjectPullRequestRow> {
    return [...rows]
      .sort((left, right) => {
        const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
        return byUpdatedAt === 0
          ? this.#rowIdentityKey(left).localeCompare(this.#rowIdentityKey(right))
          : byUpdatedAt;
      })
      .slice(0, MAX_CODE_PROJECT_PULL_REQUEST_ROWS);
  }

  #detailView(input: {
    readonly query: CodeProjectPullRequestDetailQuery;
    readonly detail: CodeProjectPullRequestDetail;
    readonly freshness: CodeProjectPullRequestFreshness;
    readonly linkedThreads: CodeProjectPullRequestDetailView["linkedThreads"];
  }): CodeProjectPullRequestDetailView {
    return decodeCodeProjectPullRequestDetailView({
      version: 1,
      query: input.query,
      detail: input.detail,
      freshness: input.freshness,
      linkedThreads: input.linkedThreads,
      generatedAt: decodeUtcTimestamp(this.#clock()),
    });
  }
}

function uniqueStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

function repositoryKey(projectId: ProjectId, owner: string, name: string): string {
  return `${String(projectId)}:${owner}/${name}`;
}

/**
 * The delivery contract accepts at most 256 UTF-8 bytes of title. A longer
 * GitHub title must not sink the whole observation — cut it at the byte limit
 * and drop the partial code point the cut may leave behind.
 */
function deliveryTitleBytes(title: string): string | undefined {
  const bytes = Buffer.from(title, "utf8");
  const cut =
    bytes.byteLength <= 256
      ? title
      : bytes
          .subarray(0, 256)
          .toString("utf8")
          .replace(/\uFFFD+/u, "");
  const trimmed = cut.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `gh` timestamps arrive without milliseconds; normalize to the contract's ISO form. */
function deliveryOccurredAt(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function projectFreshnessKey(
  project: Extract<CodeProjectPullRequestConnection, { readonly kind: "connected" }>,
): string {
  return repositoryKey(project.projectId, project.repositoryOwner, project.repositoryName);
}

function detailKey(identity: {
  readonly projectId: ProjectId;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
}): string {
  return `${String(identity.projectId)}:${identity.repositoryOwner}/${identity.repositoryName}:${identity.number}`;
}

function retryAfterTimestamp(
  result: Extract<GhActivePullRequestListResult, { status: "rate-limited" }>,
  clock: () => string,
): UtcTimestamp | undefined {
  if (result.retryAfterSeconds === undefined) return undefined;
  const now = Date.parse(clock());
  if (!Number.isFinite(now)) return undefined;
  try {
    return decodeUtcTimestamp(new Date(now + result.retryAfterSeconds * 1000).toISOString());
  } catch {
    return undefined;
  }
}

function summarizeObservedChecks(
  checks: Extract<GhPullRequestReviewResult, { status: "observed" }>["checks"],
): CodeProjectPullRequestRow["checks"] {
  if (checks.some((check) => check.state === "failure")) return "failing";
  if (checks.some((check) => check.state === "pending")) return "pending";
  if (
    checks.length > 0 &&
    checks.every((check) => check.state === "success" || check.state === "neutral")
  ) {
    return "passing";
  }
  return "unknown";
}

function summarizeObservedReviews(
  reviews: Extract<GhPullRequestReviewResult, { status: "observed" }>["reviews"],
): CodeProjectPullRequestRow["review"] {
  if (reviews.some((review) => review.state === "changes-requested")) {
    return "changes-requested";
  }
  if (reviews.some((review) => review.state === "approved")) return "approved";
  if (reviews.some((review) => review.state === "pending")) return "pending";
  return reviews.length === 0 ? "none" : "unknown";
}

function openRowsForThread(rows: ReadonlyArray<CodeProjectPullRequestRow>, threadId: CodeThreadId) {
  return rows.filter(
    (row) =>
      (row.state === "open" || row.state === "unknown") &&
      row.linkedThreads.some((thread) => String(thread.threadId) === String(threadId)),
  );
}
