import { decodeHostId, type GlobalEntityReference, type HostId } from "@octant/contracts/host";
import { globalEntityReference } from "./hostFederationTransports";
import type {
  FederatedHostTransportSlot,
  FederatedTransportState,
  HostFederationTransports,
} from "./hostFederationTransports";

/**
 * Client-side All Hosts merged read models for Post-preview B3.
 *
 * Merges namespaced per-host projections (Projects, threads, activity, agents,
 * approvals, Code board, search/filters) without merging ownership. Disconnected
 * hosts keep clearly stale read-only caches; authority-bearing mutations are
 * never queued.
 */

export type FederatedReadModelKind =
  | "project"
  | "thread"
  | "activity"
  | "agent"
  | "approval"
  | "code-board"
  | "search";

/**
 * Connection freshness for one host's contribution to All Hosts.
 * `stale` is the cache presentation after disconnect / refresh failure.
 */
export type FederatedHostReadFreshness =
  | "ready"
  | "stale"
  | "connecting"
  | "unavailable"
  | "unauthorized"
  | "incompatible";

export type FederatedHostFailureCategory =
  | "offline"
  | "rejected"
  | "unavailable"
  | "stale"
  | "unauthorized"
  | "incompatible";

export interface FederatedReadItem<TPayload = unknown> {
  readonly ref: GlobalEntityReference;
  readonly kind: FederatedReadModelKind;
  readonly hostDisplayName: string;
  readonly title: string;
  /** ISO-8601 / lexical sort key — newer sorts first when merged. */
  readonly sortKey: string;
  readonly searchableText: string;
  readonly freshness: FederatedHostReadFreshness;
  /** True whenever freshness is not `ready` — UI must disable mutations. */
  readonly readOnly: boolean;
  readonly tags: ReadonlyArray<string>;
  readonly payload: TPayload;
}

export interface HostReadModelContribution {
  readonly hostId: HostId;
  readonly hostDisplayName: string;
  readonly freshness: FederatedHostReadFreshness;
  readonly items: ReadonlyArray<FederatedReadItem>;
}

export interface FederatedHostFailure {
  readonly hostId: HostId;
  readonly category: FederatedHostFailureCategory;
  readonly message: string;
}

export interface FederatedHostState {
  readonly hostId: HostId;
  readonly hostDisplayName: string;
  readonly freshness: FederatedHostReadFreshness;
  readonly itemCount: number;
}

export interface MergedAllHostsReadModels {
  readonly items: ReadonlyArray<FederatedReadItem>;
  readonly hostStates: ReadonlyArray<FederatedHostState>;
  readonly failures: ReadonlyArray<FederatedHostFailure>;
}

export interface FederatedReadFilter {
  readonly hostId?: HostId | string;
  readonly kinds?: ReadonlyArray<FederatedReadModelKind>;
  readonly tags?: ReadonlyArray<string>;
  readonly includeStale?: boolean;
}

export interface HostReadRefreshFulfilled {
  readonly hostId: HostId | string;
  readonly status: "fulfilled";
  readonly contribution: HostReadModelContribution;
}

export interface HostReadRefreshRejected {
  readonly hostId: HostId | string;
  readonly status: "rejected";
  readonly reason?: unknown;
  readonly category?: FederatedHostFailureCategory;
  readonly message?: string;
  /** Known display name for a host that has never been cached before. */
  readonly hostDisplayName?: string;
}

export type HostReadRefreshResult = HostReadRefreshFulfilled | HostReadRefreshRejected;

export interface HostReadModelCache {
  readonly get: (hostId: HostId | string) => HostReadModelContribution | undefined;
  readonly put: (contribution: HostReadModelContribution) => void;
  /**
   * Mark a host's cached contribution stale + read-only.
   * Preserves last-known items for All Hosts display during partial outages.
   */
  readonly markStale: (
    hostId: HostId | string,
    cause?: Exclude<FederatedHostReadFreshness, "ready" | "stale">,
  ) => HostReadModelContribution | undefined;
  readonly remove: (hostId: HostId | string) => HostReadModelContribution | undefined;
  readonly list: () => ReadonlyArray<HostReadModelContribution>;
  /**
   * Guarantee a cache row exists for a registered host so it stays visible
   * in `hostStates` even when it has never been fetched. Seeds an empty
   * contribution when absent; when present, only renames the display name
   * if one was given, leaving freshness and items untouched.
   */
  readonly ensureHost: (
    hostId: HostId | string,
    input?: {
      readonly hostDisplayName?: string;
      readonly freshness?: FederatedHostReadFreshness;
    },
  ) => HostReadModelContribution;
  /**
   * Apply fan-out refresh results with isolation: fulfilled hosts update the
   * cache; rejected hosts keep (or create) stale cache rows and appear in
   * failures without clearing healthy hosts.
   */
  readonly applyRefreshResults: (
    results: ReadonlyArray<HostReadRefreshResult>,
  ) => MergedAllHostsReadModels;
}

