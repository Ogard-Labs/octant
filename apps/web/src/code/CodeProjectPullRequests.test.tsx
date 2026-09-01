import {
  decodeCodeProjectPullRequestView,
  type CodeProjectPullRequestQuery,
  type CodeProjectPullRequestRefreshCommand,
  type CodeProjectPullRequestView,
} from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodeProjectPullRequests } from "./CodeProjectPullRequests";

const projectA = "10000000-0000-4000-8000-000000000001";
const projectB = "10000000-0000-4000-8000-000000000002";
const threadId = "20000000-0000-4000-8000-000000000001";
const generatedAt = "2026-08-22T08:00:00.000Z";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}

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
    readonly backgroundRefresh?: {
      readonly enabledFor: (projectId: import("@octant/contracts").ProjectId) => boolean;
      readonly setEnabled: (
        projectId: import("@octant/contracts").ProjectId,
        enabled: boolean,
      ) => Promise<boolean>;
    };
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
      {...(options.backgroundRefresh === undefined
        ? {}
        : { backgroundRefresh: options.backgroundRefresh })}
    />,
  );
  return { load, refresh };
}

describe("CodeProjectPullRequests", () => {
  it("loads the cached snapshot on open and does not refresh GitHub", async () => {
    const { load, refresh } = renderWorkspace();

    expect(await screen.findByRole("heading", { name: "Pull requests" })).toBeVisible();
    expect(await screen.findByText("List active pull requests")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search pull requests" })).toBeVisible();
    expect(screen.getByText("1 pull request")).toBeVisible();
    expect(load).toHaveBeenCalledWith({ version: 1 });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("guides setup instead of offering refresh and search before a Code Project exists", async () => {
    renderWorkspace({
      load: vi.fn(async () => view({ projects: [], rows: [] })),
    });

    const title = await screen.findByText("No Code Projects yet");
    expect(title.closest("[role='status']")).toHaveClass("surface-empty");
    expect(screen.getByText("Add a Code Project to see pull requests here.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Refresh all" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search pull requests" })).toBeNull();
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
      within(notes).getByText(
        "No github.com origin detected. Add one to this Project to enable pull-request refresh.",
      ),
    ).toBeVisible();
    expect(octant.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("toggles a connected Project's background refresh through the authoritative setter", async () => {
    const user = userEvent.setup();
    const setEnabled = vi.fn(async () => true);
    renderWorkspace({
      backgroundRefresh: { enabledFor: () => false, setEnabled },
    });
    await screen.findByText("List active pull requests");

    const toggle = screen.getByRole("button", { name: "Background refresh for Octant" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Background refresh off");
    // The unconnected Project has nothing to refresh, so it gets no toggle.
    expect(
      screen.queryByRole("button", { name: "Background refresh for Local notes" }),
    ).not.toBeInTheDocument();

    await user.click(toggle);
    expect(setEnabled).toHaveBeenCalledWith(projectA, true);
  });

  it("explains an unavailable background refresh instead of pretending cards will update", async () => {
    renderWorkspace({
      load: vi.fn(async () =>
        view({
          backgroundRefresh: [{ projectId: projectA, state: "unavailable" }],
        }),
      ),
      backgroundRefresh: { enabledFor: () => true, setEnabled: vi.fn(async () => true) },
    });

    expect(
      await screen.findByText(
        "Background refresh is unavailable: the GitHub CLI is missing or not authenticated.",
      ),
    ).toBeVisible();
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
    // The surface reads and refreshes pull requests; it never mutates one. A
    // row's own name carries its review state ("Review approved"), so only a
    // control that starts with a mutating verb counts.
    expect(
      within(screen.getByRole("region", { name: "Pull requests" })).queryByRole("button", {
        name: /^(merge|approve|comment|close|force-push)\b/i,
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
          state: "open",
          mergeability: "unknown",
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

  it("does not present a failed GitHub refresh as an empty zero-count snapshot", async () => {
    const stale = view({
      rows: [],
      freshness: { status: "stale", staleReason: "disconnected" },
    });
    renderWorkspace({ load: async () => stale, refresh: async () => stale });

    expect(
      await screen.findByText(
        "GitHub access is unavailable. Check the GitHub CLI connection, then refresh.",
      ),
    ).toBeVisible();
    expect(screen.getByText("No cached pull requests")).toBeVisible();
    expect(screen.queryByText("0 pull requests")).not.toBeInTheDocument();
  });

  it("does not show an untouched connected Project as confirmed empty", async () => {
    const perProject = view({
      projects: [
        {
          kind: "connected",
          projectId: projectA,
          projectName: "AuroraDocs",
          repositoryOwner: "octant",
          repositoryName: "aurora",
        },
        {
          kind: "connected",
          projectId: projectB,
          projectName: "Divetools",
          repositoryOwner: "octant",
          repositoryName: "divetools",
        },
      ],
      rows: [],
      freshness: { status: "fresh", lastSuccessfulRefreshAt: generatedAt },
      projectFreshness: [
        {
          projectId: projectA,
          freshness: { status: "empty", lastSuccessfulRefreshAt: generatedAt },
        },
        { projectId: projectB, freshness: { status: "empty" } },
      ],
    });
    renderWorkspace({ load: async () => perProject, refresh: async () => perProject });

    const aurora = await screen.findByRole("region", { name: "Project AuroraDocs" });
    const divetools = screen.getByRole("region", { name: "Project Divetools" });
    expect(within(aurora).getByText("No open or draft pull requests.")).toBeVisible();
    expect(
      within(divetools).getByText("Not refreshed yet. Refresh this Project to load pull requests."),
    ).toBeVisible();
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

  it("filters the cached snapshot locally and clears the query without contacting GitHub", async () => {
    const user = userEvent.setup();
    const { load, refresh } = renderWorkspace();
    await screen.findByText("List active pull requests");

    const search = screen.getByRole("searchbox", { name: "Search pull requests" });
    await user.type(search, "missing title");
    expect(screen.getByText("No pull requests match “missing title”.")).toBeVisible();
    expect(screen.queryByText("List active pull requests")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear pull-request search" }));
    expect(await screen.findByText("List active pull requests")).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps pull-request row content from collapsing by separating metadata into its own column", () => {
    const rowContent = ruleBody(stylesheet, ".code-project-pull-requests__row-content");
    expect(rowContent).toMatch(/display:\s*grid/);
    expect(rowContent).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(rowContent).not.toMatch(/gap:\s*3px/);
    expect(rowContent).toMatch(/gap:\s*var\(--oct-space-2\)\s+var\(--oct-space-3\)/);

    const meta = ruleBody(stylesheet, ".code-project-pull-requests__meta");
    expect(meta).toMatch(/grid-column:\s*2/);
    expect(meta).toMatch(/grid-row:\s*1\s*\/\s*span\s+4/);

    const narrowMeta = ruleBody(
      stylesheet,
      '.code-project-pull-requests[data-narrow="true"] .code-project-pull-requests__meta',
    );
    expect(narrowMeta).toMatch(/grid-column:\s*1/);
    expect(narrowMeta).toMatch(/grid-row:\s*auto/);
  });
});
