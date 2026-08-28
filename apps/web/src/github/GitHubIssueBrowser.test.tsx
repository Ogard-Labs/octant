import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  GithubCatalogueReadRequest,
  GithubCatalogueReadResponse,
  GithubIssueDetail,
  GithubIssueRow,
  GithubRepositoryRow,
} from "@octant/contracts";
import type { GithubClient } from "@octant/client-runtime/github-client";
import { GitHubIssueBrowser } from "./GitHubIssueBrowser";

function repositoryRow(
  n: number,
  overrides: Partial<GithubRepositoryRow> = {},
): GithubRepositoryRow {
  return {
    nodeId: `R_node${n}`,
    owner: "octant",
    name: `repo-${n}`,
    visibility: "private",
    defaultBranch: "main",
    viewerPermission: "admin",
    capabilities: [],
    ...overrides,
  } as GithubRepositoryRow;
}

function issueRow(n: number, overrides: Partial<GithubIssueRow> = {}): GithubIssueRow {
  return {
    number: n,
    title: `Issue ${n}`,
    state: "open",
    author: "octocat",
    updatedAt: "2026-08-28T09:00:00.000Z",
    url: `https://github.com/octant/repo-1/issues/${n}`,
    ...overrides,
  };
}

function issueDetail(n: number, overrides: Partial<GithubIssueDetail> = {}): GithubIssueDetail {
  return {
    number: n,
    title: `Issue ${n}`,
    state: "open",
    author: "octocat",
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-28T09:00:00.000Z",
    url: `https://github.com/octant/repo-1/issues/${n}`,
    labels: ["bug"],
    body: `Body of issue ${n}. See https://github.com/octant/repo-1 for context.`,
    bodyTruncated: false,
    comments: [
      {
        author: "reviewer",
        createdAt: "2026-08-21T10:00:00.000Z",
        body: "Please check https://github.com/octant/repo-1/wiki.",
        truncated: false,
      },
    ],
    ...overrides,
  };
}

const recents: GithubCatalogueReadResponse = {
  kind: "recent-repositories",
  rows: [],
};

const repositories: GithubCatalogueReadResponse = {
  kind: "repositories",
  page: {
    rows: [repositoryRow(1)],
    sort: "pushed-desc",
    hasNextPage: false,
    freshness: { status: "fresh" },
  },
};

const issuesPageOne: GithubCatalogueReadResponse = {
  kind: "issues",
  page: {
    rows: [issueRow(1), issueRow(2, { title: "Login timeout" })],
    sort: "updated-desc",
    hasNextPage: true,
    endCursor: "cursor-issues-2",
    freshness: { status: "fresh" },
  },
};

const issuesPageTwo: GithubCatalogueReadResponse = {
  kind: "issues",
  page: {
    rows: [issueRow(3, { title: "Third page row" })],
    sort: "updated-desc",
    hasNextPage: false,
    freshness: { status: "fresh" },
  },
};

function makeClient(
  readCatalogue: (request: GithubCatalogueReadRequest) => Promise<GithubCatalogueReadResponse>,
): GithubClient {
  return {
    authenticationSnapshot: async () => {
      throw new Error("not used");
    },
    executeAuthenticationCommand: async () => {
      throw new Error("not used");
    },
    readCatalogue,
    recordRecentRepository: async () => recents,
  };
}

async function selectFirstRepository() {
  const option = await screen.findByRole("option", { name: /octant\/repo-1/ });
  fireEvent.click(option);
}

