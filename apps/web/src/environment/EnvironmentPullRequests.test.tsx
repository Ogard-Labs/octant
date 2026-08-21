import type { GithubClient } from "@octant/client-runtime/github-client";
import { decodeGithubCatalogueReadResponse } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentPullRequests } from "./EnvironmentPullRequests";

const response = decodeGithubCatalogueReadResponse({
  kind: "pull-requests",
  page: {
    rows: [
      {
        number: 42,
        title: "Make the environment useful",
        state: "open",
        author: "henrikogaard",
        updatedAt: "2026-08-21T12:00:00Z",
        url: "https://github.com/acme/repo/pull/42",
        baseBranch: "main",
        headBranch: "feature/environment",
      },
    ],
    sort: "updated-desc",
    hasNextPage: false,
    freshness: { status: "fresh" },
  },
});

describe("EnvironmentPullRequests", () => {
  it("lists the repository's open pull requests and refreshes them on demand", async () => {
    const user = userEvent.setup();
    const readCatalogue = vi.fn(async () => response);
    render(
      <EnvironmentPullRequests
        client={{ readCatalogue } as unknown as GithubClient}
        enabled
        repository="acme/repo"
      />,
    );

    await waitFor(() => expect(screen.getByText(/#42 Make the environment useful/)).toBeVisible());
    expect(screen.getByRole("link", { name: /#42 Make the environment useful/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/42",
    );
    expect(readCatalogue).toHaveBeenCalledWith({
      kind: "pull-requests",
      owner: "acme",
      name: "repo",
      pageSize: 20,
      state: "open",
    });

    await user.click(screen.getByRole("button", { name: "Refresh pull requests" }));
    await waitFor(() => expect(readCatalogue).toHaveBeenCalledTimes(2));
  });

  it("keeps an empty repository list explicit", async () => {
    const empty = decodeGithubCatalogueReadResponse({
      kind: "pull-requests",
      page: {
        rows: [],
        sort: "updated-desc",
        hasNextPage: false,
        freshness: { status: "fresh" },
      },
    });
    render(
      <EnvironmentPullRequests
        client={{ readCatalogue: vi.fn(async () => empty) } as unknown as GithubClient}
        enabled
        repository="acme/repo"
      />,
    );

    expect(await screen.findByText("No open pull requests.")).toBeVisible();
  });

  it("reports the host's unavailable GitHub catalogue", async () => {
    const unavailable = decodeGithubCatalogueReadResponse({
      kind: "unavailable",
      capability: "repository-catalogue",
      reason: "unauthorized",
      remediation: "Connect GitHub in Settings.",
    });
    render(
      <EnvironmentPullRequests
        client={{ readCatalogue: vi.fn(async () => unavailable) } as unknown as GithubClient}
        enabled
        repository="acme/repo"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Connect GitHub in Settings.");
  });
});
