import type { WebSearchBackendEntry } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  WebSearchInterrupted,
  WebSearchUnavailable,
  searchWebSearchBackends,
  type WebSearchRouting,
} from "./webSearchBackends";

type Fetch = NonNullable<WebSearchRouting["fetch"]>;

function entry(
  n: number,
  kind: WebSearchBackendEntry["kind"],
  address?: string,
): WebSearchBackendEntry {
  return {
    id: `00000000-0000-4000-8000-0000000000e${n}` as WebSearchBackendEntry["id"],
    kind,
    ...(address === undefined ? {} : { address }),
    ...(kind === "searxng" ? {} : { credentialRef: `00000000-0000-4000-8000-0000000000f${n}` }),
    enabled: true,
    statesZdr: false,
    statesEuProcessing: false,
  };
}

const searx = entry(1, "searxng", "https://one.search.example/");
const searxTwo = entry(2, "searxng", "https://two.search.example/");
const brave = entry(3, "brave");

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

const answer = (title: string) =>
  Response.json({ results: [{ title, url: `https://example.com/${title}`, content: "text" }] });

function route(
  backends: ReadonlyArray<WebSearchBackendEntry>,
  fetch: Fetch,
  extra: Partial<WebSearchRouting> = {},
) {
  const routed: Array<Parameters<NonNullable<WebSearchRouting["onRouted"]>>[0]> = [];
  const run = searchWebSearchBackends({
    backends,
    search: { query: "octant", limit: 5 },
    resolveKey: async () => "key",
    fetch,
    onRouted: (record) => routed.push(record),
    ...extra,
  });
  return { run, routed };
}

describe("web search fallback", () => {
  it("moves to the next backend when one does not answer, and records why", async () => {
    const fetch = vi.fn<Fetch>(async (input) =>
      urlOf(input).startsWith("https://one.")
        ? new Response("down", { status: 503 })
        : answer("two"),
    );
    const { run, routed } = route([searx, searxTwo], fetch);
    expect((await run).results.map((result) => result.title)).toEqual(["two"]);
    expect(routed).toEqual([
      {
        answeredBy: { entryId: searxTwo.id, backend: "searxng" },
        failed: [{ entryId: searx.id, backend: "searxng", failure: "network" }],
      },
    ]);
  });

  it("treats an empty result as an answer and sends the query to no other backend", async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ results: [] }));
    const { run, routed } = route([searx, searxTwo], fetch);
    expect((await run).results).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(routed[0]?.answeredBy?.entryId).toBe(searx.id);
  });

  it("moves on from a rate limit and a refused key, and stops at a vendor's refusal of the query", async () => {
    const statuses = [429, 401, 400];
    const vendors = [entry(4, "exa"), entry(5, "staan"), entry(6, "mojeek"), searx];
    const fetch = vi.fn<Fetch>(async () => new Response("{}", { status: statuses.shift() ?? 200 }));
    const { run, routed } = route(vendors, fetch);
    await expect(run).rejects.toBeInstanceOf(WebSearchUnavailable);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(routed[0]?.failed.map((failed) => failed.failure)).toEqual([
      "rate-limited",
      "key-refused",
      "refused-query",
      "not-tried",
    ]);
  });

  it("skips a vendor with no stored key without sending it anything", async () => {
    const fetch = vi.fn<Fetch>(async () => answer("searx"));
    const { run, routed } = route([brave, searx], fetch, { resolveKey: async () => undefined });
    expect((await run).results).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(urlOf(fetch.mock.calls[0]?.[0] ?? "")).toMatch(/^https:\/\/one\./);
    expect(routed[0]?.failed).toEqual([
      { entryId: brave.id, backend: "brave", failure: "needs-key" },
    ]);
  });

  it("times a slow backend out at its share of the budget and moves on", async () => {
    const fetch = vi.fn<Fetch>(async (input, init) => {
      if (urlOf(input).startsWith("https://one.")) {
        return await new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
      return answer("two");
    });
    const { run, routed } = route([searx, searxTwo], fetch, { backendTimeoutMs: 20 });
    expect((await run).results.map((result) => result.title)).toEqual(["two"]);
    expect(routed[0]?.failed).toEqual([
      { entryId: searx.id, backend: "searxng", failure: "timeout" },
    ]);
  });

  it("records a backend the call's budget did not reach as not tried", async () => {
    const times = [0, 0, 20_000];
    const fetch = vi.fn<Fetch>(async () => new Response("down", { status: 500 }));
    const { run, routed } = route([searx, searxTwo], fetch, { now: () => times.shift() ?? 20_000 });
    await expect(run).rejects.toBeInstanceOf(WebSearchUnavailable);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(routed[0]?.failed.map((failed) => failed.failure)).toEqual(["network", "not-tried"]);
  });

  it("stops at once when the turn is cancelled", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<Fetch>(async (_input, init) => {
      controller.abort();
      throw init?.signal?.reason ?? new Error("aborted");
    });
    const run = searchWebSearchBackends({
      backends: [searx, searxTwo],
      search: { query: "octant", limit: 5, signal: controller.signal },
      fetch,
    });
    await expect(run).rejects.toBeInstanceOf(WebSearchInterrupted);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends no query when the turn is cancelled while a key is being read, and records what was tried", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<Fetch>(async () => new Response("down", { status: 503 }));
    const { run, routed } = route([searx, brave, searxTwo], fetch, {
      search: { query: "octant", limit: 5, signal: controller.signal },
      resolveKey: async () => {
        controller.abort();
        return "key";
      },
    });
    await expect(run).rejects.toBeInstanceOf(WebSearchInterrupted);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(routed).toEqual([
      { failed: [{ entryId: searx.id, backend: "searxng", failure: "network" }] },
    ]);
  });

  it("sends nothing when the turn was cancelled before the search began", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn<Fetch>(async () => answer("one"));
    const { run, routed } = route([searx], fetch, {
      search: { query: "octant", limit: 5, signal: controller.signal },
    });
    await expect(run).rejects.toBeInstanceOf(WebSearchInterrupted);
    expect(fetch).not.toHaveBeenCalled();
    expect(routed).toEqual([{ failed: [] }]);
  });
});

