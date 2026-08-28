import type {
  GithubAuthenticationSnapshot,
  GithubCapability,
  GithubCapabilityKind,
  GithubCatalogueFreshness,
  GithubCatalogueReadRequest,
  GithubCatalogueReadResponse,
  GithubCatalogueStaleReason,
  GithubRecentRepositoryCommand,
  GithubRepositoryRow,
} from "@octant/contracts";
import { decodeGithubCatalogueReadResponse } from "@octant/contracts";
import { decideGithubCatalogueRead } from "@octant/domain";
import { CacheStatsProjection, type CacheStatsRecorder } from "../cacheStatsProjection";
import type {
  GhCatalogueFailure,
  GhCataloguePageObservation,
  GhCatalogueResult,
  GhIssueDetailObservation,
  GhIssueObservationRow,
  GhProjectObservationRow,
  GhPullRequestObservationRow,
  GhRepositoryObservationRow,
} from "./ghRepositoryCataloguePort";

const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_KNOWN_ROWS = 500;
const MAX_RECENTS = 20;
const DEFAULT_ISSUE_STATE = "open" as const;

interface CataloguePort {
  listRepositories(
    request: { readonly pageSize: number; readonly cursor?: string; readonly search?: string },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhRepositoryObservationRow>>>;
  listIssues(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly pageSize: number;
      readonly cursor?: string;
      readonly state: "open" | "closed" | "all";
      readonly search?: string;
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhIssueObservationRow>>>;
  readIssue(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhIssueDetailObservation>>;
  listPullRequests(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly pageSize: number;
      readonly cursor?: string;
      readonly state: "open" | "closed" | "all";
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhPullRequestObservationRow>>>;
  listProjects(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly pageSize: number;
      readonly cursor?: string;
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhProjectObservationRow>>>;
}

interface CacheEntry {
  readonly response: GithubCatalogueReadResponse;
  readonly fetchedAt: number;
}

/**
 * Server-owned catalogue reads: per-operation capability gating, bounded
 * host-local caching with honest freshness labels, and the recents list.
 * Stale pages stay viewable but carry an explicit stale label so nothing
 * downstream can treat them as authorization.
 */
export class GithubCatalogueService {
  readonly #port: CataloguePort;
  readonly #snapshot: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;
  readonly #now: () => number;
  readonly #cacheTtlMs: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #knownRows = new Map<string, GithubRepositoryRow>();
  readonly #cacheStats: CacheStatsRecorder;
  #recents: GithubRepositoryRow[] = [];
  #cachedAccountKey: string | undefined;
  #heldFailure: "rate-limited" | "unavailable" | undefined;

  constructor(options: {
    readonly port: CataloguePort;
    readonly snapshot: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;
    readonly now?: () => number;
    readonly cacheTtlMs?: number;
    readonly cacheStats?: CacheStatsRecorder;
  }) {
    this.#port = options.port;
    this.#snapshot = options.snapshot;
    this.#now = options.now ?? Date.now;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    // Pacing is part of how this service treats a failing GitHub, so it holds a
    // reading of its own when the host did not give it a shared one.
    this.#cacheStats = options.cacheStats ?? new CacheStatsProjection({ now: this.#now });
  }

  async read(
    request: GithubCatalogueReadRequest,
    signal: AbortSignal,
  ): Promise<GithubCatalogueReadResponse> {
    const snapshot = await this.#observeSnapshot(signal);
    if (request.kind === "recent-repositories") {
      return this.#decodeOrUnavailable(
        { kind: "recent-repositories", rows: this.#recents },
        "repository-catalogue",
      );
    }
    const capability = capabilityFor(request.kind);
    const gate = decideGithubCatalogueRead({ capability, snapshot });
    if (gate.decision === "deny") {
      return {
        kind: "unavailable",
        capability,
        reason: gate.reason,
        ...(gate.remediation === undefined ? {} : { remediation: gate.remediation }),
      };
    }
    const cacheKey = JSON.stringify({ ...request, refresh: undefined });
    const refresh = request.kind === "repositories" && request.refresh === true;
    if (!refresh) {
      const cached = this.#cache.get(cacheKey);
      if (cached !== undefined && this.#now() - cached.fetchedAt < this.#cacheTtlMs) {
        this.#cacheStats.recordHit("github-catalogue");
        return cached.response;
      }
      // A GitHub that just failed will usually fail again, and retrying on every
      // expired entry turns one outage into a request per read — which for a
      // rate-limited account is what keeps it limited. While the streak is
      // pacing, an expired entry is served with its stale label instead. A
      // refresh the user asked for is never held back.
      if (this.#cacheStats.holdsUnattendedRefresh("github-catalogue")) {
        const heldReason = this.#heldFailure ?? "unavailable";
        if (cached !== undefined) {
          this.#cacheStats.recordHit("github-catalogue");
          return this.#decodeOrUnavailable(
            markStale(
              cached.response,
              heldReason === "rate-limited" ? "rate-limited" : "disconnected",
            ),
            capability,
          );
        }
        this.#cacheStats.recordMiss("github-catalogue");
        return { kind: "unavailable", capability, reason: heldReason };
      }
    }
    this.#cacheStats.recordMiss("github-catalogue");
    const result = await this.#fetch(request, signal);
    if (result.kind === "ok") {
      this.#heldFailure = undefined;
      this.#cacheStats.recordRefreshSucceeded("github-catalogue");
      const response = this.#decodeOrUnavailable(result.value, capability);
      if (response.kind !== "unavailable") this.#storeCache(cacheKey, response);
      return response;
    }
    // Only transient rate-limit and connectivity failures may fall back to a
    // bounded stale view. Authorization losses drop straight to unavailable so
    // revoked access never keeps private data actionable.
    if (result.kind === "rate-limited" || result.kind === "unavailable") {
      this.#heldFailure = result.kind;
      this.#cacheStats.recordRefreshFailed("github-catalogue");
      const cached = this.#cache.get(cacheKey);
      if (cached !== undefined) {
        const staleReason: GithubCatalogueStaleReason = refresh
          ? "refresh-failed"
          : result.kind === "rate-limited"
            ? "rate-limited"
            : "disconnected";
        return this.#decodeOrUnavailable(markStale(cached.response, staleReason), capability);
      }
    }
    return {
      kind: "unavailable",
      capability,
      reason: result.kind === "unavailable" ? "unavailable" : result.kind,
      ...(result.remediation === undefined ? {} : { remediation: result.remediation }),
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
    };
  }

  /** Recents accept only repositories this server itself observed. */
  async recordRecentRepository(
    command: GithubRecentRepositoryCommand,
    signal: AbortSignal,
  ): Promise<GithubCatalogueReadResponse> {
    await this.#observeSnapshot(signal);
    const row = this.#knownRows.get(command.nodeId);
    if (row === undefined) {
      return {
        kind: "unavailable",
        capability: "repository-catalogue",
        reason: "unavailable",
        remediation: "unknown-repository-selection",
      };
    }
    this.#recents = [
      row,
      ...this.#recents.filter((candidate) => candidate.nodeId !== row.nodeId),
    ].slice(0, MAX_RECENTS);
    return this.#decodeOrUnavailable(
      { kind: "recent-repositories", rows: this.#recents },
      "repository-catalogue",
    );
  }

  async #observeSnapshot(signal: AbortSignal): Promise<GithubAuthenticationSnapshot> {
    const snapshot = await this.#snapshot(signal);
    const accountKey = `${snapshot.account?.login ?? ""}`;
    // A different active account must never see the previous account's cached
    // catalogue, known rows, or recents, and must not inherit that account's
    // rate-limit hold.
    if (this.#cachedAccountKey !== undefined && this.#cachedAccountKey !== accountKey) {
      this.#cache.clear();
      this.#knownRows.clear();
      this.#recents = [];
      this.#heldFailure = undefined;
      this.#cacheStats.clearBackoff("github-catalogue");
    }
    this.#cachedAccountKey = accountKey;
    return snapshot;
  }

  async #fetch(
    request: Exclude<GithubCatalogueReadRequest, { kind: "recent-repositories" }>,
    signal: AbortSignal,
  ): Promise<
    { readonly kind: "ok"; readonly value: GithubCatalogueReadResponse } | GhCatalogueFailure
  > {
    if (request.kind === "repositories") {
      const snapshot = await this.#snapshot(signal);
      const result = await this.#port.listRepositories(
        {
          pageSize: request.pageSize,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.search === undefined ? {} : { search: request.search }),
        },
        signal,
      );
      if (result.kind !== "ok") return result;
      const rows = result.value.rows.map((row) => this.#annotateRow(row, snapshot));
      for (const row of rows) this.#rememberRow(row);
      return {
        kind: "ok",
        value: {
          kind: "repositories",
          page: {
            rows,
            sort: "pushed-desc",
            hasNextPage: result.value.hasNextPage,
            ...(result.value.endCursor === undefined ? {} : { endCursor: result.value.endCursor }),
            freshness: { status: "fresh" },
          },
        },
      };
    }
    if (request.kind === "issue") {
      const result = await this.#port.readIssue(
        { owner: request.owner, name: request.name, number: request.number },
        signal,
      );
      if (result.kind !== "ok") return result;
      return {
        kind: "ok",
        value: {
          kind: "issue",
          issue: result.value,
          freshness: { status: "fresh" },
        },
      };
    }
    if (request.kind === "issues") {
      const result = await this.#port.listIssues(
        {
          owner: request.owner,
          name: request.name,
          pageSize: request.pageSize,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          state: request.state ?? DEFAULT_ISSUE_STATE,
          ...(request.search === undefined ? {} : { search: request.search }),
        },
        signal,
      );
      if (result.kind !== "ok") return result;
      return {
        kind: "ok",
        value: {
          kind: "issues",
          page: {
            rows: result.value.rows,
            sort: "updated-desc",
            hasNextPage: result.value.hasNextPage,
            ...(result.value.endCursor === undefined ? {} : { endCursor: result.value.endCursor }),
            freshness: { status: "fresh" },
          },
        },
      };
    }
    if (request.kind === "pull-requests") {
      const result = await this.#port.listPullRequests(
        {
          owner: request.owner,
          name: request.name,
          pageSize: request.pageSize,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          state: request.state ?? DEFAULT_ISSUE_STATE,
        },
        signal,
      );
      if (result.kind !== "ok") return result;
      return {
        kind: "ok",
        value: {
          kind: "pull-requests",
          page: {
            rows: result.value.rows,
            sort: "updated-desc",
            hasNextPage: result.value.hasNextPage,
            ...(result.value.endCursor === undefined ? {} : { endCursor: result.value.endCursor }),
            freshness: { status: "fresh" },
          },
        },
      };
    }
    const result = await this.#port.listProjects(
      {
        owner: request.owner,
        name: request.name,
        pageSize: request.pageSize,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      },
      signal,
    );
    if (result.kind !== "ok") return result;
    return {
      kind: "ok",
      value: {
        kind: "projects",
        page: {
          rows: result.value.rows,
          sort: "updated-desc",
          hasNextPage: result.value.hasNextPage,
          ...(result.value.endCursor === undefined ? {} : { endCursor: result.value.endCursor }),
          freshness: { status: "fresh" },
        },
      },
    };
  }

  #annotateRow(
    row: GhRepositoryObservationRow,
    snapshot: GithubAuthenticationSnapshot,
  ): GithubRepositoryRow {
    const readCapability = (kind: GithubCapabilityKind): GithubCapability => {
      const capability = snapshot.capabilities.find((candidate) => candidate.kind === kind);
      if (capability !== undefined) return capability;
      return { kind, available: false, remediation: "operation-probe-required" };
    };
    return {
      nodeId: row.nodeId,
      owner: row.owner,
      name: row.name,
      visibility: row.visibility,
      ...(row.defaultBranch === undefined ? {} : { defaultBranch: row.defaultBranch }),
      viewerPermission: row.viewerPermission,
      capabilities: [
        readCapability("issues-read"),
        readCapability("pull-requests-read"),
        readCapability("projects-read"),
      ],
    };
  }

  #rememberRow(row: GithubRepositoryRow): void {
    this.#knownRows.delete(row.nodeId);
    this.#knownRows.set(row.nodeId, row);
    while (this.#knownRows.size > MAX_KNOWN_ROWS) {
      const oldest = this.#knownRows.keys().next().value;
      if (oldest === undefined) break;
      this.#knownRows.delete(oldest);
    }
  }

  #storeCache(key: string, response: GithubCatalogueReadResponse): void {
    this.#cache.delete(key);
    this.#cache.set(key, { response, fetchedAt: this.#now() });
    while (this.#cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  #decodeOrUnavailable(
    response: unknown,
    capability: GithubCapabilityKind,
  ): GithubCatalogueReadResponse {
    try {
      return decodeGithubCatalogueReadResponse(response);
    } catch {
      return { kind: "unavailable", capability, reason: "unavailable" };
    }
  }
}

function capabilityFor(
  kind: Exclude<GithubCatalogueReadRequest["kind"], "recent-repositories">,
): GithubCapabilityKind {
  switch (kind) {
    case "repositories":
      return "repository-catalogue";
    case "issues":
    case "issue":
      return "issues-read";
    case "pull-requests":
      return "pull-requests-read";
    case "projects":
      return "projects-read";
  }
}

function markStale(
  response: GithubCatalogueReadResponse,
  staleReason: GithubCatalogueStaleReason,
): GithubCatalogueReadResponse {
  if (response.kind === "unavailable" || response.kind === "recent-repositories") return response;
  const freshness: GithubCatalogueFreshness = { status: "stale", staleReason };
  switch (response.kind) {
    case "issue":
      return { kind: "issue", issue: response.issue, freshness };
    case "repositories":
      return { kind: "repositories", page: { ...response.page, freshness } };
    case "issues":
      return { kind: "issues", page: { ...response.page, freshness } };
    case "pull-requests":
      return { kind: "pull-requests", page: { ...response.page, freshness } };
    case "projects":
      return { kind: "projects", page: { ...response.page, freshness } };
  }
}
