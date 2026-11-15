import type { WebSearchBackendFailure, WebSearchBackendKind } from "@octant/contracts";
import type { SearxngFetch } from "../chat/research/searxngClient";
import { validateSearxngEndpoint } from "../chat/research/searxngEndpoint";

/**
 * The search APIs of the vendors Octant's own `web-search` can send a query to.
 * Each request carries only the query, the result count, and the person's key;
 * each answer is read into `{ title, url, snippet }` and nothing else.
 *
 * Where each shape was read from (checked 2026-11-14; the vendors' own
 * documentation sites were not reachable from the build environment, so the
 * shapes come from each vendor's official client or from two published
 * integrations that call the API):
 * - Brave Search: GET `api.search.brave.com/res/v1/web/search?q=&count=`,
 *   `X-Subscription-Token`, `web.results[].{title,url,description}`, at most
 *   20 per request (Brave's API reference, quoted in search results; Brave's
 *   own MCP search server).
 * - Exa: POST `api.exa.ai/search` `{ query, numResults, contents }`,
 *   `x-api-key`, `results[].{title,url,highlights}` (Exa's official `exa-js`
 *   client, 2.28.0).
 * - Linkup: POST `api.linkup.so/v1/search` `{ q, depth, outputType:
 *   "searchResults", maxResults }`, `Authorization: Bearer`,
 *   `results[].{type,name,url,content}` (Linkup's official `linkup-sdk`, 3.7.2).
 * - Mojeek: GET `api.mojeek.com/search?q=&api_key=&fmt=json&t=`,
 *   `response.results[].{title,url,desc}` (Mojeek's quickstart for the
 *   endpoint and parameters; two published integrations for the result
 *   fields, which Mojeek's own reference was not read for). Mojeek takes its
 *   key in the query string, so this URL is never logged.
 * - Staan: GET `api.staan.ai/v2/search/web?q=`, `Authorization: Bearer`,
 *   `web.results[].{title,url,snippet}` (one published integration; Staan's
 *   own reference was not read). Its result count parameter is not known, so
 *   the count is applied here.
 */

export const MAX_VENDOR_RESPONSE_BYTES = 1_048_576;
const USER_AGENT = "Octant Research";

export class VendorSearchFailed extends Error {
  readonly failure: WebSearchBackendFailure;

  constructor(failure: WebSearchBackendFailure) {
    super(`The search vendor did not answer (${failure}).`);
    this.name = "VendorSearchFailed";
    this.failure = failure;
  }
}

export interface VendorSearchRequest {
  readonly kind: Exclude<WebSearchBackendKind, "searxng">;
  /** An agreed regional host, for a vendor that has one. */
  readonly address?: string;
  readonly key: string;
  readonly search: { readonly query: string; readonly limit: number; readonly signal: AbortSignal };
  readonly fetch?: SearxngFetch;
}

interface VendorResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/<[^>]*>/g, "").trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, maximum);
}

function pageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Read each candidate into a result, dropping any without a title or a web address. */
function results(
  candidates: unknown,
  limit: number,
  read: (entry: Readonly<Record<string, unknown>>) => {
    readonly title: unknown;
    readonly url: unknown;
    readonly snippet: unknown;
  },
): ReadonlyArray<VendorResult> {
  if (!Array.isArray(candidates)) throw new VendorSearchFailed("server-error");
  const seen = new Set<string>();
  const found: VendorResult[] = [];
  for (const candidate of candidates) {
    if (found.length >= limit) break;
    const entry = record(candidate);
    if (entry === undefined) continue;
    const fields = read(entry);
    const title = text(fields.title, 256);
    const url = pageUrl(fields.url);
    if (title === undefined || url === undefined || seen.has(url)) continue;
    seen.add(url);
    found.push({ title, url, snippet: text(fields.snippet, 2_048) ?? "" });
  }
  return found;
}