export interface AuthorityMutationDecision {
  readonly allowed: boolean;
  /** Always false — this layer never queues offline mutations. */
  readonly queued: false;
  readonly reason: string;
}

function withHostFreshness(
  contribution: HostReadModelContribution,
  freshness: FederatedHostReadFreshness,
): HostReadModelContribution {
  const readOnly = freshness !== "ready";
  return {
    hostId: contribution.hostId,
    hostDisplayName: contribution.hostDisplayName,
    freshness,
    items: contribution.items.map((entry) => ({
      ...entry,
      hostDisplayName: contribution.hostDisplayName,
      freshness,
      readOnly,
    })),
  };
}

/**
 * Deterministic All Hosts ordering: newer `sortKey` first; ties broken by
 * `hostId` then `entityId` so duplicate names never swap nondeterministically.
 */
export function sortFederatedReadItems(
  items: ReadonlyArray<FederatedReadItem>,
): ReadonlyArray<FederatedReadItem> {
  return [...items].sort((left, right) => {
    if (left.sortKey !== right.sortKey) {
      return left.sortKey < right.sortKey ? 1 : -1;
    }
    if (left.ref.hostId !== right.ref.hostId) {
      return left.ref.hostId < right.ref.hostId ? -1 : 1;
    }
    if (left.ref.entityId !== right.ref.entityId) {
      return left.ref.entityId < right.ref.entityId ? -1 : 1;
    }
    return left.kind.localeCompare(right.kind);
  });
}

export function mergeAllHostsReadModels(
  contributions: ReadonlyArray<HostReadModelContribution>,
  options?: { readonly failures?: ReadonlyArray<FederatedHostFailure> },
): MergedAllHostsReadModels {
  const items: FederatedReadItem[] = [];
  const hostStates: FederatedHostState[] = [];

  for (const contribution of contributions) {
    const normalized = withHostFreshness(contribution, contribution.freshness);
    items.push(...normalized.items);
    hostStates.push({
      hostId: normalized.hostId,
      hostDisplayName: normalized.hostDisplayName,
      freshness: normalized.freshness,
      itemCount: normalized.items.length,
    });
  }

  hostStates.sort((left, right) => {
    if (left.hostId === right.hostId) return 0;
    return left.hostId < right.hostId ? -1 : 1;
  });

  return {
    items: sortFederatedReadItems(items),
    hostStates,
    failures: options?.failures ?? [],
  };
}

export function filterFederatedReadItems(
  items: ReadonlyArray<FederatedReadItem>,
  filter: FederatedReadFilter,
): ReadonlyArray<FederatedReadItem> {
  const hostId = filter.hostId !== undefined ? decodeHostId(filter.hostId) : undefined;
  const kinds = filter.kinds !== undefined ? new Set(filter.kinds) : undefined;
  const tags = filter.tags !== undefined ? new Set(filter.tags) : undefined;
  const includeStale = filter.includeStale ?? true;

  return sortFederatedReadItems(
    items.filter((entry) => {
      if (hostId !== undefined && entry.ref.hostId !== hostId) return false;
      if (kinds !== undefined && !kinds.has(entry.kind)) return false;
      if (tags !== undefined && !entry.tags.some((tag) => tags.has(tag))) return false;
      if (!includeStale && entry.freshness !== "ready") return false;
      return true;
    }),
  );
}

/**
 * Case-insensitive substring search over title + searchableText.
 * Ordering remains deterministic after filtering.
 */
