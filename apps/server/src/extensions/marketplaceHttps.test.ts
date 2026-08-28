import { describe, expect, it, vi } from "vitest";
import {
  MARKETPLACE_FETCH_ALLOWED_HEADER_NAMES,
  MARKETPLACE_FETCH_USER_AGENT,
  MarketplaceFetchesDisabledError,
  createMarketplaceFetch,
  marketplaceHeadersAreAllowlisted,
  marketplaceRequestHeaders,
} from "./marketplaceHttps";

describe("marketplace HTTPS", () => {
  it("constrains User-Agent to the version-free marketplace string", () => {
    expect(MARKETPLACE_FETCH_USER_AGENT).toBe("octant-skill-marketplace");
    expect(MARKETPLACE_FETCH_USER_AGENT).not.toMatch(/\d/);
    const headers = marketplaceRequestHeaders({ accept: "application/json" });
    expect(headers["user-agent"]).toBe(MARKETPLACE_FETCH_USER_AGENT);
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
    expect(marketplaceHeadersAreAllowlisted(headers)).toBe(true);
  });

  it("drops non-allowlisted headers before the request leaves", () => {
    const headers = marketplaceRequestHeaders({
      accept: "application/vnd.github+json",
      "user-agent": "Bun/1.2.0",
      cookie: "session=nope",
      "x-octant-version": "9.9.9",
    });
    expect(headers).toEqual({
      accept: "application/vnd.github+json",
      "user-agent": MARKETPLACE_FETCH_USER_AGENT,
    });
    expect([...MARKETPLACE_FETCH_ALLOWED_HEADER_NAMES].sort()).toEqual(Object.keys(headers).sort());
  });

  it("forces allowlisted headers on every wrapped fetch call", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = createMarketplaceFetch({
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        calls.push({ url, headers });
        expect(marketplaceHeadersAreAllowlisted(headers)).toBe(true);
        expect(headers["user-agent"]).toBe(MARKETPLACE_FETCH_USER_AGENT);
        return new Response("{}", { status: 200 });
      },
    });

    await fetchImpl("https://skills.sh/api/search?q=review", {
      headers: { accept: "application/json", "x-runtime": "leak" },
    });
    await fetchImpl("https://registry.npmjs.org/-/v1/search", {
      headers: { accept: "application/json" },
    });
    await fetchImpl("https://api.github.com/repos/o/r/git/trees/abc", {
      headers: { accept: "application/vnd.github+json" },
    });
    await fetchImpl("https://raw.githubusercontent.com/o/r/abc/file");

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(Object.keys(call.headers).sort()).toEqual(
        call.headers.accept === undefined ? ["user-agent"] : ["accept", "user-agent"],
      );
      expect(call.headers["user-agent"]).toBe(MARKETPLACE_FETCH_USER_AGENT);
    }
  });

  it("makes no request when marketplace fetches are turned off", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const fetchImpl = createMarketplaceFetch({
      fetch: fetchSpy,
      isAllowed: () => false,
    });
    await expect(fetchImpl("https://skills.sh/api/search?q=x")).rejects.toBeInstanceOf(
      MarketplaceFetchesDisabledError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
