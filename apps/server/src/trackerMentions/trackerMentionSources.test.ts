import type { GithubCatalogueReadResponse } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { githubTrackerSource, linearTrackerSource } from "./trackerMentionSources";

const row = {
  kind: "pull-request" as const,
  number: 7,
  title: "Fix login",
  state: "open" as const,
  author: "dana",
  updatedAt: "2026-11-27T10:00:00Z",
  url: "https://github.com/acme/app/pull/7",
};
const repository = { owner: "acme", name: "app" };

function github(freshness: { status: "fresh" } | { status: "stale"; staleReason: "rate-limited" }) {
  const read = vi.fn(
    async (request: { readonly kind: string }): Promise<GithubCatalogueReadResponse> =>
      (request.kind === "item"
        ? { kind: "item", row, freshness }
        : {
            kind: "search",
            page: { rows: [row], sort: "updated-desc", hasNextPage: false, freshness },
          }) as GithubCatalogueReadResponse,
  );
  return githubTrackerSource({ catalogue: { read }, connected: () => true });
}

describe("what the # list reads from GitHub", () => {
  it("offers the rows of a read GitHub just answered", async () => {
    const source = github({ status: "fresh" });
    const signal = new AbortController().signal;

    await expect(source.search({ ...repository, text: "login" }, signal)).resolves.toEqual([row]);
    await expect(source.item({ ...repository, number: 7 }, signal)).resolves.toEqual(row);
  });

  it("offers nothing from a page kept from before a failed read", async () => {
    const source = github({ status: "stale", staleReason: "rate-limited" });
    const signal = new AbortController().signal;

    await expect(source.search({ ...repository, text: "login" }, signal)).resolves.toEqual([]);
    await expect(source.item({ ...repository, number: 7 }, signal)).resolves.toBeUndefined();
  });
});

describe("what the # list reads from Linear", () => {
  const empty = async () => ({ kind: "ok" as const, value: { rows: [], hasNextPage: false } });

  it("asks for a key's own issue, in the mapped team, and for title text otherwise", async () => {
    const run = vi.fn(empty);
    const source = linearTrackerSource({ run, connected: () => true });
    const signal = new AbortController().signal;

    await source.list({ identifier: "OCT-1042", teamId: "team-1" }, signal);
    await source.list({ search: "login" }, signal);

    expect(run.mock.calls).toEqual([
      [
        "list-issues",
        { identifier: "OCT-1042", pageSize: 10, filter: { teamId: "team-1" } },
        signal,
      ],
      ["list-issues", { search: "login", pageSize: 10 }, signal],
    ]);
  });
});
