import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DraftThreadWorkspace } from "./DraftThreadWorkspace";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type {
  GithubCatalogueReadResponse,
  GithubCloneCommandResponse,
  GithubCloneOperation,
} from "@octant/contracts";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";

const codeProjectId = "00000000-0000-4000-8000-000000000111" as ProjectId;
const workProjectId = "00000000-0000-4000-8000-000000000112" as ProjectId;

const projects = [
  {
    id: codeProjectId,
    type: "code",
    name: "Octant",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    binding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
    codeAccessPersistence: "current-session",
  },
  {
    id: workProjectId,
    type: "work",
    name: "Knowledge",
    lifecycle: "active",
    pinned: false,
    rank: "1/1",
    version: 1,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    binding: { canonicalRoot: "/Users/example/Knowledge" },
  },
] as unknown as ReadonlyArray<ProjectSummary>;

const baseProps = {
  mode: "chat" as const,
  providerGroups: [],
  onSelectProvider: vi.fn(),
  onCreateThread: vi.fn(),
  onCancel: vi.fn(),
};

function makeLinearClient(
  options: {
    readonly snapshot?: {
      readonly state: "ready" | "unauthorized";
      readonly capabilities: ReadonlyArray<{
        readonly operationId: string;
        readonly available: boolean;
      }>;
    };
  } = {},
): IntegrationClient {
  const snapshot = options.snapshot ?? {
    state: "ready" as const,
    capabilities: [{ operationId: "list-issues", available: true }],
  };
  return {
    authenticationSnapshot: async () => snapshot,
    executeAuthenticationCommand: async () => snapshot,
    executeOperation: async () => ({ kind: "refused", reason: "not used" }),
    listIssues: async () => ({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          identifier: "ENG-12",
          title: "Browse issues in the workspace",
          state: { name: "In Progress", type: "started" },
          url: "https://linear.app/ogard-labs/issue/ENG-12",
        },
      ],
      hasNextPage: false,
    }),
    getIssue: async () => {
      throw new Error("not used");
    },
    listIssueFilters: async () => ({ teams: [], states: [], assignees: [], projects: [] }),
    storePersonalCredential: async () => {},
    deletePersonalCredential: async () => {},
  };
}

