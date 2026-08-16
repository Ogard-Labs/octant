import type {
  GithubAuthenticationSnapshot,
  GithubCapability,
  GithubCapabilityKind,
  GithubCatalogueReadRequest,
  GithubCatalogueReadResponse,
  GithubCatalogueStaleReason,
  GithubRecentRepositoryCommand,
  GithubRepositoryRow,
} from "@octant/contracts";
import { decodeGithubCatalogueReadResponse } from "@octant/contracts";
import { decideGithubCatalogueRead } from "@octant/domain";
import type {
  GhCatalogueFailure,
  GhCataloguePageObservation,
  GhCatalogueResult,
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
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhIssueObservationRow>>>;
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
  #recents: GithubRepositoryRow[] = [];
  #cachedAccountKey: string | undefined;

  constructor(options: {
    readonly port: CataloguePort;
    readonly snapshot: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;
    readonly now?: () => number;
    readonly cacheTtlMs?: number;
  }) {
    this.#port = options.port;
    this.#snapshot = options.snapshot;
    this.#now = options.now ?? Date.now;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
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
        return cached.response;
      }
    }
    const result = await this.#fetch(request, signal);
    if (result.kind === "ok") {
      const response = this.#decodeOrUnavailable(result.value, capability);
      if (response.kind !== "unavailable") this.#storeCache(cacheKey, response);
      return response;
    }
    // Only transient rate-limit and connectivity failures may fall back to a
    // bounded stale view. Authorization losses drop straight to unavailable so
    // revoked access never keeps private data actionable.
    if (result.kind === "rate-limited" || result.kind === "unavailable") {
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
    // catalogue, known rows, or recents.
    if (this.#cachedAccountKey !== undefined && this.#cachedAccountKey !== accountKey) {
      this.#cache.clear();
      this.#knownRows.clear();
      this.#recents = [];
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
    if (request.kind === "issues" || request.kind === "pull-requests") {
      const scoped = {
        owner: request.owner,
        name: request.name,
        pageSize: request.pageSize,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        state: request.state ?? DEFAULT_ISSUE_STATE,
      };
      const result =
        request.kind === "issues"
          ? await this.#port.listIssues(scoped, signal)
          : await this.#port.listPullRequests(scoped, signal);
      if (result.kind !== "ok") return result;
      return {
        kind: "ok",
        value: {
          kind: request.kind,
          page: {
            rows: result.value.rows,
            sort: "updated-desc",
            hasNextPage: result.value.hasNextPage,
            ...(result.value.endCursor === undefined ? {} : { endCursor: result.value.endCursor }),
            freshness: { status: "fresh" },
          },
        } as GithubCatalogueReadResponse,
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
  kind: "repositories" | "issues" | "pull-requests" | "projects",
): GithubCapabilityKind {
  switch (kind) {
    case "repositories":
      return "repository-catalogue";
    case "issues":
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
  return {
    ...response,
    page: { ...response.page, freshness: { status: "stale", staleReason } },
  } as GithubCatalogueReadResponse;
}
