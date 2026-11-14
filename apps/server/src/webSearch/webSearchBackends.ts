import type { WebSearchBackendEntry } from "@octant/contracts";
import { SearxngClient, type SearxngFetch } from "../chat/research/searxngClient";

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
  readonly backend: "octant";
  readonly results: ReadonlyArray<WebSearchResult>;
}

export class WebSearchUnavailable extends Error {
  constructor() {
    super("No web search backend may receive this query.");
    this.name = "WebSearchUnavailable";
  }
}

/**
 * Search the eligible backends for one query. The list is the one the data
 * policy left, in the person's order; it is read by the caller for each call,
 * since a turn may outlive the settings it started with.
 */
export async function searchWebSearchBackends(input: {
  readonly backends: ReadonlyArray<WebSearchBackendEntry>;
  readonly search: WebSearchInput;
  readonly fetch?: SearxngFetch;
}): Promise<WebSearchAnswer> {
  const first = input.backends[0];
  if (first === undefined || first.address === undefined) throw new WebSearchUnavailable();
  const found = await new SearxngClient({
    baseUrl: first.address,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  }).search(input.search);
  return {
    query: found.query,
    backend: "octant",
    results: found.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
  };
}
