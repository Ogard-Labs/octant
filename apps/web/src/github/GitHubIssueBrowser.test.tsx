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

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

async function selectFirstRepository() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Repository: Choose a repository" }));
  const option = await screen.findByRole("option", { name: /octant\/repo-1/ });
  fireEvent.click(option);
}

describe("GitHubIssueBrowser", () => {
  it("opens on every recent repository, attributes each row, and sorts across them", async () => {
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") {
        return {
          kind: "recent-repositories",
          rows: [repositoryRow(1), repositoryRow(2)],
        } satisfies GithubCatalogueReadResponse;
      }
      if (request.kind === "repositories") return repositories;
      if (request.kind === "issues" && request.name === "repo-2") {
        return {
          kind: "issues",
          page: {
            rows: [
              issueRow(40, { title: "Newest in repo-2", updatedAt: "2026-09-01T09:00:00.000Z" }),
            ],
            sort: "updated-desc",
            hasNextPage: false,
            freshness: { status: "fresh" },
          },
        } satisfies GithubCatalogueReadResponse;
      }
      if (request.kind === "issues") return issuesPageOne;
      if (request.kind === "issue") {
        return {
          kind: "issue",
          issue: issueDetail(request.number, { title: `Detail ${request.number}` }),
          freshness: { status: "fresh" },
        } satisfies GithubCatalogueReadResponse;
      }
      throw new Error(`unexpected ${request.kind}`);
    });
    const user = userEvent.setup();
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} />);

    const list = await screen.findByRole("list", { name: "GitHub issues" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Newest in repo-2"),
      expect.stringContaining("Issue 1"),
      expect.stringContaining("Login timeout"),
    ]);
    expect(rows[0]).toHaveTextContent("repo-2");
    expect(rows[1]).toHaveTextContent("repo-1");
    expect(
      screen.getByRole("button", { name: "Repository: All recent repositories" }),
    ).toBeVisible();
    expect(screen.getByText(/Showing the newest 20 from octant\/repo-1/)).toBeVisible();

    fireEvent.click(rows[0]!);
    expect(await screen.findByRole("heading", { name: /Detail 40/ })).toBeVisible();
    expect(readCatalogue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "issue", name: "repo-2", number: 40 }),
    );

    await user.click(screen.getByRole("button", { name: "Repository: All recent repositories" }));
    expect(await screen.findByRole("option", { name: /octant\/repo-1/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /All recent repositories/, pressed: true }),
    ).toBeVisible();
  });

  it("asks for a repository before listing anything and hands the issue being read to a new thread", async () => {
    const onStartThread = vi.fn();
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
    render(<GitHubIssueBrowser client={makeClient(readCatalogue)} onStartThread={onStartThread} />);

    expect(await screen.findByRole("button", { name: "Choose a repository" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "GitHub issues" })).not.toBeInTheDocument();
    expect(readCatalogue).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "issues" }));

    await selectFirstRepository();
    fireEvent.click(await screen.findByRole("button", { name: /Login timeout/ }));
    const detail = await screen.findByRole("article", { name: "Issue #2" });
    fireEvent.click(within(detail).getByRole("button", { name: "Start a Code thread" }));
    expect(onStartThread).toHaveBeenCalledWith({
      owner: "octant",
      name: "repo-1",
      number: 2,
      title: "Issue 2",
      state: "open",
      author: "octocat",
      updatedAt: "2026-08-28T09:00:00.000Z",
      url: "https://github.com/octant/repo-1/issues/2",
    });
  });

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
    expect(await screen.findByRole("button", { name: /Issue 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Login timeout/ })).toBeInTheDocument();
    expect(readCatalogue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "issues",
        owner: "octant",
        name: "repo-1",
        state: "open",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Issue 1/ }));
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
    await screen.findByRole("button", { name: /Issue 1/ });

    await user.type(screen.getByRole("searchbox", { name: "Search GitHub issues" }), "login");
    await waitFor(() =>
      expect(readCatalogue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "issues", search: "login" }),
      ),
    );
    expect(await screen.findByRole("button", { name: /Login timeout/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Issue 1/ })).not.toBeInTheDocument();
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
    await screen.findByRole("button", { name: /Issue 1/ });

    await user.click(screen.getByRole("button", { name: "Load more issues" }));
    expect(await screen.findByRole("button", { name: /Third page row/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Issue 1/ })).toBeInTheDocument();
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
    await screen.findByRole("button", { name: /Issue 1/ });

    await user.click(screen.getByRole("button", { name: "Load more issues" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load more issues. Wait before loading more issues. Retry after 20 seconds.",
    );
    expect(screen.getByRole("button", { name: /Issue 1/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Third page row/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Third page row/ })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: /Issue 1/ }));
    expect(await screen.findByRole("article", { name: "Issue #1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Repository: octant/repo-1" }));
    fireEvent.click(await screen.findByRole("option", { name: /octant\/repo-2/ }));

    expect(await screen.findByRole("button", { name: /Other repo/ })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Issue #1" })).not.toBeInTheDocument();
    expect(screen.getByText("Select an issue to read it.")).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: /Issue 1/ })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: /Issue 1/ }));
    expect(await screen.findByText("Loading issue…")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search GitHub issues" }), "login");
    await waitFor(() =>
      expect(readCatalogue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "issues", search: "login" }),
      ),
    );
    expect(await screen.findByRole("button", { name: /Login timeout/ })).toBeInTheDocument();

    releaseDetail?.({
      kind: "issue",
      issue: issueDetail(1),
      freshness: { status: "fresh" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Issue #1" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Select an issue to read it.")).toBeInTheDocument();
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

  it("marks the current issue with fill and text emphasis in increased contrast", () => {
    const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles/github.css"), "utf8");
    expect(stylesheet).toMatch(
      /\[data-octant-increased-contrast="true"\] \.work-list__row[^{]*\{[^}]*?background:\s*var\(--octant-control-hover\);[\s\S]*?text-decoration:\s*underline/,
    );
    expect(stylesheet).not.toMatch(/box-shadow:\s*inset 0 0 0 2px/);
  });

  describe("the shared list", () => {
    function acrossClient() {
      return makeClient(async (request: GithubCatalogueReadRequest) => {
        if (request.kind === "recent-repositories") {
          return {
            kind: "recent-repositories",
            rows: [repositoryRow(1), repositoryRow(2)],
          } satisfies GithubCatalogueReadResponse;
        }
        if (request.kind === "issues" && request.name === "repo-2") {
          return {
            kind: "issues",
            page: {
              rows: [
                issueRow(40, { title: "Newest in repo-2", updatedAt: "2026-09-01T09:00:00.000Z" }),
              ],
              sort: "updated-desc",
              hasNextPage: false,
              freshness: { status: "fresh" },
            },
          } satisfies GithubCatalogueReadResponse;
        }
        if (request.kind === "issues") {
          return {
            kind: "issues",
            page: {
              rows: [
                issueRow(1, { updatedAt: "2026-08-20T09:00:00.000Z" }),
                issueRow(2, { title: "Closed one", state: "closed" }),
              ],
              sort: "updated-desc",
              hasNextPage: false,
              freshness: { status: "fresh" },
            },
          } satisfies GithubCatalogueReadResponse;
        }
        throw new Error(`unexpected ${request.kind}`);
      });
    }

    function titles(): ReadonlyArray<string> {
      return Array.from(document.querySelectorAll(".work-list__title")).map(
        (element) => element.textContent ?? "",
      );
    }

    it("draws an issue as a title and one meta line with the number at the trailing edge", async () => {
      render(<GitHubIssueBrowser client={acrossClient()} storage={memoryStorage()} />);

      const row = await screen.findByRole("button", { name: /Newest in repo-2/ });
      expect(within(row).getByText("Newest in repo-2")).toHaveClass("work-list__title");
      expect(within(row).getByRole("img", { name: "Open" })).toBeInTheDocument();
      expect(within(row).getByText("octant/repo-2")).toBeVisible();
      expect(within(row).getByText("octocat")).toBeVisible();
      expect(within(row).getByText("#40")).toHaveClass("work-list__number");
      expect(
        within(screen.getByRole("button", { name: /Closed one/ })).getByRole("img", {
          name: "Closed",
        }),
      ).toBeInTheDocument();
      expect(await screen.findByText("3 issues")).toBeVisible();
    });

    it("sorts from an icon menu and offers Repository only across repositories", async () => {
      const user = userEvent.setup();
      render(<GitHubIssueBrowser client={acrossClient()} storage={memoryStorage()} />);
      await screen.findByText("Newest in repo-2");

      await user.click(screen.getByRole("button", { name: "Sort issues" }));
      expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(
        ["Recently updated", "Least recently updated", "Highest number", "Repository"],
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Least recently updated" }),
      );
      expect(titles()[0]).toBe("Issue 1");
    });

    it("groups by repository under a slim header and remembers the choice", async () => {
      const user = userEvent.setup();
      const storage = memoryStorage();
      const first = render(<GitHubIssueBrowser client={acrossClient()} storage={storage} />);
      await screen.findByText("Newest in repo-2");

      await user.click(screen.getByRole("button", { name: "Sort issues" }));
      await user.click(
        await screen.findByRole("menuitemcheckbox", { name: "Group by repository" }),
      );
      const group = await screen.findByRole("region", { name: "octant/repo-2" });
      expect(within(group).getByRole("heading", { name: "octant/repo-2" })).toBeVisible();
      expect(within(group).getByText("1")).toBeVisible();
      expect(within(group).queryByText("Issue 1")).toBeNull();
      first.unmount();

      render(<GitHubIssueBrowser client={acrossClient()} storage={storage} />);
      expect(await screen.findByRole("region", { name: "octant/repo-1" })).toBeVisible();
    });

    it("names the owner only on an ungrouped list across repositories", async () => {
      const user = userEvent.setup();
      render(<GitHubIssueBrowser client={acrossClient()} storage={memoryStorage()} />);
      const row = await screen.findByRole("button", { name: /Newest in repo-2/ });
      expect(within(row).getByText("octant/repo-2")).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Sort issues" }));
      await user.click(
        await screen.findByRole("menuitemcheckbox", { name: "Group by repository" }),
      );
      const group = await screen.findByRole("region", { name: "octant/repo-2" });
      expect(
        within(group).getByText("repo-2", { selector: ".work-list__meta-text" }),
      ).toBeVisible();
      // Each grouped list is named by its group, not "GitHub issues" twice.
      expect(within(group).getByRole("list", { name: "octant/repo-2" })).toBeVisible();
      expect(screen.queryByRole("list", { name: "GitHub issues" })).toBeNull();
    });

    it("renders no row again when the page renders with the same rows", async () => {
      const client = acrossClient();
      const storage = memoryStorage();
      const { rerender } = render(<GitHubIssueBrowser client={client} storage={storage} />);
      await screen.findByText("Newest in repo-2");

      const formatted = vi.spyOn(Date.prototype, "toLocaleString");
      try {
        rerender(<GitHubIssueBrowser client={client} storage={storage} />);
        expect(formatted).not.toHaveBeenCalled();
      } finally {
        formatted.mockRestore();
      }
    });

    it("keeps an issue to the list's own measure beside its detail pane", () => {
      const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles/github.css"), "utf8");
      expect(stylesheet).toMatch(/grid-template-columns:\s*minmax\(320px,\s*min\(720px,\s*46%\)\)/);
    });
  });
});
