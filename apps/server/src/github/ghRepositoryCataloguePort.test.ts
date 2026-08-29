import { describe, expect, it, vi } from "vitest";
import { GhRepositoryCataloguePort } from "./ghRepositoryCataloguePort";

function searchItem(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Confine Plan git per call",
    state: "open",
    user: { login: "octocat" },
    updated_at: "2026-08-28T10:00:00Z",
    html_url: "https://github.com/octant/octant/pull/12",
    repository_url: "https://api.github.com/repos/octant/octant",
    ...overrides,
  };
}

function portReturning(pages: ReadonlyArray<readonly unknown[]>) {
  let call = 0;
  const run = vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ items: pages[Math.min(call++, pages.length - 1)] ?? [] }),
  }));
  return { port: new GhRepositoryCataloguePort({ command: { run } }), run };
}

describe("listAssignedWork", () => {
  it("merges the three viewer searches and keeps one row per item", async () => {
    const { port, run } = portReturning([
      [searchItem()],
      [searchItem()],
      [
        searchItem({
          number: 7,
          html_url: "https://github.com/octant/octant/issues/7",
        }),
      ],
    ]);
    const result = await port.listAssignedWork(new AbortController().signal);
    expect(result).toMatchObject({
      kind: "ok",
      value: [
        { category: "review-request", owner: "octant", name: "octant", number: 12 },
        { category: "issue", owner: "octant", name: "octant", number: 7 },
      ],
    });
    expect(run).toHaveBeenCalledTimes(3);
    const queries = run.mock.calls.map(
      (call_) => (call_ as unknown as [readonly string[]])[0][1] ?? "",
    );
    // Every query is bound to the signed-in account; none accepts a login.
    for (const query of queries) expect(query).toContain("%40me");
  });

  it("returns unavailable rather than rows it cannot attribute to a repository", async () => {
    const { port } = portReturning([
      [searchItem({ repository_url: "https://evil.example.com/repos/octant/octant" })],
    ]);
    expect(await port.listAssignedWork(new AbortController().signal)).toEqual({
      kind: "unavailable",
    });
  });
});
