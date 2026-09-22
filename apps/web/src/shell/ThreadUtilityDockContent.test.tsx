import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeCodeProjectPullRequestView } from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { describe, expect, it, vi } from "vitest";
import { ThreadUtilityDockContent } from "./ThreadUtilityDockContent";

vi.mock("../code/CodeWorkspaceTab", () => ({
  default: (props: { readonly tab: { readonly kind: string; readonly projectPath?: string } }) => (
    <p>{`${props.tab.kind}:${props.tab.projectPath ?? "none"}`}</p>
  ),
}));

vi.mock("../android/AndroidEmulatorPane", () => ({
  AndroidEmulatorPane: () => <p>android-emulator-pane</p>,
}));

vi.mock("../browser/BrowserWorkspace", () => ({
  BrowserWorkspace: (props: { readonly tab: { readonly threadId?: string } }) => (
    <p>{`browser:${props.tab.threadId ?? "none"}`}</p>
  ),
}));

const threadId = "10000000-0000-4000-8000-000000000001";
const codeController = {
  activeView: {
    thread: { id: threadId },
    checkout: { id: "20000000-0000-4000-8000-000000000002" },
  },
  client: {},
} as never;

function props() {
  return {
    appleProjectPath: "App/App.xcodeproj",
    appleToolchainClient: {} as never,
    chatClient: {} as never,
    chatReadCursorStore: { read: vi.fn(), write: vi.fn() } as never,
    codeController,
    onOpenFile: vi.fn(),
    onSidecarOpened: vi.fn(),
    subject: { mode: "code" as const, threadId },
    surface: "ios-simulator" as const,
  };
}

