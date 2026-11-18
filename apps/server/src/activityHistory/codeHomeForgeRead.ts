import {
  decodeActivityRecord,
  type ActivityRecord,
  type ActivityWindow,
} from "@octant/contracts/code-home-activity";
import {
  decodeUtcTimestamp,
  type ProjectId,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import type { GithubAuthenticationSnapshot, GithubCapabilityKind } from "@octant/contracts";
import { decideGithubCatalogueRead } from "@octant/domain";
import type { GhHomeActivityPort, GhHomeActivityRow } from "../github/ghHomeActivityPort";
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
    Awaited<ReturnType<GhHomeActivityPort["observe"]>>,
    { readonly status: "ready" | "partial" }
  >;
}

type GateOutcome =
  | { readonly kind: "ready"; readonly account: string }
  | { readonly kind: "result"; readonly result: CodeHomeActivityForgeResult };

type ForgeCard = "prs-merged" | "issues-closed" | "releases-published";

/** The catalogue capability each card's read actually needs. */
const capabilityOf = (card: ForgeCard): GithubCapabilityKind =>
  card === "prs-merged"
    ? "pull-requests-read"
    : card === "issues-closed"
      ? "issues-read"
      : "repository-catalogue";

export interface CodeHomeForgeReadPorts {
  /** The secure account and per-capability state `gh` would run under. */
  readonly capabilitySnapshot: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;
  /** Whether the bundled GitHub integration is trusted and enabled. */
  readonly integrationEffective: () => boolean;
  /** Connected repositories named only by this window's admitted Projects. */
  readonly listRepositories: (windowId: WindowId) => Promise<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
    }>
  >;
  /** The window's current read admission for one Project. */
  readonly mayReadProject: (windowId: WindowId, projectId: ProjectId) => boolean;
  /** The bounded read-only history port; absent when no `gh` is configured. */
  readonly port: Pick<GhHomeActivityPort, "observe"> | undefined;
  /** Milliseconds now, for the cache lifetime and observation times. */
  readonly now: () => number;
}

/**
 * The resolved GitHub history read behind the activity service's forge seam.
 * Only the signed-in account's own actions count — another actor's merge,
 * closure or release is not the person's activity. Results are cached per
 * normalized account + repository + card for one minute; an account change,
 * disconnect or insecure storage drops every entry so no view can borrow
 * another account's history, and a refused transient refresh serves the last
 * good rows as partial with their original checkedAt instead of a fabricated
 * fresh answer. A repository that answers 404/403 is not a temporary failure:
 * its cache is purged and its formerly read rows are never reused.
 */
