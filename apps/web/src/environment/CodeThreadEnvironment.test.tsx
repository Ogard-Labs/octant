import type { ProjectClient } from "@octant/client-runtime/project-client";
import {
  decodeCodeProjectPullRequestView,
  decodeCodeOperationId,
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
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeCheckoutBar } from "../code/CodeCheckoutBar";
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

function readyObservation(): Extract<CodeEnvironmentObservation, { readonly status: "ready" }> {
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

const goalCriteria = [
  {
    id: "c1",
    text: "The parser tests pass",
    check: "bun run test --filter parser",
    status: "met",
    evidence: {
      kind: "test",
      referenceId: "goal-check:c1",
      summary: "Exited 0 after 41 passing tests",
      observedAt: "2026-08-01T10:00:00.000Z",
    },
  },
  {
    id: "c2",
    text: "The changelog names the change",
    status: "unmet",
  },
  {
    id: "c3",
    text: "The build is clean",
    check: "bun run build",
    status: "unmet",
    evidence: {
      kind: "test",
      referenceId: "goal-check:c3",
      summary: "Exited 1: type error in lexer.ts",
      observedAt: "2026-08-01T10:05:00.000Z",
    },
  },
];

function goalClientFor(goal: unknown) {
  return {
    read: vi.fn(async () => ({ goal, history: [] })),
    execute: vi.fn(),
  };
}

function codeGoal(criteria: unknown) {
  return {
    id: "00000000-0000-4000-8000-000000000206",
    threadId: codeThreadId,
    revisionId: "00000000-0000-4000-8000-000000000207",
    objective: "Ship the parser",
    status: "active",
    budget: {},
    usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
    evidence: [],
    criteria,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 2,
  };
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

  it("reads the checkout once the host has reconnected it, so the bar under the composer appears", async () => {
    const client = projectClient(readyObservation());
    const view = (checkoutAvailability: "waiting" | "available") => (
      <CodeThreadEnvironment
        checkoutAvailability={checkoutAvailability}
        observe
        project={codeProject()}
        projectClient={client}
        tab={codeTab()}
      >
        <CodeCheckoutBar />
      </CodeThreadEnvironment>
    );
    const { rerender } = render(view("waiting"));
    await act(async () => {
      await Promise.resolve();
    });

    // The host refuses a read while it is still reconnecting the checkout, and
    // nothing asked again, so the bar stayed away for as long as the tab lived.
    expect(client.environmentForThread).not.toHaveBeenCalled();
    rerender(view("available"));

    await waitFor(() =>
      expect(screen.getByLabelText("Checkout")).toHaveTextContent("feature/issue-204"),
    );
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

  it("re-reads the checkout when a turn settles, so the bar under the composer counts what the turn changed", async () => {
    const client = projectClient({ ...readyObservation(), insertions: 3, deletions: 1 });
    let settleReRead: (observation: CodeEnvironmentObservation) => void = () => undefined;
    const view = (latestSettledTurn: string) => (
      <CodeThreadEnvironment
        latestSettledTurn={decodeCodeOperationId(latestSettledTurn)}
        observe
        project={codeProject()}
        projectClient={client}
        tab={codeTab()}
      >
        <CodeCheckoutBar />
      </CodeThreadEnvironment>
    );
    const { rerender } = render(view("00000000-0000-4000-8000-000000000a01"));
    expect(await screen.findByLabelText("Checkout")).toHaveTextContent("+3−1");

    vi.mocked(client.environmentForThread).mockImplementationOnce(
      () => new Promise((resolve) => (settleReRead = resolve)),
    );
    rerender(view("00000000-0000-4000-8000-000000000a02"));

    // The host keeps a Git reading for a few seconds, so a read that did not
    // skip it could hand back the counts from before the turn's edits.
    await waitFor(() =>
      expect(client.environmentForThread).toHaveBeenLastCalledWith(
        codeProjectId,
        codeThreadId,
        expect.any(AbortSignal),
        true,
      ),
    );
    // Dropping the facts while they are re-read would pull the bar out from
    // under the composer and put it back a moment later, after every turn.
    expect(screen.getByLabelText("Checkout")).toHaveTextContent("+3−1");
    await act(async () => {
      settleReRead({ ...readyObservation(), insertions: 12, deletions: 4 });
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Checkout")).toHaveTextContent("+12−4");
    expect(client.environmentForThread).toHaveBeenCalledTimes(2);
  });

  it("shows the thread's goal with each criterion's check and evidence, without controls to change it", async () => {
    const goalClient = goalClientFor(codeGoal(goalCriteria));
    render(
      <CodeThreadEnvironment
        environmentOpen
        goalClient={goalClient as never}
        observe
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );

    const ledger = await screen.findByRole("region", { name: "Acceptance criteria" });
    expect(goalClient.read).toHaveBeenCalledWith(String(codeThreadId), expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Goal 1 of 3 met" })).toBeVisible();
    expect(screen.getByTestId("goal-objective")).toHaveTextContent("Ship the parser");
    expect(within(ledger).getAllByRole("listitem")).toHaveLength(3);
    expect(ledger).toHaveTextContent("bun run test --filter parser");
    expect(ledger).toHaveTextContent("Exited 0 after 41 passing tests");
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revise" })).not.toBeInTheDocument();
    expect(goalClient.execute).not.toHaveBeenCalled();
  });

  it("leaves the Goal row out of a thread that has no goal", async () => {
    const goalClient = goalClientFor(null);
    render(
      <CodeThreadEnvironment
        environmentOpen
        goalClient={goalClient as never}
        observe
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    await waitFor(() => expect(goalClient.read).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: /^Goal/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("goal-objective")).not.toBeInTheDocument();
  });

  it("reads the goal again when a turn settles, so criteria the lead just checked show as met", async () => {
    const goalClient = goalClientFor(codeGoal(goalCriteria));
    const view = (turn: string) => (
      <CodeThreadEnvironment
        environmentOpen
        goalClient={goalClient as never}
        latestSettledTurn={decodeCodeOperationId(turn)}
        observe
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>
    );
    const { rerender } = render(view("00000000-0000-4000-8000-000000000a01"));
    expect(await screen.findByTestId("goal-criteria-summary")).toHaveTextContent("1 of 3 met");

    goalClient.read.mockResolvedValue({
      goal: codeGoal(goalCriteria.map((criterion) => ({ ...criterion, status: "met" }))),
      history: [],
    });
    rerender(view("00000000-0000-4000-8000-000000000a02"));

    await waitFor(() =>
      expect(screen.getByTestId("goal-criteria-summary")).toHaveTextContent("3 of 3 met"),
    );
    expect(goalClient.read).toHaveBeenCalledTimes(2);
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

  it("lists the connected Project's journaled pull requests beneath the environment facts", async () => {
    const queryProjectPullRequests = vi.fn(async () =>
      decodeCodeProjectPullRequestView({
        version: 1,
        query: { version: 1 },
        projects: [
          {
            kind: "connected",
            projectId: String(codeProjectId),
            projectName: "Octant",
            repositoryOwner: "acme",
            repositoryName: "repo",
          },
        ],
        rows: [
          {
            projectId: String(codeProjectId),
            projectName: "Octant",
            repositoryOwner: "acme",
            repositoryName: "repo",
            number: 42,
            title: "Keep the environment useful",
            draft: false,
            state: "open",
            mergeability: "mergeable",
            author: "henrikogaard",
            baseBranch: "main",
            headBranch: "feature/environment",
            updatedAt: "2026-08-21T12:00:00.000Z",
            checks: "passing",
            review: "approved",
            linkedThreads: [],
          },
        ],
        repositoriesTruncated: false,
        pullRequestsTruncated: false,
        freshness: { status: "fresh" },
        generatedAt: "2026-08-21T12:05:00.000Z",
      }),
    );
    const pullRequestClient = {
      queryProjectPullRequests,
      refreshProjectPullRequests: vi.fn(),
    };
    render(
      <CodeThreadEnvironment
        environmentOpen
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        pullRequestClient={pullRequestClient}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );

    await openEnvironment();
    fireEvent.click(screen.getByRole("button", { name: /Pull requests/ }));
    expect(await screen.findByText(/#42 Keep the environment useful/)).toBeVisible();
    // The Environment reads the journaled snapshot only — never the live
    // repository catalogue the old group used.
    expect(queryProjectPullRequests).toHaveBeenCalledWith({ version: 1 });
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

  it("names the checkout, its branch, and its folder once, above the changes", async () => {
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
    const header = screen.getByRole("region", { name: "Environment details" });
    expect(within(header).getByText("feature/issue-204")).toBeVisible();
    expect(within(header).getByText("~/Dev/Repos/octant/.worktrees/issue-204")).toBeVisible();
    expect(screen.getAllByText("feature/issue-204")).toHaveLength(1);
    expect(screen.getByTitle(readyObservation().worktreeRoot)).toHaveTextContent("issue-204");
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
    expect(screen.getByText("Code · No Project")).toBeVisible();
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

  it("keeps keyboard focus on the Working folder row when applying re-reads the checkout", async () => {
    const user = userEvent.setup();
    const initial = readyObservation();
    const reread = { ...initial, workingDirectory: "packages/app", threadVersion: 2 } as never;
    let reads = 0;
    const client = projectClient(initial);
    // The re-read takes long enough for the Environment to render without its
    // facts, which unmounts the field and the group that held focus.
    vi.mocked(client.environmentForThread).mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return initial;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return reread;
    });
    const onExecute = vi.fn(async () => ({
      kind: "thread-updated" as const,
      thread: { workingDirectory: "packages/app", version: 2 },
    }));
    render(
      <CodeThreadEnvironment
        environmentOpen
        onExecute={onExecute as never}
        project={codeProject()}
        projectClient={client}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    await user.click(screen.getByRole("button", { name: /^Working folder/ }));
    await user.click(screen.getByRole("button", { name: "Change working folder" }));
    const workingFolder = await screen.findByDisplayValue(".");
    await user.clear(workingFolder);
    await user.type(workingFolder, "packages/app");
    await user.click(screen.getByRole("button", { name: "Apply working folder" }));

    await waitFor(
      () => expect(screen.getByRole("button", { name: /^Working folder/ })).toHaveFocus(),
      { timeout: 5_000 },
    );
  });

  it("moves keyboard focus to the failure when the re-read after an apply fails", async () => {
    const user = userEvent.setup();
    const initial = readyObservation();
    let reads = 0;
    const client = projectClient(initial);
    vi.mocked(client.environmentForThread).mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return initial;
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("The Project service did not answer.");
    });
    const onExecute = vi.fn(async () => ({
      kind: "thread-updated" as const,
      thread: { workingDirectory: "packages/app", version: 2 },
    }));
    render(
      <CodeThreadEnvironment
        environmentOpen
        onExecute={onExecute as never}
        project={codeProject()}
        projectClient={client}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    await user.click(screen.getByRole("button", { name: /^Working folder/ }));
    await user.click(screen.getByRole("button", { name: "Change working folder" }));
    const workingFolder = await screen.findByDisplayValue(".");
    await user.clear(workingFolder);
    await user.type(workingFolder, "packages/app");
    await user.click(screen.getByRole("button", { name: "Apply working folder" }));

    const alert = await screen.findByRole("alert", {}, { timeout: 5_000 });
    expect(alert).toHaveTextContent("The Project service did not answer.");
    await waitFor(() => expect(alert.closest(".environment-git-group__state")).toHaveFocus());
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
