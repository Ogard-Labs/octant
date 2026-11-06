import { WEB_SEARCH_TOOL_DEFINITION } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWebSearchTools } from "./webSearchTools";

function searchReturning() {
  return vi.fn(async (input: { readonly query: string; readonly limit: number }) => ({
    query: input.query,
    backend: "searxng" as const,
    results: [{ title: "Octant", url: "https://example.com/octant", snippet: "A workspace." }],
  }));
}

describe("Chat web search", () => {
  it("offers the same web-search definition the harness offers", () => {
    expect(createWebSearchTools(searchReturning()).definitions).toEqual([
      WEB_SEARCH_TOOL_DEFINITION,
    ]);
    expect(WEB_SEARCH_TOOL_DEFINITION.name).toBe("web-search");
  });

  it.each([
    ["a missing query", {}],
    ["an empty query", { query: "" }],
    ["a blank query", { query: "   " }],
    ["a query that is not text", { query: 42 }],
    ["a query past 512 characters", { query: "x".repeat(513) }],
  ])("refuses %s as invalid instead of searching anything else", async (_, input) => {
    const search = searchReturning();

    const outcome = await createWebSearchTools(search).execute({
      name: "web-search",
      inputJson: JSON.stringify(input),
    });

    expect(outcome).toMatchObject({ isError: true, result: { error: "invalid-query" } });
    expect(search).not.toHaveBeenCalled();
  });

  it("searches the query it was given, five results unless the call asks for another limit", async () => {
    const search = searchReturning();
    const tools = createWebSearchTools(search);

    const found = await tools.execute({
      name: "web-search",
      inputJson: JSON.stringify({ query: "octant" }),
    });
    await tools.execute({
      name: "web-search",
      inputJson: JSON.stringify({ query: "octant docs", limit: 2 }),
    });

    expect(found).toEqual({
      result: {
        query: "octant",
        results: [{ title: "Octant", url: "https://example.com/octant", snippet: "A workspace." }],
      },
    });
    expect(search.mock.calls.map(([input]) => [input.query, input.limit])).toEqual([
      ["octant", 5],
      ["octant docs", 2],
    ]);
  });

  it("answers a failed search as an error the model can act on", async () => {
    const outcome = await createWebSearchTools(async () => {
      throw new Error("SearXNG is not configured.");
    }).execute({ name: "web-search", inputJson: JSON.stringify({ query: "octant" }) });

    expect(outcome).toMatchObject({ isError: true, result: { error: "search-failed" } });
  });
});
