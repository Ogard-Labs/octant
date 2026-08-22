import {
  decodeCodeProjectPullRequestView,
  type CodeProjectPullRequestQuery,
  type CodeProjectPullRequestRefreshCommand,
  type CodeProjectPullRequestView,
} from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeProjectPullRequests } from "./CodeProjectPullRequests";

const projectA = "10000000-0000-4000-8000-000000000001";
const projectB = "10000000-0000-4000-8000-000000000002";
const threadId = "20000000-0000-4000-8000-000000000001";
const generatedAt = "2026-08-22T08:00:00.000Z";

function view(overrides: Record<string, unknown> = {}): CodeProjectPullRequestView {
  return decodeCodeProjectPullRequestView({
    version: 1,
    query: { version: 1 },
    projects: [
      {
        kind: "connected",
        projectId: projectA,
        projectName: "Octant",
        repositoryOwner: "octant",
        repositoryName: "octant",
      },
      { kind: "unconnected", projectId: projectB, projectName: "Local notes" },
    ],
    rows: [
      {
        projectId: projectA,
        projectName: "Octant",
        repositoryOwner: "octant",
        repositoryName: "octant",
        number: 12,
        title: "List active pull requests",
        draft: false,
        author: "octocat",
        baseBranch: "development",
        headBranch: "feature/manual-refresh",
        updatedAt: "2026-08-22T07:00:00.000Z",
        checks: "passing",
        review: "approved",
        linkedThreads: [{ threadId, title: "Manual refresh" }],
      },
    ],
    repositoriesTruncated: false,
    pullRequestsTruncated: false,
    freshness: { status: "fresh", lastSuccessfulRefreshAt: generatedAt },
    generatedAt,
    ...overrides,
  });
}

function renderWorkspace(
  options: {
    readonly load?: (query: CodeProjectPullRequestQuery) => Promise<CodeProjectPullRequestView>;
    readonly refresh?: (
      command: CodeProjectPullRequestRefreshCommand,
    ) => Promise<CodeProjectPullRequestView>;
    readonly isNarrow?: boolean;
    readonly onSelectRow?: (row: import("@octant/contracts").CodeProjectPullRequestRow) => void;
  } = {},
) {
  const load = options.load ?? vi.fn(async () => view());
  const refresh = options.refresh ?? vi.fn(async () => view());
  render(
    <CodeProjectPullRequests
      {...(options.isNarrow === undefined ? {} : { isNarrow: options.isNarrow })}
      load={load}
      refresh={refresh}
      onClose={() => undefined}
      {...(options.onSelectRow === undefined ? {} : { onSelectRow: options.onSelectRow })}
    />,
  );
  return { load, refresh };
}

describe("CodeProjectPullRequests", () => {
  it("loads the cached snapshot on open and does not refresh GitHub", async () => {
    const { load, refresh } = renderWorkspace();

    expect(await screen.findByRole("heading", { name: "Pull requests" })).toBeVisible();
    expect(await screen.findByText("List active pull requests")).toBeVisible();
    expect(load).toHaveBeenCalledWith({ version: 1 });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("groups rows by Project then repository and keeps an unconnected Project visible", async () => {
    renderWorkspace();

    const octant = await screen.findByRole("region", { name: "Project Octant" });
    const notes = screen.getByRole("region", { name: "Project Local notes" });
    expect(within(octant).getByRole("heading", { name: "octant/octant" })).toBeVisible();
    expect(within(octant).getByText("#12")).toBeVisible();
    expect(within(octant).getByText("octocat")).toBeVisible();
    expect(within(octant).getByText("feature/manual-refresh → development")).toBeVisible();
    expect(within(octant).getByText("Checks passing")).toBeVisible();
    expect(within(octant).getByText("Review approved")).toBeVisible();
    expect(within(octant).getByText("Linked: Manual refresh")).toBeVisible();
    expect(
      within(notes).getByText("Not connected to a github.com origin. The Project stays usable."),
    ).toBeVisible();
    expect(octant.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("refreshes all Projects or one Project only when those buttons are used", async () => {
    const user = userEvent.setup();
    const { refresh } = renderWorkspace();
    await screen.findByText("List active pull requests");

    await user.click(screen.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ kind: "refresh-all" }));

    await user.click(screen.getByRole("button", { name: "Refresh Local notes" }));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({ kind: "refresh-project", projectId: projectB }),
    );
    const actions = document.querySelector(".code-project-pull-requests__actions");
    expect(actions).not.toBeNull();
    expect(
      within(actions as HTMLElement).queryByRole("button", {
        name: /merge|approve|comment|close|force-push/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("labels a stale snapshot, truncation, and draft state at normal and narrow widths", async () => {
    const stale = view({
      repositoriesTruncated: true,
      pullRequestsTruncated: true,
      freshness: {
        status: "stale",
        staleReason: "rate-limited",
        lastSuccessfulRefreshAt: generatedAt,
        retryAfter: "2026-08-22T08:00:30.000Z",
      },
      rows: [
        {
          projectId: projectA,
          projectName: "Octant",
          repositoryOwner: "octant",
          repositoryName: "octant",
          number: 12,
          title: "Draft refresh",
          draft: true,
          author: "octocat",
          baseBranch: "development",
          headBranch: "feature/manual-refresh",
          updatedAt: "2026-08-22T07:00:00.000Z",
          checks: "passing",
          review: "approved",
          linkedThreads: [{ threadId, title: "Manual refresh" }],
        },
      ],
    });
    const { rerender } = render(
      <CodeProjectPullRequests
        isNarrow={false}
        load={async () => stale}
        refresh={async () => stale}
      />,
    );
    expect(await screen.findByText(/GitHub rate-limited the last refresh/)).toBeVisible();
    expect(screen.getByText(/preview bound of 25/)).toBeVisible();
    expect(screen.getByText(/preview bound of 100/)).toBeVisible();
    expect(screen.getByText("Draft")).toBeVisible();
    expect(document.querySelector(".code-project-pull-requests")).toHaveAttribute(
      "data-narrow",
      "false",
    );

    rerender(
      <CodeProjectPullRequests isNarrow load={async () => stale} refresh={async () => stale} />,
    );
    expect(await screen.findByText("Draft refresh")).toBeVisible();
    expect(document.querySelector(".code-project-pull-requests")).toHaveAttribute(
      "data-narrow",
      "true",
    );
  });

  it("selects a pull request row without refreshing GitHub", async () => {
    const user = userEvent.setup();
    const onSelectRow = vi.fn();
    renderWorkspace({ onSelectRow });
    await screen.findByText("List active pull requests");
    await user.click(screen.getByRole("button", { name: /List active pull requests/i }));
    expect(onSelectRow).toHaveBeenCalledWith(
      expect.objectContaining({ number: 12, title: "List active pull requests" }),
    );
  });
});
