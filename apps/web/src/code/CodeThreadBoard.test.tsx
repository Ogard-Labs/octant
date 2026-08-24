import type {
  CodeBoardCard,
  CodeBoardQuery,
  CodeBoardStatus,
  CodeBoardView,
} from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeThreadBoard } from "./CodeThreadBoard";

const projectA = "00000000-0000-4000-8000-0000000050a1" as ProjectId;
const projectB = "00000000-0000-4000-8000-0000000050a2" as ProjectId;

function card(overrides: {
  readonly id: string;
  readonly status: CodeBoardStatus;
  readonly title?: string;
  readonly projectId?: ProjectId;
  readonly recovering?: boolean;
  readonly followUp?: boolean;
  readonly checks?: CodeBoardCard["checks"];
  readonly activeAgents?: number;
  readonly blockingReason?: string;
  readonly worktree?: CodeBoardCard["worktree"];
  readonly changedFiles?: CodeBoardCard["changedFiles"];
  readonly linkedPullRequest?: CodeBoardCard["linkedPullRequest"];
  readonly reviewState?: CodeBoardCard["reviewState"];
  readonly lastMeaningfulActivityAt?: CodeBoardCard["lastMeaningfulActivityAt"];
}): CodeBoardCard {
  return {
    threadId: `00000000-0000-4000-8000-0000000051${overrides.id}`,
    projectId: overrides.projectId ?? projectA,
    checkoutId: "00000000-0000-4000-8000-0000000050ff",
    checkoutKind: "existing-worktree",
    title: overrides.title ?? `Thread ${overrides.id}`,
    status: overrides.status,
    statusReason:
      overrides.status === "done"
        ? "delivery-satisfied"
        : overrides.status === "in-progress"
          ? "executing"
          : overrides.status === "waiting"
            ? overrides.recovering
              ? "recovering"
              : "awaiting-input"
            : "idle-unmet-delivery",
    outcomeKind: "opened-pr",
    deliverySatisfaction: overrides.status === "done" ? "done" : "pending",
    providerInstanceId: "00000000-0000-4000-8000-0000000050fe",
    modelId: "model-a",
    executing: overrides.status === "in-progress",
    worktree: overrides.worktree ?? {
      kind: "unavailable",
      checkoutId: "00000000-0000-4000-8000-0000000050ff",
    },
    changedFiles: overrides.changedFiles ?? { kind: "unavailable" },
    linkedPullRequest: overrides.linkedPullRequest ?? { kind: "none", freshness: "fresh" },
    pullRequestSummaries: { items: [], hiddenCount: 0 },
    checks: overrides.checks ?? { freshness: "fresh", state: "unknown" },
    reviewState: overrides.reviewState ?? { freshness: "fresh", state: "unknown" },
    childAgents: {
      active: overrides.activeAgents ?? 0,
      completed: 0,
      failed: 0,
      unacknowledgedResults: 0,
    },
    recovery: overrides.recovering
      ? { kind: "recovering", reasons: ["project-projection-missing"] }
      : { kind: "ok" },
    githubFreshness: "fresh",
    ...(overrides.blockingReason === undefined ? {} : { blockingReason: overrides.blockingReason }),
    followUp: overrides.followUp ?? false,
    lastMeaningfulActivityAt: overrides.lastMeaningfulActivityAt ?? null,
  } as unknown as CodeBoardCard;
}

function view(
  cards: readonly CodeBoardCard[],
  statuses?: readonly CodeBoardStatus[],
): CodeBoardView {
  return {
    version: 1,
    query: statuses === undefined ? { version: 1 } : { version: 1, statuses: [...statuses] },
    cards: [...cards],
    generatedAt: "2026-07-22T10:00:00.000Z",
  } as unknown as CodeBoardView;
}

const projects = [
  { id: projectA, name: "Project A" },
  { id: projectB, name: "Project B" },
];

