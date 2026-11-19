import { type ActivityWindow } from "@octant/contracts/code-home-activity";
import {
  decodeUtcTimestamp,
  type ProjectId,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import type {
  IntegrationActivityObservation,
  IntegrationActivitySource,
} from "@octant/plugin-api/integration";
import type {
  CodeHomeActivityForgeRecord,
  CodeHomeActivityForgeResult,
  CodeHomeActivityServicePorts,
} from "./codeHomeActivityService";

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 32;

interface CachedRepositoryRead {
  readonly storedAtMs: number;
  readonly checkedAt: string;
  readonly result: Extract<
    IntegrationActivityObservation,
    { readonly status: "ready" | "partial" }
  >;
}

export interface CodeHomeForgeReadPorts {
  /**
   * The registered repository activity source, or undefined while the
   * integration is ineffective. It is looked up ahead of every observation
   * and rechecked after every await, so a source released mid-read — by a
   * disable or a re-registration — cannot serve the rows it gathered.
   */
  readonly source: () => IntegrationActivitySource | undefined;
  /** Connected repositories named only by this window's admitted Projects. */
  readonly listRepositories: (windowId: WindowId) => Promise<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
    }>
  >;
  /** Milliseconds now, for the cache lifetime and observation times. */
  readonly now: () => number;
}

/**
 * The resolved history read behind the activity service's forge seam,
 * answered through the contributed activity source the host admits. Results
 * are cached per normalized account + repository + card for one minute; an
 * account change, disconnect or insecure storage drops every entry so no
 * view can borrow another account's history, and a refused transient refresh
 * serves the last good rows as partial with their original checkedAt instead
 * of a fabricated fresh answer. A repository the source reports missing is
 * not a temporary failure: its cache is purged, its access epoch is bumped
 * so snapshots and in-flight reads built on its rows end instead of serving
 * them, and its formerly read rows are never reused.
 */