export function searchFederatedReadItems(
  items: ReadonlyArray<FederatedReadItem>,
  query: string,
): ReadonlyArray<FederatedReadItem> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return sortFederatedReadItems(items);
  return sortFederatedReadItems(
    items.filter((entry) => {
      const haystack = `${entry.title} ${entry.searchableText}`.toLowerCase();
      return haystack.includes(needle);
    }),
  );
}

/**
 * Authority-bearing mutations (create/approve/mutate) are allowed only while
 * the host contribution is `ready`. Stale caches are display-only.
 */
export function allowAuthorityBearingMutation(freshness: FederatedHostReadFreshness): boolean {
  return freshness === "ready";
}

/**
 * Explicitly refuse to queue mutations for disconnected/stale hosts.
 * Callers must surface `reason` rather than deferring execution.
 */
export function rejectQueuedAuthorityMutation(input: {
  readonly hostId: HostId | string;
  readonly freshness: FederatedHostReadFreshness;
  readonly action: string;
}): AuthorityMutationDecision {
  const hostId = decodeHostId(input.hostId);
  if (allowAuthorityBearingMutation(input.freshness)) {
    return {
      allowed: true,
      queued: false,
      reason: `Host ${hostId} is ready for ${input.action}.`,
    };
  }
  return {
    allowed: false,
    queued: false,
    reason: `Host ${hostId} is ${input.freshness} (read-only). Reconnect before ${input.action}; mutations are not queued.`,
  };
}

function failureMessage(result: HostReadRefreshRejected): string {
  if (typeof result.message === "string" && result.message.length > 0) return result.message;
  if (typeof result.reason === "string" && result.reason.length > 0) return result.reason;
  if (result.reason instanceof Error) return result.reason.message;
  return "Could not refresh read models from this host.";
}

function failureCategory(result: HostReadRefreshRejected): FederatedHostFailureCategory {
  return result.category ?? "unavailable";
}

/**
 * Build a namespaced All Hosts item. Identity is always `{ hostId, entityId }`.
 */
export function buildFederatedReadItem<TPayload = unknown>(input: {
  readonly hostId: HostId | string;
  readonly entityId: string;
  readonly kind: FederatedReadModelKind;
  readonly hostDisplayName: string;
  readonly title: string;
  readonly sortKey: string;
  readonly freshness?: FederatedHostReadFreshness;
  readonly searchableText?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly payload?: TPayload;
}): FederatedReadItem<TPayload> {
  const freshness = input.freshness ?? "ready";
  return {
    ref: globalEntityReference(input.hostId, input.entityId),
    kind: input.kind,
    hostDisplayName: input.hostDisplayName,
    title: input.title,
    sortKey: input.sortKey,
    searchableText: input.searchableText ?? `${input.title} ${input.kind} ${input.entityId}`,
    freshness,
    readOnly: freshness !== "ready",
    tags: input.tags ?? [],
    payload: (input.payload ?? ({ title: input.title } as TPayload)) as TPayload,
  };
}

/**
 * Map a B2 transport slot state onto All Hosts read freshness.
 * Only `ready` / `local-ready` allow mutations; everything else is read-only.
 */
export function freshnessFromTransportState(
  state: FederatedTransportState,
): FederatedHostReadFreshness {
  switch (state.kind) {
    case "local-ready":
    case "ready":
      return "ready";
    case "connecting":
    case "negotiating":
    case "authenticating":
    case "reconnecting":
      return "connecting";
    case "stale":
      return "stale";
    case "incompatible":
      return "incompatible";
    case "unauthorized":
      return "unauthorized";
    case "unavailable":
    case "idle":
      return "unavailable";
  }
}

/**
 * Fan-out per-host read fetches through B2 transports, then merge through the
 * stale-aware cache. One host rejection never clears another host's rows.
 */
