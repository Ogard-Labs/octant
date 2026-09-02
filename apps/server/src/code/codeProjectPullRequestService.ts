import type {
  CodeProjectPullRequestBackgroundRefreshState,
  CodeProjectPullRequestConnection,
  CodeProjectPullRequestDetail,
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestDetailQuery,
  CodeProjectPullRequestDetailRefreshCommand,
  CodeProjectPullRequestDetailView,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestQuery,
  CodeProjectPullRequestRefreshCommand,
  CodeProjectPullRequestRow,
  CodeProjectPullRequestStaleReason,
  CodeProjectPullRequestView,
  ConnectedGitHubRepository,
  ProjectId,
  UtcTimestamp,
  WindowId,
} from "@octant/contracts";
import {
  decodeCodeProjectPullRequestDetailView,
  decodeCodeProjectPullRequestView,
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
import { Schema } from "effect";
import type { CacheStatsRecorder } from "../cacheStatsProjection";
import { resolveConnectedGitHubRepository } from "./connectedRepository";
import type {
  GhActivePullRequestListResult,
  GhActivePullRequestRow,
  GhPullRequestReviewResult,
} from "./ghPullRequestPort";
import { mapConcurrentOrdered } from "./boundedReads";
import type {
  CodeProjectPullRequestSnapshotStore,
  StoredCodeProjectPullRequestSnapshot,
} from "./codeProjectPullRequestSnapshotStore";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestampSchema);
const GITHUB_READ_CONCURRENCY = 4;

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
  readonly #threads: CodeProjectLinkedThreadSource;
  readonly #clock: () => string;
  readonly #cacheStats: CacheStatsRecorder | undefined;
  readonly #snapshotStore: CodeProjectPullRequestSnapshotStore | undefined;
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
    readonly threads: CodeProjectLinkedThreadSource;
    readonly clock?: () => string;
    readonly cacheStats?: CacheStatsRecorder;
    readonly snapshotStore?: CodeProjectPullRequestSnapshotStore;
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
    this.#threads = options.threads;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#cacheStats = options.cacheStats;
    this.#snapshotStore = options.snapshotStore;
    this.#onSnapshotRefreshed = options.onSnapshotRefreshed;
    const restored = this.#snapshotStore?.load();
    if (restored !== undefined) this.#restoreSnapshot(restored);
  }

  revokeGithub(): void {
    this.#githubRevoked = true;
    this.#revocationGeneration += 1;
    this.#cache = undefined;
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
    const projects = await this.#resolveProjects(windowId);
    this.#observeListRead();
    const rows = this.#authorizedActiveRows(projects);
    return this.#view({
      query,
      projects,
      rows,
      repositoriesTruncated: this.#cache?.repositoriesTruncated ?? false,
      pullRequestsTruncated: this.#cache?.pullRequestsTruncated ?? false,
      freshness: this.#queryFreshness(),
    });
  }

  /**
   * Read-only board join snapshot. Never reaches GitHub; it combines the
   * private refresh cache with bounded exact identities recovered by the
   * thread source from the operation journal.
   */
  async boardSnapshot(windowId: WindowId): Promise<{
    readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
    readonly freshness: CodeProjectPullRequestFreshness;
    readonly githubRevoked: boolean;
  }> {
    const [projects, threads] = await Promise.all([
      this.#resolveProjects(windowId),
      this.#threads.list(),
    ]);
    this.#observeListRead();
    const cachedRows = this.#authorizedRows(projects);
    const rows = boundPullRequestRows(
      mergePullRequestRows(cachedRows, this.#knownRows(projects, threads)),
    );
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
    const cached = this.#detailCache.get(detailKey(query));
    if (cached === undefined) {
      this.#cacheStats?.recordMiss("pull-request-detail");
      return this.#detailView({
        query,
        detail: { state: "empty" },
        freshness: this.#detailFreshness.get(detailKey(query)) ?? { status: "empty" },
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
    const projects = await this.#resolveProjects(windowId);
    const authorized = this.#authorizedConnection(projects, command);
    if (authorized === undefined || this.#githubRevoked) {
      return this.queryDetail(windowId, command);
    }

    const key = detailKey(command);
    const observed = await this.#detail.observeReviewByIdentity(
      {
        owner: command.repositoryOwner,
        name: command.repositoryName,
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
    this.#detailCache.set(key, { detail, lastSuccessfulRefreshAt: now });
    this.#detailFreshness.set(key, { status: "fresh", lastSuccessfulRefreshAt: now });
    const threads = await this.#threads.list();
    return this.#detailView({
      query: command,
      detail,
      freshness: { status: "fresh", lastSuccessfulRefreshAt: now },
      linkedThreads: this.#linkedThreads(authorized, detail, threads),
    });
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
    const projects = await this.#resolveProjects(windowId);
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
    const listedNumbersByProject = new Map<string, ReadonlySet<number>>();
    for (const { repository, listed } of listedResults) {
      if (listed.status !== "ok") continue;
      const remaining = CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS - collected.length;
      if (remaining <= 0) {
        if (listed.rows.length > 0) pullRequestsTruncated = true;
        continue;
      }
      const usable = listed.rows.length > remaining ? listed.rows.slice(0, remaining) : listed.rows;
      if (listed.rows.length > remaining) pullRequestsTruncated = true;
      listedNumbersByProject.set(
        String(repository.projectId),
        new Set(usable.map((row) => row.number)),
      );
      for (const row of usable) collected.push(this.#row(repository, row, threads));
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
        const listedNumbers = listedNumbersByProject.get(String(repository.projectId)) ?? new Set();
        for (const knownRow of this.#knownRows([repository], threads)) {
          if (listedNumbers.has(knownRow.number)) continue;
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
          const settled = this.#cachedSettledRow(repository, knownRow.number);
          if (settled !== undefined) return { kind: "settled", repository, row: settled };
        }
        const observed = await this.#detail.observeReviewByIdentity(
          {
            owner: repository.repositoryOwner,
            name: repository.repositoryName,
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
        collected.push(entry.row);
        continue;
      }
      const { repository, knownRow, observed } = entry;
      if (observed.status === "observed" && observed.freshness === "fresh" && !observed.ambiguous) {
        collected.push(this.#rowFromObserved(repository, observed, threads, knownRow.updatedAt));
      } else {
        knownIdentityRefreshFailed.add(String(repository.projectId));
        collected.push(knownRow);
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
        ? [
            ...this.#authorizedRows(projects).filter(
              (row) => String(row.projectId) !== String(command.projectId),
            ),
            ...collected,
          ]
        : collected;
    const rows = boundPullRequestRows(refreshedRows);
    if (rows.length < refreshedRows.length) pullRequestsTruncated = true;
    this.#cache = {
      rows,
      lastSuccessfulRefreshAt: now,
      repositoriesTruncated: bounded.repositoriesTruncated,
      pullRequestsTruncated,
    };
    for (const repository of bounded.repositories) {
      const projectId = String(repository.projectId);
      const projectRows = rows.filter((row) => String(row.projectId) === projectId);
      const failed = knownIdentityRefreshFailed.has(projectId);
      this.#projectFreshness.set(projectFreshnessKey(repository), {
        status: failed ? "stale" : projectRows.length === 0 ? "empty" : "fresh",
        lastSuccessfulRefreshAt: now,
        ...(failed ? { staleReason: "refresh-failed" as const } : {}),
      });
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
      projects,
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
  #cachedSettledRow(
    repository: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    number: number,
  ): CodeProjectPullRequestRow | undefined {
    if (this.#githubRevoked || this.#cache === undefined) return undefined;
    return this.#cache.rows.find(
      (row) =>
        (row.state === "merged" || row.state === "closed") &&
        row.number === number &&
        String(row.projectId) === String(repository.projectId) &&
        row.repositoryOwner === repository.repositoryOwner &&
        row.repositoryName === repository.repositoryName,
    );
  }

  async #resolveProjects(
    windowId: WindowId,
  ): Promise<ReadonlyArray<CodeProjectPullRequestConnection>> {
    const bootstrap = await this.#projects.bootstrap(windowId);
    const resolved = await mapConcurrentOrdered(
      bootstrap.active,
      GITHUB_READ_CONCURRENCY,
      async (project): Promise<CodeProjectPullRequestConnection | undefined> => {
        if (project.type !== "code" || project.lifecycle !== "active") return undefined;
        const remotes =
          project.connectedRepository !== undefined || project.binding === undefined
            ? undefined
            : await this.#remotes.remotes(project.binding.canonicalRoot);
        const identity =
          project.connectedRepository === undefined
            ? githubIdentityFromRemotes(remotes ?? [])
            : {
                owner: project.connectedRepository.owner,
                name: project.connectedRepository.repository,
              };
        return identity === undefined
          ? { kind: "unconnected", projectId: project.id, projectName: project.name }
          : {
              kind: "connected",
              projectId: project.id,
              projectName: project.name,
              repositoryOwner: identity.owner,
              repositoryName: identity.name,
            };
      },
    );
    return resolved.filter(
      (connection): connection is CodeProjectPullRequestConnection => connection !== undefined,
    );
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
    const authorized = new Set(
      projects
        .filter((project) => project.kind === "connected")
        .map((project) =>
          repositoryKey(project.projectId, project.repositoryOwner, project.repositoryName),
        ),
    );
    return this.#cache.rows.filter((row) =>
      authorized.has(repositoryKey(row.projectId, row.repositoryOwner, row.repositoryName)),
    );
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
  ): CodeProjectPullRequestRow {
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      repositoryOwner: project.repositoryOwner,
      repositoryName: project.repositoryName,
      number: row.number,
      title: row.title,
      draft: row.draft,
      state: row.state,
      mergeability: row.mergeability,
      author: row.author,
      baseBranch: row.baseBranch,
      headBranch: row.headBranch,
      updatedAt: row.updatedAt,
      checks: row.checks,
      review: row.review,
      linkedThreads: matchLinkedThreadsToPullRequest({
        pullRequest: {
          repository: { owner: project.repositoryOwner, name: project.repositoryName },
          projectId: String(project.projectId),
          number: row.number,
          headBranch: row.headBranch,
          title: row.title,
        },
        threads,
      })
        .slice(0, MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS)
        .map((thread) => ({
          threadId: decodeCodeThreadId(thread.threadId),
          title: thread.title,
        })),
    };
  }

  #knownRows(
    projects: ReadonlyArray<CodeProjectPullRequestConnection>,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
  ): ReadonlyArray<CodeProjectPullRequestRow> {
    const rows: CodeProjectPullRequestRow[] = [];
    for (const project of projects) {
      if (project.kind !== "connected") continue;
      for (const thread of threads) {
        if (thread.projectId !== String(project.projectId)) continue;
        if (
          thread.repository.owner !== project.repositoryOwner ||
          thread.repository.name !== project.repositoryName
        ) {
          continue;
        }
        for (const identity of thread.pullRequestNumbers ?? []) {
          rows.push({
            projectId: project.projectId,
            projectName: project.projectName,
            repositoryOwner: project.repositoryOwner,
            repositoryName: project.repositoryName,
            number: identity.number,
            title: `Pull request #${identity.number}`,
            draft: false,
            state: "unknown",
            mergeability: "unknown",
            author: "Unknown author",
            baseBranch: "unknown",
            headBranch: thread.deliveryBranch ?? "unknown",
            updatedAt: identity.observedAt,
            checks: "unknown",
            review: "unknown",
            linkedThreads: [{ threadId: decodeCodeThreadId(thread.threadId), title: thread.title }],
          });
        }
      }
    }
    return boundPullRequestRows(mergePullRequestRows([], rows));
  }

  #rowFromObserved(
    project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    observed: Extract<GhPullRequestReviewResult, { readonly status: "observed" }>,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
    knownObservedAt: string,
  ): CodeProjectPullRequestRow {
    const pullRequest = observed.pullRequest;
    const state = pullRequest.state === "draft" ? "open" : pullRequest.state;
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      repositoryOwner: project.repositoryOwner,
      repositoryName: project.repositoryName,
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
      linkedThreads: matchLinkedThreadsToPullRequest({
        pullRequest: {
          projectId: String(project.projectId),
          repository: { owner: project.repositoryOwner, name: project.repositoryName },
          number: pullRequest.number,
          headBranch: pullRequest.headBranch,
          title: pullRequest.title,
        },
        threads,
      })
        .slice(0, MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS)
        .map((thread) => ({ threadId: decodeCodeThreadId(thread.threadId), title: thread.title })),
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
      project.repositoryOwner !== identity.repositoryOwner ||
      project.repositoryName !== identity.repositoryName
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
    if (this.#githubRevoked) {
      const current = this.#detailFreshness.get(detailKey(query));
      return {
        status: "stale",
        staleReason: "disconnected",
        ...(current?.lastSuccessfulRefreshAt === undefined
          ? {}
          : { lastSuccessfulRefreshAt: current.lastSuccessfulRefreshAt }),
      };
    }
    return this.#detailFreshness.get(detailKey(query)) ?? { status: "empty" };
  }

  #staleDetailView(input: {
    readonly query: CodeProjectPullRequestDetailQuery;
    readonly authorized: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>;
    readonly reason: CodeProjectPullRequestStaleReason;
  }): Promise<CodeProjectPullRequestDetailView> {
    const key = detailKey(input.query);
    const cached = this.#detailCache.get(key);
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
      baseRepository: observed.pullRequest.baseRepository,
      baseBranch: observed.pullRequest.baseBranch,
      headRepository: observed.pullRequest.headRepository,
      headBranch: observed.pullRequest.headBranch,
      author: observed.pullRequest.author,
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

  #linkedThreads(
    project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
    detail: Extract<CodeProjectPullRequestDetail, { readonly state: "observed" }>,
    threads: ReadonlyArray<CodeProjectLinkedThreadFact>,
  ) {
    return matchLinkedThreadsToPullRequest({
      pullRequest: {
        repository: { owner: project.repositoryOwner, name: project.repositoryName },
        projectId: String(project.projectId),
        number: detail.number,
        headBranch: detail.headBranch,
        title: detail.title,
      },
      threads,
    })
      .slice(0, MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS)
      .map((thread) => ({
        threadId: decodeCodeThreadId(thread.threadId),
        title: thread.title,
      }));
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

function githubIdentityFromRemotes(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly fetchUrl: string;
    readonly pushUrl: string;
    readonly credentialed?: boolean;
  }>,
): { readonly owner: string; readonly name: string } | undefined {
  const identity = resolveConnectedGitHubRepository(
    remotes.map((remote) => ({
      name: remote.name,
      fetchUrl: remote.fetchUrl,
      pushUrl: remote.pushUrl,
      ...(remote.credentialed === undefined ? {} : { credentialed: remote.credentialed }),
    })),
  );
  return identity === undefined ? undefined : { owner: identity.owner, name: identity.repository };
}

