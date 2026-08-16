import { describe, expect, it, vi } from "vitest";
import { createGithubClient, GithubClientFailure } from "./githubClient";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetch: ReturnType<typeof vi.fn>) {
  return createGithubClient({
    baseUrl: "http://127.0.0.1:4317",
    fetch: fetch as never,
    windowCapability: "capability-token",
  });
}

const repositoriesPage = {
  kind: "repositories",
  page: {
    rows: [
      {
        nodeId: "R_kgDOG8x1Aa",
        owner: "octant",
        name: "octant",
        visibility: "private",
        defaultBranch: "development",
        viewerPermission: "admin",
        capabilities: [{ kind: "issues-read", available: true }],
      },
    ],
    sort: "pushed-desc",
    hasNextPage: false,
    freshness: { status: "fresh" },
  },
};

describe("createGithubClient", () => {
  it("reads the authentication snapshot from the authenticated route", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ state: "unauthorized", capabilities: [] }));
    await expect(client(fetch).authenticationSnapshot()).resolves.toMatchObject({
      state: "unauthorized",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4317/api/github/authentication");
    expect(init.method).toBe("GET");
    expect(init.headers["x-octant-window-capability"]).toBe("capability-token");
  });

  it("posts a validated catalogue read and decodes the bounded page", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(repositoriesPage));
    const response = await client(fetch).readCatalogue({
      kind: "repositories",
      pageSize: 30,
      search: "atlas",
    });
    expect(response).toMatchObject({ kind: "repositories", page: { hasNextPage: false } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4317/api/github/catalogue/reads");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ kind: "repositories", pageSize: 30, search: "atlas" });
  });

  it("refuses to send a request the read contract rejects", async () => {
    const fetch = vi.fn();
    await expect(
      client(fetch).readCatalogue({ kind: "repositories", pageSize: 500 } as never),
    ).rejects.toBeInstanceOf(GithubClientFailure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("executes authentication commands and records recents through their strict commands", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ state: "unauthorized", capabilities: [] }))
      .mockResolvedValueOnce(jsonResponse({ kind: "recent-repositories", rows: [] }));
    const value = client(fetch);
    await value.executeAuthenticationCommand({
      kind: "setup",
      confirmation: "confirm-github-setup",
    });
    await value.recordRecentRepository({
      kind: "record-recent-repository",
      nodeId: "R_kgDOG8x1Aa",
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:4317/api/github/authentication/commands",
    );
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:4317/api/github/catalogue/recents",
    );
  });

  it("surfaces server failure messages with their status", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ category: "unauthorized", message: "GitHub request is unauthorized." }, 403),
      );
    const failure = await client(fetch)
      .readCatalogue({ kind: "recent-repositories" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubClientFailure);
    expect((failure as GithubClientFailure).status).toBe(403);
    expect((failure as GithubClientFailure).message).toBe("GitHub request is unauthorized.");
  });

  it("fails closed on a response that violates the catalogue contract", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: "repositories",
        page: { ...repositoriesPage.page, rows: [{ nodeId: "x", raw: "unexpected" }] },
      }),
    );
    await expect(
      client(fetch).readCatalogue({ kind: "repositories", pageSize: 30 }),
    ).rejects.toBeInstanceOf(GithubClientFailure);
  });

  it("only accepts loopback base URLs", () => {
    expect(() =>
      createGithubClient({
        baseUrl: "https://attacker.example",
        fetch: vi.fn() as never,
        windowCapability: "capability-token",
      }),
    ).toThrow(GithubClientFailure);
  });
});
