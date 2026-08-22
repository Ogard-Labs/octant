import type { CodeBoardCard, CodeBoardView } from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeOverview } from "./CodeOverview";
import type { CodeController } from "./useCodeController";

describe("CodeOverview", () => {
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
    expect(screen.getByText("Approval gated")).toBeVisible();
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

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Code sessions" })).toBeVisible(),
    );
    // The thread title appears once, on its own row — never repeated by a
    // facet section, because there are no facet sections any more.
    expect(screen.getAllByText("Controller foundation")).toHaveLength(1);
    expect(screen.queryByText("Another Project")).not.toBeInTheDocument();
    expect(screen.getByText("feature/controller")).toBeVisible();
    expect(
      screen.getByText("3 changed files · 1 staged · 2 committed ahead · stale"),
    ).toBeVisible();
    expect(screen.getByText("Passing")).toBeVisible();
    expect(screen.getByText("#806 · open")).toBeVisible();
    expect(screen.getByText("1 active · 2 completed")).toBeVisible();
    expect(screen.getByText("In progress")).toBeVisible();
    expect(screen.getByText("Approval gated")).toBeVisible();
    expect(screen.getByText("Follow-up")).toBeVisible();
    // Rarely-glanced facts stay reachable behind the per-thread disclosure.
    fireEvent.click(screen.getByText("Full detail"));
    expect(screen.getByText("/opaque/worktree")).toBeVisible();
    expect(screen.getByText("Opened pull request · Pending")).toBeVisible();
    expect(screen.getByText("Reviewing the checkout")).toBeVisible();
    expect(screen.getByRole("region", { name: "Code quick start" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Access policy" })).toHaveValue("approval-gated");
    expect(
      screen.getByText("Checkout and worktree are confirmed by the Code service before creation."),
    ).toBeVisible();
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
    render(
      <CodeOverview controller={value} onOpenThread={vi.fn()} projectId={ids.project as never} />,
    );

    expect(await screen.findByText("feature/controller")).toBeVisible();
    // Exactly one Branch row: the thread whose worktree the host reported.
    expect(screen.getAllByText("Branch")).toHaveLength(1);
    expect(screen.getByText("Worktree pending")).toBeVisible();
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

  it("states the repository and authority note once at project level, never per thread", async () => {
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

    expect(await screen.findByText("2 threads are waiting")).toBeVisible();
    expect(
      screen.getAllByText(
        "Waiting for server-reported approval, input, or recovery. The overview does not grant authority.",
      ),
    ).toHaveLength(1);
    expect(screen.getAllByText("/opaque/repository")).toHaveLength(1);
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
    expect(habit).toHaveValue("current-checkout");
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveValue("current-checkout");

    fireEvent.change(habit, { target: { value: "managed-worktree" } });
    await waitFor(() =>
      expect(onChangeNewThreadWorkspace).toHaveBeenCalledWith(ids.project, "managed-worktree"),
    );
    // The control never moves ahead of the server: it still reads the old
    // projection until the accepted change comes back.
    expect(habit).toHaveValue("current-checkout");

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
    expect(screen.getByRole("combobox", { name: "New threads start in" })).toHaveValue(
      "managed-worktree",
    );
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveValue("managed-worktree");
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
      await screen.findByText(
        "Code quick start is unavailable until server creation authority is connected.",
      ),
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
    answerProviderRequest: vi.fn(async () => true),
    archiveThread: vi.fn(async () => true),
    threadUsage: { inputTokens: 0, outputTokens: 0, limits: [] },
    restoreUndo: undefined,
    noteRestoreUndo: vi.fn(),
    forkThread: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => true),
    pinThread: vi.fn(async () => true),

    turnActivity: new Map(),
    providerRequests: [],
    bootstrap: { checkouts: [checkout], settings: {} as never, threads: [thread] } as never,
    client: { queryBoard: vi.fn(async () => boardView([])) } as never,
    editorDrafts: {
      clear: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
    },
    errorCategory: undefined,
    errorMessage: undefined,
    conversation: [],
    conversationHistory: "loaded" as const,
    completeFollowUp: vi.fn(async () => true),
    execute: vi.fn(),
    followUps: new Map(),
    lastExecuteError: { current: undefined },
    markFollowUp: vi.fn(async () => true),
    markThreadRead: vi.fn(),
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
    startThreadTurn: vi.fn(async () => true),
    status: "ready",
    turnError: undefined,
    turnStatus: "idle",
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
    checks: { freshness: "fresh", state: "unknown" },
    reviewState: { freshness: "fresh", state: "unknown" },
    childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
    recovery: { kind: "ok" },
    githubFreshness: "fresh",
    followUp: false,
    lastMeaningfulActivityAt: null,
    ...overrides,
  } as CodeBoardCard;
}