describe("thread utility dock content", () => {
  it("remounts the AgentRun hierarchy as the Agents dock tool", async () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        agentRunClient={
          {
            parentSummary: vi.fn(async () => ({
              parentThreadId: threadId,
              entries: [],
            })),
            preview: vi.fn(async () => ({
              status: "ready",
              facts: {
                mode: "code",
                allowedRoles: ["implementation", "review"],
                providerInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                modelId: "gpt-4o",
                workspaceKind: "code-worktree",
                authority: {
                  filesystem: true,
                  shell: true,
                  git: true,
                  network: true,
                  tools: true,
                  subagents: true,
                  executionPolicy: "approval-gated",
                  permissionPersistence: "current-session",
                },
                executionKind: "octant-managed",
                attemptedExecutionKind: "provider-native",
                nativeFallbackReason: "nativeChildAgents-claimed-unsupported",
                capabilityDegradations: ["native-child-agents-unavailable"],
                creationPosture: "ask",
              },
            })),
            acknowledge: vi.fn(),
            requestRun: vi.fn(),
            cancel: vi.fn(),
            steer: vi.fn(),
            retry: vi.fn(),
            resume: vi.fn(),
            prepareWorkspace: vi.fn(),
            confirmWorkspace: vi.fn(),
          } as never
        }
        surface="agents"
      />,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/Loading Agents/i);
    expect(
      await screen.findByRole("heading", { name: "Active / History" }, { timeout: 10_000 }),
    ).toBeVisible();
    expect(
      await screen.findByRole("form", { name: "Create subagent" }, { timeout: 10_000 }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Provider instance ID")).not.toBeInTheDocument();
  });

  it("opens Agents on a zero-child thread and shows the Off refusal without a create form", async () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        agentRunClient={
          {
            parentSummary: vi.fn(async () => ({
              parentThreadId: threadId,
              entries: [],
            })),
            preview: vi.fn(async () => ({
              status: "ready",
              facts: {
                mode: "code",
                allowedRoles: ["implementation"],
                providerInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                modelId: "gpt-4o",
                workspaceKind: "code-worktree",
                authority: {
                  filesystem: true,
                  shell: true,
                  git: true,
                  network: true,
                  tools: true,
                  subagents: true,
                  executionPolicy: "approval-gated",
                  permissionPersistence: "current-session",
                },
                executionKind: "octant-managed",
                attemptedExecutionKind: "provider-native",
                nativeFallbackReason: "nativeChildAgents-claimed-unsupported",
                capabilityDegradations: ["native-child-agents-unavailable"],
                creationPosture: "off",
              },
            })),
            acknowledge: vi.fn(),
            requestRun: vi.fn(),
            cancel: vi.fn(),
            steer: vi.fn(),
            retry: vi.fn(),
            resume: vi.fn(),
            prepareWorkspace: vi.fn(),
            confirmWorkspace: vi.fn(),
          } as never
        }
        agentRunSettingsClient={
          {
            current: vi.fn(async () => ({
              creationPosture: "off",
              version: 1,
              updatedAt: "2026-07-14T10:00:00.000Z",
            })),
            update: vi.fn(),
          } as never
        }
        surface="agents"
      />,
    );
    expect(await screen.findAllByText(/posture is Off/i, {}, { timeout: 10_000 })).not.toHaveLength(
      0,
    );
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Task")).not.toBeInTheDocument();
  });

  it("opens iOS Simulator through the real Apple workbench surface", async () => {
    render(<ThreadUtilityDockContent {...props()} />);
    expect(await screen.findByText("apple-workbench:App/App.xcodeproj")).toBeVisible();
  });

  it("states why iOS Simulator is unavailable when the thread has no Xcode project", async () => {
    const { appleProjectPath: _missing, ...withoutProject } = props();
    render(<ThreadUtilityDockContent {...withoutProject} />);
    expect(
      await screen.findByRole("heading", { name: "iOS Simulator is unavailable" }),
    ).toBeVisible();
  });

  it("explains that Files opens from a Code thread when the active thread is Chat", async () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        subject={{ mode: "chat", threadId }}
        surface="files"
      />,
    );

    // The Files pane is lazy-loaded; a cold module transform can exceed the
    // query library's one-second default in the full renderer suite.
    expect(
      await screen.findByRole("heading", { name: "Files is unavailable" }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.getByText("Files opens from a Code thread.")).toBeVisible();
  });

  it("lists the active Project's pull requests and hands a row to the shell", async () => {
    const user = userEvent.setup();
    const onSelectProjectPullRequest = vi.fn();
    const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
    const view = decodeCodeProjectPullRequestView({
      version: 1,
      query: { version: 1 },
      projects: [
        {
          kind: "connected",
          projectId,
          projectName: "Octant",
          repositoryOwner: "octant",
          repositoryName: "octant",
        },
        {
          kind: "connected",
          projectId: "10000000-0000-4000-8000-000000000002",
          projectName: "Elsewhere",
          repositoryOwner: "octant",
          repositoryName: "elsewhere",
        },
      ],
      rows: [
        {
          projectId,
          projectName: "Octant",
          repositoryOwner: "octant",
          repositoryName: "octant",
          number: 12,
          title: "List active pull requests",
          draft: false,
          state: "open",
          mergeability: "mergeable",
          author: "octocat",
          baseBranch: "main",
          headBranch: "feature/list",
          updatedAt: "2026-09-08T00:00:00.000Z",
          checks: "passing",
          review: "approved",
          linkedThreads: [],
        },
      ],
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      freshness: { status: "fresh", lastSuccessfulRefreshAt: "2026-09-08T00:00:00.000Z" },
      generatedAt: "2026-09-08T00:00:00.000Z",
    });
    render(
      <ThreadUtilityDockContent
        {...props()}
        codeClient={
          {
            queryProjectPullRequests: vi.fn(async () => view),
            refreshProjectPullRequests: vi.fn(async () => view),
          } as never
        }
        onSelectProjectPullRequest={onSelectProjectPullRequest}
        subject={{ mode: "code", threadId, projectId }}
        surface="pull-requests"
      />,
    );

    // The module is lazy-loaded; a cold module transform can exceed the query
    // library's one-second default in the full renderer suite.
    const row = await screen.findByRole(
      "button",
      { name: /List active pull requests/i },
      { timeout: 5_000 },
    );
    expect(screen.queryByRole("region", { name: "Project Elsewhere" })).toBeNull();

    await user.click(row);
    expect(onSelectProjectPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ number: 12, title: "List active pull requests" }),
    );
  });

  it("explains that Pull requests needs a Project on the active thread", async () => {
    render(<ThreadUtilityDockContent {...props()} surface="pull-requests" />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Pull requests is unavailable" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(
      screen.getByText("This thread has no Project whose pull requests could be listed."),
    ).toBeVisible();
  });

  it("uses a loading state while Code utility data is still arriving", async () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        codeController={{ client: {} } as never}
        surface="terminal"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading Terminal");
    expect(
      screen.queryByRole("heading", { name: "Terminal is unavailable" }),
    ).not.toBeInTheDocument();
  });

  it("states why iOS Simulator is unavailable when the Apple toolchain client is missing", async () => {
    const { appleToolchainClient: _missing, ...withoutClient } = props();
    render(<ThreadUtilityDockContent {...withoutClient} />);
    expect(
      await screen.findByRole("heading", { name: "iOS Simulator is unavailable" }),
    ).toBeVisible();
    expect(screen.queryByText(/apple-workbench/)).not.toBeInTheDocument();
  });

  it("does not leak Simulator state from another pane's thread", async () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        subject={{ mode: "code", threadId: "10000000-0000-4000-8000-000000000099" }}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Loading iOS Simulator" })).toBeVisible();
    expect(screen.queryByText("apple-workbench:App/App.xcodeproj")).not.toBeInTheDocument();
  });

  it("does not stop the Simulator destination when the dock tab unmounts", async () => {
    const execute = vi.fn();
    const { unmount } = render(
      <ThreadUtilityDockContent {...props()} appleToolchainClient={{ execute } as never} />,
    );
    await screen.findByText("apple-workbench:App/App.xcodeproj");
    unmount();
    expect(execute).not.toHaveBeenCalled();
  });

  it("renders the live Browser instance owned by the thread", async () => {
    const stop = vi.fn();
    const { unmount } = render(
      <ThreadUtilityDockContent
        {...props()}
        browserAutomationClient={{ stop } as never}
        subject={{ mode: "code", threadId }}
        surface="browser"
      />,
    );
    expect(await screen.findByText(`browser:${threadId}`)).toBeVisible();
    unmount();
    expect(stop).not.toHaveBeenCalled();
  });

  it("opens Review for the Code thread without a workspace diff tab", async () => {
    render(<ThreadUtilityDockContent {...props()} surface="review" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Git observation is unavailable");
    expect(screen.queryByText(/code-diff/)).not.toBeInTheDocument();
  });

  it("renders the live Terminal instance owned by the thread", async () => {
    render(<ThreadUtilityDockContent {...props()} surface="terminal" />);
    expect(await screen.findByText("code-terminal:none")).toBeVisible();
  });

  it("does not offer a Propose plan form in the dock", async () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        planClient={
          {
            read: vi.fn(async () => ({ plan: null, history: [] })),
            execute: vi.fn(),
          } as never
        }
        surface="plan"
      />,
    );
    expect(screen.queryByRole("button", { name: "Propose plan" })).not.toBeInTheDocument();
  });

  it("renders the Android emulator pane from a Code thread without an Xcode project", async () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        androidToolchainClient={{ execute: vi.fn() } as never}
        surface="android-emulator"
      />,
    );
    expect(await screen.findByText("android-emulator-pane")).toBeVisible();
  });

  it("states why Android emulator is unavailable when the toolchain client is missing", async () => {
    render(<ThreadUtilityDockContent {...props()} surface="android-emulator" />);
    expect(
      await screen.findByRole("heading", { name: "Android emulator is unavailable" }),
    ).toBeVisible();
  });
});