export function createCodeHomeForgeRead(ports: CodeHomeForgeReadPorts): {
  readonly forgeRead: NonNullable<CodeHomeActivityServicePorts["forgeRead"]>;
  readonly forgeAccount: NonNullable<CodeHomeActivityServicePorts["forgeAccount"]>;
} {
  const cache = new Map<string, CachedRepositoryRead>();
  let cacheAccount: string | undefined;

  const gate = (snapshot: GithubAuthenticationSnapshot, card: ForgeCard): GateOutcome => {
    // A disconnected or insecure account is a labeled fallback; a live
    // account that cannot be observed is a read failure, never a connection
    // claim.
    if (snapshot.state === "insecure-storage" || snapshot.state === "external-token") {
      cache.clear();
      cacheAccount = undefined;
      return {
        kind: "result",
        result: { status: "fallback", fallback: "insecure-github-storage" },
      };
    }
    if (snapshot.state === "unauthorized") {
      cache.clear();
      cacheAccount = undefined;
      return { kind: "result", result: { status: "fallback", fallback: "no-github-connection" } };
    }
    if (snapshot.state === "unavailable") {
      return { kind: "result", result: { status: "unavailable", reason: "read-failed" } };
    }
    if (snapshot.state === "rate-limited") {
      return { kind: "result", result: { status: "unavailable", reason: "rate-limited" } };
    }
    if (!ports.integrationEffective()) {
      return { kind: "result", result: { status: "unavailable", reason: "not-connected" } };
    }
    const read = decideGithubCatalogueRead({
      capability: capabilityOf(card),
      snapshot: { state: snapshot.state, capabilities: snapshot.capabilities },
    });
    if (read.decision === "deny") {
      return {
        kind: "result",
        result: {
          status: "unavailable",
          reason: read.reason === "rate-limited" ? "rate-limited" : "not-connected",
        },
      };
    }
    const account = snapshot.account?.login.toLowerCase();
    if (account === undefined) {
      return { kind: "result", result: { status: "unavailable", reason: "not-connected" } };
    }
    return { kind: "ready", account };
  };

  const forgeAccount = async (card: ForgeCard): Promise<string | undefined> => {
    try {
      const gated = gate(await ports.capabilitySnapshot(new AbortController().signal), card);
      return gated.kind === "ready" ? gated.account : undefined;
    } catch {
      return undefined;
    }
  };

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
    let snapshot: GithubAuthenticationSnapshot;
    try {
      snapshot = await ports.capabilitySnapshot(signal);
    } catch {
      return { status: "unavailable", reason: "read-failed" };
    }
    const gated = gate(snapshot, input.card);
    if (gated.kind === "result") return gated.result;
    const account = gated.account;
    if (cacheAccount !== account) {
      cache.clear();
      cacheAccount = account;
    }
    if (ports.port === undefined) return { status: "unavailable", reason: "not-checked" };

    const repositories = (await ports.listRepositories(input.windowId)).filter((repository) =>
      ports.mayReadProject(input.windowId, repository.projectId),
    );
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
      const cacheKey = `${account}|${repositoryKey}|${input.card}|${since ?? "all"}|${until ?? "open"}`;
      const cached = cache.get(cacheKey);
      const fresh =
        cached !== undefined && !input.refresh && ports.now() - cached.storedAtMs < CACHE_TTL_MS
          ? cached
          : undefined;
      let observed: CachedRepositoryRead | undefined = fresh;
      if (observed === undefined) {
        const result = await ports.port.observe({
          owner: repository.repositoryOwner,
          name: repository.repositoryName,
          card: input.card,
          since,
          until,
          signal,
        });
        if (result.status === "ready" || result.status === "partial") {
          if (result.status === "partial" && result.reason === "repository-missing") {
            // A missing or forbidden repository is not temporary: every card
            // and window it ever answered is purged, so no formerly read rows
            // are served again under another timeframe.
            const prefix = `${account}|${repositoryKey}|`;
            for (const key of cache.keys()) {
              if (key.startsWith(prefix)) cache.delete(key);
            }
            partial = true;
            continue;
          }
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
        } else if (cached !== undefined) {
          // A refused transient refresh keeps the last good rows as partial
          // coverage with their own original observation time.
          observed = cached;
          partial = true;
          if (result.reason === "rate-limited") rateLimited = true;
        } else {
          // A repository that could not be read leaves coverage incomplete.
          partial = true;
          if (result.reason === "rate-limited") rateLimited = true;
          continue;
        }
      }
      if (observed.result.status === "partial") partial = true;
      if (checkedAt === undefined || observed.checkedAt < checkedAt) {
        checkedAt = observed.checkedAt;
      }
      for (const row of observed.result.rows) {
        // Only the signed-in person's own actions are their activity: an
        // observation by or about any other actor is not counted.
        const actor =
          row.kind === "prs-merged"
            ? row.mergedBy
            : row.kind === "issues-closed"
              ? row.closedBy
              : row.publishedBy;
        if (actor.toLowerCase() !== account) continue;
        const record = forgeRecordOf(row, repositoryKey);
        if (record === undefined) continue;
        records.push({ record, projectId: String(repository.projectId), repositoryKey });
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
    };
  };

  return { forgeRead, forgeAccount };
}

/**
 * Normalizes one observed forge row into a validated activity record; the
 * identity matches the journal's own `owner/name#number` form so the same
 * delivery cannot count twice across sources. Releases key on their stable
 * numeric release id, not the mutable tag.
 */
function forgeRecordOf(row: GhHomeActivityRow, repositoryKey: string): ActivityRecord | undefined {
  const [repositoryOwner, repositoryName] = repositoryKey.split("/");
  if (repositoryOwner === undefined || repositoryName === undefined) return undefined;
  // GitHub omits fractional seconds; the contract's timestamp form needs them.
  const instant = (value: string): string => new Date(value).toISOString();
  try {
    if (row.kind === "prs-merged") {
      return decodeActivityRecord({
        kind: "prs-merged",
        occurredAt: instant(row.mergedAt),
        id: `${repositoryKey}#${row.number}`,
        label: row.title === "" ? `${repositoryKey}#${row.number}` : row.title,
        repositoryOwner,
        repositoryName,
        number: row.number,
        mergedBy: row.mergedBy,
      });
    }
    if (row.kind === "issues-closed") {
      return decodeActivityRecord({
        kind: "issues-closed",
        occurredAt: instant(row.closedAt),
        id: `${repositoryKey}#${row.number}`,
        label: row.title === "" ? `${repositoryKey}#${row.number}` : row.title,
        repositoryOwner,
        repositoryName,
        number: row.number,
      });
    }
    if (!isCanonicalReleaseHref(row.url, repositoryKey)) return undefined;
    return decodeActivityRecord({
      kind: "releases-published",
      occurredAt: instant(row.publishedAt),
      id: `${repositoryKey}/releases/${row.releaseId}`,
      label: row.name === "" ? row.tag : row.name,
      tag: row.tag,
      url: row.url,
    });
  } catch {
    return undefined;
  }
}

/**
 * A release link is trusted only when it is a canonical github.com release
 * tag URL for the authorized repository: exact https host, no credentials,
 * and an `/{owner}/{repo}/releases/tag/…` path. Anything else — an
 * attacker-influenced or third-party URL — is dropped, never shown.
 */
function isCanonicalReleaseHref(url: string, repositoryKey: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return false;
  }
  const prefix = `/${repositoryKey}/releases/tag/`;
  const path = parsed.pathname.toLowerCase();
  return path.startsWith(prefix) && path.length > prefix.length;
}
