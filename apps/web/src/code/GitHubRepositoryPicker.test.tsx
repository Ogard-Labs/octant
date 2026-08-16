import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  GithubCatalogueReadRequest,
  GithubCatalogueReadResponse,
  GithubRepositoryRow,
} from "@octant/contracts";
import type { GithubClient } from "@octant/client-runtime/github-client";
import { GitHubRepositoryPicker } from "./GitHubRepositoryPicker";

function repositoryRow(n: number, overrides: Partial<GithubRepositoryRow> = {}) {
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

const pageOne: GithubCatalogueReadResponse = {
  kind: "repositories",
  page: {
    rows: [
      repositoryRow(1),
      repositoryRow(2, { visibility: "public", viewerPermission: "read", owner: "atlas-org" }),
    ],
    sort: "pushed-desc",
    hasNextPage: true,
    endCursor: "cursor-2",
    freshness: { status: "fresh" },
  },
} as GithubCatalogueReadResponse;

const pageTwo: GithubCatalogueReadResponse = {
  kind: "repositories",
  page: {
    rows: [repositoryRow(3)],
    sort: "pushed-desc",
    hasNextPage: false,
    freshness: { status: "fresh" },
  },
} as GithubCatalogueReadResponse;

const recents: GithubCatalogueReadResponse = {
  kind: "recent-repositories",
  rows: [repositoryRow(9, { name: "recent-repo" })],
} as GithubCatalogueReadResponse;

interface ClientOverrides {
  readonly readCatalogue?: (
    request: GithubCatalogueReadRequest,
  ) => Promise<GithubCatalogueReadResponse>;
  readonly recordRecentRepository?: (command: unknown) => Promise<GithubCatalogueReadResponse>;
}

function makeClient(overrides: ClientOverrides = {}): GithubClient {
  return {
    authenticationSnapshot: async () => {
      throw new Error("not used");
    },
    executeAuthenticationCommand: async () => {
      throw new Error("not used");
    },
    readCatalogue:
      overrides.readCatalogue ??
      (async (request) => {
        if (request.kind === "recent-repositories") return recents;
        if (request.kind === "repositories" && request.cursor === "cursor-2") return pageTwo;
        return pageOne;
      }),
    recordRecentRepository: (overrides.recordRecentRepository ?? (async () => recents)) as never,
  };
}

describe("GitHubRepositoryPicker", () => {
  it("loads recents and the first repository page with owner, visibility, and permission facts", async () => {
    render(<GitHubRepositoryPicker client={makeClient()} onSelect={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading repositories…");
    const listbox = await screen.findByRole("listbox", { name: "GitHub repositories" });
    expect(within(listbox).getByText("octant/repo-1")).toBeInTheDocument();
    expect(within(listbox).getByText("atlas-org/repo-2")).toBeInTheDocument();
    expect(within(listbox).getByText("octant/recent-repo")).toBeInTheDocument();
    expect(within(listbox).getAllByText("Private").length).toBeGreaterThan(0);
    expect(within(listbox).getByText("Public")).toBeInTheDocument();
    expect(within(listbox).getAllByText("main").length).toBeGreaterThan(0);
    expect(within(listbox).getByText("read")).toBeInTheDocument();
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("searches through the normalized read request and hides recents while filtering", async () => {
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "repositories" && request.search === "atlas") {
        return {
          kind: "repositories",
          page: {
            rows: [repositoryRow(5, { name: "atlas-match" })],
            sort: "pushed-desc",
            hasNextPage: false,
            freshness: { status: "fresh" },
          },
        } as GithubCatalogueReadResponse;
      }
      return pageOne;
    });
    render(<GitHubRepositoryPicker client={makeClient({ readCatalogue })} onSelect={vi.fn()} />);
    await screen.findByText("octant/repo-1");

    fireEvent.change(screen.getByLabelText("Search GitHub repositories"), {
      target: { value: "atlas" },
    });

    expect(await screen.findByText("octant/atlas-match")).toBeInTheDocument();
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
    expect(readCatalogue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "repositories", search: "atlas" }),
    );
  });

  it("paginates with the opaque server cursor and appends the next page", async () => {
    render(<GitHubRepositoryPicker client={makeClient()} onSelect={vi.fn()} />);
    await screen.findByText("octant/repo-1");

    fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));

    expect(await screen.findByText("octant/repo-3")).toBeInTheDocument();
    expect(screen.getByText("octant/repo-1")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more repositories" }),
    ).not.toBeInTheDocument();
  });

  it("refreshes through an explicit refresh read", async () => {
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      return pageOne;
    });
    render(<GitHubRepositoryPicker client={makeClient({ readCatalogue })} onSelect={vi.fn()} />);
    await screen.findByText("octant/repo-1");

    fireEvent.click(screen.getByRole("button", { name: "Refresh repositories" }));

    await waitFor(() =>
      expect(readCatalogue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "repositories", refresh: true }),
      ),
    );
  });

  it("labels stale results without hiding them", async () => {
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      return {
        kind: "repositories",
        page: {
          rows: [repositoryRow(1)],
          sort: "pushed-desc",
          hasNextPage: false,
          freshness: { status: "stale", staleReason: "rate-limited" },
        },
      } as GithubCatalogueReadResponse;
    });
    render(<GitHubRepositoryPicker client={makeClient({ readCatalogue })} onSelect={vi.fn()} />);

    expect(await screen.findByText("octant/repo-1")).toBeInTheDocument();
    expect(screen.getByText(/Results may be stale/)).toBeInTheDocument();
    expect(screen.getByText(/rate limit/)).toBeInTheDocument();
  });

  it("shows an honest unavailable state with remediation and recovers through retry", async () => {
    let failures = 1;
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories") return recents;
      if (failures > 0) {
        failures -= 1;
        return {
          kind: "unavailable",
          capability: "repository-catalogue",
          reason: "unauthorized",
          remediation: "Set up GitHub in Settings to browse repositories.",
        } as GithubCatalogueReadResponse;
      }
      return pageOne;
    });
    render(<GitHubRepositoryPicker client={makeClient({ readCatalogue })} onSelect={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Set up GitHub in Settings to browse repositories.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("octant/repo-1")).toBeInTheDocument();
  });

  it("selects with the keyboard through listbox semantics and records the recent selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const recordRecentRepository = vi.fn(async () => recents);
    render(
      <GitHubRepositoryPicker
        client={makeClient({ recordRecentRepository })}
        onSelect={onSelect}
      />,
    );
    const listbox = await screen.findByRole("listbox", { name: "GitHub repositories" });

    listbox.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const active = listbox.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "R_node1" }));
    await waitFor(() =>
      expect(recordRecentRepository).toHaveBeenCalledWith({
        kind: "record-recent-repository",
        nodeId: "R_node1",
      }),
    );
  });

  it("marks the current selection and reveals scope remediation only on demand", async () => {
    const readCatalogue = vi.fn(async (request: GithubCatalogueReadRequest) => {
      if (request.kind === "recent-repositories")
        return { kind: "recent-repositories", rows: [] } as GithubCatalogueReadResponse;
      return {
        kind: "repositories",
        page: {
          rows: [
            repositoryRow(1, {
              capabilities: [
                {
                  kind: "issues-read",
                  available: false,
                  remediation: "Authorize organization SSO to read Issues.",
                },
              ],
            }),
          ],
          sort: "pushed-desc",
          hasNextPage: false,
          freshness: { status: "fresh" },
        },
      } as GithubCatalogueReadResponse;
    });
    render(
      <GitHubRepositoryPicker
        client={makeClient({ readCatalogue })}
        onSelect={vi.fn()}
        selectedNodeId="R_node1"
      />,
    );

    const option = await screen.findByRole("option", { name: /repo-1/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByText("Authorize organization SSO to read Issues."),
    ).not.toBeInTheDocument();

    const details = screen.getByRole("button", { name: "Repository details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(details);
    expect(screen.getByText("Authorize organization SSO to read Issues.")).toBeInTheDocument();
  });

  it("completes a search, paginate, refresh, and select walkthrough with zero console errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onSelect = vi.fn();
      render(<GitHubRepositoryPicker client={makeClient()} onSelect={onSelect} />);
      await screen.findByText("octant/repo-1");

      fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
      await screen.findByText("octant/repo-3");
      fireEvent.click(screen.getByRole("button", { name: "Refresh repositories" }));
      await screen.findByText("octant/repo-1");
      fireEvent.click(screen.getByText("octant/repo-1"));
      expect(onSelect).toHaveBeenCalled();

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