export function createCodeHomeForgeRead(ports: CodeHomeForgeReadPorts): {
  readonly forgeRead: NonNullable<CodeHomeActivityServicePorts["forgeRead"]>;
  readonly forgeAccount: NonNullable<CodeHomeActivityServicePorts["forgeAccount"]>;
  readonly forgeRepositoryEpoch: NonNullable<CodeHomeActivityServicePorts["forgeRepositoryEpoch"]>;
} {
  const cache = new Map<string, CachedRepositoryRead>();
  let cacheAccount: string | undefined;
  // Rows belong to the provider instance that gathered them, not merely its
  // account: a re-registered source starts with an empty cache.
  let cacheSource: IntegrationActivitySource | undefined;
  // Confirmed access losses, per account|repository: a snapshot or an
  // in-flight read built on since-purged rows must still notice even though
  // the rows are gone.
  const epochs = new Map<string, number>();

  const forgeAccount = async (
    card: "prs-merged" | "issues-closed" | "releases-published",
  ): Promise<string | undefined> => {
    // A disabled or untrusted integration observes no credentials at all.
    const source = ports.source();
    if (source === undefined) return undefined;
    try {
      const connection = await source.account(card, new AbortController().signal);
      if (ports.source() !== source) return undefined;
      if (connection.status === "connected") {
        // A different account observed here ends every row the previous one
        // read, even if a concurrent forge read still believes it is current.
        if (connection.account !== cacheAccount) {
          cache.clear();
          cacheAccount = connection.account;
        }
        return connection.account;
      }
      if (connection.status === "disconnected" || connection.status === "insecure-storage") {
        cache.clear();
        cacheAccount = undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const forgeRepositoryEpoch = (account: string, repositoryKey: string): number =>
    epochs.get(`${account}|${repositoryKey}`) ?? 0;

  const forgeRead = async (input: {
    readonly windowId: WindowId;
    readonly card: "prs-merged" | "issues-closed" | "releases-published";
    readonly current: ActivityWindow;
    readonly comparison?: ActivityWindow;
    readonly refresh: boolean;
    readonly signal?: AbortSignal;
    readonly admission?: () => boolean;
  }): Promise<CodeHomeActivityForgeResult> => {
    const signal = input.signal ?? new AbortController().signal;
    const admitted = () => input.admission === undefined || input.admission();
    // The slot lookup comes before any account observation, so a disabled
    // integration never reaches its own credentials for this read.
    const source = ports.source();
    if (source === undefined) return { status: "unavailable", reason: "not-connected" };
    const sourceLost = (): CodeHomeActivityForgeResult => ({
      status: "unavailable",
      reason: ports.source() === undefined ? "not-connected" : "read-failed",
    });
    let connection: Awaited<ReturnType<IntegrationActivitySource["account"]>>;
    try {
      connection = await source.account(input.card, signal);
    } catch {
      return { status: "unavailable", reason: "read-failed" };
    }
    if (ports.source() !== source) return sourceLost();
    if (!admitted()) return { status: "unavailable", reason: "read-failed" };
    if (connection.status !== "connected") {
      if (connection.status === "unavailable") {
        return { status: "unavailable", reason: connection.reason };
      }
      cache.clear();
      cacheAccount = undefined;
      return {
        status: "fallback",
        fallback:
          connection.status === "insecure-storage"
            ? "insecure-github-storage"
            : "no-github-connection",
      };
    }
    const account = connection.account;
    if (cacheSource !== source) {
      cache.clear();
      cacheSource = source;
      cacheAccount = undefined;
    }
    if (cacheAccount !== account) {
      cache.clear();
      cacheAccount = account;
    }

    const repositories = await ports.listRepositories(input.windowId);
    // An account swap another caller confirmed mid-read ends this one too:
    // its rows were gathered under an account that is no longer current.
    if (ports.source() !== source || cacheAccount !== account) return sourceLost();
    if (repositories.length === 0) return { status: "unavailable", reason: "not-connected" };

    // The read's lower bound is the earlier window start, floored to the
    // second GitHub qualifiers use; an unbounded window walks back without
    // one. It belongs to the cache key so a widened window cannot serve a
    // narrower read's rows.
    const froms = [input.current.from, input.comparison?.from];
    const since =
      input.current.from === null || input.comparison?.from === null
        ? undefined
        : new Date(
            Math.floor(
              Math.min(
                ...froms
                  .filter((from): from is UtcTimestamp => from !== undefined)
                  .map((from) => Date.parse(from)),
              ) / 1000,
            ) * 1000,
          ).toISOString();

    // The read's upper bound is the later window end, ceiled to the second.
    // An end still close to now (a live range such as This week) reads
    // open-ended instead, so its cache key stays stable while the range slides.
    const OPEN_ENDED_EDGE_MS = 5 * 60 * 1000;
    const latestUntilMs = Math.max(
      ...[input.current.until, input.comparison?.until]
        .filter((end): end is UtcTimestamp => end !== undefined)
        .map((end) => Date.parse(end)),
    );
    const until =
      ports.now() - latestUntilMs <= OPEN_ENDED_EDGE_MS
        ? undefined
        : new Date(Math.ceil(latestUntilMs / 1000) * 1000).toISOString();

    const records: CodeHomeActivityForgeRecord[] = [];
    let partial = false;
    let rateLimited = false;
    let checkedAt: string | undefined;
    for (const repository of repositories) {
      if (!admitted()) return { status: "unavailable", reason: "read-failed" };
      const repositoryKey = `${repository.repositoryOwner.toLowerCase()}/${repository.repositoryName.toLowerCase()}`;
      const epochKey = `${account}|${repositoryKey}`;
      const cacheKey = `${epochKey}|${input.card}|${since ?? "all"}|${until ?? "open"}`;
      const cached = cache.get(cacheKey);
      const fresh =
        cached !== undefined && !input.refresh && ports.now() - cached.storedAtMs < CACHE_TTL_MS
          ? cached
          : undefined;
      let observed: CachedRepositoryRead | undefined = fresh;
      // The access epoch this repository's rows may be served under,
      // captured before the read's only await and carried on every record
      // so a later revocation still retires them.
      const repositoryEpoch = epochs.get(epochKey) ?? 0;
      if (observed === undefined) {
        let result: IntegrationActivityObservation;
        try {
          result = await source.readRepository({
            owner: repository.repositoryOwner,
            name: repository.repositoryName,
            card: input.card,
            since,
            until,
            account,
            signal,
          });
        } catch {
          // A rejecting source read is a transient failure like any adapter
          // refusal: it falls back to cached rows when they are still
          // authorized rather than escaping to the caller.
          result = { status: "unavailable", reason: "read-failed" };
        }
        if (ports.source() !== source || cacheAccount !== account) return sourceLost();
        if (result.status === "repository-missing") {
          // A confirmed access loss invalidates this repository's rows for
          // every window, so the purge and epoch bump run even when this
          // read's own admission was lost while it flew — though the
          // abandoned read still refuses its result.
          const prefix = `${epochKey}|`;
          for (const key of cache.keys()) {
            if (key.startsWith(prefix)) cache.delete(key);
          }
          epochs.set(epochKey, (epochs.get(epochKey) ?? 0) + 1);
          partial = true;
          if (!admitted()) return { status: "unavailable", reason: "read-failed" };
          continue;
        }
        if (!admitted()) return { status: "unavailable", reason: "read-failed" };
        // Any other answer that arrived across an epoch bump is as stale as
        // the revocation it raced: never cached, never served. That holds
        // for fresh rows and for the cached fallback a refused refresh
        // would otherwise resurrect.
        if ((epochs.get(epochKey) ?? 0) !== repositoryEpoch) {
          partial = true;
          continue;
        }
        if (result.status === "unavailable") {
          // A session-level refusal ends the read; a per-read transient
          // keeps the last good rows as partial coverage with their own
          // original observation time.
          if (result.reason === "not-connected" || result.reason === "not-checked") {
            return { status: "unavailable", reason: result.reason };
          }
          if (result.reason === "rate-limited") rateLimited = true;
          partial = true;
          if (cached !== undefined) {
            observed = cached;
          } else {
            continue;
          }
        } else {
          observed = {
            storedAtMs: ports.now(),
            checkedAt: new Date(ports.now()).toISOString(),
            result,
          };
          cache.set(cacheKey, observed);
          while (cache.size > MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
      }
      if (observed.result.status === "partial") partial = true;
      if (checkedAt === undefined || observed.checkedAt < checkedAt) {
        checkedAt = observed.checkedAt;
      }
      for (const record of observed.result.records) {
        records.push({
          record,
          projectId: String(repository.projectId),
          repositoryKey,
          repositoryEpoch,
        });
      }
    }
    if (!admitted() || checkedAt === undefined) {
      return {
        status: "unavailable",
        reason: rateLimited ? "rate-limited" : "read-failed",
      };
    }
    // Newest first so the service's first-wins dedupe keeps the freshest
    // witness, e.g. a reopened-then-reclosed issue counts its latest close.
    records.sort(
      (a, b) =>
        (a.record.occurredAt < b.record.occurredAt
          ? 1
          : a.record.occurredAt > b.record.occurredAt
            ? -1
            : 0) || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0),
    );
    return {
      status: partial ? "partial" : "ready",
      account,
      checkedAt: decodeUtcTimestamp(checkedAt),
      records,
      // The binding this read's rows stand on. A view or page built on them
      // fails closed when the source was released or swapped, or another
      // caller confirmed a different account. It outlives this request's
      // signal on a snapshot, so cancellation stays with the caller.
      current: () => ports.source() === source && cacheAccount === account,
    };
  };

  return { forgeRead, forgeAccount, forgeRepositoryEpoch };
}
