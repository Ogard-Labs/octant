import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { GithubClient } from "@octant/client-runtime/github-client";
import {
  decodeGithubCatalogueReadResponse,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type CodeEnvironmentObservation,
  type LocalServerCommand,
  type LocalServerCommandResult,
  type ProjectId,
  type ProjectSummary,
  type WorkspaceTab,
} from "@octant/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeThreadEnvironment } from "./CodeThreadEnvironment";

const codeProjectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const tabId = decodeWorkspaceTabId("30000000-0000-4000-8000-00000000000a");
const codeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000701");

function codeTab(): Extract<WorkspaceTab, { readonly mode: "code" }> {
  return decodeWorkspaceTab({
    kind: "code-overview",
    id: tabId,
    threadId: codeThreadId,
    mode: "code",
    title: "Issue 204",
  }) as Extract<WorkspaceTab, { readonly mode: "code" }>;
}

function codeProject(id: ProjectId = codeProjectId): ProjectSummary {
  return {
    id,
    type: "code",
    name: "Octant",
    lifecycle: "active",
    pinned: true,
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["createdAt"],
    updatedAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["updatedAt"],
    binding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
    codeAccessPersistence: "current-session",
  } as ProjectSummary;
}

function readyObservation(): CodeEnvironmentObservation {
  return {
    status: "ready",
    projectId: codeProjectId,
    projectName: "Octant",
    repositoryRoot: "/Users/example/Dev/Repos/octant",
    worktreeRoot: "/Users/example/Dev/Repos/octant/.worktrees/issue-204",
    branch: { kind: "named", name: "feature/issue-204" },
    changes: "dirty",
    workingDirectory: "." as never,
    threadVersion: 1 as never,
    observedAt: "2026-07-23T20:00:00.000Z" as CodeEnvironmentObservation["observedAt"],
  };
}

function projectClient(observation: CodeEnvironmentObservation): ProjectClient {
  return {
    bootstrap: vi.fn(),
    search: vi.fn(),
    executeProject: vi.fn(),
    memory: vi.fn(),
    environment: vi.fn(async () => observation),
    environmentForThread: vi.fn(async () => observation),
    executeMemory: vi.fn(),
  };
}

async function openEnvironment(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Environment details" })).toBeVisible(),
  );
}