export async function refreshAllHostsReadModels(input: {
  readonly transports: HostFederationTransports;
  readonly cache: HostReadModelCache;
  readonly fetchContribution: (
    slot: FederatedHostTransportSlot,
  ) => Promise<
    ReadonlyArray<Omit<FederatedReadItem, "freshness" | "readOnly" | "hostDisplayName">>
  >;
}): Promise<MergedAllHostsReadModels> {
  const fanOut = await input.transports.fanOut(async (slot) => {
    const freshness = freshnessFromTransportState(slot.state);
    if (freshness !== "ready") {
      throw Object.assign(new Error(`Host ${slot.hostId} is ${freshness}.`), {
        category: freshness,
      });
    }
    const items = await input.fetchContribution(slot);
    return {
      hostId: slot.hostId,
      hostDisplayName: slot.displayName,
      freshness: "ready" as const,
      items: items.map((entry) => ({
        ...entry,
        hostDisplayName: slot.displayName,
        freshness: "ready" as const,
        readOnly: false,
      })),
    } satisfies HostReadModelContribution;
  });

  const results: HostReadRefreshResult[] = fanOut.map((result) => {
    if (result.status === "fulfilled") {
      return {
        hostId: result.hostId,
        status: "fulfilled" as const,
        contribution: result.value!,
      };
    }
    const reason = result.reason;
    const category =
      reason !== null &&
      typeof reason === "object" &&
      "category" in reason &&
      typeof (reason as { category: unknown }).category === "string"
        ? normalizeFailureCategory((reason as { category: string }).category)
        : "unavailable";
    const message = reason instanceof Error ? reason.message : undefined;
    const slot = input.transports.get?.(result.hostId);
    return {
      hostId: result.hostId,
      status: "rejected" as const,
      reason,
      category,
      ...(message !== undefined ? { message } : {}),
      ...(slot?.displayName !== undefined ? { hostDisplayName: slot.displayName } : {}),
    };
  });

  return input.cache.applyRefreshResults(results);
}

function normalizeFailureCategory(value: string): FederatedHostFailureCategory {
  switch (value) {
    case "offline":
    case "rejected":
    case "unavailable":
    case "stale":
    case "unauthorized":
    case "incompatible":
      return value;
    case "connecting":
      return "unavailable";
    default:
      return "unavailable";
  }
}

export function createHostReadModelCache(): HostReadModelCache {
  const byHost = new Map<string, HostReadModelContribution>();

  return {
    get(hostId) {
      return byHost.get(decodeHostId(hostId));
    },

    put(contribution) {
      const hostId = decodeHostId(contribution.hostId);
      byHost.set(hostId, withHostFreshness({ ...contribution, hostId }, contribution.freshness));
    },

    markStale(hostId, _cause) {
      const id = decodeHostId(hostId);
      const existing = byHost.get(id);
      if (existing === undefined) return undefined;
      // Presentation is always `stale` once cached after disconnect, regardless
      // of the transport cause (unavailable/unauthorized/…). Cause is for
      // failures[] at the refresh boundary, not for overwriting cache freshness.
      void _cause;
      const stale = withHostFreshness(existing, "stale");
      byHost.set(id, stale);
      return stale;
    },

    remove(hostId) {
      const id = decodeHostId(hostId);
      const existing = byHost.get(id);
      if (existing === undefined) return undefined;
      byHost.delete(id);
      return existing;
    },

    ensureHost(hostId, input) {
      const id = decodeHostId(hostId);
      const existing = byHost.get(id);
      if (existing === undefined) {
        const freshness = input?.freshness ?? "stale";
        const seeded = withHostFreshness(
          { hostId: id, hostDisplayName: input?.hostDisplayName ?? id, freshness, items: [] },
          freshness,
        );
        byHost.set(id, seeded);
        return seeded;
      }
      if (
        input?.hostDisplayName !== undefined &&
        input.hostDisplayName !== existing.hostDisplayName
      ) {
        const renamed = withHostFreshness(
          { ...existing, hostDisplayName: input.hostDisplayName },
          existing.freshness,
        );
        byHost.set(id, renamed);
        return renamed;
      }
      return existing;
    },

    list() {
      return [...byHost.values()].sort((left, right) =>
        left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0,
      );
    },

    applyRefreshResults(results) {
      const failures: FederatedHostFailure[] = [];

      for (const result of results) {
        const hostId = decodeHostId(result.hostId);
        if (result.status === "fulfilled") {
          this.put({ ...result.contribution, hostId });
          continue;
        }
        const existing = byHost.get(hostId);
        if (existing !== undefined) {
          this.markStale(hostId);
        } else {
          this.ensureHost(hostId, {
            hostDisplayName: result.hostDisplayName ?? hostId,
            freshness: "stale",
          });
        }
        failures.push({
          hostId,
          category: failureCategory(result),
          message: failureMessage(result),
        });
      }

      return mergeAllHostsReadModels(this.list(), { failures });
    },
  };
}
