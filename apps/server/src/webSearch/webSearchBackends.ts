import type {
  WebSearchBackendEntry,
  WebSearchBackendFailure,
  WebSearchCallRouted,
} from "@octant/contracts";
import { WEB_SEARCH_BACKEND_OFFERS } from "@octant/domain";
import {
  SearxngClient,
  SearxngSearchFailed,
  type SearxngFetch,
} from "../chat/research/searxngClient";
import { searchVendor, VendorSearchFailed } from "./vendorBackends";

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchInput {
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface WebSearchAnswer {
  readonly query: string;
  readonly backend: "searxng";
  readonly results: ReadonlyArray<WebSearchResult>;
}

/** No eligible backend answered: every one failed, or none may receive the query. */
export class WebSearchUnavailable extends Error {
  constructor() {
    super("No web search backend answered this query.");
    this.name = "WebSearchUnavailable";
  }
}

export class WebSearchInterrupted extends Error {
  constructor() {
    super("The web search was interrupted.");
    this.name = "WebSearchInterrupted";
  }
}

/**
 * One call's budget inside the turn's own cancellation, and each backend's
 * share of it. Rationale: a per-backend timeout alone lets three slow backends
 * hold a turn for most of a minute; 15 seconds is SearXNG's own timeout.
 */
export const WEB_SEARCH_CALL_BUDGET_MS = 20_000;
export const WEB_SEARCH_BACKEND_TIMEOUT_MS = 15_000;

export interface WebSearchRouting {
  readonly backends: ReadonlyArray<WebSearchBackendEntry>;
  readonly search: WebSearchInput;
  /** The entry's API key from the credential broker, or undefined when none is stored. */
  readonly resolveKey?: (entry: WebSearchBackendEntry) => Promise<string | undefined>;
  /** Told where the query went, answered or not, so it can be journaled. */
  readonly onRouted?: (routed: Omit<WebSearchCallRouted, "kind" | "routedAt">) => void;
  readonly fetch?: SearxngFetch;
  readonly budgetMs?: number;
  readonly backendTimeoutMs?: number;
  readonly now?: () => number;
}

type BackendOutcome =
  | { readonly kind: "answered"; readonly results: ReadonlyArray<WebSearchResult> }
  | { readonly kind: "failed"; readonly failure: WebSearchBackendFailure };

function searxngFailure(error: SearxngSearchFailed): WebSearchBackendFailure {
  if (error.category === "timeout") return "timeout";
  if (error.category === "invalid-query") return "refused-query";
  // SearXNG reports an unreachable instance, an HTTP error, and an unreadable
  // body alike; none of them is an answer.
  return error.category === "unavailable" ? "network" : "server-error";
}

/**
 * The entry's key, or undefined once `signal` aborts: the broker's own fetch
 * has no deadline, so the backend's timer and the turn's cancellation bound
 * the wait here instead.
 */
async function keyWithin(
  routing: WebSearchRouting,
  entry: WebSearchBackendEntry,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  let onAbort = () => {};
  const stopped = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      (routing.resolveKey?.(entry) ?? Promise.resolve(undefined)).catch(() => undefined),
      stopped,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function searchOne(
  entry: WebSearchBackendEntry,
  routing: WebSearchRouting,
  timeoutMs: number,
): Promise<BackendOutcome> {
  const offer = WEB_SEARCH_BACKEND_OFFERS[entry.kind];
  // The backend's time starts before its key is read: a broker that is slow
  // to answer spends this backend's share of the budget, not the turn's.
  const lifecycle = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    lifecycle.abort();
  }, timeoutMs);
  const onCallerAbort = () => lifecycle.abort();
  routing.search.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const search = {
    query: routing.search.query,
    limit: routing.search.limit,
    signal: lifecycle.signal,
  };
  try {
    let key: string | undefined;
    if (offer.takesKey) {
      key = await keyWithin(routing, entry, lifecycle.signal);
      // The turn may have stopped while the broker answered; nothing is sent then.
      if (routing.search.signal?.aborted === true) throw new WebSearchInterrupted();
      if (timedOut) return { kind: "failed", failure: "timeout" };
      if (key === undefined) return { kind: "failed", failure: "needs-key" };
    }
    if (entry.kind === "searxng") {
      if (entry.address === undefined) return { kind: "failed", failure: "server-error" };
      const found = await new SearxngClient({
        baseUrl: entry.address,
        ...(routing.fetch === undefined ? {} : { fetch: routing.fetch }),
      }).search(search);
      return { kind: "answered", results: found.results };
    }
    const results = await searchVendor({
      kind: entry.kind,
      ...(entry.address === undefined ? {} : { address: entry.address }),
      key: key ?? "",
      search,
      ...(routing.fetch === undefined ? {} : { fetch: routing.fetch }),
    });
    return { kind: "answered", results };
  } catch (error) {
    if (routing.search.signal?.aborted === true) throw new WebSearchInterrupted();
    if (timedOut) return { kind: "failed", failure: "timeout" };
    if (error instanceof VendorSearchFailed) return { kind: "failed", failure: error.failure };
    if (error instanceof SearxngSearchFailed)
      return { kind: "failed", failure: searxngFailure(error) };
    return { kind: "failed", failure: "network" };
  } finally {
    clearTimeout(timer);
    routing.search.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Search the eligible backends for one query, in the person's order. A query
 * moves on only when a backend did not answer: a network error, a timeout, a
 * rate limit, a server error, or a refused or missing key. An empty result is
 * an answer and stops, so a query reaches no more vendors than it has to; so
 * does a vendor's refusal of the query itself. Each backend gets the time left
 * in the call's budget, at most its own timeout; one the budget does not reach
 * is recorded as not tried.
 */
export async function searchWebSearchBackends(routing: WebSearchRouting): Promise<WebSearchAnswer> {
  const now = routing.now ?? Date.now;
  const deadline = now() + (routing.budgetMs ?? WEB_SEARCH_CALL_BUDGET_MS);
  const backendTimeout = routing.backendTimeoutMs ?? WEB_SEARCH_BACKEND_TIMEOUT_MS;
  const failed: Array<WebSearchCallRouted["failed"][number]> = [];
  const report = (answeredBy?: WebSearchBackendEntry) =>
    routing.onRouted?.({
      ...(answeredBy === undefined
        ? {}
        : { answeredBy: { entryId: answeredBy.id, backend: answeredBy.kind } }),
      failed,
    });
  let stopped = false;
  for (const entry of routing.backends) {
    if (routing.search.signal?.aborted === true) {
      report();
      throw new WebSearchInterrupted();
    }
    const remaining = deadline - now();
    if (stopped || remaining <= 0) {
      failed.push({ entryId: entry.id, backend: entry.kind, failure: "not-tried" });
      continue;
    }
    let outcome: BackendOutcome;
    try {
      outcome = await searchOne(entry, routing, Math.min(backendTimeout, remaining));
    } catch (error) {
      // The backends already asked are journaled even when the turn stops.
      if (error instanceof WebSearchInterrupted) report();
      throw error;
    }
    if (outcome.kind === "answered") {
      report(entry);
      return { query: routing.search.query, backend: "searxng", results: outcome.results };
    }
    failed.push({ entryId: entry.id, backend: entry.kind, failure: outcome.failure });
    if (outcome.failure === "refused-query") stopped = true;
  }
  report();
  throw new WebSearchUnavailable();
}
