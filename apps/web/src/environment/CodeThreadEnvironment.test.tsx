import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { GithubClient } from "@octant/client-runtime/github-client";
import {
  decodeGithubCatalogueReadResponse,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type CodeEnvironmentObservation,
  type ProjectId,
  type ProjectSummary,
  type WorkspaceTab,
} from "@octant/contracts";
import { defaultEnvironmentPresentationState } from "@octant/domain/shell-policy";
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

describe("CodeThreadEnvironment", () => {
  it("renders the code workspace children inside the content area", () => {
    render(
      <CodeThreadEnvironment
        onChangePresentation={vi.fn()}
        presentation={defaultEnvironmentPresentationState()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div data-testid="code-workspace-content">Code surface</div>
      </CodeThreadEnvironment>,
    );
    expect(screen.getByTestId("code-workspace-content")).toBeVisible();
  });

  it("holds only environment-scoped groups, leaving the thread's own surfaces to the dock", async () => {
    render(
      <CodeThreadEnvironment
        onChangePresentation={vi.fn()}
        presentation={defaultEnvironmentPresentationState()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div data-testid="code-workspace-content">Code surface</div>
      </CodeThreadEnvironment>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: /^Changes/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Local servers/ })).toBeVisible();
    // Files, Plan, Publish, and Agents are thread surfaces, not environment
    // facts; stacked here they turned a glance into a list of disclosures.
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
        githubClient={githubClient}
        onChangePresentation={vi.fn()}
        presentation={defaultEnvironmentPresentationState()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        pullRequestRepository="acme/repo"
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );

    expect(await screen.findByText("#42 Keep the environment useful")).toBeVisible();
    expect(githubClient.readCatalogue).toHaveBeenCalledWith({
      kind: "pull-requests",
      owner: "acme",
      name: "repo",
      pageSize: 20,
      state: "open",
    });
  });

  it("projects an authoritative identity from the ready observation", async () => {
    render(
      <CodeThreadEnvironment
        onChangePresentation={vi.fn()}
        presentation={defaultEnvironmentPresentationState()}
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
    // Code mode defaults to floating, so the panel is on screen.
    expect(screen.getByRole("dialog", { name: "Environment for Octant" })).toBeVisible();
    expect(screen.getAllByText("feature/issue-204").length).toBeGreaterThan(0);
    expect(screen.getByText("available")).toBeVisible();
  });

  it("renders the authoritative Git facts in the panel body once ready", async () => {
    render(
      <CodeThreadEnvironment
        onChangePresentation={vi.fn()}
        presentation={defaultEnvironmentPresentationState()}
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
    expect(screen.getByTestId("environment-worktree-value")).toBeVisible();
    expect(screen.getAllByText("Branch").length).toBeGreaterThan(0);
  });

  it("reports an unavailable identity when no project is bound to the tab", () => {
    render(
      <CodeThreadEnvironment
        onChangePresentation={vi.fn()}
        presentation={defaultEnvironmentPresentationState()}
        project={undefined}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    // No project -> effective presentation falls back to the code-mode default
    // (floating), and the compact identity reports the unavailable state.
    expect(screen.getByText("No project")).toBeVisible();
    expect(screen.getByText("unavailable")).toBeVisible();
  });

  it("dispatches presentation overrides through onChangePresentation", () => {
    const onChange = vi.fn();
    render(
      <CodeThreadEnvironment
        onChangePresentation={onChange}
        presentation={defaultEnvironmentPresentationState()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    screen.getByRole("button", { name: "Hide environment panel" }).click();
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultEnvironmentPresentationState(),
      byTab: [{ tabId, presentation: "hidden" }],
    });
  });

  it("submits a bounded relative working directory through the Code command authority", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn(async () => ({
      kind: "thread-updated" as const,
      thread: { workingDirectory: "packages/app", version: 2 },
    }));
    render(
      <CodeThreadEnvironment
        onChangePresentation={vi.fn()}
        onExecute={onExecute as never}
        presentation={defaultEnvironmentPresentationState()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Working folder" }));
    await screen.findByDisplayValue(".");
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
        onChangePresentation={vi.fn()}
        onExecute={onExecute as never}
        presentation={defaultEnvironmentPresentationState()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Working folder" }));
    await screen.findByDisplayValue(".");
    fireEvent.change(screen.getByLabelText("Working folder"), {
      target: { value: "missing" },
    });
    screen.getByRole("button", { name: "Apply working folder" }).click();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an existing folder inside this Project.",
    );
  });
});