function repositoryKey(projectId: ProjectId, owner: string, name: string): string {
  return `${String(projectId)}:${owner}/${name}`;
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

function mergePullRequestRows(
  primary: ReadonlyArray<CodeProjectPullRequestRow>,
  fallback: ReadonlyArray<CodeProjectPullRequestRow>,
): ReadonlyArray<CodeProjectPullRequestRow> {
  const rows = [...primary];
  const indexByKey = new Map(primary.map((row, index) => [pullRequestRowKey(row), index] as const));
  for (const row of fallback) {
    const key = pullRequestRowKey(row);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = rows[existingIndex];
      if (existing === undefined) continue;
      const linkedThreads = [...existing.linkedThreads];
      const linkedIds = new Set(linkedThreads.map((thread) => String(thread.threadId)));
      for (const linked of row.linkedThreads) {
        if (linkedIds.has(String(linked.threadId))) continue;
        linkedIds.add(String(linked.threadId));
        linkedThreads.push(linked);
      }
      rows[existingIndex] = {
        ...existing,
        linkedThreads: linkedThreads.slice(0, MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS),
      };
      continue;
    }
    indexByKey.set(key, rows.length);
    rows.push(row);
  }
  return rows;
}

function boundPullRequestRows(
  rows: ReadonlyArray<CodeProjectPullRequestRow>,
): ReadonlyArray<CodeProjectPullRequestRow> {
  return [...rows]
    .sort((left, right) => {
      const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
      return byUpdatedAt === 0
        ? pullRequestRowKey(left).localeCompare(pullRequestRowKey(right))
        : byUpdatedAt;
    })
    .slice(0, MAX_CODE_PROJECT_PULL_REQUEST_ROWS);
}

function pullRequestRowKey(row: CodeProjectPullRequestRow): string {
  return `${String(row.projectId)}:${row.repositoryOwner}/${row.repositoryName}:${row.number}`;
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
