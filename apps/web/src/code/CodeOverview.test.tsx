import type { CodeBoardCard, CodeBoardView } from "@octant/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { CodeOverview } from "./CodeOverview";
import { CoordinatorProposalCards } from "./CoordinatorProposalCards";
import { reservePlannerAttempt, finishPlannerAttempt } from "./plannerProposalAttempt";
import type { PlannerProposalReview } from "./plannerProposalCreation";
import type { CodeController } from "./useCodeController";

describe("CodeOverview", () => {
  it("keeps an unresolved approval blocked after review close and component remount with a fresh pending read", async () => {
    const value = controller();
    const entry = {
      proposal: {
        id: "70000000-0000-4000-8000-000000000021",
        projectId: ids.project,
        plannerThreadId: ids.thread,
        title: "Uncertain task",
        intent: "Only this described task.",
        status: "pending",
        proposedAt: "2026-11-02T00:00:00.000Z",
      },
      proposalVersion: 1,
    } as PlannerProposalReview;
    const executePlannerProposal = vi.fn();
    value.client = {
      ...value.client,
      readPlanner: vi.fn(async () => ({
        designation: {
          kind: "none",
          projectId: ids.project,
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
        designationVersion: 0,
        proposals: [entry],
      })),
      executePlannerProposal,
    } as never;
    const onCreateThread = vi.fn();
    const onOpenThread = vi.fn();
    const element = (
      <CodeOverview
        controller={value}
        onOpenThread={onOpenThread}
        projectId={ids.project as never}
        showQuickStart={false}
        onCreateThread={onCreateThread}
      />
    );
    const rendered = render(element);
    try {
      await screen.findByText("Only this described task.");
      expect(screen.getByRole("button", { name: "Review and approve" })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "Review and approve" }));
      expect(
        reservePlannerAttempt(entry, "90000000-0000-4000-8000-000000000021" as never).status,
      ).toBe("none");
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("button", { name: "Review and approve" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Decline proposal" })).toBeDisabled();
      rendered.unmount();
      render(element);
      await screen.findByText("Only this described task.");
      expect(screen.getByRole("button", { name: "Review and approve" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Inspect submitted task" }));
      expect(onOpenThread).toHaveBeenCalledWith("90000000-0000-4000-8000-000000000021");
      expect(onCreateThread).not.toHaveBeenCalled();
      expect(executePlannerProposal).not.toHaveBeenCalled();
    } finally {
      finishPlannerAttempt(entry);
    }
  });

  it("keeps a stale proposal refused without retrying and disables decisions while disconnected", async () => {
    const value = controller();
    const executePlannerProposal = vi.fn(async () => ({
      status: "refused",
      reason: "proposal-changed",
      message: "The proposal changed; reload and retry.",
    }));
    value.client = {
      ...value.client,
      readPlanner: vi.fn(async () => ({
        designation: {
          kind: "none",
          projectId: ids.project,
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
        designationVersion: 0,
        proposals: [
          {
            proposal: {
              id: "70000000-0000-4000-8000-000000000003",
              projectId: ids.project,
              plannerThreadId: ids.thread,
              title: "Review parser",
              intent: "Only the described parser fix.",
              status: "pending",
              proposedAt: "2026-11-02T00:00:00.000Z",
            },
            proposalVersion: 2,
          },
        ],
      })),
      executePlannerProposal,
    } as never;
    const onCreateThread = vi.fn();
    const { rerender } = render(
      <CodeOverview
        controller={value}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
        showQuickStart={false}
        onCreateThread={onCreateThread}
      />,
    );
    await screen.findByText("Only the described parser fix.");
    fireEvent.click(screen.getByRole("button", { name: "Decline proposal" }));
    expect(await screen.findByText("The proposal changed; reload and retry.")).toBeVisible();
    expect(executePlannerProposal).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review and approve" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
    const review = await screen.findByRole("dialog", { name: "Approve planner proposal" });
    expect(review).toBeVisible();
    expect(
      within(review).getByRole("heading", { name: "Review the planner's proposal" }),
    ).toBeVisible();
    expect(
      within(review).queryByRole("heading", { name: "What are we building today?" }),
    ).not.toBeInTheDocument();
    expect(within(review).queryByText(/just start typing/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
      "Only the described parser fix.",
    );
    expect(screen.getByRole("button", { name: "Approve and start described task" })).toBeDisabled();
    expect(
      screen.getByText("Choose an available provider and model before approving this task."),
    ).toBeVisible();
    expect(onCreateThread).not.toHaveBeenCalled();
    rerender(
      <CodeOverview
        controller={{ ...value, status: "disconnected" }}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
        showQuickStart={false}
        onCreateThread={onCreateThread}
      />,
    );
    expect(screen.getByRole("button", { name: "Decline proposal", hidden: true })).toBeDisabled();
    expect(executePlannerProposal).toHaveBeenCalledTimes(1);
    const readPlanner = value.client.readPlanner;
    if (readPlanner === undefined) throw new Error("Expected planner fixture");
    const snapshot = await readPlanner(ids.project as never);
    const reconnect = Promise.withResolvers<typeof snapshot>();
    vi.mocked(readPlanner).mockReturnValueOnce(reconnect.promise);
    rerender(
      <CodeOverview
        controller={value}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
        showQuickStart={false}
        onCreateThread={onCreateThread}
      />,
    );
    expect(screen.getByRole("button", { name: "Decline proposal", hidden: true })).toBeDisabled();
    reconnect.resolve(snapshot);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Decline proposal", hidden: true })).toBeEnabled(),
    );
  });

  it("lets a person designate a same-Project planner and decline the exact current proposal", async () => {
    const value = controller();
    const proposalId = "70000000-0000-4000-8000-000000000001";
    const executePlanner = vi.fn(async () => ({ status: "designated" }));
    const executePlannerProposal = vi.fn(async () => ({ status: "declined" }));
    value.client = {
      ...value.client,
      readPlanner: vi.fn(async () => ({
        designation: {
          kind: "none",
          projectId: ids.project,
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
        designationVersion: 4,
        proposals: [
          {
            proposal: {
              id: proposalId,
              projectId: ids.project,
              plannerThreadId: ids.thread,
              title: "Describe the next task",
              intent: "Review the parser and fix the stale branch check.",
              status: "pending",
              proposedAt: "2026-11-02T00:00:00.000Z",
            },
            proposalVersion: 3,
          },
        ],
      })),
      executePlanner,
      executePlannerProposal,
    } as never;
    render(
      <CodeOverview
        controller={value}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
        showQuickStart={false}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Project planner" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Designate planner" }));
    await waitFor(() =>
      expect(executePlanner).toHaveBeenCalledWith({
        kind: "designate-code-planner-thread",
        projectId: ids.project,
        threadId: ids.thread,
        expectedVersion: 4,
      }),
    );
    expect(screen.getByText("Review the parser and fix the stale branch check.")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Decline proposal" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline proposal" }));
    await waitFor(() =>
      expect(executePlannerProposal).toHaveBeenCalledWith({
        kind: "decline-planner-work-proposal",
        proposalId,
        expectedVersion: 3,
      }),
    );
  });

  it("renders only authoritative thread, checkout, policy, and delivery facts", () => {
    const onOpenReview = vi.fn();
    const onOpenSurface = vi.fn();
    render(
      <CodeOverview
        controller={controller()}
        onOpenReview={onOpenReview}
        onOpenSurface={onOpenSurface}
        threadId={ids.thread as never}
      />,
    );

    expect(screen.getByRole("heading", { name: "Controller foundation" })).toBeVisible();
    expect(screen.getAllByText("development").length).toBeGreaterThan(0);
    expect(screen.getByText("Ask for approvals")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getByText("feature/controller → development")).toBeVisible();
    expect(screen.getByRole("region", { name: "Code status summary" })).toBeVisible();
    expect(screen.getByText("Local changes open in Review beside this thread.")).toBeVisible();
    expect(screen.getByText("Test summaries load when repository tests run.")).toBeVisible();
    expect(screen.getByText("Approval requests appear when the provider asks.")).toBeVisible();
    expect(screen.getByText("Review checkout changes")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View changes" }));
    expect(onOpenReview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(onOpenSurface).toHaveBeenCalledWith("code-terminal");
  });

  it("keeps Plan mode read-only and surfaces waiting state", () => {
    const value = controller();
    value.activeView = {
      ...value.activeView!,
      thread: { ...value.activeView!.thread, executionPolicy: "plan", lifecycle: "waiting" },
    };
    render(<CodeOverview controller={value} threadId={ids.thread as never} />);

    expect(screen.getByText("Plan · read-only")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Waiting");
    expect(screen.queryByRole("button", { name: /Run|Start|Approve/ })).not.toBeInTheDocument();
  });

  it("renders a recoverable disconnected state", () => {
    const retry = vi.fn();
    render(
      <CodeOverview
        controller={{
          ...controller(),
          activeView: undefined,
          errorMessage: "Code transport disconnected.",
          retry,
          status: "disconnected",
        }}
        threadId={ids.thread as never}
      />,
    );

    expect(screen.getByRole("heading", { name: "Code is disconnected" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry Code" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("renders each thread once with its reported facts inline beside the quick start", async () => {
    const onOpenThread = vi.fn();
    const onCreateThread = vi.fn();
    const value = controller();
    value.navigation = [
      {
        executionPolicy: "approval-gated",
        lifecycle: "active",
        providerInstanceId: "provider-one" as never,
        projectId: ids.project as never,
        threadId: ids.thread as never,
        title: "Controller foundation",
      },
      {
        executionPolicy: "full-access",
        lifecycle: "active",
        providerInstanceId: "provider-one" as never,
        projectId: "20000000-0000-4000-8000-000000000099" as never,
        threadId: "10000000-0000-4000-8000-000000000099" as never,
        title: "Another Project",
      },
    ];
    const board = boardView([
      boardCard({
        title: "Controller foundation",
        threadId: ids.thread as never,
        projectId: ids.project as never,
        worktree: {
          kind: "available",
          checkoutId: ids.checkout as never,
          path: "/opaque/worktree" as never,
          head: {
            kind: "branch",
            name: "feature/controller" as never,
            oid: "a".repeat(40) as never,
          },
        },
        changedFiles: {
          kind: "observed",
          freshness: "stale",
          changedPathCount: 3,
          stagedCount: 1,
          committedAhead: 2,
          workingTreeClean: false,
          insertions: 12,
          deletions: 3,
        },
        checks: { freshness: "fresh", state: "passing" },
        linkedPullRequest: {
          kind: "linked",
          freshness: "fresh",
          number: 806,
          url: "https://github.com/octocat/octant/pull/806" as never,
          baseRepository: "octocat/octant",
          baseBranch: "development",
          headBranch: "feature/controller",
          state: "open",
          matchesDeliveryBranch: true,
        },
        childAgents: {
          active: 1,
          completed: 2,
          failed: 0,
          unacknowledgedResults: 0,
          latestSummary: "Reviewing the checkout",
        },
        followUp: true,
        lastMeaningfulActivityAt: "2026-08-10T00:00:00.000Z" as never,
      }),
      boardCard({
        title: "Another Project",
        threadId: "10000000-0000-4000-8000-000000000099" as never,
        projectId: "20000000-0000-4000-8000-000000000099" as never,
      }),
    ]);
    value.client = {
      queryBoard: vi.fn(async (query) => {
        expect(query).toEqual({ version: 1, projectIds: [ids.project] });
        return board;
      }),
    } as never;
    render(
      <CodeOverview
        controller={value}
        errorMessage="The previous Code creation attempt was refused."
        onCreateThread={onCreateThread}
        onOpenThread={onOpenThread}
        projectId={ids.project as never}
        projectName="Controller Project"
        projectRoot="/opaque/repository"
      />,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Threads" })).toBeVisible());
    // The thread title appears once, on its own row — never repeated by a
    // facet section, because there are no facet sections any more.
    expect(screen.getAllByText("Controller foundation")).toHaveLength(1);
    expect(screen.queryByText("Another Project")).not.toBeInTheDocument();
    expect(screen.getByText("feature/controller")).toBeVisible();
    expect(
      screen.getByText("3 changed files · +12 −3 · 1 staged · 2 committed ahead · stale"),
    ).toBeVisible();
    expect(screen.getByText("Passing")).toBeVisible();
    expect(screen.getByText("#806 · open")).toBeVisible();
    expect(screen.getByText("1 active · 2 completed")).toBeVisible();
    expect(screen.getByText("In progress")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Controller foundation" }).closest("article"),
    ).toHaveTextContent("Ask for approvals");
    expect(screen.getByText("Follow-up")).toBeVisible();
    // Rarely-glanced facts stay reachable behind the per-thread disclosure.
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("/opaque/worktree")).toBeVisible();
    expect(screen.getByText("Opened pull request · Pending")).toBeVisible();
    expect(screen.getByText("Reviewing the checkout")).toBeVisible();
    expect(screen.getByRole("region", { name: "Code quick start" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName("Mode: Ask first");
    const message = screen.getByLabelText("First message");
    fireEvent.change(message, { target: { value: "Keep the draft" } });
    expect(message).toHaveValue("Keep the draft");
    // Pinning is only offered by this list, so a Project the board has already
    // projected cards for must still show the control rather than hiding the
    // command behind an empty-board state nobody reaches twice.
    fireEvent.click(screen.getByRole("button", { name: "Pin Controller foundation" }));
    expect(value.pinThread).toHaveBeenCalledWith(ids.thread, true);
    fireEvent.click(screen.getByRole("button", { name: "Controller foundation" }));
    expect(onOpenThread).toHaveBeenCalledWith(ids.thread);
  });

  it("shows a thread's branch fact only when the host reported one", async () => {
    const value = controller();
    value.navigation = [
      navigationThread({ threadId: ids.thread, title: "Controller foundation" }),
      navigationThread({
        threadId: "10000000-0000-4000-8000-000000000002",
        title: "Worktree pending",
      }),
    ];
    value.client = {
      queryBoard: vi.fn(async () =>
        boardView([
          boardCard({
            threadId: ids.thread as never,
            title: "Controller foundation",
            worktree: {
              kind: "available",
              checkoutId: ids.checkout as never,
              path: "/opaque/worktree" as never,
              head: {
                kind: "branch",
                name: "feature/controller" as never,
                oid: "a".repeat(40) as never,
              },
            },
          }),
          boardCard({
            threadId: "10000000-0000-4000-8000-000000000002" as never,
            title: "Worktree pending",
          }),
        ]),
      ),
    } as never;
    const { rerender } = render(
      <CodeOverview controller={value} onOpenThread={vi.fn()} projectId={ids.project as never} />,
    );

    expect(await screen.findByText("feature/controller")).toBeVisible();
    // Exactly one Branch row: the thread whose worktree the host reported.
    expect(screen.getAllByText("Branch")).toHaveLength(1);
    expect(screen.getByText("Worktree pending")).toBeVisible();
    rerender(
      <CodeOverview
        controller={{ ...value, status: "loading" }}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
      />,
    );
    expect(screen.getByText("feature/controller")).toBeVisible();
    expect(screen.queryByText("Loading threads…")).not.toBeInTheDocument();
    rerender(
      <CodeOverview
        controller={{ ...value, status: "loading" }}
        onOpenThread={vi.fn()}
        projectId={"20000000-0000-4000-8000-000000000099" as never}
      />,
    );
    expect(screen.queryByText("feature/controller")).not.toBeInTheDocument();
    expect(screen.getByText("Loading threads…")).toBeVisible();
    rerender(
      <CodeOverview controller={value} onOpenThread={vi.fn()} projectId={ids.project as never} />,
    );
    expect(await screen.findByText("feature/controller")).toBeVisible();
    rerender(
      <CodeOverview
        controller={{ ...value, status: "disconnected" }}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
      />,
    );
    expect(screen.queryByText("feature/controller")).not.toBeInTheDocument();
    expect(screen.getByText("Code projections unavailable")).toBeVisible();
  });

  it("renders no placeholder for a facet the host did not report", async () => {
    const value = controller();
    value.navigation = [navigationThread({ threadId: ids.thread, title: "Controller foundation" })];
    value.client = {
      queryBoard: vi.fn(async () =>
        boardView([boardCard({ threadId: ids.thread as never, title: "Controller foundation" })]),
      ),
    } as never;
    render(
      <CodeOverview controller={value} onOpenThread={vi.fn()} projectId={ids.project as never} />,
    );

    expect(await screen.findByText("Controller foundation")).toBeVisible();
    // Absent facets are absent rows, not sentences about absence.
    expect(screen.queryByText(/Unknown/)).not.toBeInTheDocument();
    expect(screen.queryByText("None reported.")).not.toBeInTheDocument();
    expect(screen.queryByText("No projection is currently reported.")).not.toBeInTheDocument();
    expect(screen.queryByText("Changed files unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText(/no mutation is authorized/)).not.toBeInTheDocument();
    expect(screen.queryByText("No linked pull request reported.")).not.toBeInTheDocument();
    expect(screen.queryByText("Branch")).not.toBeInTheDocument();
    expect(screen.queryByText("Changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Checks")).not.toBeInTheDocument();
    expect(screen.queryByText("Pull request")).not.toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
  });

  it("counts waiting threads in the section label and never repeats the repository per thread", async () => {
    const value = controller();
    value.navigation = [
      navigationThread({ threadId: ids.thread, title: "Controller foundation" }),
      navigationThread({
        threadId: "10000000-0000-4000-8000-000000000002",
        title: "Second thread",
      }),
    ];
    value.client = {
      queryBoard: vi.fn(async () =>
        boardView([
          boardCard({
            threadId: ids.thread as never,
            title: "Controller foundation",
            status: "waiting",
            executing: false,
          }),
          boardCard({
            threadId: "10000000-0000-4000-8000-000000000002" as never,
            title: "Second thread",
            status: "waiting",
            executing: false,
          }),
        ]),
      ),
    } as never;
    render(
      <CodeOverview
        controller={value}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
        projectRoot="/opaque/repository"
      />,
    );

    expect(await screen.findByText("2 threads · 2 waiting")).toBeVisible();
    // The repository is the page's, stated once in its header; the list
    // carries no copy of it and no lecture about what the page may grant.
    expect(screen.queryByText("/opaque/repository")).not.toBeInTheDocument();
    expect(screen.queryByText(/does not grant authority/)).not.toBeInTheDocument();
  });

  it("counts waiting threads among the rows it shows, not every card the board holds", async () => {
    const value = controller();
    value.navigation = [];
    value.client = {
      queryBoard: vi.fn(async () =>
        boardView(
          Array.from({ length: 26 }, (_, index) =>
            boardCard({
              threadId:
                `10000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}` as never,
              title: `Thread ${index}`,
              status: "waiting",
              executing: false,
            }),
          ),
        ),
      ),
    } as never;
    render(
      <CodeOverview controller={value} onOpenThread={vi.fn()} projectId={ids.project as never} />,
    );

    // The list is capped at 24 rows; the count describes those rows.
    expect(await screen.findByText("24 threads · 24 waiting")).toBeVisible();
  });

  it("renames a thread from the keyboard without leaving the overview", async () => {
    const value = controller();
    value.navigation = [navigationThread({ threadId: ids.thread, title: "Controller foundation" })];
    value.client = { queryBoard: vi.fn(async () => boardView([])) } as never;
    render(
      <CodeOverview controller={value} onOpenThread={vi.fn()} projectId={ids.project as never} />,
    );

    const title = await screen.findByRole("button", { name: "Controller foundation" });
    fireEvent.keyDown(title, { key: "F2" });
    const field = screen.getByRole("textbox", { name: "Rename Code thread" });
    fireEvent.change(field, { target: { value: "Renamed foundation" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(value.renameThread).toHaveBeenCalledWith(ids.thread, "Renamed foundation");
  });

  /**
   * The habit is a Project setting, so it needs a reachable control that
   * records it through the journaled Project command — not a per-thread
   * choice that quietly rewrites the Project.
   */
  it("records a new Project workspace habit through the journaled command path", async () => {
    const user = userEvent.setup();
    const onChangeNewThreadWorkspace = vi.fn(async () => true);
    const value = controller();
    value.client = { queryBoard: vi.fn(async () => boardView([])) } as never;
    const { rerender } = render(
      <CodeOverview
        controller={value}
        onChangeNewThreadWorkspace={onChangeNewThreadWorkspace}
        onCreateThread={vi.fn()}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
      />,
    );

    // A Project that never chose reads as the current checkout, and the
    // composer preselects the same habit rather than a second truth.
    const habit = await screen.findByRole("combobox", { name: "New threads start in" });
    expect(habit).toHaveTextContent("This Project's current checkout");
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveTextContent("Current checkout");

    await chooseSelectFieldOption(user, habit, "A managed worktree Octant creates");
    await waitFor(() =>
      expect(onChangeNewThreadWorkspace).toHaveBeenCalledWith(ids.project, "managed-worktree"),
    );
    // The control never moves ahead of the server: it still reads the old
    // projection until the accepted change comes back.
    expect(habit).toHaveTextContent("This Project's current checkout");

    rerender(
      <CodeOverview
        controller={value}
        newThreadWorkspace="managed-worktree"
        onChangeNewThreadWorkspace={onChangeNewThreadWorkspace}
        onCreateThread={vi.fn()}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
      />,
    );
    expect(screen.getByRole("combobox", { name: "New threads start in" })).toHaveTextContent(
      "A managed worktree Octant creates",
    );
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveTextContent("Managed worktree");
  });

  it("does not tell the person to start a thread below when quick start is hidden", async () => {
    render(
      <CodeOverview
        controller={controller()}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
        showQuickStart={false}
      />,
    );

    expect(await screen.findByText("No threads yet.")).toBeVisible();
    expect(screen.queryByText("No threads yet. Start one below.")).not.toBeInTheDocument();
  });

  it("keeps quick-start creation read-only until the ordinary callback is supplied", async () => {
    const value = controller();
    value.client = {
      queryBoard: vi.fn(async () => boardView([])),
    } as never;
    render(
      <CodeOverview controller={value} projectId={ids.project as never} onOpenThread={vi.fn()} />,
    );

    expect(
      await screen.findByText("Starting a thread here needs the host connection."),
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "First message" })).not.toBeInTheDocument();
  });

  it("labels a disconnected Code host without presenting mutation affordances", async () => {
    const value = controller();
    value.status = "disconnected";
    value.errorMessage = "Code transport disconnected.";
    value.client = { queryBoard: vi.fn() } as never;
    render(
      <CodeOverview controller={value} projectId={ids.project as never} onOpenThread={vi.fn()} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Code transport disconnected.");
    expect(screen.getByText("Code projections unavailable")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "First message" })).not.toBeInTheDocument();
  });
});

describe("CoordinatorProposalCards", () => {
  const otherCoordinator = "10000000-0000-4000-8000-000000000009";
  function proposal(
    id: string,
    overrides: Record<string, unknown>,
  ): { readonly proposal: Record<string, unknown>; readonly proposalVersion: number } {
    return {
      proposal: {
        id: `70000000-0000-4000-8000-0000000001${id}`,
        projectId: ids.project,
        plannerThreadId: ids.thread,
        fromCoordinator: true,
        title: `Worker ${id}`,
        intent: `Intent of worker ${id}.`,
        status: "pending",
        proposedAt: "2026-11-10T00:00:00.000Z",
        ...overrides,
      },
      proposalVersion: 2,
    };
  }

  function coordinatorController(
    proposals: ReadonlyArray<ReturnType<typeof proposal>>,
  ): CodeController & { readonly decline: ReturnType<typeof vi.fn> } {
    const value = controller();
    const decline = vi.fn(async () => ({ status: "declined" }));
    value.client = {
      ...value.client,
      readPlanner: vi.fn(async () => ({
        designation: { kind: "none", projectId: ids.project, updatedAt: "2026-11-10T00:00:00Z" },
        designationVersion: 0,
        proposals,
      })),
      executePlannerProposal: decline,
    } as never;
    return Object.assign(value, { decline });
  }

  it("shows only this coordinator's pending proposed workers and declines the exact current one", async () => {
    const value = coordinatorController([
      proposal("01", {}),
      proposal("02", { plannerThreadId: otherCoordinator }),
      proposal("03", { fromCoordinator: undefined }),
      proposal("04", {
        status: "declined",
        resolvedAt: "2026-11-10T00:00:00.000Z",
      }),
    ]);
    render(
      <CoordinatorProposalCards
        controller={value}
        coordinatorThreadId={ids.thread as never}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
      />,
    );
    const card = await screen.findByRole("article", { name: "Proposed worker: Worker 01" });
    expect(within(card).getByText("Intent of worker 01.")).toBeVisible();
    expect(screen.queryByText("Worker 02")).toBeNull();
    expect(screen.queryByText("Worker 03")).toBeNull();
    expect(screen.queryByText("Worker 04")).toBeNull();
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: "Decline" })).toBeEnabled(),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(value.decline).toHaveBeenCalledWith({
        kind: "decline-planner-work-proposal",
        proposalId: "70000000-0000-4000-8000-000000000101",
        expectedVersion: 2,
      }),
    );
  });

  it("opens the ordinary creation review with the proposed worker's intent fixed", async () => {
    const onCreateThread = vi.fn();
    render(
      <CoordinatorProposalCards
        controller={coordinatorController([proposal("01", {})])}
        coordinatorThreadId={ids.thread as never}
        onCreateThread={onCreateThread}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
      />,
    );
    const approve = await screen.findByRole("button", { name: "Review and approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    const review = await screen.findByRole("dialog", { name: "Approve planner proposal" });
    expect(
      within(review).getByRole("heading", { name: "Review the proposed worker" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
      "Intent of worker 01.",
    );
    expect(screen.getByRole("button", { name: "Approve and start described task" })).toBeDisabled();
    expect(onCreateThread).not.toHaveBeenCalled();
  });

  it("preselects the requested provider and model and offers no mode above the requested level", async () => {
    const providerId = "60000000-0000-4000-8000-000000000009";
    const onSelectProvider = vi.fn();
    const providerGroups = [
      {
        driverLabel: "Local",
        endpointHost: "local",
        executionHost: "local",
        instance: { id: providerId, displayName: "Requested provider" },
        readiness: "ready",
        sections: [{ label: "Models", models: [{ model: { id: "model-b", displayName: "B" } }] }],
      },
    ] as never;
    render(
      <CoordinatorProposalCards
        controller={coordinatorController([
          proposal("01", {
            workerOptions: {
              providerInstanceId: providerId,
              modelId: "model-b",
              executionPolicy: "approval-gated",
            },
          }),
        ])}
        coordinatorThreadId={ids.thread as never}
        onCreateThread={vi.fn()}
        onOpenThread={vi.fn()}
        onSelectProvider={onSelectProvider}
        projectId={ids.project as never}
        providerGroups={providerGroups}
      />,
    );
    const approve = await screen.findByRole("button", { name: "Review and approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    const review = await screen.findByRole("dialog", { name: "Approve planner proposal" });
    expect(
      within(review).getByText(
        "The coordinator asked for this worker on model-b at Ask first or lower.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(onSelectProvider).toHaveBeenCalledWith({
        providerInstanceId: providerId,
        modelId: "model-b",
      }),
    );
    expect(onSelectProvider).toHaveBeenCalledTimes(1);
    const mode = within(review).getByRole("button", { name: /^Mode:/ });
    expect(mode).toHaveAccessibleName("Mode: Ask first");
    await userEvent.click(mode);
    const choices = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
    expect(choices.some((text) => text?.startsWith("Ask first"))).toBe(true);
    expect(choices.some((text) => text?.startsWith("Accept edits"))).toBe(false);
    expect(choices.some((text) => text?.startsWith("Full access"))).toBe(false);
  });

  it("leaves the window's selection alone when the requested model is not selectable here", async () => {
    const onSelectProvider = vi.fn();
    render(
      <CoordinatorProposalCards
        controller={coordinatorController([
          proposal("01", {
            workerOptions: {
              providerInstanceId: "60000000-0000-4000-8000-00000000dead",
              modelId: "gone",
              executionPolicy: "full-access",
            },
          }),
        ])}
        coordinatorThreadId={ids.thread as never}
        onCreateThread={vi.fn()}
        onOpenThread={vi.fn()}
        onSelectProvider={onSelectProvider}
        projectId={ids.project as never}
      />,
    );
    const approve = await screen.findByRole("button", { name: "Review and approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await screen.findByRole("dialog", { name: "Approve planner proposal" });
    expect(onSelectProvider).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName(
      "Mode: Full access",
    );
  });

  it("shows nothing on a coordinator with no proposal waiting", async () => {
    const value = coordinatorController([proposal("02", { plannerThreadId: otherCoordinator })]);
    const { container } = render(
      <CoordinatorProposalCards
        controller={value}
        coordinatorThreadId={ids.thread as never}
        onOpenThread={vi.fn()}
        projectId={ids.project as never}
      />,
    );
    await waitFor(() => expect(value.client.readPlanner).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

const ids = {
  checkout: "40000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  thread: "10000000-0000-4000-8000-000000000001",
} as const;

function controller(): CodeController {
  const now = "2026-07-21T12:00:00.000Z" as never;
  const checkout = {
    id: ids.checkout,
    repositoryId: `repo_${"a".repeat(64)}`,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "development", oid: "a".repeat(40) },
    observedAt: now,
  } as const;
  const thread = {
    id: ids.thread,
    projectId: ids.project,
    bindingRevisionId: "30000000-0000-4000-8000-000000000001",
    repositoryId: checkout.repositoryId,
    checkoutId: checkout.id,
    title: "Controller foundation",
    lifecycle: "active",
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/controller",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as const;
  return {
    activeView: { checkout, lastSequence: 1, thread } as never,
    accessNotice: undefined,
    setAccessNotice: vi.fn(),
    announceFirstPrompt: vi.fn(),
    answerProviderRequest: vi.fn(async () => true),
    forceStopTurn: vi.fn(async () => false),
    cancelTurn: vi.fn(async () => true),
    archiveThread: vi.fn(async () => true),
    completeThread: vi.fn(async () => ({ status: "ok" }) as const),
    reopenThread: vi.fn(async () => ({ status: "ok" }) as const),
    snoozeThread: vi.fn(async () => ({ status: "ok" }) as const),
    wakeThread: vi.fn(async () => ({ status: "ok" }) as const),
    moveThread: vi.fn(async () => ({ status: "ok" }) as const),
    sendBackTurn: vi.fn(async () => ({ status: "ok" }) as const),
    threadUsage: { inputTokens: 0, outputTokens: 0, limits: [] },
    restoreUndo: undefined,
    noteRestoreUndo: vi.fn(),
    forkThread: vi.fn(async () => undefined),
    mergeForkContext: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => true),
    pinThread: vi.fn(async () => true),
    setThreadCoordinator: vi.fn(async () => ({ status: "ok" as const })),
    setThreadCoordinatorWake: vi.fn(async () => ({ status: "ok" as const })),
    setThreadMessageWake: vi.fn(async () => ({ status: "ok" as const })),
    rebindThreadCheckout: vi.fn(async () => undefined),

    turnActivity: new Map(),
    turnErrorInTranscript: false,
    providerRequests: [],
    providerAnswerRefusal: undefined,
    bootstrap: {
      checkouts: [checkout],
      settings: { defaultExecutionPolicy: "approval-gated" } as never,
      threads: [thread],
    } as never,
    client: { queryBoard: vi.fn(async () => boardView([])) } as never,
    editorDrafts: {
      clear: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
    },
    errorCategory: undefined,
    errorMessage: undefined,
    firstPromptInFlight: undefined,
    conversation: [],
    conversationHistory: "loaded" as const,
    completeFollowUp: vi.fn(async () => true),
    execute: vi.fn(),
    followUps: new Map(),
    lastExecuteError: { current: undefined },
    lastStartRefusal: { current: undefined },
    markFollowUp: vi.fn(async () => true),
    markThreadRead: vi.fn(),
    refreshConversation: vi.fn(() => true),
    earlierConversation: undefined,
    loadEarlierConversation: vi.fn(),
    refreshNavigation: vi.fn(async () => undefined),
    navigation: [],
    pendingDraft: "",
    pendingDraftCaret: 0,
    draftStagedDropped: false,
    draftPersistError: undefined,
    markDraftStagedDropped: vi.fn(),
    purgeThreadDraft: vi.fn(),
    refreshFollowUp: vi.fn(async () => undefined),
    retry: vi.fn(),
    sendFollowUp: vi.fn(async () => true),
    setPendingDraft: vi.fn(),
    setPendingDraftCaret: vi.fn(),
    showTurnRefusal: vi.fn(),
    startThreadTurn: vi.fn(async () => true),
    status: "ready",
    turnError: undefined,
    turnErrorCategory: undefined,
    turnStatus: "idle",
    turnUsageLimit: undefined,
    latestProviderTurnOperationId: undefined,
    updateSettings: vi.fn(),
  };
}

function navigationThread(overrides: {
  readonly threadId: string;
  readonly title: string;
}): CodeController["navigation"][number] {
  return {
    executionPolicy: "approval-gated",
    lifecycle: "active",
    providerInstanceId: "provider-one" as never,
    projectId: ids.project as never,
    threadId: overrides.threadId as never,
    title: overrides.title,
  };
}

function boardView(cards: ReadonlyArray<CodeBoardCard>): CodeBoardView {
  return {
    version: 1,
    query: { version: 1 },
    cards,
    generatedAt: "2026-08-10T00:00:00.000Z",
  } as CodeBoardView;
}

function boardCard(overrides: Partial<CodeBoardCard>): CodeBoardCard {
  return {
    threadId: ids.thread,
    projectId: ids.project,
    checkoutId: ids.checkout,
    checkoutKind: "existing-worktree",
    title: "Controller foundation",
    status: "in-progress",
    statusReason: "executing",
    outcomeKind: "opened-pr",
    deliverySatisfaction: "pending",
    providerInstanceId: "50000000-0000-4000-8000-000000000001" as never,
    modelId: "model-a" as never,
    executing: true,
    worktree: { kind: "unavailable", checkoutId: ids.checkout },
    changedFiles: { kind: "unavailable" },
    linkedPullRequest: { kind: "none", freshness: "fresh" },
    pullRequestSummaries: { items: [], hiddenCount: 0 },
    checks: { freshness: "fresh", state: "unknown" },
    reviewState: { freshness: "fresh", state: "unknown" },
    childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
    recovery: { kind: "ok" },
    githubFreshness: "fresh",
    followUp: false,
    lastMeaningfulActivityAt: null,
    ...overrides,
  } as unknown as CodeBoardCard;
}