export function failureForStatus(status: number): WebSearchBackendFailure {
  if (status === 401 || status === 403) return "key-refused";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  return "refused-query";
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_VENDOR_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new VendorSearchFailed("server-error");
  }
  if (response.body === null) throw new VendorSearchFailed("server-error");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_VENDOR_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new VendorSearchFailed("server-error");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw new VendorSearchFailed("timeout");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new VendorSearchFailed("server-error");
  }
}

interface PreparedRequest {
  readonly url: URL;
  readonly init: RequestInit;
  readonly read: (payload: unknown, limit: number) => ReadonlyArray<VendorResult>;
}

function prepare(request: VendorSearchRequest, limit: number): PreparedRequest {
  const { query } = request.search;
  const json = { accept: "application/json", "user-agent": USER_AGENT };
  switch (request.kind) {
    case "brave": {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(limit, 20)));
      return {
        url,
        init: { method: "GET", headers: { ...json, "x-subscription-token": request.key } },
        read: (payload, max) =>
          results(record(record(payload)?.web)?.results, max, (entry) => ({
            title: entry.title,
            url: entry.url,
            snippet: entry.description,
          })),
      };
    }
    case "exa":
      return {
        url: new URL("https://api.exa.ai/search"),
        init: {
          method: "POST",
          headers: { ...json, "content-type": "application/json", "x-api-key": request.key },
          body: JSON.stringify({ query, numResults: limit, contents: { highlights: true } }),
        },
        read: (payload, max) =>
          results(record(payload)?.results, max, (entry) => ({
            title: entry.title,
            url: entry.url,
            snippet: Array.isArray(entry.highlights)
              ? entry.highlights.filter((part) => typeof part === "string").join(" … ")
              : undefined,
          })),
      };
    case "linkup": {
      const base =
        request.address === undefined
          ? new URL("https://api.linkup.so/v1/")
          : validateSearxngEndpoint(request.address);
      return {
        url: new URL("search", base),
        init: {
          method: "POST",
          headers: {
            ...json,
            "content-type": "application/json",
            authorization: `Bearer ${request.key}`,
          },
          body: JSON.stringify({
            q: query,
            depth: "standard",
            outputType: "searchResults",
            maxResults: limit,
          }),
        },
        read: (payload, max) =>
          results(
            (record(payload)?.results as ReadonlyArray<unknown> | undefined)?.filter(
              (entry) => record(entry)?.type === "text",
            ),
            max,
            (entry) => ({ title: entry.name, url: entry.url, snippet: entry.content }),
          ),
      };
    }
    case "mojeek": {
      const url = new URL("https://api.mojeek.com/search");
      url.searchParams.set("q", query);
      url.searchParams.set("api_key", request.key);
      url.searchParams.set("fmt", "json");
      url.searchParams.set("t", String(limit));
      return {
        url,
        init: { method: "GET", headers: json },
        read: (payload, max) =>
          results(record(record(payload)?.response)?.results, max, (entry) => ({
            title: entry.title,
            url: entry.url,
            snippet: entry.desc,
          })),
      };
    }
    case "staan": {
      const url = new URL("https://api.staan.ai/v2/search/web");
      url.searchParams.set("q", query);
      return {
        url,
        init: { method: "GET", headers: { ...json, authorization: `Bearer ${request.key}` } },
        read: (payload, max) =>
          results(record(record(payload)?.web)?.results, max, (entry) => ({
            title: entry.title,
            url: entry.url,
            snippet: entry.snippet,
          })),
      };
    }
  }
}

export async function searchVendor(
  request: VendorSearchRequest,
): Promise<ReadonlyArray<VendorResult>> {
  const limit = Math.min(Math.max(1, Math.floor(request.search.limit)), 10);
  const prepared = prepare(request, limit);
  const fetchImpl = request.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(prepared.url, {
      ...prepared.init,
      // A vendor's API never redirects a search; following one could hand the
      // key to another host.
      redirect: "error",
      cache: "no-store",
      signal: request.search.signal,
    });
  } catch {
    throw new VendorSearchFailed(request.search.signal.aborted ? "timeout" : "network");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new VendorSearchFailed(failureForStatus(response.status));
  }
  return prepared.read(await readJson(response, request.search.signal), limit);
}
