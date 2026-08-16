import { validateSearxngEndpoint, validateSearxngRedirectTarget } from "./searxngEndpoint";

export const MAX_SEARXNG_QUERY_LENGTH = 4_096;
export const MAX_SEARXNG_RESULT_LIMIT = 10;
export const MAX_SEARXNG_RESPONSE_BODY_BYTES = 1_048_576;
export const SEARXNG_REQUEST_TIMEOUT_MS = 15_000;
export const SEARXNG_USER_AGENT = "Octant Research";

export type SearxngFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface ResearchResultSet {
  readonly query: string;
  readonly backend: "searxng";
  readonly results: ReadonlyArray<ResearchResult>;
}

export type SearxngSearchFailureCategory =
  | "invalid-query"
  | "invalid-endpoint"
  | "protocol"
  | "unavailable"
  | "timeout"
  | "interrupted";

export class SearxngSearchFailed extends Error {
  readonly category: SearxngSearchFailureCategory;

  constructor(category: SearxngSearchFailureCategory, message: string) {
    super(message);
    this.name = "SearxngSearchFailed";
    this.category = category;
  }
}

export interface SearxngSearchInput {
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface SearxngClientOptions {
  readonly baseUrl: string;
  readonly fetch?: SearxngFetch;
}

function fail(category: SearxngSearchFailureCategory, message: string): never {
  throw new SearxngSearchFailed(category, message);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function boundedString(value: unknown, maximum = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).length <= maximum ? normalized : undefined;
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function isJsonMediaType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"))
  );
}

function canonicalizeResultUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  url.hash = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function normalizeResults(candidates: unknown, limit: number): ReadonlyArray<ResearchResult> {
  if (!Array.isArray(candidates)) {
    fail("protocol", "SearXNG returned an invalid results payload.");
  }

  const seen = new Set<string>();
  const results: ResearchResult[] = [];
  for (const candidate of candidates) {
    if (results.length >= limit) break;
    const entry = record(candidate);
    const title = boundedString(entry?.title, 256);
    const rawUrl = boundedString(entry?.url, 2_048);
    const rawSnippet = boundedString(entry?.content ?? entry?.snippet, 2_048);
    if (title === undefined || rawUrl === undefined || rawSnippet === undefined) continue;

    const url = canonicalizeResultUrl(rawUrl);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: stripMarkup(rawSnippet) });
  }

  return results;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((error: DOMException) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(new DOMException("Aborted", "AbortError"));
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), abortPromise]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        fail("protocol", "The SearXNG response exceeded the size limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may settle a pending read after this cleanup path starts.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJsonBody(body: Uint8Array): unknown {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    fail("protocol", "SearXNG returned a non-JSON response.");
  }
}

function resolveRedirectLocation(response: Response, currentUrl: URL): URL {
  const location = response.headers.get("location");
  if (location === null || location.trim().length === 0) {
    fail("protocol", "SearXNG returned a redirect without a location.");
  }
  try {
    return validateSearxngRedirectTarget(new URL(location, currentUrl));
  } catch {
    fail("invalid-endpoint", "SearXNG redirected to an invalid endpoint.");
  }
}

export class SearxngClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: SearxngFetch;

  constructor(options: SearxngClientOptions) {
    this.baseUrl = validateSearxngEndpoint(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async search(input: SearxngSearchInput): Promise<ResearchResultSet> {
    const query = input.query.trim();
    if (query.length === 0 || Array.from(query).length > MAX_SEARXNG_QUERY_LENGTH) {
      fail("invalid-query", "The SearXNG query exceeded the allowed length.");
    }

    const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit) : 1;
    const limit = Math.min(Math.max(1, requestedLimit), MAX_SEARXNG_RESULT_LIMIT);
    const searchUrl = new URL("search", this.baseUrl);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("language", "auto");

    if (isAborted(input.signal)) {
      fail("interrupted", "The SearXNG request was interrupted.");
    }
    const lifecycle = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => lifecycle.abort();
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      lifecycle.abort();
    }, SEARXNG_REQUEST_TIMEOUT_MS);

    try {
      const response = await this.request(searchUrl, lifecycle.signal);
      const contentType = response.headers.get("content-type") ?? "";
      if (!isJsonMediaType(contentType)) {
        await cancelResponseBody(response);
        fail("protocol", "SearXNG returned a non-JSON response.");
      }

      const body = await readBoundedBody(
        response,
        MAX_SEARXNG_RESPONSE_BODY_BYTES,
        lifecycle.signal,
      );
      const payload = record(parseJsonBody(body));
      return {
        query,
        backend: "searxng",
        results: normalizeResults(payload?.results, limit),
      };
    } catch (error) {
      if (timedOut) {
        fail("timeout", "The SearXNG request timed out.");
      }
      if (isAborted(input.signal)) {
        fail("interrupted", "The SearXNG request was interrupted.");
      }
      if (error instanceof SearxngSearchFailed) {
        throw error;
      }
      fail("unavailable", "The SearXNG response could not be read.");
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onCallerAbort);
    }

    fail("unavailable", "The SearXNG response could not be read.");
  }

  private async request(url: URL, callerSignal: AbortSignal): Promise<Response> {
    if (isAborted(callerSignal)) {
      fail("interrupted", "The SearXNG request was interrupted.");
    }

    let rejectAbort: ((error: SearxngSearchFailed) => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onCallerAbort = () => {
      rejectAbort?.(new SearxngSearchFailed("interrupted", "The SearXNG request was interrupted."));
    };
    if (isAborted(callerSignal)) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      let currentUrl = url;
      for (let redirects = 0; redirects < 5; redirects += 1) {
        const fetchPromise = this.fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          headers: {
            accept: "application/json",
            "user-agent": SEARXNG_USER_AGENT,
          },
          signal: callerSignal,
        });

        let response: Response;
        try {
          response = await Promise.race([fetchPromise, abortPromise]);
        } catch (error) {
          if (error instanceof SearxngSearchFailed) throw error;
          if (isAborted(callerSignal)) {
            fail("interrupted", "The SearXNG request was interrupted.");
          }
          fail("unavailable", "The SearXNG endpoint could not be reached.");
        }

        if (response.status >= 300 && response.status < 400) {
          currentUrl = resolveRedirectLocation(response, currentUrl);
          await cancelResponseBody(response);
          continue;
        }

        if (!response.ok) {
          await cancelResponseBody(response);
          fail("unavailable", `The SearXNG request failed with HTTP ${response.status}.`);
        }

        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_SEARXNG_RESPONSE_BODY_BYTES) {
          await cancelResponseBody(response);
          fail("protocol", "The SearXNG response exceeded the size limit.");
        }

        return response;
      }
    } finally {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }

    fail("protocol", "SearXNG returned too many redirects.");
  }
}