describe("GitHubIssueBrowser", () => {
  it("lists issues for the selected repository and opens a plain-text detail pane", async () => {
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues") return issuesPageOne;
      if (request.kind === "issue") {
        return {
          kind: "issue",
          issue: issueDetail(request.number),
          freshness: { status: "fresh" },
        } as GithubCatalogueReadResponse;
      }
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);

    await selectFirstRepository();
    expect(await screen.findByRole("button", { name: /#1 Issue 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#2 Login timeout/ })).toBeInTheDocument();
    expect(readCatalogue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "issues",
        owner: "octant",
        name: "repo-1",
        state: "open",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /#1 Issue 1/ }));
    const detail = await screen.findByRole("article", { name: "Issue #1" });
    expect(detail).toHaveTextContent("Body of issue 1.");
    expect(detail).toHaveTextContent("https://github.com/octant/repo-1/issues/1");
    expect(detail).toHaveTextContent("Please check https://github.com/octant/repo-1/wiki.");
    expect(within(detail).queryByRole("link")).not.toBeInTheDocument();
  });

  it("sends the search query through the catalogue read", async () => {
    const user = userEvent.setup();
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues" && request.search === "login") {
        return {
          kind: "issues",
          page: {
            rows: [issueRow(2, { title: "Login timeout" })],
            sort: "updated-desc",
            hasNextPage: false,
            freshness: { status: "fresh" },
          },
        } as GithubCatalogueReadResponse;
      }
      if (request.kind === "issues") return issuesPageOne;
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);
    await selectFirstRepository();
    await screen.findByRole("button", { name: /#1 Issue 1/ });

    await user.type(screen.getByRole("searchbox", { name: "Search GitHub issues" }), "login");
    await waitFor(() =>
      expect(readCatalogue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "issues", search: "login" }),
      ),
    );
    expect(await screen.findByRole("button", { name: /#2 Login timeout/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#1 Issue 1/ })).not.toBeInTheDocument();
  });

  it("paginates with the opaque catalogue cursor", async () => {
    const user = userEvent.setup();
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues" && request.cursor === "cursor-issues-2") return issuesPageTwo;
      if (request.kind === "issues") return issuesPageOne;
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);
    await selectFirstRepository();
    await screen.findByRole("button", { name: /#1 Issue 1/ });

    await user.click(screen.getByRole("button", { name: "Load more issues" }));
    expect(await screen.findByRole("button", { name: /#3 Third page row/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#1 Issue 1/ })).toBeInTheDocument();
    expect(readCatalogue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "issues", cursor: "cursor-issues-2" }),
    );
  });

  it("keeps loaded rows and explains a failed load-more request until retry succeeds", async () => {
    const user = userEvent.setup();
    let failMore = true;
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues" && request.cursor === "cursor-issues-2") {
        if (failMore) {
          failMore = false;
          return {
            kind: "unavailable",
            capability: "issues-read",
            reason: "rate-limited",
            remediation: "Wait before loading more issues.",
            retryAfterSeconds: 20,
          } as GithubCatalogueReadResponse;
        }
        return issuesPageTwo;
      }
      if (request.kind === "issues") return issuesPageOne;
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);
    await selectFirstRepository();
    await screen.findByRole("button", { name: /#1 Issue 1/ });

    await user.click(screen.getByRole("button", { name: "Load more issues" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load more issues. Wait before loading more issues. Retry after 20 seconds.",
    );
    expect(screen.getByRole("button", { name: /#1 Issue 1/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#3 Third page row/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /#3 Third page row/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not read the previous issue from a newly selected repository", async () => {
    const user = userEvent.setup();
    const twoRepositories: GithubCatalogueReadResponse = {
      kind: "repositories",
      page: {
        rows: [repositoryRow(1), repositoryRow(2)],
        sort: "pushed-desc",
        hasNextPage: false,
        freshness: { status: "fresh" },
      },
    };
    const repoTwoIssues: GithubCatalogueReadResponse = {
      kind: "issues",
      page: {
        rows: [issueRow(9, { title: "Other repo" })],
        sort: "updated-desc",
        hasNextPage: false,
        freshness: { status: "fresh" },
      },
    };
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return twoRepositories;
      if (request.kind === "issues" && request.name === "repo-2") return repoTwoIssues;
      if (request.kind === "issues") return issuesPageOne;
      if (request.kind === "issue") {
        return {
          kind: "issue",
          issue: issueDetail(request.number),
          freshness: { status: "fresh" },
        } as GithubCatalogueReadResponse;
      }
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);
    await selectFirstRepository();
    fireEvent.click(await screen.findByRole("button", { name: /#1 Issue 1/ }));
    expect(await screen.findByRole("article", { name: "Issue #1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change repository" }));
    fireEvent.click(await screen.findByRole("option", { name: /octant\/repo-2/ }));

    expect(await screen.findByRole("button", { name: /#9 Other repo/ })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Issue #1" })).not.toBeInTheDocument();
    expect(screen.getByText("Select an issue to read its details.")).toBeInTheDocument();
    expect(
      readCatalogue.mock.calls.some(
        ([request]) =>
          request.kind === "issue" && request.name === "repo-2" && request.number === 1,
      ),
    ).toBe(false);
  });

  it("keeps the stale label on a served stale issue page", async () => {
    const user = userEvent.setup();
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues") {
        return {
          kind: "issues",
          page: {
            rows: [issueRow(1)],
            sort: "updated-desc",
            hasNextPage: false,
            freshness: { status: "stale", staleReason: "rate-limited" },
          },
        } as GithubCatalogueReadResponse;
      }
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);
    await selectFirstRepository();

    expect(await screen.findByRole("button", { name: /#1 Issue 1/ })).toBeInTheDocument();
    expect(screen.getByText(/Results may be stale/)).toBeInTheDocument();
    expect(screen.getByText(/rate limit/)).toBeInTheDocument();
    const issuesCalls = () =>
      readCatalogue.mock.calls.filter(([request]) => request.kind === "issues").length;
    expect(issuesCalls()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Refresh issues" }));
    await waitFor(() => expect(issuesCalls()).toBe(2));
  });

  it("does not restore a previous issue after the list resets", async () => {
    const user = userEvent.setup();
    let releaseDetail: ((value: GithubCatalogueReadResponse) => void) | undefined;
    const pendingDetail = new Promise<GithubCatalogueReadResponse>((resolve) => {
      releaseDetail = resolve;
    });
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues" && request.search === "login") {
        return {
          kind: "issues",
          page: {
            rows: [issueRow(2, { title: "Login timeout" })],
            sort: "updated-desc",
            hasNextPage: false,
            freshness: { status: "fresh" },
          },
        } as GithubCatalogueReadResponse;
      }
      if (request.kind === "issues") return issuesPageOne;
      if (request.kind === "issue") return pendingDetail;
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);
    await selectFirstRepository();
    fireEvent.click(await screen.findByRole("button", { name: /#1 Issue 1/ }));
    expect(await screen.findByText("Loading issue…")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search GitHub issues" }), "login");
    await waitFor(() =>
      expect(readCatalogue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "issues", search: "login" }),
      ),
    );
    expect(await screen.findByRole("button", { name: /#2 Login timeout/ })).toBeInTheDocument();

    releaseDetail?.({
      kind: "issue",
      issue: issueDetail(1),
      freshness: { status: "fresh" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Issue #1" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Select an issue to read its details.")).toBeInTheDocument();
  });

  it("renders unavailable reason, remediation, and retry delay", async () => {
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues") {
        return {
          kind: "unavailable",
          capability: "issues-read",
          reason: "rate-limited",
          remediation: "Wait before reading issues again.",
          retryAfterSeconds: 45,
        } as GithubCatalogueReadResponse;
      }
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);
    await selectFirstRepository();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wait before reading issues again. Retry after 45 seconds.",
    );
  });

  it("keeps the contrast outline on the lowercase currentcolor keyword", () => {
    const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles/github.css"), "utf8");
    expect(stylesheet).toMatch(
      /@media \(prefers-contrast: more\)[\s\S]*?box-shadow:[^;]*currentcolor/,
    );
    expect(stylesheet).not.toMatch(/\bcurrentColor\b/);
  });
});