/** The card article that owns the thread title, whatever column it is in. */
function cardFor(title: string): HTMLElement {
  const card = screen.getByRole("button", { name: title }).closest("article");
  if (card === null) throw new Error(`Expected a board card for ${title}`);
  return card;
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("CodeThreadBoard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("overlays client unread without reading unread from the server card", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({ id: "01", status: "ready", title: "Unread thread" }),
        card({ id: "02", status: "ready", title: "Read thread" }),
      ]),
    );
    render(
      <CodeThreadBoard
        loadBoard={loadBoard}
        onOpenThread={() => undefined}
        projects={projects}
        storage={memoryStorage()}
        unreadThreadIds={new Set(["00000000-0000-4000-8000-000000005101"])}
      />,
    );

    await screen.findByRole("button", { name: "Unread thread" });
    expect(within(cardFor("Unread thread")).getByRole("img", { name: "Unread" })).toBeTruthy();
    expect(within(cardFor("Read thread")).queryByRole("img", { name: "Unread" })).toBeNull();
  });

  it("renders every Status column by default, including empty ones, and opens a thread", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({ id: "01", status: "ready", title: "Ready thread" }),
        card({ id: "02", status: "done", title: "Done thread" }),
      ]),
    );
    const onOpenThread = vi.fn();
    render(
      <CodeThreadBoard
        loadBoard={loadBoard}
        onOpenThread={onOpenThread}
        projects={projects}
        storage={memoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: "Ready thread" });
    // All four status columns are present in the approved order; empty ones stay
    // visible with a quiet placeholder so the view reads as a board.
    const columns = screen.getAllByRole("region", { name: /\(\d+\)$/ });
    expect(columns.map((column) => column.getAttribute("aria-label"))).toEqual([
      "Ready (1)",
      "In Progress (0)",
      "Waiting (0)",
      "Done (1)",
    ]);
    const doneColumn = screen.getByRole("region", { name: "Done (1)" });
    expect(within(doneColumn).getByText("Done thread")).toBeVisible();
    const waitingColumn = screen.getByRole("region", { name: "Waiting (0)" });
    expect(within(waitingColumn).getByText("No threads")).toBeVisible();

    fireEvent.click(screen.getByText("View"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show empty groups" }));
    expect(screen.queryByRole("region", { name: "In Progress (0)" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Ready (1)" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Ready thread" }));
    expect(onOpenThread).toHaveBeenCalledWith({
      threadId: "00000000-0000-4000-8000-000000005101",
      projectId: projectA,
    });
  });

  it("remembers the empty-group view preference on this client", async () => {
    const loadBoard = vi.fn(async () => view([card({ id: "01", status: "ready" })]));
    const storage = memoryStorage();
    const first = render(
      <CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={storage} />,
    );

    await screen.findByText("Thread 01");
    expect(screen.getByRole("region", { name: "Done (0)" })).toBeVisible();
    fireEvent.click(screen.getByText("View"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show empty groups" }));
    expect(screen.queryByRole("region", { name: "Done (0)" })).not.toBeInTheDocument();
    first.unmount();

    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={storage} />);
    await screen.findByText("Thread 01");
    expect(screen.queryByRole("region", { name: "Done (0)" })).not.toBeInTheDocument();
  });

  it("keeps the loaded board when its host re-renders with a fresh callback", async () => {
    const loadBoard = vi.fn(async (_query: CodeBoardQuery) =>
      view([card({ id: "01", status: "ready" })]),
    );
    const storage = memoryStorage();
    const { rerender } = render(
      <CodeThreadBoard
        loadBoard={(query) => loadBoard(query)}
        projects={projects}
        storage={storage}
      />,
    );

    await screen.findByText("Thread 01");
    expect(loadBoard).toHaveBeenCalledTimes(1);

    // The shell re-renders constantly while threads stream. A new inline
    // callback each time is not a new question about the board, and treating
    // it as one dropped the board back to "Loading" over and over.
    rerender(
      <CodeThreadBoard
        loadBoard={(query) => loadBoard(query)}
        projects={projects}
        storage={storage}
      />,
    );

    expect(screen.getByText("Thread 01")).toBeVisible();
    expect(screen.queryByText("Loading the board.")).toBeNull();
    expect(loadBoard).toHaveBeenCalledTimes(1);
  });

  it("switches to Project grouping without issuing another board query", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({ id: "01", status: "ready", projectId: projectA, title: "A thread" }),
        card({ id: "02", status: "waiting", projectId: projectB, title: "B thread" }),
      ]),
    );
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByRole("region", { name: "Ready (1)" });
    expect(loadBoard).toHaveBeenCalledTimes(1);

    // Status grouping: the column header states the status visibly, so the card
    // carries it for assistive technology instead of relying on the dot color.
    const statusStatus = within(cardFor("A thread")).getByText("Ready");
    expect(statusStatus).toHaveClass("sr-only");

    fireEvent.click(screen.getByRole("radio", { name: "Project" }));

    expect(await screen.findByRole("region", { name: "Project A (1)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Project B (1)" })).toBeVisible();
    // Project grouping: no column states the status, so every card shows it as
    // a visible chip rather than a colored dot alone.
    const projectStatus = within(cardFor("A thread")).getByText("Ready");
    expect(projectStatus).toBeVisible();
    expect(projectStatus).not.toHaveClass("sr-only");
    expect(within(cardFor("B thread")).getByText("Waiting")).toBeVisible();
    // Grouping is a pure client projection: no additional server query.
    expect(loadBoard).toHaveBeenCalledTimes(1);
  });

  it("re-queries with an explicit status filter and can restore the all-status default", async () => {
    const loadBoard = vi.fn(async (query: CodeBoardQuery) => {
      const statuses = query.statuses ?? (["ready", "in-progress", "waiting", "done"] as const);
      const all = [
        card({ id: "01", status: "ready", title: "Ready thread" }),
        card({ id: "02", status: "waiting", title: "Waiting thread" }),
      ];
      return view(
        all.filter((c) => statuses.includes(c.status)),
        query.statuses,
      );
    });
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByText("Ready thread");
    expect(loadBoard).toHaveBeenLastCalledWith({ version: 1 });
    expect(screen.queryByRole("checkbox", { name: "Ready" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    // Unchecking Ready leaves an explicit, summarized status filter.
    fireEvent.click(screen.getByRole("checkbox", { name: "Ready" }));
    await waitFor(() =>
      expect(loadBoard).toHaveBeenLastCalledWith({
        version: 1,
        statuses: ["in-progress", "waiting", "done"],
      }),
    );
    expect(screen.getByText("3 statuses")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(loadBoard).toHaveBeenLastCalledWith({ version: 1 }));
  });

  it("keeps advanced filters in a Filters popover and summarizes active choices", async () => {
    const loadBoard = vi.fn(async () => view([card({ id: "01", status: "ready" })]));
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByText("Thread 01");
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Pull request" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("dialog", { name: "Filters" });
    expect(within(panel).getByRole("checkbox", { name: "Ready" })).toBeChecked();
    fireEvent.change(within(panel).getByRole("combobox", { name: "Project" }), {
      target: { value: String(projectB) },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
      target: { value: "open" },
    });

    await waitFor(() =>
      expect(loadBoard).toHaveBeenLastCalledWith({
        version: 1,
        projectIds: [projectB],
        pullRequest: "open",
      }),
    );
    expect(screen.getByRole("button", { name: "Filters, 2 active" })).toBeVisible();
    const activeFilters = screen.getByRole("status", { name: "Active filters" });
    expect(within(activeFilters).getByText("Project B")).toBeVisible();
    expect(within(activeFilters).getByText("Open PR")).toBeVisible();

    fireEvent.click(within(panel).getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(loadBoard).toHaveBeenLastCalledWith({ version: 1 }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    // Escape unmounts the dialog the person was in, so focus goes back to the
    // control that opened it rather than falling to the document body.
    expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus();
  });

  it("shows a typed search term as typed in the active filters, not as an uppercase label", async () => {
    const loadBoard = vi.fn(async () => view([card({ id: "01", status: "ready" })]));
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByText("Thread 01");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads" }), {
      target: { value: "MixedCase term" },
    });
    await waitFor(() =>
      expect(loadBoard).toHaveBeenLastCalledWith({ version: 1, text: "MixedCase term" }),
    );

    const activeFilters = screen.getByRole("status", { name: "Active filters" });
    // The tag recipe uppercases labels; a tag carrying what the person typed
    // opts out via the value modifier so the term renders verbatim.
    const searchTag = within(activeFilters).getByText("Search: MixedCase term");
    expect(searchTag).toHaveClass("tag", "tag-value");

    // Fixed-vocabulary filter labels stay plain tags and keep the label look.
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
      target: { value: "open" },
    });
    expect(await within(activeFilters).findByText("Open PR")).not.toHaveClass("tag-value");
    // A Project name is user-entered text too, so its tag renders verbatim.
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: String(projectB) },
    });
    expect(await within(activeFilters).findByText("Project B")).toHaveClass("tag", "tag-value");
  });

  it("keeps secondary card metadata collapsed until Details is opened", async () => {
    const loadBoard = vi.fn(async () =>
      view([card({ id: "01", status: "waiting", title: "Waiting thread" })]),
    );
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    await screen.findByText("Waiting thread");
    const metadata = screen.getByText("Delivery target").closest("dl");
    expect(metadata).not.toBeNull();
    if (metadata === null) throw new Error("Expected card metadata");
    expect(metadata).not.toBeVisible();

    fireEvent.click(screen.getByText("Details"));
    expect(metadata).toBeVisible();
    expect(within(metadata).getByText("Project A")).toBeVisible();
    expect(within(metadata).getByText(/Opened PR/)).toBeVisible();
  });

  it("keeps failing checks and active agents visible in the board scan path", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({
          id: "01",
          status: "waiting",
          checks: { freshness: "fresh", state: "failing" },
          activeAgents: 2,
        }),
      ]),
    );
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    expect(await screen.findByText("Checks failing")).toBeVisible();
    expect(screen.getByText("2 active runs")).toBeVisible();
  });

  it("explains active filters on an empty result without implying deletion", async () => {
    const loadBoard = vi.fn(async () => view([]));
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const message = await screen.findByText("No Code threads match the current filters.");
    const empty = message.closest("[role='status']");
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent("No threads were deleted or completed");

    // Status grouping still shows its four fixed columns: the column view is
    // the point, and a board with nothing in it is when its shape matters most.
    for (const column of ["Ready (0)", "In Progress (0)", "Waiting (0)", "Done (0)"]) {
      const region = screen.getByRole("region", { name: column });
      expect(within(region).getByText("No threads")).toBeVisible();
    }
  });

  it("keeps a recovering thread in Waiting with its specific reason visible", async () => {
    const loadBoard = vi.fn(async () =>
      view([card({ id: "01", status: "waiting", title: "Recovering thread", recovering: true })]),
    );
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    const waiting = await screen.findByRole("region", { name: "Waiting (1)" });
    expect(within(waiting).getByText("Recovering thread")).toBeVisible();
    expect(within(waiting).getByText(/Project projection missing/)).toBeVisible();
    expect(screen.queryByRole("region", { name: /Recovery/ })).not.toBeInTheDocument();
  });

  it("keeps a specific Waiting reason visible in the narrow grouped list", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({
          id: "01",
          status: "waiting",
          title: "Blocked thread",
          blockingReason: "Runtime work is waiting for a decision or input.",
        }),
      ]),
    );
    render(
      <CodeThreadBoard
        isNarrow
        loadBoard={loadBoard}
        projects={projects}
        storage={memoryStorage()}
      />,
    );

    expect(await screen.findByText("Blocked thread")).toBeVisible();
    expect(screen.getByText("Runtime work is waiting for a decision or input.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Ready (0)" })?.className).toContain(
      "code-board__list-group",
    );
  });

  it("preserves the last useful view while refreshing and after a later failure", async () => {
    let resolveBoard: ((value: CodeBoardView) => void) | undefined;
    const loadBoard = vi
      .fn()
      .mockImplementationOnce(async () =>
        view([card({ id: "01", status: "ready", title: "Kept" })]),
      )
      .mockImplementationOnce(
        () =>
          new Promise<CodeBoardView>((resolve) => {
            resolveBoard = resolve;
          }),
      )
      .mockImplementationOnce(async () => {
        throw new Error("The host could not refresh the board.");
      });
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    expect(await screen.findByText("Kept")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(await screen.findByText("Refreshing local board state.")).toBeVisible();
    expect(screen.getByText("Kept")).toBeVisible();
    resolveBoard?.(view([card({ id: "01", status: "ready", title: "Kept" })]));
    await waitFor(() => expect(screen.queryByText("Refreshing local board state.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The host could not refresh the board. Showing the last useful view.",
    );
    expect(screen.getByText("Kept")).toBeVisible();
  });

  it("shows Project, checkout, branch, files, provider, child runs, PR, checks, review, delivery, follow-up, recovery, and activity", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card({
          id: "01",
          status: "waiting",
          title: "Full card",
          recovering: true,
          followUp: true,
          checks: { freshness: "fresh", state: "failing" },
          reviewState: { freshness: "stale", state: "changes-requested" },
          activeAgents: 1,
          worktree: {
            kind: "available",
            checkoutId: "00000000-0000-4000-8000-0000000050ff",
            path: "/tmp/wt",
            head: { kind: "branch", name: "feature/board", oid: "a".repeat(40) },
          } as CodeBoardCard["worktree"],
          changedFiles: {
            kind: "observed",
            freshness: "fresh",
            changedPathCount: 3,
            stagedCount: 1,
            committedAhead: 1,
            workingTreeClean: false,
          },
          linkedPullRequest: {
            kind: "linked",
            freshness: "stale",
            number: 18,
            url: "https://github.com/acme/repo/pull/18",
            baseRepository: "acme/repo",
            baseBranch: "development",
            headBranch: "feature/board",
            state: "open",
            matchesDeliveryBranch: true,
          },
          lastMeaningfulActivityAt:
            "2026-07-22T10:00:00.000Z" as CodeBoardCard["lastMeaningfulActivityAt"],
        }),
      ]),
    );
    render(
      <CodeThreadBoard
        loadBoard={loadBoard}
        projects={projects}
        providerLabels={new Map([["00000000-0000-4000-8000-0000000050fe", "Studio"]])}
        storage={memoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: "Full card" });
    const article = cardFor("Full card");
    const facts = article.querySelector(".board-card-facts");
    if (facts === null) throw new Error("Expected card facts");
    expect(facts).toHaveTextContent("Project A");
    expect(facts).toHaveTextContent("Current checkout");
    expect(facts).toHaveTextContent("feature/board");
    expect(facts).toHaveTextContent("3 files");
    expect(facts).toHaveTextContent("Studio · model-a");
    expect(facts).toHaveTextContent("1 active run");
    expect(facts).toHaveTextContent("#18 · stale");
    expect(facts).toHaveTextContent("Checks failing");
    expect(facts).toHaveTextContent("Review changes requested");
    expect(facts).toHaveTextContent("Opened PR · pending");
    expect(facts).toHaveTextContent("Follow-up");
    const waitingReason = within(article).getByText(/Project projection missing/);
    expect(waitingReason).toBeVisible();
    expect(waitingReason).toHaveClass("board-card-blocked");
  });

  it("renders a recoverable error state when the first board query fails", async () => {
    const loadBoard = vi.fn(async () => {
      throw new Error("Code Thread Board is unavailable.");
    });
    render(<CodeThreadBoard loadBoard={loadBoard} projects={projects} storage={memoryStorage()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Code Thread Board is unavailable.");
  });
});
