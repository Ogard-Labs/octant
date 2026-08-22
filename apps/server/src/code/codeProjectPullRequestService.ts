import type {
  CodeProjectPullRequestConnection,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestQuery,
  CodeProjectPullRequestRefreshCommand,
  CodeProjectPullRequestRow,
  CodeProjectPullRequestStaleReason,
  CodeProjectPullRequestView,
  ProjectId,
  UtcTimestamp,
  WindowId,
} from "@octant/contracts";
import {
  decodeCodeProjectPullRequestView,
  UtcTimestamp as UtcTimestampSchema,
} from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import {
  boundActivePullRequestRefresh,
  CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS,
  matchLinkedThreadsToPullRequest,
  type CodeProjectLinkedThreadFact,
} from "@octant/domain/code-project-pull-request-policy";
import { parseGithubRemote } from "@octant/domain/github-remote-identity";
import { Schema } from "effect";
import type { GhActivePullRequestListResult, GhActivePullRequestRow } from "./ghPullRequestPort";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestampSchema);

export interface CodeProjectPullRequestAuthorizedProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly type: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
  readonly binding?: { readonly canonicalRoot: string };
}

export interface CodeProjectPullRequestProjectSource {
  bootstrap(
    windowId: WindowId,
  ): Promise<{ readonly active: ReadonlyArray<CodeProjectPullRequestAuthorizedProject> }>;
}

export interface CodeProjectPullRequestRemoteSource {
  remotes(
    root: string,
  ): Promise<ReadonlyArray<{ readonly name: string; readonly fetchUrl: string }> | undefined>;
}

export interface CodeProjectPullRequestListPort {
  listActive(
    request: { readonly owner: string; readonly name: string; readonly limit: number },
    signal: AbortSignal,
  ): Promise<GhActivePullRequestListResult>;
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

/**
 * In-memory Project-scoped active pull-request snapshot. Process restart
 * loses it. The journal never sees list or detail rows.
 */
export class CodeProjectPullRequestService {
  readonly #projects: CodeProjectPullRequestProjectSource;
  readonly #remotes: CodeProjectPullRequestRemoteSource;
  readonly #list: CodeProjectPullRequestListPort;
  readonly #threads: CodeProjectLinkedThreadSource;
  readonly #clock: () => string;
  #cache: CachedSnapshot | undefined;
  #freshness: CodeProjectPullRequestFreshness = { status: "empty" };
  #githubRevoked = false;

  constructor(options: {
    readonly projects: CodeProjectPullRequestProjectSource;
    readonly remotes: CodeProjectPullRequestRemoteSource;
    readonly list: CodeProjectPullRequestListPort;
    readonly threads: CodeProjectLinkedThreadSource;
    readonly clock?: () => string;
  }) {
    this.#projects = options.projects;
    this.#remotes = options.remotes;
    this.#list = options.list;
    this.#threads = options.threads;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  revokeGithub(): void {
    this.#githubRevoked = true;
    this.#cache = undefined;
    this.#freshness = { status: "stale", staleReason: "disconnected" };
  }

