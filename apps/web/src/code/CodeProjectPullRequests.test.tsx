import {
  decodeCodeProjectPullRequestView,
  type CodeProjectPullRequestQuery,
  type CodeProjectPullRequestRefreshCommand,
  type CodeProjectPullRequestView,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodeProjectPullRequests } from "./CodeProjectPullRequests";

const projectA = "10000000-0000-4000-8000-000000000001";
const projectB = "10000000-0000-4000-8000-000000000002";
const projectAId = decodeProjectId(projectA);
const projectBId = decodeProjectId(projectB);
const workProjectId = decodeProjectId("10000000-0000-4000-8000-000000000003");
const threadId = "20000000-0000-4000-8000-000000000001";
const generatedAt = "2026-08-22T08:00:00.000Z";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles/code.css"), "utf8");

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

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

type RowOverrides = Record<string, unknown>;

/** Three pull requests across two repositories, each with a distinct age. */
function threeRepositoryView(): CodeProjectPullRequestView {
  const base = {
    projectId: projectA,
    projectName: "Octant",
    repositoryOwner: "octant",
    repositoryName: "octant",
    draft: false,
    state: "open",
    mergeability: "mergeable",
    author: "octocat",
    baseBranch: "development",
    headBranch: "feature/x",
    checks: "passing",
    review: "approved",
    linkedThreads: [],
  };
  const rows: ReadonlyArray<RowOverrides> = [
    { ...base, number: 1, title: "Oldest in octant", updatedAt: "2026-08-20T07:00:00.000Z" },
    { ...base, number: 2, title: "Newest in octant", updatedAt: "2026-08-22T07:00:00.000Z" },
    {
      ...base,
      projectId: projectB,
      projectName: "Aurora",
      repositoryName: "aurora",
      number: 3,
      title: "Middle in aurora",
      updatedAt: "2026-08-21T07:00:00.000Z",
    },
  ];
  return view({
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
        projectName: "Aurora",
        repositoryOwner: "octant",
        repositoryName: "aurora",
      },
    ],
    rows,
  });
}

