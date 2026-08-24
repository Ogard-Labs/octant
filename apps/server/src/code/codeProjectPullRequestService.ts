import type {
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
import { resolveConnectedGitHubRepository } from "./connectedRepository";
import type {
  GhActivePullRequestListResult,
  GhActivePullRequestRow,
  GhPullRequestReviewResult,
} from "./ghPullRequestPort";

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

export interface CodeProjectLinkedThreadSource {
  list(windowId: WindowId): Promise<ReadonlyArray<CodeProjectLinkedThreadFact>>;
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
 * In-memory Project-scoped pull-request snapshot. Manual refresh reconstructs
 * the bounded open, draft, merged, and closed history after a process restart.
 * The journal never sees list or detail rows.
 */
export class CodeProjectPullRequestService {
  readonly #projects: CodeProjectPullRequestProjectSource;
  readonly #remotes: CodeProjectPullRequestRemoteSource;
  readonly #list: CodeProjectPullRequestListPort;
  readonly #detail: CodeProjectPullRequestDetailPort;
  readonly #threads: CodeProjectLinkedThreadSource;
  readonly #clock: () => string;
  #cache: CachedSnapshot | undefined;
  readonly #projectFreshness = new Map<string, CodeProjectPullRequestFreshness>();
  readonly #detailCache = new Map<string, CachedDetail>();
  #freshness: CodeProjectPullRequestFreshness = { status: "empty" };
  readonly #detailFreshness = new Map<string, CodeProjectPullRequestFreshness>();
  #githubRevoked = false;

  constructor(options: {
    readonly projects: CodeProjectPullRequestProjectSource;
    readonly remotes: CodeProjectPullRequestRemoteSource;
    readonly list: CodeProjectPullRequestListPort;
    readonly detail: CodeProjectPullRequestDetailPort;
    readonly threads: CodeProjectLinkedThreadSource;
    readonly clock?: () => string;
  }) {
    this.#projects = options.projects;
    this.#remotes = options.remotes;
    this.#list = options.list;
    this.#detail = options.detail;
    this.#threads = options.threads;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  revokeGithub(): void {
    this.#githubRevoked = true;
    this.#cache = undefined;
    this.#detailCache.clear();
    this.#detailFreshness.clear();
    this.#freshness = { status: "stale", staleReason: "disconnected" };
  }

  async query(
    windowId: WindowId,
    query: CodeProjectPullRequestQuery,
  ): Promise<CodeProjectPullRequestView> {
    const projects = await this.#resolveProjects(windowId);
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
   * process-local refresh cache with bounded exact identities recovered by the
   * thread source from the operation journal.
   */
  async boardSnapshot(windowId: WindowId): Promise<{
    readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
    readonly freshness: CodeProjectPullRequestFreshness;
    readonly githubRevoked: boolean;
  }> {
    const [projects, threads] = await Promise.all([
      this.#resolveProjects(windowId),
      this.#threads.list(windowId),
    ]);
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
      return this.#detailView({
        query,
        detail: { state: "empty" },
        freshness: this.#detailFreshness.get(detailKey(query)) ?? { status: "empty" },
        linkedThreads: [],
      });
    }
    const threads = await this.#threads.list(windowId);
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
      return this.#staleDetailView({
        query: command,
        authorized,
        reason: "refresh-failed",
        windowId,
      });
    }

    const detail = this.#observedDetail(observed);
    const now = decodeUtcTimestamp(this.#clock());
    this.#detailCache.set(key, { detail, lastSuccessfulRefreshAt: now });
    this.#detailFreshness.set(key, { status: "fresh", lastSuccessfulRefreshAt: now });
    const threads = await this.#threads.list(windowId);
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
    const projects = await this.#resolveProjects(windowId);
    const selected =
      command.kind === "refresh-all"
        ? projects
        : projects.filter((project) => String(project.projectId) === String(command.projectId));
    if (command.kind === "refresh-project" && selected.length === 0) {
      return this.#view({
        query: { version: 1 },
        projects,
        rows: this.#authorizedActiveRows(projects),
        repositoriesTruncated: this.#cache?.repositoriesTruncated ?? false,
        pullRequestsTruncated: this.#cache?.pullRequestsTruncated ?? false,
        freshness: this.#queryFreshness(),
      });
    }

    const connected = selected.filter(
      (project): project is Extract<CodeProjectPullRequestConnection, { kind: "connected" }> =>
        project.kind === "connected",
    );
    const bounded = boundActivePullRequestRefresh({
      repositories: connected,
      pullRequestsFor: () => [],
    });
    const [threads, listedResults] = await Promise.all([
      this.#threads.list(windowId),
      mapConcurrentOrdered(
        bounded.repositories,
        GITHUB_READ_CONCURRENCY,
        async (repository) => ({
          repository,
          listed: await this.#list.listActive(
            {
              owner: repository.repositoryOwner,
              name: repository.repositoryName,
              limit: CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS + 1,
            },
            signal,
          ),
        }),
      ),
    ]);
    const knownIdentityRefreshFailed = new Set<string>();

    // Inspect results in the policy's repository order so a concurrent
    // refresh has the same deterministic first-error semantics as the old
    // sequential refresh.
    for (const { repository, listed } of listedResults) {
      if (listed.status !== "ok") {
        if (listed.status === "unauthorized") this.revokeGithub();
        const retryAfter =
          listed.status === "rate-limited" ? retryAfterTimestamp(listed, this.#clock) : undefined;
        this.#markProjectStale(
          repository,
          listed.status === "unauthorized" ? "disconnected" : listed.status,
          retryAfter,
        );
        return this.#staleView({
          projects,
          reason: listed.status === "unauthorized" ? "disconnected" : listed.status,
          ...(retryAfter === undefined ? {} : { retryAfter }),
        });
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
      async ({ repository, knownRow }) => {
        const observed = await this.#detail.observeReviewByIdentity(
          {
            owner: repository.repositoryOwner,
            name: repository.repositoryName,
            number: knownRow.number,
            maxDiffBytes: MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES,
          },
          signal,
        );
        return { repository, knownRow, observed };
      },
    );
    for (const { repository, knownRow, observed } of recoveredKnown) {
      if (observed.status === "observed" && observed.freshness === "fresh" && !observed.ambiguous) {
        collected.push(this.#rowFromObserved(repository, observed, threads, knownRow.updatedAt));
      } else {
        knownIdentityRefreshFailed.add(String(repository.projectId));
        collected.push(knownRow);
      }
    }

    this.#githubRevoked = false;
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
    return this.#view({
      query: { version: 1 },
      projects,
      rows: rows.filter((row) => row.state === "open"),
      repositoriesTruncated: bounded.repositoriesTruncated,
      pullRequestsTruncated,
      freshness: this.#freshness,
    });
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
    readonly windowId: WindowId;
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
    return this.#threads.list(input.windowId).then((threads) =>
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

async function mapConcurrentOrdered<TItem, TResult>(
  items: ReadonlyArray<TItem>,
  concurrency: number,
  run: (item: TItem, index: number) => Promise<TResult>,
): Promise<ReadonlyArray<TResult>> {
  const results: Array<{ readonly value: TResult } | undefined> = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = { value: await run(item, index) };
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Concurrent GitHub read ${String(index)} did not produce a result.`);
    }
    return result.value;
  });
}