describe("DraftThreadWorkspace", () => {
  it("renders mode-specific welcome copy for chat", () => {
    render(<DraftThreadWorkspace {...baseProps} />);
    expect(screen.getByRole("heading", { name: "What are you working on?" })).toBeVisible();
    expect(screen.queryByText("Octant Chat")).not.toBeInTheDocument();
    expect(screen.queryByText(/Start a calm, focused conversation/)).not.toBeInTheDocument();
  });

  it("renders mode-specific welcome copy for code", () => {
    render(<DraftThreadWorkspace {...baseProps} mode="code" />);
    expect(screen.getByRole("heading", { name: "What should we build?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Provider and model" })).toBeDisabled();
  });

  it("renders mode-specific welcome copy for work", () => {
    render(<DraftThreadWorkspace {...baseProps} mode="work" />);
    expect(screen.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
    expect(screen.queryByText("Octant Work")).not.toBeInTheDocument();
  });

  it("renders intent cards for the active mode", () => {
    const { container } = render(<DraftThreadWorkspace {...baseProps} />);
    expect(screen.getByRole("group", { name: "Suggested actions" })).toBeVisible();
    expect(screen.getByText("Explain a concept")).toBeVisible();
    expect(screen.getByText("Draft text")).toBeVisible();
    expect(screen.getByText("Brainstorm ideas")).toBeVisible();
    const composer = container.querySelector(".draft-thread__composer");
    const suggestions = container.querySelector(".draft-thread__intent-cards");
    expect(composer?.compareDocumentPosition(suggestions!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("hides starter actions when recent work already gives the screen a next step", () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        recentThreads={[{ id: "thread-a", title: "Latency telemetry", onOpen: vi.fn() }]}
      />,
    );

    expect(screen.queryByRole("group", { name: "Suggested actions" })).not.toBeInTheDocument();
  });

  it("offers the threads this mode already has and opens the one chosen", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        recentThreads={[
          { id: "thread-a", title: "Latency telemetry", detail: "2 hours ago", onOpen },
          { id: "thread-b", title: "Cache hit ratio", onOpen: vi.fn() },
        ]}
      />,
    );

    expect(screen.getByText("Latency telemetry")).toBeVisible();
    expect(screen.getByText("2 hours ago")).toBeVisible();

    await user.click(screen.getByText("Latency telemetry"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("leaves the start screen to the prompt when the mode has no threads yet", () => {
    render(<DraftThreadWorkspace {...baseProps} recentThreads={[]} />);
    expect(screen.queryByText("Continue")).not.toBeInTheDocument();
  });

  it("fills the composer when an intent card is clicked", async () => {
    const user = userEvent.setup();
    render(<DraftThreadWorkspace {...baseProps} />);
    await user.click(screen.getByText("Explain a concept"));
    const textarea = screen.getByRole("textbox", { name: "First message" });
    expect(textarea).toHaveValue("Explain a concept: ");
  });

  it("does not overwrite existing prompt text when an intent card is clicked", async () => {
    const user = userEvent.setup();
    render(<DraftThreadWorkspace {...baseProps} />);
    const textarea = screen.getByRole("textbox", { name: "First message" });
    await user.type(textarea, "My custom prompt");
    await user.click(screen.getByText("Explain a concept"));
    expect(textarea).toHaveValue("My custom prompt");
  });

  it("disables the send button when the prompt is empty", () => {
    render(<DraftThreadWorkspace {...baseProps} />);
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
  });

  it("enables the send button when the prompt has text", async () => {
    const user = userEvent.setup();
    render(<DraftThreadWorkspace {...baseProps} />);
    const textarea = screen.getByRole("textbox", { name: "First message" });
    await user.type(textarea, "Hello");
    expect(screen.getByRole("button", { name: "Create thread" })).toBeEnabled();
  });

  it("calls onCreateThread with trimmed prompt on send", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(<DraftThreadWorkspace {...baseProps} onCreateThread={onCreateThread} />);
    const textarea = screen.getByRole("textbox", { name: "First message" });
    await user.type(textarea, "  Hello world  ");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(onCreateThread).toHaveBeenCalledWith("Hello world");
  });

  it("submits on Enter without Shift", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(<DraftThreadWorkspace {...baseProps} onCreateThread={onCreateThread} />);
    const textarea = screen.getByRole("textbox", { name: "First message" });
    await user.type(textarea, "Hello");
    await user.keyboard("{Enter}");
    expect(onCreateThread).toHaveBeenCalledWith("Hello");
  });

  it("calls onCancel on Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<DraftThreadWorkspace {...baseProps} onCancel={onCancel} />);
    const textarea = screen.getByRole("textbox", { name: "First message" });
    await user.click(textarea);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows project context in the context strip", () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        mode="code"
        projectId={codeProjectId}
        projectName="my-repo"
        branchName="feature/test"
        approvalLabel="Approval gated"
      />,
    );
    expect(screen.getByText("my-repo")).toBeVisible();
    // The branch context now lives on the branch selector trigger.
    expect(screen.getByRole("button", { name: "Base branch" })).toHaveTextContent("feature/test");
    expect(screen.getByRole("button", { name: "Access policy" })).toHaveTextContent("Approval");
  });

  it("shows the authoritative Environment health in the context strip", () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        hosts={[
          {
            hostId: LOCAL_HOST_ID,
            displayName: "This Mac",
            health: "healthy",
            capabilities: ["chat", "work", "code"],
          },
        ]}
      />,
    );
    expect(screen.getByRole("status", { name: "Environment: This Mac · Connected" })).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Environment: This Mac · Connected" }).firstChild,
    ).toHaveClass("host-selector__environment-icon");
  });

  it.each(["code", "work"] as const)(
    "passes authoritative host health into the %s composer",
    (mode) => {
      render(
        <DraftThreadWorkspace
          {...baseProps}
          mode={mode}
          hosts={[
            {
              hostId: LOCAL_HOST_ID,
              displayName: "This Mac",
              health: "healthy",
              capabilities: ["chat", "work", "code"],
            },
          ]}
        />,
      );

      expect(
        screen.getByRole("status", { name: "Environment: This Mac · Connected" }),
      ).toBeVisible();
    },
  );

  it("keeps Environment choice visible and changeable for multi-host create", async () => {
    const user = userEvent.setup();
    const onSelectHost = vi.fn();
    const studio = "11111111-1111-4111-8111-111111111111" as never;
    render(
      <DraftThreadWorkspace
        {...baseProps}
        hosts={[
          {
            hostId: LOCAL_HOST_ID,
            displayName: "This Mac",
            health: "healthy",
            capabilities: ["chat", "work", "code"],
          },
          {
            hostId: studio,
            displayName: "Studio",
            health: "healthy",
            capabilities: ["chat", "work", "code"],
          },
        ]}
        lastSelectedHealthyHostId={studio}
        onSelectHost={onSelectHost}
        selectedHostId={studio}
        viewScope={{ kind: "all-hosts" }}
      />,
    );

    const combobox = screen.getByRole("combobox", { name: "Environment" });
    expect(combobox).toHaveTextContent(/Studio/);
    expect(screen.getByTestId("host-selector")).toHaveAttribute("data-host-id", String(studio));
    await user.click(combobox);
    await user.click(await screen.findByRole("option", { name: /This Mac/ }));
    expect(onSelectHost).toHaveBeenCalledWith(LOCAL_HOST_ID);
  });

  it("fixes destination host when creating inside an existing Project", () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        fixedHostId={LOCAL_HOST_ID}
        hosts={[
          {
            hostId: LOCAL_HOST_ID,
            displayName: "This Mac",
            health: "healthy",
            capabilities: ["chat", "work", "code"],
          },
          {
            hostId: "11111111-1111-4111-8111-111111111111" as never,
            displayName: "Studio",
            health: "healthy",
            capabilities: ["chat", "work", "code"],
          },
        ]}
        projectId={"22222222-2222-4222-8222-222222222222" as never}
        projectName="Aurora"
        selectedHostId={LOCAL_HOST_ID}
      />,
    );
    expect(screen.getByRole("status", { name: "Environment: This Mac · Connected" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Environment" })).not.toBeInTheDocument();
  });

  it("does not show branch for non-code modes", () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        mode="chat"
        projectName="Chat Project"
        branchName="main"
      />,
    );
    expect(screen.getByText("Chat Project")).toBeVisible();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("shows an error message when provided", () => {
    render(<DraftThreadWorkspace {...baseProps} errorMessage="Something went wrong" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });

  it.each(["code", "work"] as const)(
    "preserves the %s first prompt and exposes retry plus Project choices after a failed first turn",
    async (mode) => {
      const user = userEvent.setup();
      const onCreateThread = vi.fn();
      const { rerender } = render(
        <DraftThreadWorkspace
          {...baseProps}
          mode={mode}
          onCreateThread={onCreateThread}
          projects={projects}
        />,
      );

      await user.type(screen.getByRole("textbox", { name: "First message" }), "Keep this draft");
      await user.click(screen.getByRole("button", { name: "Create thread" }));
      rerender(
        <DraftThreadWorkspace
          {...baseProps}
          errorMessage="The first turn was not created."
          mode={mode}
          onCreateThread={onCreateThread}
          projects={projects}
        />,
      );

      expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue("Keep this draft");
      expect(screen.getByRole("button", { name: "Retry creating thread" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Project: Choose a Project" })).toBeVisible();
    },
  );

  it.each(["code", "work"] as const)(
    "shows an honest pending first-turn state for %s while retaining the draft",
    async (mode) => {
      const user = userEvent.setup();
      const onCancelFirstTurn = vi.fn();
      const { rerender } = render(
        <DraftThreadWorkspace {...baseProps} mode={mode} projects={projects} />,
      );
      await user.type(screen.getByRole("textbox", { name: "First message" }), "Pending draft");

      rerender(
        <DraftThreadWorkspace
          {...baseProps}
          creating
          mode={mode}
          onCancelFirstTurn={onCancelFirstTurn}
          pendingMessage="Checking the authoritative receipt…"
          projects={projects}
        />,
      );

      expect(screen.getByRole("status", { name: "First-turn status" })).toHaveTextContent(
        "Checking the authoritative receipt",
      );
      expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue("Pending draft");
      await user.click(screen.getByRole("button", { name: "Cancel first turn" }));
      expect(onCancelFirstTurn).toHaveBeenCalledOnce();
    },
  );

  it.each(["chat", "code", "work"] as const)(
    "does not show a multi-model pool control for %s drafts",
    (mode) => {
      render(<DraftThreadWorkspace {...baseProps} mode={mode} projects={projects} />);
      expect(screen.queryByRole("button", { name: "Use multiple models" })).toBeNull();
    },
  );

  it("disables the textarea while creating", () => {
    render(<DraftThreadWorkspace {...baseProps} creating />);
    expect(screen.getByRole("textbox", { name: "First message" })).toBeDisabled();
  });

  it.each([
    ["code", "Octant", "Knowledge"],
    ["work", "Knowledge", "Octant"],
  ] as const)(
    "lists only compatible saved Projects and Add local folder for %s",
    async (mode, compatible, incompatible) => {
      const user = userEvent.setup();
      render(<DraftThreadWorkspace {...baseProps} mode={mode} projects={projects} />);

      await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
      expect(screen.getByRole("option", { name: new RegExp(compatible) })).toBeVisible();
      expect(screen.queryByRole("option", { name: new RegExp(incompatible) })).toBeNull();
      expect(screen.getByRole("option", { name: "Add local folder…" })).toBeVisible();
      expect(screen.queryByRole("option", { name: "No folder" })).toBeNull();
    },
  );

  /**
   * The Code Project habit is only worth storing if the surface a user
   * actually reaches consumes it. These pin the reachable draft composer to
   * the persisted value and keep a one-thread override from rewriting it.
   */
  const habitProjects = (workspace?: "managed-worktree" | "current-checkout") =>
    projects.map((candidate) =>
      candidate.type === "code" && workspace !== undefined
        ? ({ ...candidate, newThreadWorkspace: workspace } as ProjectSummary)
        : candidate,
    );

  async function submitCodeDraft(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    await user.click(screen.getByRole("option", { name: /Octant/ }));
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix search");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
  }

  it("starts a new Code thread in the Project's stored managed-worktree habit", async () => {
    const user = userEvent.setup();
    const onCreateCodeThread = vi.fn();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        mode="code"
        onCreateCodeThread={onCreateCodeThread}
        projects={habitProjects("managed-worktree")}
      />,
    );

    await submitCodeDraft(user);

    expect(onCreateCodeThread).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "managed-worktree" }),
      codeProjectId,
    );
  });

  it("binds the current checkout for a Project with no stored habit", async () => {
    const user = userEvent.setup();
    const onCreateCodeThread = vi.fn();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        mode="code"
        onCreateCodeThread={onCreateCodeThread}
        projects={habitProjects()}
      />,
    );

    await submitCodeDraft(user);

    expect(onCreateCodeThread).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "current-checkout" }),
      codeProjectId,
    );
  });

  it("uses a connected GitHub Project identity for the first Code delivery target", async () => {
    const user = userEvent.setup();
    const onCreateCodeThread = vi.fn();
    const connectedProjects = projects.map((candidate) =>
      candidate.type === "code"
        ? ({
            ...candidate,
            connectedRepository: { host: "github.com", owner: "acme", repository: "octant" },
          } as ProjectSummary)
        : candidate,
    );
    render(
      <DraftThreadWorkspace
        {...baseProps}
        mode="code"
        onCreateCodeThread={onCreateCodeThread}
        projects={connectedProjects}
      />,
    );

    await submitCodeDraft(user);

    expect(onCreateCodeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryTarget: expect.objectContaining({ proposedBaseRepository: "acme/octant" }),
      }),
      codeProjectId,
    );
  });

  it("lets one thread override the habit without asking to rewrite the Project", async () => {
    const user = userEvent.setup();
    const onCreateCodeThread = vi.fn();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        mode="code"
        onCreateCodeThread={onCreateCodeThread}
        projects={habitProjects("managed-worktree")}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    await user.click(screen.getByRole("option", { name: /Octant/ }));
    const workspace = screen.getByRole("button", { name: "Workspace" });
    expect(workspace).toHaveTextContent("Managed worktree");
    await user.click(workspace);
    await user.click(screen.getByRole("option", { name: /Current checkout/ }));
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Fix search");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(onCreateCodeThread).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "current-checkout" }),
      codeProjectId,
    );
  });

  it("submits the saved Project selected inline without opening a picker", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        mode="work"
        onCreateThread={onCreateThread}
        projects={projects}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "First message" }), "Draft brief");
    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    await user.click(screen.getByRole("option", { name: /Knowledge/ }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(onCreateThread).toHaveBeenCalledWith("Draft brief", workProjectId, undefined, [], []);
  });

  it("returns from authenticated-web Add folder to the unchanged Code draft and settings", async () => {
    const user = userEvent.setup();
    const createdProjectId = "00000000-0000-4000-8000-000000000113" as ProjectId;
    const folderBrowseClient: FolderBrowseClient = {
      browse: vi.fn(async () => ({
        candidates: [
          {
            candidateId: "00000000-0000-4000-8000-000000000114" as never,
            displayName: "new-repository",
            isGitRepository: true,
            isSelectable: true,
          },
        ],
        breadcrumbs: [{ label: "Repos" }],
        hasMore: false,
        browsedAt: "2026-07-28T12:00:00.000Z" as never,
      })),
      select: vi.fn(async () => ({
        receiptId: "R".repeat(43),
        displayName: "new-repository",
        selectedAt: "2026-07-28T12:00:01.000Z" as never,
      })),
    };
    const onCreateProject = vi.fn(async () => createdProjectId);

    render(
      <DraftThreadWorkspace
        {...baseProps}
        folderBrowseClient={folderBrowseClient}
        hostId={LOCAL_HOST_ID}
        mode="code"
        onCreateProject={onCreateProject}
        projects={projects}
      />,
    );

    const prompt = screen.getByRole("textbox", { name: "First message" });
    await user.type(prompt, "Keep this exact prompt");
    await user.click(screen.getByRole("button", { name: "Access policy" }));
    await user.click(screen.getByRole("option", { name: /Full access/ }));

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    await user.click(screen.getByRole("option", { name: "Add local folder…" }));
    await user.click(await screen.findByRole("button", { name: "Select" }));

    expect(onCreateProject).toHaveBeenCalledWith("code", "new-repository", "R".repeat(43));
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
      "Keep this exact prompt",
    );
    expect(screen.getByRole("button", { name: "Access policy" })).toHaveTextContent("Full access");
    expect(screen.getByRole("button", { name: "Project: new-repository" })).toBeVisible();
  });

  const GITHUB_RECEIPT = "R".repeat(43);
  const GITHUB_DIGEST = "a".repeat(64);

  function makeGithubClient(
    overrides: {
      readonly snapshot?: import("@octant/contracts").GithubAuthenticationSnapshot;
    } = {},
  ): GithubClient {
    const page: GithubCatalogueReadResponse = {
      kind: "repositories",
      page: {
        rows: [
          {
            nodeId: "R_node1",
            owner: "octant",
            name: "atlas-docs",
            visibility: "private",
            defaultBranch: "development",
            viewerPermission: "admin",
            capabilities: [],
          },
        ],
        sort: "pushed-desc",
        hasNextPage: false,
        freshness: { status: "fresh" },
      },
    } as GithubCatalogueReadResponse;
    return {
      authenticationSnapshot: vi.fn(async () => {
        if (overrides.snapshot !== undefined) return overrides.snapshot;
        throw new Error("not used");
      }),
      executeAuthenticationCommand: vi.fn(async () => {
        throw new Error("not used");
      }),
      readCatalogue: vi.fn(async (request) =>
        request.kind === "recent-repositories"
          ? ({ kind: "recent-repositories", rows: [] } as never)
          : page,
      ),
      recordRecentRepository: vi.fn(
        async () => ({ kind: "recent-repositories", rows: [] }) as never,
      ),
    };
  }

  function githubOperation(overrides: Partial<GithubCloneOperation>): GithubCloneOperation {
    return {
      requestId: "00000000-0000-4000-8000-000000000201",
      state: "awaiting-confirmation",
      mode: "clone",
      repository: {
        nodeId: "R_node1",
        owner: "octant",
        name: "atlas-docs",
        visibility: "private",
        defaultBranch: "development",
      },
      destination: {
        inventoryPath: "/home/user/Octant/Repositories",
        destinationPath: "/home/user/Octant/Repositories/github.com/octant/atlas-docs",
        digest: GITHUB_DIGEST,
      },
      version: 1,
      requestedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
      ...overrides,
    } as GithubCloneOperation;
  }

  function makeGithubCloneClient(): GithubCloneClient {
    return {
      execute: vi.fn(async (command) => {
        if (command.kind === "request-clone") {
          return {
            kind: "operation",
            operation: githubOperation({ requestId: command.requestId }),
          } as GithubCloneCommandResponse;
        }
        return {
          kind: "operation",
          operation: githubOperation({
            requestId: (command as { requestId: string }).requestId,
            state: "completed",
            bindingIssued: true,
          }),
          binding: { receiptId: GITHUB_RECEIPT, projectType: "code", expiresAt: 9_999_999_999 },
        } as GithubCloneCommandResponse;
      }),
      listOperations: vi.fn(async () => ({ operations: [] })),
    };
  }

  it("keeps Host, Project, and GitHub repository distinct visible selections in the Code draft", async () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        githubClient={makeGithubClient()}
        githubCloneClient={makeGithubCloneClient()}
        mode="code"
        onCreateProject={vi.fn(async () => codeProjectId)}
        projects={projects}
      />,
    );

    expect(screen.getByRole("status", { name: /Environment: This computer/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Project: Choose a Project" })).toBeVisible();
    // The GitHub control loads on demand, so it lands a tick after the rest.
    expect(await screen.findByRole("button", { name: "GitHub repository" })).toBeVisible();
  });

  it("keeps another folder reachable from the Project control after Code creation is refused", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn(async () => codeProjectId);
    render(
      <DraftThreadWorkspace
        {...baseProps}
        errorMessage="This Project folder has no Git checkout."
        mode="code"
        onCreateProject={onCreateProject}
        projectId={codeProjectId}
        projects={projects}
      />,
    );

    const project = screen.getByRole("button", { name: "Project: Octant" });
    expect(screen.getByRole("heading", { level: 1 })).not.toContainElement(project);
    expect(project.closest(".composer-tray")).not.toBeNull();

    await user.click(project);
    await user.click(screen.getByRole("option", { name: "Add local folder…" }));
    expect(screen.getByRole("dialog", { name: "Create Project" })).toBeVisible();
  });

  it("omits the GitHub repository selection when the GitHub clients are unavailable", () => {
    render(<DraftThreadWorkspace {...baseProps} mode="code" projects={projects} />);
    expect(screen.queryByRole("button", { name: "GitHub repository" })).toBeNull();
  });

  it("onboards a GitHub repository into a new bound Code Project selected in the composer", async () => {
    const user = userEvent.setup();
    const createdProjectId = "00000000-0000-4000-8000-000000000115" as ProjectId;
    const onCreateProject = vi.fn(async () => createdProjectId);
    render(
      <DraftThreadWorkspace
        {...baseProps}
        githubClient={makeGithubClient()}
        githubCloneClient={makeGithubCloneClient()}
        mode="code"
        onCreateProject={onCreateProject}
        projects={projects}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "First message" }), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "GitHub repository" }));
    await user.click(await screen.findByText("octant/atlas-docs"));
    await user.click(await screen.findByRole("button", { name: "Clone repository" }));

    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith("code", "atlas-docs", GITHUB_RECEIPT),
    );
    await user.click(await screen.findByRole("button", { name: "Done" }));

    // The new Project becomes the composer's Project selection, and the
    // draft prompt survives the whole onboarding round trip.
    expect(screen.getByRole("button", { name: "Project: atlas-docs" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue("Keep this draft");
  });

  it("shows the Create from Issues tab when issues-read is available", async () => {
    const user = userEvent.setup();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        githubClient={makeGithubClient({
          snapshot: {
            state: "ready",
            account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
            capabilities: [
              { kind: "repository-catalogue", available: true },
              { kind: "issues-read", available: true },
              { kind: "pull-requests-read", available: true },
              { kind: "projects-read", available: true },
            ],
          },
        })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Create from…" }));
    expect(screen.getByRole("tab", { name: "Issues" })).toBeVisible();
  });

  it("hides Create from when the GitHub plugin is disabled", async () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        githubClient={makeGithubClient({
          snapshot: {
            state: "ready",
            account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
            capabilities: [{ kind: "issues-read", available: true }],
          },
        })}
        githubPluginEnabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Create from…" })).toBeNull();
  });

  it("hides Create from when issues-read is unavailable", async () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        githubClient={makeGithubClient({
          snapshot: { state: "unauthorized", capabilities: [] },
        })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create from…" })).toBeNull());
  });

  it("shows the Create from Linear tab when list-issues is available", async () => {
    const user = userEvent.setup();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        linearClient={makeLinearClient()}
        linearPluginEnabled={true}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Create from…" }));
    expect(screen.getByRole("tab", { name: "Linear" })).toBeVisible();
  });

  it("hides Create from when the Linear plugin is disabled even if a client exists", async () => {
    render(
      <DraftThreadWorkspace
        {...baseProps}
        linearClient={makeLinearClient()}
        linearPluginEnabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Create from…" })).toBeNull();
  });

  it("attaches only a Linear node id when creating from a Linear issue", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        linearClient={makeLinearClient()}
        linearPluginEnabled={true}
        onCreateThread={onCreateThread}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Create from…" }));
    await user.click(await screen.findByRole("tab", { name: "Linear" }));
    await user.click(
      await screen.findByRole("button", { name: /ENG-12 Browse issues in the workspace/ }),
    );
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Start from Linear");
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(onCreateThread).toHaveBeenCalledWith(
      "Start from Linear",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { id: "11111111-1111-4111-8111-111111111111" },
    );
  });

  it("fails the GitHub flow closed while an existing Project fixes the repository", async () => {
    const user = userEvent.setup();
    render(
      <DraftThreadWorkspace
        {...baseProps}
        githubClient={makeGithubClient()}
        githubCloneClient={makeGithubCloneClient()}
        mode="code"
        onCreateProject={vi.fn(async () => codeProjectId)}
        projects={projects}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    await user.click(screen.getByRole("option", { name: /Octant/ }));
    await user.click(screen.getByRole("button", { name: "GitHub repository" }));

    expect(await screen.findByText(/Octant.*already binds its repository/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Search GitHub repositories")).toBeNull();
  });
});