describe("search vendors", () => {
  it("asks each vendor's API for the query alone and reads its results into title, URL and snippet", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const payloads: Record<string, unknown> = {
      "api.search.brave.com": {
        web: {
          results: [{ title: "B", url: "https://b.example/", description: "<strong>b</strong>" }],
        },
      },
      "api.exa.ai": {
        results: [{ title: "E", url: "https://e.example/", highlights: ["e1", "e2"] }],
      },
      "api.linkup.so": {
        results: [
          { type: "image", name: "skip", url: "https://img.example/" },
          { type: "text", name: "L", url: "https://l.example/", content: "l" },
        ],
      },
      "api.mojeek.com": {
        response: { results: [{ title: "M", url: "https://m.example/", desc: "m" }] },
      },
      "api.staan.ai": {
        web: { results: [{ title: "S", url: "https://s.example/", snippet: "s" }] },
      },
    };
    const fetch = vi.fn<Fetch>(async (input, init) => {
      const url = urlOf(input);
      seen.push({ url, init });
      return Response.json(payloads[new URL(url).hostname]);
    });
    const found: Record<string, unknown> = {};
    for (const [n, kind] of (["brave", "exa", "linkup", "mojeek", "staan"] as const).entries()) {
      const result = await searchWebSearchBackends({
        backends: [entry(n, kind)],
        search: { query: "octant", limit: 3 },
        resolveKey: async () => `${kind}-key`,
        fetch,
      });
      found[kind] = result.results;
    }
    expect(found).toEqual({
      brave: [{ title: "B", url: "https://b.example/", snippet: "b" }],
      exa: [{ title: "E", url: "https://e.example/", snippet: "e1 … e2" }],
      linkup: [{ title: "L", url: "https://l.example/", snippet: "l" }],
      mojeek: [{ title: "M", url: "https://m.example/", snippet: "m" }],
      staan: [{ title: "S", url: "https://s.example/", snippet: "s" }],
    });
    const [braveCall, exaCall, linkupCall, mojeekCall, staanCall] = seen;
    expect(braveCall?.url).toBe("https://api.search.brave.com/res/v1/web/search?q=octant&count=3");
    expect(braveCall?.init?.headers).toMatchObject({ "x-subscription-token": "brave-key" });
    expect(exaCall?.url).toBe("https://api.exa.ai/search");
    expect(JSON.parse(String(exaCall?.init?.body))).toEqual({
      query: "octant",
      numResults: 3,
      contents: { highlights: true },
    });
    expect(exaCall?.init?.headers).toMatchObject({ "x-api-key": "exa-key" });
    expect(linkupCall?.url).toBe("https://api.linkup.so/v1/search");
    expect(JSON.parse(String(linkupCall?.init?.body))).toEqual({
      q: "octant",
      depth: "standard",
      outputType: "searchResults",
      maxResults: 3,
    });
    expect(linkupCall?.init?.headers).toMatchObject({ authorization: "Bearer linkup-key" });
    expect(mojeekCall?.url).toBe(
      "https://api.mojeek.com/search?q=octant&api_key=mojeek-key&fmt=json&t=3",
    );
    expect(staanCall?.url).toBe("https://api.staan.ai/v2/search/web?q=octant");
    expect(staanCall?.init?.headers).toMatchObject({ authorization: "Bearer staan-key" });
    for (const call of seen) expect(call.init?.redirect).toBe("error");
  });

  it("sends a Linkup query to the EU host an agreement names", async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ results: [] }));
    await searchWebSearchBackends({
      backends: [entry(7, "linkup", "https://eu.linkup.example/v1/")],
      search: { query: "octant", limit: 3 },
      resolveKey: async () => "key",
      fetch,
    });
    expect(urlOf(fetch.mock.calls[0]?.[0] ?? "")).toBe("https://eu.linkup.example/v1/search");
  });
});