describe("CodeThreadEnvironment", () => {
  it("defers Git observation until the transcript is display-ready", async () => {
    const client = projectClient(readyObservation());
    const { rerender } = render(
      <CodeThreadEnvironment
        environmentOpen
        observe={false}
        project={codeProject()}
        projectClient={client}
        tab={codeTab()}
      >
        <div>Transcript</div>
      </CodeThreadEnvironment>,
    );

    expect(client.environmentForThread).not.toHaveBeenCalled();
    rerender(
      <CodeThreadEnvironment
        environmentOpen
        observe
        project={codeProject()}
        projectClient={client}
        tab={codeTab()}
      >
        <div>Transcript</div>
      </CodeThreadEnvironment>,
    );

    await waitFor(() => expect(client.environmentForThread).toHaveBeenCalledOnce());
  });

  it("renders the code workspace children inside the content area", () => {
    render(
      <CodeThreadEnvironment
        environmentOpen
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div data-testid="code-workspace-content">Code surface</div>
      </CodeThreadEnvironment>,
    );
    expect(screen.getByTestId("code-workspace-content")).toBeVisible();
  });

  it("names the thread's identity and facts in the Environment header", async () => {
    render(
      <CodeThreadEnvironment
        environmentOpen
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("region", { name: "Environment details" })).toBeVisible();
    expect(screen.getByText("Octant · feature/issue-204 · Dirty")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Environment" })).not.toBeInTheDocument();
  });

  it("holds only environment-scoped groups, leaving the thread's own surfaces to the dock", async () => {
    render(
      <CodeThreadEnvironment
        environmentOpen
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div data-testid="code-workspace-content">Code surface</div>
      </CodeThreadEnvironment>,
    );
    await openEnvironment();

    expect(screen.getByRole("button", { name: /^Local servers/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Files/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Plan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Agents/ })).not.toBeInTheDocument();
  });

  it("lists open pull requests beneath the environment facts", async () => {
    const githubClient = {
      readCatalogue: vi.fn(async () =>
        decodeGithubCatalogueReadResponse({
          kind: "pull-requests",
          page: {
            rows: [
              {
                number: 42,
                title: "Keep the environment useful",
                state: "open",
                author: "henrikogaard",
                updatedAt: "2026-08-21T12:00:00Z",
                url: "https://github.com/acme/repo/pull/42",
                baseBranch: "main",
                headBranch: "feature/environment",
              },
            ],
            sort: "updated-desc",
            hasNextPage: false,
            freshness: { status: "fresh" },
          },
        }),
      ),
    } as unknown as GithubClient;
    render(
      <CodeThreadEnvironment
        environmentOpen
        githubClient={githubClient}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        pullRequestRepository="acme/repo"
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );

    await openEnvironment();
    fireEvent.click(screen.getByRole("button", { name: "Pull requests" }));
    expect(await screen.findByText("#42 Keep the environment useful")).toBeVisible();
    expect(githubClient.readCatalogue).toHaveBeenCalledWith({
      kind: "pull-requests",
      owner: "acme",
      name: "repo",
      pageSize: 20,
      state: "open",
    });
  });

  it("opens Review from View changes without leaving the thread surface", async () => {
    const onOpenChanges = vi.fn();
    render(
      <CodeThreadEnvironment
        environmentOpen
        onOpenChanges={onOpenChanges}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div data-testid="code-workspace-content">Transcript stays here</div>
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    fireEvent.click(screen.getByRole("button", { name: "View changes" }));
    expect(onOpenChanges).toHaveBeenCalledOnce();
    expect(screen.getByTestId("code-workspace-content")).toBeVisible();
  });

  it("renders the authoritative Git facts in the disclosure once opened", async () => {
    render(
      <CodeThreadEnvironment
        environmentOpen
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.getByTestId("environment-worktree-value")).toBeVisible();
    expect(screen.getAllByText("Branch").length).toBeGreaterThan(0);
  });

  it("reports an unavailable identity when no project is bound to the tab", () => {
    render(
      <CodeThreadEnvironment
        environmentOpen
        project={undefined}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    expect(screen.getByRole("region", { name: "Environment details" })).toHaveAttribute(
      "data-environment-status",
      "unavailable",
    );
    expect(screen.getByText("Code · No project")).toBeVisible();
  });

  it("keeps open state as renderer state and closes when the pane is no longer active", async () => {
    const { rerender } = render(
      <CodeThreadEnvironment
        environmentOpen
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.getByRole("region", { name: "Environment details" })).toBeVisible();

    rerender(
      <CodeThreadEnvironment
        environmentOpen
        active={false}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    expect(screen.queryByRole("region", { name: "Environment details" })).not.toBeInTheDocument();
  });

  it("submits a bounded relative working directory through the focused Change working folder flow", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn(async () => ({
      kind: "thread-updated" as const,
      thread: { workingDirectory: "packages/app", version: 2 },
    }));
    render(
      <CodeThreadEnvironment
        environmentOpen
        onExecute={onExecute as never}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.queryByLabelText("Working folder")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Working folder/ }));
    await user.click(screen.getByRole("button", { name: "Change working folder" }));
    await screen.findByDisplayValue(".");
    expect(screen.getByLabelText("Working folder")).toHaveFocus();
    const workingFolder = screen.getByLabelText("Working folder");
    await user.clear(workingFolder);
    await user.type(workingFolder, "packages/app");
    const apply = screen.getByRole("button", { name: "Apply working folder" });
    await waitFor(() => expect(apply).toBeEnabled(), { timeout: 5_000 });
    await user.click(apply);

    await waitFor(
      () =>
        expect(onExecute).toHaveBeenCalledWith({
          kind: "change-code-thread-working-directory",
          threadId: codeThreadId,
          expectedVersion: 1,
          workingDirectory: "packages/app",
        }),
      { timeout: 5_000 },
    );
  });

  it("surfaces an authoritative Code working-directory rejection", async () => {
    const onExecute = vi.fn(async () => ({
      category: "invalid" as const,
      message: "Code working directory is unavailable.",
    }));
    render(
      <CodeThreadEnvironment
        environmentOpen
        onExecute={onExecute as never}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    fireEvent.click(screen.getByRole("button", { name: /^Working folder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change working folder" }));
    await screen.findByDisplayValue(".");
    fireEvent.change(screen.getByLabelText("Working folder"), {
      target: { value: "missing" },
    });
    screen.getByRole("button", { name: "Apply working folder" }).click();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an existing folder inside this Project.",
    );
  });

  it("does not scan listeners on a timer while the Environment disclosure is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const commands: LocalServerCommand[] = [];
    const localServerClient = {
      execute: vi.fn(async (command: LocalServerCommand) => {
        commands.push(command);
        return {
          kind: "local-servers-listed",
          requestId: command.requestId,
          snapshot: {
            threadId: codeThreadId,
            projectId: codeProjectId,
            currentCheckout: [],
            other: [],
            observedAt: "2026-08-14T08:00:00.000Z",
          },
        } as unknown as LocalServerCommandResult;
      }),
    };
    try {
      render(
        <CodeThreadEnvironment
          localServerClient={localServerClient as never}
          project={codeProject()}
          projectClient={projectClient(readyObservation())}
          tab={codeTab()}
        >
          <div />
        </CodeThreadEnvironment>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      await waitFor(() => expect(localServerClient.execute).toHaveBeenCalled());
      const initial = localServerClient.execute.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(localServerClient.execute.mock.calls.length).toBe(initial);
    } finally {
      vi.useRealTimers();
    }
  });
});
