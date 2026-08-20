import type { CodeBoardCard, CodeBoardView } from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeOverview } from "./CodeOverview";
import type { CodeController } from "./useCodeController";

describe("CodeOverview", () => {
  it("renders only authoritative thread, checkout, policy, and delivery facts", () => {
    const onOpenSurface = vi.fn();
    render(
      <CodeOverview
        controller={controller()}
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
    expect(screen.getByText("Git changes load in the Git pane.")).toBeVisible();
    expect(screen.getByText("Test summaries load when repository tests run.")).toBeVisible();
    expect(screen.getByText("Approval requests appear when the provider asks.")).toBeVisible();
    expect(screen.getByText("Review checkout changes")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Git changes" }));
    expect(onOpenSurface).toHaveBeenCalledWith("code-diff");
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

  it("composes exact-Project Code projections and the server-authorized quick start", async () => {
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
    expect(screen.getByRole("button", { name: /^Controller foundation/ })).toBeVisible();
    expect(screen.queryByText("Another Project")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Repository, checkout, and worktree" }),
    ).toHaveTextContent("feature/controller");
    expect(screen.getByText("3 changed files · 1 staged · 2 committed ahead")).toBeVisible();
    expect(screen.getByText("Stale observation")).toBeVisible();
    expect(screen.getByRole("region", { name: "Tests and validation" })).toHaveTextContent(
      "Passing",
    );
    expect(screen.getByRole("region", { name: "Delivery and pull request" })).toHaveTextContent(
      "#806 · open",
    );
    expect(screen.getByRole("region", { name: "Active child agents" })).toHaveTextContent(
      "1 active",
    );
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
    fireEvent.click(screen.getByRole("button", { name: /^Controller foundation/ }));
    expect(onOpenThread).toHaveBeenCalledWith(ids.thread);
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
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
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
    cancelQueuedFollowUp: vi.fn(),
    queueFollowUp: vi.fn(),
    queuedFollowUps: [],
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
    navigation: [],
    pendingDraft: "",
    pendingDraftCaret: 0,
    draftStagedDropped: false,
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
    title: "Controller foundation",
    status: "in-progress",
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
    unread: false,
    followUp: false,
    lastMeaningfulActivityAt: null,
    ...overrides,
  } as CodeBoardCard;
}