/** Opens a header menu once any menu that was open has finished closing. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(screen.getByRole("button", { name }));
}

function titlesInOrder(): ReadonlyArray<string> {
  return Array.from(document.querySelectorAll(".code-project-pull-requests__title")).map(
    (element) => element.textContent ?? "",
  );
}

function renderWorkspace(
  options: {
    readonly storage?: Pick<Storage, "getItem" | "setItem">;
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
    readonly agentMerge?: {
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
      storage={options.storage ?? memoryStorage()}
      {...(options.onSelectRow === undefined ? {} : { onSelectRow: options.onSelectRow })}
      {...(options.backgroundRefresh === undefined
        ? {}
        : { backgroundRefresh: options.backgroundRefresh })}
      {...(options.agentMerge === undefined ? {} : { agentMerge: options.agentMerge })}
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

  it("names the one thing holding a pull request up, and dates it compactly", async () => {
    // The clock is pinned so "3h" is stable, but time still advances, or
    // every `findBy` in this file waits on a clock that never moves.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    try {
      const blocked = view();
      const rows = blocked.rows.map((existing) => ({
        ...existing,
        checks: "failing" as const,
        review: "pending" as const,
        mergeability: "mergeable" as const,
      }));
      renderWorkspace({ load: vi.fn(async () => ({ ...blocked, rows })) });

      // Red "Checks failing" beside a green "Mergeable" told the reader two
      // opposite things about one row. Failing checks are what blocks it, so
      // that is the only word on the row's trailing edge, and the others stay
      // available as text.
      const failing = await screen.findByText("Checks failing");
      expect(failing.closest("[data-status]")).toHaveAttribute("data-status", "negative");
      expect(screen.queryByText("Mergeable")).toBeNull();
      expect(screen.queryByText("Review pending")).toBeNull();
      expect(
        screen.getByText("Checks failing. Review pending. Mergeable.", { selector: ".sr-only" }),
      ).toBeInTheDocument();

      // "22.8.2026, 09:00:00" is a fact nobody reads; the exact time stays on
      // the element for anyone who wants it.
      const when = screen.getByText("3h");
      expect(when.tagName).toBe("TIME");
      expect(when).toHaveAttribute("title");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a row as a title and one meta line with the number at the trailing edge", async () => {
    renderWorkspace();

    const row = await screen.findByRole("button", { name: /List active pull requests/i });
    expect(within(row).getByText("List active pull requests")).toHaveClass(
      "code-project-pull-requests__title",
    );
    const meta = row.querySelector(".code-project-pull-requests__meta");
    expect(meta).not.toBeNull();
    expect(within(row).getByRole("img", { name: "Open" })).toBeInTheDocument();
    expect(within(meta as HTMLElement).getByText("octant")).toBeVisible();
    expect(within(meta as HTMLElement).getByText("octocat")).toBeVisible();
    expect(within(meta as HTMLElement).getByText(/^(\d+[mhd]|now)$/)).toBeVisible();
    expect(within(row).getByText("#12")).toHaveClass("code-project-pull-requests__number");
    // Nothing is wrong with it, so nothing is said but a check.
    expect(row.querySelector(".code-project-pull-requests__ok")).not.toBeNull();
    expect(within(row).queryByText("Checks passing")).toBeNull();
    expect(
      within(row).getByText("Checks passing. Review approved. Mergeable.", {
        selector: ".sr-only",
      }),
    ).toBeInTheDocument();
    expect(
      within(row).getByText("Linked: Manual refresh", { selector: ".sr-only" }),
    ).toBeInTheDocument();
  });

  it("says Draft, Conflicts or the pending review in words on the trailing edge", async () => {
    const base = view().rows[0];
    if (base === undefined) throw new Error("fixture has a row");
    const rows = [
      { ...base, number: 1, title: "A draft", draft: true },
      { ...base, number: 2, title: "A conflict", mergeability: "conflicting" as const },
      { ...base, number: 3, title: "Awaiting review", review: "pending" as const },
    ];
    renderWorkspace({ load: async () => ({ ...view(), rows }) });

    const draft = await screen.findByRole("button", { name: /A draft/ });
    expect(within(draft).getByText("Draft", { selector: "[data-status]" })).toBeVisible();
    expect(within(draft).getByRole("img", { name: "Draft" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: /A conflict/ })).getByText("Conflicts", {
        selector: "[data-status]",
      }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("button", { name: /Awaiting review/ })).getByText("Review pending", {
        selector: "[data-status]",
      }),
    ).toBeVisible();
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

  it("lists rows flat by default and keeps Projects off GitHub to one line at the foot", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(await screen.findByText("List active pull requests")).toBeVisible();
    // No block per Project: the Project that is not on GitHub is one notice,
    // with its name a disclosure away.
    expect(screen.queryByRole("region", { name: "Local notes" })).toBeNull();
    const notice = screen.getByRole("note");
    expect(notice).toHaveTextContent("1 Project is not on GitHub");
    await user.click(within(notice).getByText("1 Project is not on GitHub"));
    expect(within(notice).getByText("Local notes")).toBeVisible();
    // The header carries the title and the count; the toolbar only the search.
    expect(within(screen.getByRole("banner")).getByText("1 pull request")).toBeVisible();
  });

  it("orders the list by update time, least recent first, or by repository", async () => {
    const user = userEvent.setup();
    renderWorkspace({ load: async () => threeRepositoryView() });
    await screen.findByText("Newest in octant");
    expect(titlesInOrder()).toEqual(["Newest in octant", "Middle in aurora", "Oldest in octant"]);

    await openMenu(user, "Sort pull requests");
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Recently updated",
      "Least recently updated",
      "Repository",
    ]);
    await user.click(await screen.findByRole("menuitemradio", { name: "Least recently updated" }));
    expect(titlesInOrder()).toEqual(["Oldest in octant", "Middle in aurora", "Newest in octant"]);

    await openMenu(user, "Sort pull requests");
    await user.click(await screen.findByRole("menuitemradio", { name: "Repository" }));
    // aurora sorts before octant; inside a repository the newest comes first.
    expect(titlesInOrder()).toEqual(["Middle in aurora", "Newest in octant", "Oldest in octant"]);
  });

  it("remembers the sort, grouping and filters the next time the page opens", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage();
    const first = render(
      <CodeProjectPullRequests
        load={async () => threeRepositoryView()}
        refresh={async () => threeRepositoryView()}
        storage={storage}
      />,
    );
    await screen.findByText("Newest in octant");
    await openMenu(user, "Sort pull requests");
    await user.click(await screen.findByRole("menuitemradio", { name: "Repository" }));
    await openMenu(user, "Sort pull requests");
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Group by repository" }));
    first.unmount();

    render(
      <CodeProjectPullRequests
        load={async () => threeRepositoryView()}
        refresh={async () => threeRepositoryView()}
        storage={storage}
      />,
    );
    expect(await screen.findByRole("region", { name: "octant/aurora" })).toBeVisible();
    expect(titlesInOrder()).toEqual(["Middle in aurora", "Newest in octant", "Oldest in octant"]);
  });

  it("groups by repository under a slim header with its count", async () => {
    const user = userEvent.setup();
    renderWorkspace({ load: async () => threeRepositoryView() });
    await screen.findByText("Newest in octant");

    await openMenu(user, "Sort pull requests");
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Group by repository" }));

    const octant = screen.getByRole("region", { name: "octant/octant" });
    const aurora = screen.getByRole("region", { name: "octant/aurora" });
    expect(within(octant).getByRole("heading", { name: "octant/octant" })).toBeVisible();
    expect(within(octant).getByText("2")).toBeVisible();
    expect(within(aurora).getByText("1")).toBeVisible();
    expect(within(octant).getByText("Newest in octant")).toBeVisible();
    expect(within(octant).queryByText("Middle in aurora")).toBeNull();
    // The group whose newest row is newest comes first under the default sort.
    expect(octant.compareDocumentPosition(aurora) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("narrows the list by review and checks and says so when nothing is left", async () => {
    const user = userEvent.setup();
    const base = view().rows[0];
    if (base === undefined) throw new Error("fixture has a row");
    const rows = [
      { ...base, number: 1, title: "Green", checks: "passing" as const },
      { ...base, number: 2, title: "Red", checks: "failing" as const },
    ];
    renderWorkspace({ load: async () => ({ ...view(), rows }) });
    await screen.findByText("Green");

    await openMenu(user, "Filter pull requests");
    await user.click(await screen.findByRole("menuitemradio", { name: "Checks failing" }));
    expect(titlesInOrder()).toEqual(["Red"]);
    expect(screen.getByRole("button", { name: "Filter pull requests, 1 active" })).toBeVisible();

    await user.keyboard("{Escape}");
    await openMenu(user, "Filter pull requests, 1 active");
    await user.click(await screen.findByRole("menuitemradio", { name: "Draft" }));
    expect(await screen.findByText("No pull requests match these filters")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titlesInOrder()).toHaveLength(2);
  });

  it("toggles a connected Project's auto-refresh from its group menu through the authoritative setter", async () => {
    const user = userEvent.setup();
    const setEnabled = vi.fn(async () => true);
    renderWorkspace({
      backgroundRefresh: { enabledFor: () => false, setEnabled },
      storage: memoryStorage({ "octant.code.pull-requests.group-by-repository": "true" }),
    });
    await screen.findByText("List active pull requests");

    await user.click(screen.getByRole("button", { name: "octant/octant settings" }));
    const toggle = await screen.findByRole("menuitemcheckbox", {
      name: "Auto-refresh Octant pull requests",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveTextContent("Auto-refresh");
    // A Project that is not on GitHub has nothing to refresh, so it has no group.
    expect(screen.queryByRole("button", { name: /Local notes/ })).toBeNull();

    await user.click(toggle);
    expect(setEnabled).toHaveBeenCalledWith(projectA, true);
  });

  it("reaches both Project switches from the page's menu when the list is not grouped", async () => {
    const user = userEvent.setup();
    const setBackground = vi.fn(async () => true);
    const setMerge = vi.fn(async () => true);
    renderWorkspace({
      backgroundRefresh: { enabledFor: () => false, setEnabled: setBackground },
      agentMerge: { enabledFor: () => true, setEnabled: setMerge },
    });
    await screen.findByText("List active pull requests");

    await openMenu(user, "Repository settings");
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Auto-refresh Octant pull requests" }),
    );
    expect(setBackground).toHaveBeenCalledWith(projectA, true);
    // A checked item leaves the menu open, so the next toggle is in the same one.
    await user.keyboard("{Escape}");

    await openMenu(user, "Repository settings");
    const merge = await screen.findByRole("menuitemcheckbox", {
      name: "Let agents merge Octant pull requests",
    });
    expect(merge).toHaveAttribute("aria-checked", "true");
    expect(merge).toHaveTextContent("Agents may merge");
    await user.click(merge);
    expect(setMerge).toHaveBeenCalledWith(projectA, false);
  });

  it("lets a local window turn on agents merging for a connected Project only", async () => {
    const user = userEvent.setup();
    const setEnabled = vi.fn(async () => true);
    renderWorkspace({
      agentMerge: { enabledFor: () => false, setEnabled },
      storage: memoryStorage({ "octant.code.pull-requests.group-by-repository": "true" }),
    });
    await screen.findByText("List active pull requests");

    await user.click(screen.getByRole("button", { name: "octant/octant settings" }));
    const toggle = await screen.findByRole("menuitemcheckbox", {
      name: "Let agents merge Octant pull requests",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByRole("menuitemcheckbox", {
        name: "Let agents merge Local notes pull requests",
      }),
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
        "Octant: Auto-refresh is unavailable: the GitHub CLI is missing or not authenticated.",
      ),
    ).toBeVisible();
  });

  it("refreshes all Projects or one Project only when those controls are used", async () => {
    const user = userEvent.setup();
    const { refresh } = renderWorkspace({
      storage: memoryStorage({ "octant.code.pull-requests.group-by-repository": "true" }),
    });
    await screen.findByText("List active pull requests");

    await user.click(screen.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ kind: "refresh-all" }));

    await user.click(await screen.findByRole("button", { name: "octant/octant settings" }));
    await user.click(await screen.findByRole("menuitem", { name: "Refresh Octant" }));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({ kind: "refresh-project", projectId: projectA }),
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
    const { rerender } = render(
      <CodeProjectPullRequests
        load={async () => perProject}
        refresh={async () => perProject}
        storage={memoryStorage({ "octant.code.pull-requests.group-by-repository": "true" })}
      />,
    );

    const aurora = await screen.findByRole("region", { name: "octant/aurora" });
    const divetools = screen.getByRole("region", { name: "octant/divetools" });
    expect(within(aurora).getByText("No open or draft pull requests.")).toBeVisible();
    expect(
      within(divetools).getByText("Not refreshed yet. Refresh this Project to load pull requests."),
    ).toBeVisible();

    // Flat, the same untouched Project is named in one line, not hidden.
    rerender(
      <CodeProjectPullRequests
        key="flat"
        load={async () => perProject}
        refresh={async () => perProject}
        storage={memoryStorage()}
      />,
    );
    expect(await screen.findByText("Not refreshed yet: Divetools.")).toBeVisible();
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

  it("scopes the dock presentation to one Project and drops the page shell", async () => {
    const user = userEvent.setup();
    const onSelectRow = vi.fn();
    render(
      <CodeProjectPullRequests
        load={async () => view()}
        onSelectRow={onSelectRow}
        presentation="dock"
        projectId={projectAId}
        refresh={async () => view()}
        storage={memoryStorage()}
      />,
    );

    expect(await screen.findByText("List active pull requests")).toBeVisible();
    // The dock names the surface in its own tab, so the list repeats neither a
    // page title nor a Back to workspace control.
    expect(screen.queryByRole("heading", { name: "Pull requests" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to workspace" })).toBeNull();
    // Another Project's notice is not this thread's business, and its absent
    // rows must not be reported as this Project's count.
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("1 pull request")).toBeVisible();
    // A single-Project list refreshes that Project; there is nothing for a
    // cross-Project "Refresh all" or the page's sort and settings to add.
    expect(screen.queryByRole("button", { name: "Refresh all" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sort pull requests" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Repository settings" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /List active pull requests/i }));
    expect(onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ number: 12 }));
  });

  it("names the snapshot as the scope of a truncated dock list, not the Project", async () => {
    const truncated = view({ repositoriesTruncated: true, pullRequestsTruncated: true });
    render(
      <CodeProjectPullRequests
        load={async () => truncated}
        presentation="dock"
        projectId={projectAId}
        refresh={async () => truncated}
      />,
    );

    expect(
      await screen.findByText(
        /Some of the snapshot's pull requests were omitted after the preview bound of 100\./,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        /Some connected repositories in the snapshot were omitted after the preview bound of 25\./,
      ),
    ).toBeVisible();
    // Beside one Project's still-visible rows, "some pull requests were
    // omitted" would read as this Project having lost rows.
    expect(screen.queryByText(/Some pull requests were omitted/)).toBeNull();
  });

  it("says why a Project the snapshot does not cover lists no pull requests", async () => {
    render(
      <CodeProjectPullRequests
        load={async () =>
          view({
            projects: [
              {
                kind: "connected",
                projectId: projectA,
                projectName: "Octant",
                repositoryOwner: "octant",
                repositoryName: "octant",
              },
            ],
            rows: [],
          })
        }
        presentation="dock"
        projectId={workProjectId}
        refresh={async () => view()}
      />,
    );

    expect(await screen.findByText("No pull-request source for this Project")).toBeVisible();
    expect(
      screen.getByText("Only a Code Project with a github.com origin lists pull requests."),
    ).toBeVisible();
    expect(screen.queryByText("No Code Projects yet")).toBeNull();
  });

  it("says a Project is not on GitHub instead of asking for a refresh that cannot help", async () => {
    render(
      <CodeProjectPullRequests
        load={async () => view()}
        presentation="dock"
        projectId={projectBId}
        refresh={async () => view()}
      />,
    );

    expect(await screen.findByText("This Project isn't on GitHub")).toBeVisible();
    // A remote added since the last look is found by checking again.
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(screen.queryByText(/Refresh to load|No GitHub snapshot/)).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search pull requests" })).toBeNull();
    expect(screen.queryByText("List active pull requests")).toBeNull();
  });

  it("says so when checking an off-GitHub Project again fails", async () => {
    const user = userEvent.setup();
    render(
      <CodeProjectPullRequests
        load={async () => view()}
        presentation="dock"
        projectId={projectBId}
        refresh={async () => {
          throw new Error("offline");
        }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The pull-request list could not be refreshed.",
    );
  });

  it("filters the cached snapshot locally and clears the query without contacting GitHub", async () => {
    const user = userEvent.setup();
    const { load, refresh } = renderWorkspace();
    await screen.findByText("List active pull requests");

    const search = screen.getByRole("searchbox", { name: "Search pull requests" });
    await user.type(search, "missing title");
    expect(screen.getByText("No pull requests match “missing title”")).toBeVisible();
    expect(screen.queryByText("List active pull requests")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear pull-request search" }));
    expect(await screen.findByText("List active pull requests")).toBeVisible();
    expect(search).toHaveFocus();
    expect(load).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the list to a readable measure at the page's leading edge", () => {
    const surface = ruleBody(stylesheet, ".code-project-pull-requests-surface");
    expect(surface).toMatch(/--oct-surface-measure:\s*720px/);
    expect(ruleBody(stylesheet, ".code-project-pull-requests-surface > .surface__inner")).toMatch(
      /margin-inline:\s*var\(--oct-surface-gutter\)\s+auto/,
    );
  });

  it("sizes a row from its two lines and cuts the title after two", () => {
    const row = ruleBody(stylesheet, ".code-project-pull-requests__row");
    expect(row).toMatch(/height:\s*auto/);
    expect(row).toMatch(/padding:\s*var\(--oct-space-2\)/);
    expect(row).not.toMatch(/border-bottom/);
    const title = ruleBody(stylesheet, ".code-project-pull-requests__title");
    expect(title).toMatch(/-webkit-line-clamp:\s*2/);
    expect(title).toMatch(/font-weight:\s*var\(--oct-weight-medium\)/);
    expect(ruleBody(stylesheet, ".code-project-pull-requests__number")).toMatch(
      /font-variant-numeric:\s*tabular-nums/,
    );
    expect(ruleBody(stylesheet, ".code-project-pull-requests__row:hover")).toContain(
      "background: var(--octant-control-hover);",
    );
    expect(ruleBody(stylesheet, '.code-project-pull-requests__row[aria-pressed="true"]')).toContain(
      "background: var(--oct-selection);",
    );
  });

  it("scrolls a long dock list inside the dock instead of letting the dock clip it", () => {
    // The dock's body clips (overflow: hidden) and the tool is the dock's full
    // height, so the list root has to be the bounded scroller: without a
    // height and its own overflow, rows past the dock's height had no way to
    // be reached.
    const dock = ruleBody(stylesheet, '.code-project-pull-requests[data-presentation="dock"]');
    expect(dock).toMatch(/height:\s*100%/);
    expect(dock).toMatch(/min-height:\s*0/);
    expect(dock).toMatch(/overflow:\s*auto/);
    expect(dock).toMatch(/align-content:\s*start/);
  });
});
