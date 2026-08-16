import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SEARXNG_QUERY_LENGTH,
  MAX_SEARXNG_RESULT_LIMIT,
  SEARXNG_USER_AGENT,
  SearxngClient,
  SearxngSearchFailed,
} from "./searxngClient";

const baseUrl = "http://127.0.0.1:8080/";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SearxngClient.search", () => {
  it("calls /search with bounded query params and the Octant user agent", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${baseUrl}search?q=Octant&format=json&language=auto`);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json", "user-agent": SEARXNG_USER_AGENT },
      });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Octant",
              url: "https://example.com/octant",
              content: "Local-first workspace.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new SearxngClient({ baseUrl, fetch });
    const signal = AbortSignal.timeout(5_000);

    await expect(client.search({ query: "Octant", limit: 5, signal })).resolves.toEqual({
      query: "Octant",
      backend: "searxng",
      results: [
        {
          title: "Octant",
          url: "https://example.com/octant",
          snippet: "Local-first workspace.",
        },
      ],
    });
  });

  it("rejects queries longer than 4,096 characters", async () => {
    const client = new SearxngClient({ baseUrl, fetch: vi.fn() });
    const query = "a".repeat(MAX_SEARXNG_QUERY_LENGTH + 1);

    await expect(
      client.search({ query, limit: 5, signal: AbortSignal.timeout(1_000) }),
    ).rejects.toThrow(SearxngSearchFailed);
  });

  it("caps result limits to 10", async () => {
    const results = Array.from({ length: MAX_SEARXNG_RESULT_LIMIT + 5 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      content: `Snippet ${index + 1}`,
    }));
    let requestUrl = "";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new SearxngClient({ baseUrl, fetch });

    const result = await client.search({
      query: "Octant",
      limit: MAX_SEARXNG_RESULT_LIMIT + 5,
      signal: AbortSignal.timeout(1_000),
    });

    expect(requestUrl).toBe(`${baseUrl}search?q=Octant&format=json&language=auto`);
    expect(result.results).toHaveLength(MAX_SEARXNG_RESULT_LIMIT);
  });

  it("keeps non-finite result limits bounded", async () => {
    const results = Array.from({ length: MAX_SEARXNG_RESULT_LIMIT + 5 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      content: `Snippet ${index + 1}`,
    }));
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new SearxngClient({ baseUrl, fetch });

    const result = await client.search({ query: "Octant", limit: Number.NaN });

    expect(result.results.length).toBeLessThanOrEqual(MAX_SEARXNG_RESULT_LIMIT);
  });

  it("revalidates redirect targets with endpoint policy", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://search.example/redirected" },
      }),
    );
    const client = new SearxngClient({ baseUrl, fetch });

    await expect(
      client.search({ query: "Octant", limit: 5, signal: AbortSignal.timeout(1_000) }),
    ).rejects.toMatchObject({ category: "invalid-endpoint" });
  });

  it("follows a validated redirect before parsing JSON", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/search" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Octant",
                url: "https://example.com/octant",
                content: "Local-first workspace.",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new SearxngClient({ baseUrl, fetch });

    await expect(
      client.search({ query: "Octant", limit: 5, signal: AbortSignal.timeout(1_000) }),
    ).resolves.toMatchObject({
      results: [
        {
          title: "Octant",
          url: "https://example.com/octant",
          snippet: "Local-first workspace.",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toBe("http://127.0.0.1:8080/search");
  });

  it("rejects non-JSON and oversize bodies safely", async () => {
    const htmlFetch = vi.fn(
      async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const htmlClient = new SearxngClient({ baseUrl, fetch: htmlFetch });
    await expect(
      htmlClient.search({ query: "Octant", limit: 5, signal: AbortSignal.timeout(1_000) }),
    ).rejects.toMatchObject({ category: "protocol" });

    const misleadingMediaTypeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "text/application/json-example" },
        }),
    );
    const misleadingMediaTypeClient = new SearxngClient({
      baseUrl,
      fetch: misleadingMediaTypeFetch,
    });
    await expect(
      misleadingMediaTypeClient.search({ query: "Octant", limit: 5 }),
    ).rejects.toMatchObject({ category: "protocol" });

    const oversizedFetch = vi.fn(
      async () =>
        new Response("x".repeat(1_048_577), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const oversizedClient = new SearxngClient({ baseUrl, fetch: oversizedFetch });
    await expect(
      oversizedClient.search({ query: "Octant", limit: 5, signal: AbortSignal.timeout(1_000) }),
    ).rejects.toMatchObject({ category: "protocol" });
  });

  it("normalizes HTTP(S) URLs, strips markup, deduplicates, and never fetches result pages", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "First",
                url: "https://example.com/path/",
                content: "<b>One</b>",
              },
              {
                title: "Duplicate",
                url: "https://example.com/path",
                content: "<i>Two</i>",
              },
              {
                title: "FTP",
                url: "ftp://example.com/file",
                content: "ignored",
              },
              {
                title: "Fetch me",
                url: "https://other.example/page",
                content: "Three",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new SearxngClient({ baseUrl, fetch });

    const result = await client.search({
      query: "Octant",
      limit: 10,
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.results).toEqual([
      { title: "First", url: "https://example.com/path", snippet: "One" },
      { title: "Fetch me", url: "https://other.example/page", snippet: "Three" },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("times out after 15 seconds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const client = new SearxngClient({ baseUrl, fetch });
    const pending = client.search({
      query: "Octant",
      limit: 5,
      signal: AbortSignal.timeout(60_000),
    });

    const assertion = expect(pending).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("times out while a response body stalls after headers arrive", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new SearxngClient({ baseUrl, fetch });
    const pending = client.search({
      query: "Octant",
      limit: 5,
      signal: AbortSignal.timeout(60_000),
    });

    const assertion = expect(pending).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("honors caller abort", async () => {
    const fetch = vi.fn(
      (_input, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const client = new SearxngClient({ baseUrl, fetch });
    const controller = new AbortController();
    const pending = client.search({
      query: "Octant",
      limit: 5,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "interrupted" });
  });

  it("honors caller abort while reading a response body", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new SearxngClient({ baseUrl, fetch });
    const controller = new AbortController();
    const pending = client.search({ query: "Octant", limit: 5, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    controller.abort();

    await expect(pending).rejects.toMatchObject({ category: "interrupted" });
  });
});