  async query(
    windowId: WindowId,
    query: CodeProjectPullRequestQuery,
  ): Promise<CodeProjectPullRequestView> {
    const projects = await this.#resolveProjects(windowId);
    const rows = this.#authorizedRows(projects);
    return this.#view({
      query,
      projects,
      rows,
      repositoriesTruncated: this.#cache?.repositoriesTruncated ?? false,
      pullRequestsTruncated: this.#cache?.pullRequestsTruncated ?? false,
      freshness: this.#queryFreshness(),
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
        rows: this.#authorizedRows(projects),
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
    const collected: CodeProjectPullRequestRow[] = [];
    let pullRequestsTruncated = false;
    const threads = await this.#threads.list(windowId);

    for (const repository of bounded.repositories) {
      const remaining = CODE_PROJECT_PULL_REQUEST_MAX_PULL_REQUESTS - collected.length;
      if (remaining <= 0) {
        pullRequestsTruncated = true;
        break;
      }
      const listed = await this.#list.listActive(
        {
          owner: repository.repositoryOwner,
          name: repository.repositoryName,
          limit: remaining + 1,
        },
        signal,
      );
      if (listed.status !== "ok") {
        if (listed.status === "unauthorized") this.revokeGithub();
        const retryAfter =
          listed.status === "rate-limited" ? retryAfterTimestamp(listed, this.#clock) : undefined;
        return this.#staleView({
          projects,
          reason: listed.status === "unauthorized" ? "disconnected" : listed.status,
          ...(retryAfter === undefined ? {} : { retryAfter }),
        });
      }
      const usable = listed.rows.length > remaining ? listed.rows.slice(0, remaining) : listed.rows;
      if (listed.rows.length > remaining) pullRequestsTruncated = true;
      for (const row of usable) {
        collected.push(this.#row(repository, row, threads));
      }
    }

    this.#githubRevoked = false;
    const now = decodeUtcTimestamp(this.#clock());
    const rows =
      command.kind === "refresh-project"
        ? [
            ...this.#authorizedRows(projects).filter(
              (row) => String(row.projectId) !== String(command.projectId),
            ),
            ...collected,
          ]
        : collected;
    this.#cache = {
      rows,
      lastSuccessfulRefreshAt: now,
      repositoriesTruncated: bounded.repositoriesTruncated,
      pullRequestsTruncated,
    };
    this.#freshness = {
      status: "fresh",
      lastSuccessfulRefreshAt: now,
    };
    return this.#view({
      query: { version: 1 },
      projects,
      rows,
      repositoriesTruncated: bounded.repositoriesTruncated,
      pullRequestsTruncated,
      freshness: this.#freshness,
    });
  }

  async #resolveProjects(
    windowId: WindowId,
  ): Promise<ReadonlyArray<CodeProjectPullRequestConnection>> {
    const bootstrap = await this.#projects.bootstrap(windowId);
    const connections: CodeProjectPullRequestConnection[] = [];
    for (const project of bootstrap.active) {
      if (project.type !== "code" || project.lifecycle !== "active") continue;
      const remotes =
        project.binding === undefined
          ? undefined
          : await this.#remotes.remotes(project.binding.canonicalRoot);
      const identity = githubIdentityFromRemotes(remotes ?? []);
      connections.push(
        identity === undefined
          ? { kind: "unconnected", projectId: project.id, projectName: project.name }
          : {
              kind: "connected",
              projectId: project.id,
              projectName: project.name,
              repositoryOwner: identity.owner,
              repositoryName: identity.name,
            },
      );
    }
    return connections;
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
      rows: this.#authorizedRows(input.projects),
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
      author: row.author,
      baseBranch: row.baseBranch,
      headBranch: row.headBranch,
      updatedAt: row.updatedAt,
      checks: row.checks,
      review: row.review,
      linkedThreads: matchLinkedThreadsToPullRequest({
        pullRequest: {
          repository: { owner: project.repositoryOwner, name: project.repositoryName },
          number: row.number,
          headBranch: row.headBranch,
          title: row.title,
        },
        threads,
      }).map((thread) => ({
        threadId: decodeCodeThreadId(thread.threadId),
        title: thread.title,
      })),
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
      generatedAt: decodeUtcTimestamp(this.#clock()),
    });
  }
}

function githubIdentityFromRemotes(
  remotes: ReadonlyArray<{ readonly name: string; readonly fetchUrl: string }>,
): { readonly owner: string; readonly name: string } | undefined {
  const preferred = remotes.find((remote) => remote.name === "origin") ?? remotes[0];
  if (preferred === undefined) return undefined;
  const parsed = parseGithubRemote(preferred.fetchUrl);
  return parsed.status === "resolved" ? parsed.identity : undefined;
}

function repositoryKey(projectId: ProjectId, owner: string, name: string): string {
  return `${String(projectId)}:${owner}/${name}`;
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
