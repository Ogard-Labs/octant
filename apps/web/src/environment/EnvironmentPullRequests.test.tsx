import {
  decodeCodeProjectPullRequestView,
  type CodeProjectPullRequestQuery,
  type CodeProjectPullRequestRefreshCommand,
  type CodeProjectPullRequestRow,
  type CodeProjectPullRequestView,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentPullRequests } from "./EnvironmentPullRequests";

const projectA = "10000000-0000-4000-8000-000000000001";
const projectB = "10000000-0000-4000-8000-000000000002";
const projectAId = decodeProjectId(projectA);
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
      {
        kind: "connected",
        projectId: projectB,
        projectName: "Sidecar",
        repositoryOwner: "octant",
        repositoryName: "sidecar",
      },
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
        state: "open",
        mergeability: "mergeable",
        author: "octocat",
        baseBranch: "development",
        headBranch: "feature/manual-refresh",
        updatedAt: "2026-08-22T07:00:00.000Z",
        checks: "passing",
        review: "approved",
        linkedThreads: [{ threadId, title: "Manual refresh" }],
      },
      {
        projectId: projectB,
        projectName: "Sidecar",
        repositoryOwner: "octant",
        repositoryName: "sidecar",
        number: 4,
        title: "Another Project's pull request",
        draft: true,
        state: "open",
        mergeability: "unknown",
        author: "someone",
        baseBranch: "main",
        headBranch: "feature/elsewhere",
        updatedAt: "2026-08-22T06:00:00.000Z",
        checks: "pending",
        review: "pending",
        linkedThreads: [],
      },
    ],
    repositoriesTruncated: false,
    pullRequestsTruncated: false,
    freshness: { status: "fresh", lastSuccessfulRefreshAt: generatedAt },
    generatedAt,
    ...overrides,
  });
}

function renderGroup(
  options: {
    readonly load?: (query: CodeProjectPullRequestQuery) => Promise<CodeProjectPullRequestView>;
    readonly refresh?: (
      command: CodeProjectPullRequestRefreshCommand,
    ) => Promise<CodeProjectPullRequestView>;
    readonly onOpenAll?: () => void;
    readonly onSelectRow?: (row: CodeProjectPullRequestRow) => void;
  } = {},
) {
  const load = options.load ?? vi.fn(async () => view());
  const refresh = options.refresh ?? vi.fn(async () => view());
  render(
    <EnvironmentPullRequests
      enabled
      load={load}
      projectId={projectAId}
      refresh={refresh}
      threadId={threadId}
      {...(options.onOpenAll === undefined ? {} : { onOpenAll: options.onOpenAll })}
      {...(options.onSelectRow === undefined ? {} : { onSelectRow: options.onSelectRow })}
    />,
  );
  const group = screen.getByRole("button", { name: /Pull requests/ });
  if (group.getAttribute("aria-expanded") !== "true") fireEvent.click(group);
  return { load, refresh };
}

describe("EnvironmentPullRequests", () => {
  it("lists the connected Project's rows from the journaled snapshot without its own repository read", async () => {
    const { load } = renderGroup();
    expect(await screen.findByText(/#12 List active pull requests/)).toBeVisible();
    expect(load).toHaveBeenCalledWith({ version: 1 });
    // Rows another connected Project owns stay on the complete overview.
    expect(screen.queryByText(/#4 Another Project's pull request/)).not.toBeInTheDocument();
    expect(screen.getByText(/in this Project \(octant\/octant\)\./)).toBeVisible();
  });

  it("marks the pull request linked to the active thread", async () => {
    renderGroup();
    expect(await screen.findByText("Linked: this thread", { exact: false })).toBeInTheDocument();
  });

  it("opens a row's Review surface and the complete overview through the wired routes", async () => {
    const user = userEvent.setup();
    const onSelectRow = vi.fn();
    const onOpenAll = vi.fn();
    renderGroup({ onOpenAll, onSelectRow });
    await user.click(await screen.findByRole("button", { name: /#12 List active pull requests/ }));
    expect(onSelectRow).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: projectA, number: 12 }),
    );
    await user.click(screen.getByRole("button", { name: /All pull requests/ }));
    expect(onOpenAll).toHaveBeenCalled();
  });

  it("refreshes only this Project's repository on demand", async () => {
    const user = userEvent.setup();
    const { refresh } = renderGroup();
    await screen.findByText(/#12 List active pull requests/);
    await user.click(screen.getByRole("button", { name: "Refresh pull requests" }));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({ kind: "refresh-project", projectId: projectA }),
    );
  });

  it("keeps an authoritative empty result explicit", async () => {
    renderGroup({ load: vi.fn(async () => view({ rows: [] })) });
    expect(await screen.findByText(/No open or draft pull requests/)).toBeVisible();
  });

  it("reports a successful refresh that found no pull requests, not a missing snapshot", async () => {
    renderGroup({
      load: vi.fn(async () =>
        view({
          freshness: { status: "empty", lastSuccessfulRefreshAt: generatedAt },
          rows: [],
        }),
      ),
    });
    expect(await screen.findByText(/0 pull requests in this Project/)).toBeVisible();
    expect(screen.getByText(/Last successful refresh/)).toBeVisible();
    expect(screen.queryByText(/No GitHub snapshot yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/No open or draft pull requests/)).toBeVisible();
  });

  it("labels a stale snapshot rather than presenting it as current", async () => {
    renderGroup({
      load: vi.fn(async () =>
        view({
          freshness: {
            status: "stale",
            staleReason: "refresh-failed",
            lastSuccessfulRefreshAt: generatedAt,
          },
        }),
      ),
    });
    expect(await screen.findByText(/last refresh failed/i)).toBeVisible();
    expect(await screen.findByText(/cached pull request/i)).toBeVisible();
    expect(await screen.findByText(/#12 List active pull requests/)).toBeVisible();
  });

  it("says so when the Project is not on GitHub", async () => {
    renderGroup({
      load: vi.fn(async () =>
        view({
          projects: [{ kind: "unconnected", projectId: projectA, projectName: "Octant" }],
          rows: [],
        }),
      ),
    });
    expect(await screen.findByText("This Project is not on GitHub.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Refresh pull requests" })).not.toBeInTheDocument();
  });

  it("reports a failed snapshot read", async () => {
    renderGroup({ load: vi.fn(async () => Promise.reject(new Error("offline"))) });
    expect(await screen.findByText("The pull-request list could not be read.")).toBeVisible();
  });
});
