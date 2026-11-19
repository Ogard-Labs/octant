import type { ProjectClient } from "@octant/client-runtime/project-client";
import {
  decodeCodeProjectPullRequestView,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeThreadBoardPullRequestSummaries,
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
import { decodeProjectExtraFolder } from "@octant/contracts/projects";
import { describe, expect, it, vi } from "vitest";
import { CodeCheckoutBar } from "../code/CodeCheckoutBar";
import { CodeThreadEnvironment } from "./CodeThreadEnvironment";
import { ThreadActivityPreviewContext } from "../threadActivity/ThreadActivityEnvironment";

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
    listMemoryProposals: vi.fn(async () => []),
    decideMemoryProposal: vi.fn(),
    listDesignSystems: vi.fn(),
    readDesignSystem: vi.fn(),
    saveDesignSystem: vi.fn(),
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

  it("holds no thread surface that belongs to the dock, and no Local servers row while nothing is running", async () => {
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

  it("lists this thread's pull requests in the Changes card and counts them in its folded summary", async () => {
    const onOpenThreadPullRequest = vi.fn();
    const threadPullRequests = decodeThreadBoardPullRequestSummaries({
      items: [
        {
          identity: {
            projectId: String(codeProjectId),
            repositoryOwner: "acme",
            repositoryName: "repo",
            number: 12,
          },
          title: "Deliver the change",
          state: "merged",
          checks: "passing",
          review: "approved",
          mergeability: "mergeable",
          freshness: "fresh",
          readyToMerge: false,
        },
      ],
      hiddenCount: 0,
    });
    render(
      <CodeThreadEnvironment
        environmentOpen
        onOpenThreadPullRequest={onOpenThreadPullRequest}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
        threadPullRequests={threadPullRequests}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    const changes = screen.getByRole("group", { name: "Changes" });
    fireEvent.click(within(changes).getByRole("button", { name: /^Pull request 12/ }));
    expect(onOpenThreadPullRequest).toHaveBeenCalledTimes(1);
    // Folded, the section still says there is one.
    fireEvent.click(within(changes).getByRole("button", { name: /^Changes/ }));
    expect(within(changes).getByText(/· 1 PR$/)).toBeInTheDocument();
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

  it("leads with the thread's place as rows: the Project with its folder, the branch with its checkout kind", async () => {
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
    expect(header.querySelector(".environment-card__caption")).toHaveTextContent("Environment");
    expect(within(header).getByText("~/Dev/Repos/octant/.worktrees/issue-204")).toBeVisible();
    const branch = within(header).getByText("feature/issue-204").closest(".environment-row");
    expect(branch).toHaveTextContent("feature/issue-204Worktree");
    expect(screen.getByTitle(readyObservation().worktreeRoot)).toHaveTextContent(
      "Worktree…/.worktrees/issue-204",
    );
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

  it("changes what the task delivers from one Delivers row's menu, with the version it read", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn(async () => ({ kind: "thread-updated" as const }));
    render(
      <CodeThreadEnvironment
        deliveryOutcome="opened-pr"
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

    await user.click(await screen.findByRole("button", { name: "Delivers, Opened PR" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Local change" }));

    expect(onExecute).toHaveBeenCalledWith({
      kind: "confirm-code-delivery-outcome",
      threadId: codeThreadId,
      expectedVersion: 1,
      outcomeKind: "local-implementation",
    });
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

  it("shows Local servers only while a server runs, and says nothing running when none does", async () => {
    const serverClient = (currentCheckout: ReadonlyArray<unknown>) => ({
      execute: vi.fn(
        async (command: LocalServerCommand) =>
          ({
            kind: "local-servers-listed",
            requestId: command.requestId,
            snapshot: {
              threadId: codeThreadId,
              projectId: codeProjectId,
              currentCheckout,
              other: [],
              observedAt: "2026-08-14T08:00:00.000Z",
            },
          }) as unknown as LocalServerCommandResult,
      ),
    });
    const idle = serverClient([]);
    const first = render(
      <CodeThreadEnvironment
        environmentOpen
        localServerClient={idle as never}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    await waitFor(() => expect(idle.execute).toHaveBeenCalled());
    expect(screen.queryByText("Local servers")).not.toBeInTheDocument();
    first.unmount();

    const busy = serverClient([
      {
        listenerId: "lsn_0123456789abcdef0123456789abcdef",
        port: 5173,
        url: "http://127.0.0.1:5173/",
        processName: "node",
        workingDirectory: "/Users/example/code/octant",
        attribution: "current-checkout",
        startSource: "octant",
        bindScope: "loopback",
        health: "listening",
        openAvailable: true,
        stop: { status: "available", confirmationRequired: false },
      },
    ]);
    render(
      <CodeThreadEnvironment
        environmentOpen
        localServerClient={busy as never}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    expect(await screen.findByRole("button", { name: /^Local servers/ })).toBeVisible();
  });

  it("keeps the Local servers row with its error when the first read fails", async () => {
    const failing = {
      execute: vi.fn(async () => {
        throw new Error("The server list could not be read.");
      }),
    };
    render(
      <CodeThreadEnvironment
        environmentOpen
        localServerClient={failing as never}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    expect(await screen.findByRole("button", { name: /^Local servers/ })).toBeVisible();
    expect(await screen.findByRole("alert")).toBeVisible();
  });

  it("draws the Computer use row only while a session exists", async () => {
    const renderWith = (available: boolean) =>
      render(
        <ThreadActivityPreviewContext.Provider
          value={{ available, hidden: false, setHidden: vi.fn() }}
        >
          <CodeThreadEnvironment
            environmentOpen
            project={codeProject()}
            projectClient={projectClient(readyObservation())}
            tab={codeTab()}
          >
            <div />
          </CodeThreadEnvironment>
        </ThreadActivityPreviewContext.Provider>,
      );
    const none = renderWith(false);
    await openEnvironment();
    expect(screen.queryByText("Computer use")).not.toBeInTheDocument();
    none.unmount();
    renderWith(true);
    await openEnvironment();
    expect(screen.getByText("Computer use")).toBeVisible();
  });

  describe("the Changes section", () => {
    const detachedClean = (): CodeEnvironmentObservation => ({
      ...readyObservation(),
      branch: { kind: "detached", oid: "0123456789abcdef0123456789abcdef01234567" },
      changes: "clean",
    });
    const unavailable = (): CodeEnvironmentObservation => ({
      status: "unavailable",
      projectId: codeProjectId,
      projectName: "Octant",
      observedAt: "2026-07-23T20:00:00.000Z" as CodeEnvironmentObservation["observedAt"],
      reason: "The checkout is not reachable.",
    });
    async function renderChanges(observation: CodeEnvironmentObservation, extra = {}) {
      render(
        <CodeThreadEnvironment
          environmentOpen
          onCreatePullRequest={vi.fn()}
          onNewThreadInProject={vi.fn()}
          onOpenGit={vi.fn()}
          onOpenWorktrees={vi.fn()}
          project={codeProject()}
          projectClient={projectClient(observation)}
          tab={codeTab()}
          {...extra}
        >
          <div />
        </CodeThreadEnvironment>,
      );
      await openEnvironment();
      await screen.findByRole("button", { name: "More for changes" });
    }

    it("offers Commit or push and Create pull request on a checkout with changes on a branch", async () => {
      await renderChanges(readyObservation());
      expect(screen.getByRole("button", { name: "Commit or push" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Create pull request" })).toBeVisible();
    });

    it("offers neither row on a clean detached checkout or one that cannot be read", async () => {
      const clean = render(
        <CodeThreadEnvironment
          environmentOpen
          onCreatePullRequest={vi.fn()}
          onOpenGit={vi.fn()}
          project={codeProject()}
          projectClient={projectClient(detachedClean())}
          tab={codeTab()}
        >
          <div />
        </CodeThreadEnvironment>,
      );
      await openEnvironment();
      await screen.findByText("No uncommitted changes");
      expect(screen.queryByRole("button", { name: "Commit or push" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create pull request" })).not.toBeInTheDocument();
      clean.unmount();
      render(
        <CodeThreadEnvironment
          environmentOpen
          onCreatePullRequest={vi.fn()}
          onOpenGit={vi.fn()}
          project={codeProject()}
          projectClient={projectClient(unavailable())}
          tab={codeTab()}
        >
          <div />
        </CodeThreadEnvironment>,
      );
      await screen.findByText("Repository unavailable");
      expect(screen.queryByRole("button", { name: "Commit or push" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create pull request" })).not.toBeInTheDocument();
    });

    it("keeps New task in this Project in a menu on the title row that does not fold the section", async () => {
      const user = userEvent.setup();
      await renderChanges(readyObservation());
      expect(screen.queryByRole("button", { name: "New task in this Project" })).toBeNull();
      const section = screen.getByRole("button", { name: /^Changes/ });
      expect(section).toHaveAttribute("aria-expanded", "true");
      await user.click(screen.getByRole("button", { name: "More for changes" }));
      expect(
        await screen.findByRole("menuitem", { name: "New task in this Project" }),
      ).toBeVisible();
      // The branch entries moved to the Branch row itself; nothing else may
      // be hidden behind this menu.
      expect(screen.queryByRole("menuitem", { name: "Worktrees" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Switch branch…" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Move to Project…" })).toBeNull();
      await user.keyboard("{Escape}");
      expect(section).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("lists the Project's extra folders from home, and shows nothing when it has none", async () => {
    const user = userEvent.setup();
    const withExtras = {
      ...codeProject(),
      extraFolders: [
        decodeProjectExtraFolder({
          canonicalRoot: "/Users/example/Dev/Research",
          addedBy: { kind: "local-user", actorId: "30000000-0000-4000-8000-000000000102" },
          addedAt: "2026-07-17T08:00:00.000Z",
        }),
      ],
    } as ProjectSummary;
    const { unmount } = render(
      <CodeThreadEnvironment
        environmentOpen
        project={codeProject()}
        tab={codeTab()}
        projectClient={projectClient(readyObservation())}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.queryByRole("button", { name: /^Extra folders/ })).not.toBeInTheDocument();
    unmount();

    render(
      <CodeThreadEnvironment
        environmentOpen
        project={withExtras}
        tab={codeTab()}
        projectClient={projectClient(readyObservation())}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    await user.click(screen.getByRole("button", { name: /^Extra folders/ }));

    expect(screen.getByTitle("/Users/example/Dev/Research")).toHaveTextContent("~/Dev/Research");
  });
});

describe("CodeThreadEnvironment branch and move actions", () => {
  function worktreeRefsExecute() {
    return vi.fn(async (command: { kind: string }) =>
      command.kind === "list-code-worktree-refs"
        ? ({
            kind: "worktree-refs-listed",
            refs: [
              { name: "feature/issue-204", kind: "local", isCurrent: true },
              { name: "main", kind: "local" },
              { name: "held", kind: "local", hasWorktree: true },
              { name: "origin/main", kind: "remote" },
            ],
          } as never)
        : undefined,
    );
  }

  const previewEntries = () => [
    { path: "src/a.ts", index: " ", worktree: "M" },
    { path: "new-file.ts", index: "?", worktree: "?" },
  ];

  const preview = (stateToken: string) => ({
    status: "ok" as const,
    preview: { stateToken, entries: previewEntries() },
  });

  async function openBranchMenu(extra: Partial<Parameters<typeof CodeThreadEnvironment>[0]> = {}) {
    const user = userEvent.setup();
    const rendered = render(
      <CodeThreadEnvironment
        environmentOpen
        checkoutKind="managed-worktree"
        onExecute={worktreeRefsExecute()}
        onMoveToProject={vi.fn()}
        onNewTaskOnBranch={vi.fn()}
        onNewThreadInProject={vi.fn()}
        onObserveBranchState={vi.fn(async () => preview("token-1"))}
        onOpenWorktrees={vi.fn()}
        onSwitchBranch={vi.fn(async () => ({ status: "ok", branch: "main" }) as const)}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
        {...extra}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    return { ...rendered, user };
  }

  async function openBranchMenuClicked(
    extra: Partial<Parameters<typeof CodeThreadEnvironment>[0]> = {},
  ) {
    const rendered = await openBranchMenu(extra);
    await rendered.user.click(screen.getByRole("button", { name: "Branch feature/issue-204" }));
    return rendered;
  }

  // The row's text is the same whether it is a fact or an action; the element
  // is what differs — a <p> states, a <button> leads somewhere.
  function projectRowElement(container: HTMLElement): Element | undefined {
    return [...container.querySelectorAll(".environment-row")].find(
      (row) => row.textContent?.includes(".worktrees/issue-204") === true,
    );
  }

  it("opens the branch menu from the Branch row itself", async () => {
    const { user } = await openBranchMenuClicked();
    for (const name of ["Switch branch…", "New task on another branch…", "Worktrees"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeEnabled();
    }
    await user.keyboard("{Escape}");
  });

  it("starts a new task on another branch from the Branch row", async () => {
    const onNewTaskOnBranch = vi.fn();
    const { user } = await openBranchMenuClicked({ onNewTaskOnBranch });
    await user.click(await screen.findByRole("menuitem", { name: "New task on another branch…" }));
    expect(onNewTaskOnBranch).toHaveBeenCalledOnce();
  });

  it("greys Switch branch while a turn runs and keeps the other entries usable", async () => {
    const { user } = await openBranchMenuClicked({ threadBusy: true });
    expect(await screen.findByRole("menuitem", { name: "Switch branch…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "New task on another branch…" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Worktrees" })).toBeEnabled();
    await user.keyboard("{Escape}");
  });

  it("greys Switch branch under Plan mode, which is read-only", async () => {
    const { user } = await openBranchMenuClicked({ threadPolicy: "plan" });
    expect(await screen.findByRole("menuitem", { name: "Switch branch…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "New task on another branch…" })).toBeEnabled();
    await user.keyboard("{Escape}");
  });

  it("offers no current-thread switch on a remote root or a plain folder, but still opens a new task from either", async () => {
    for (const checkoutKind of ["remote-root", "plain-folder"] as const) {
      const { unmount, user } = await openBranchMenuClicked({ checkoutKind });
      expect(
        await screen.findByRole("menuitem", { name: "New task on another branch…" }),
      ).toBeEnabled();
      expect(screen.queryByRole("menuitem", { name: "Switch branch…" })).toBeNull();
      // Neither kind has a local worktree set to manage, so Worktrees stays
      // out of the menu too; the new task is the only thing still offered.
      expect(screen.queryByRole("menuitem", { name: "Worktrees" })).toBeNull();
      await user.keyboard("{Escape}");
      unmount();
    }
  });

  it("draws the branch as a fact row when none of its actions can run", async () => {
    const { container } = render(
      <CodeThreadEnvironment
        environmentOpen
        checkoutKind="remote-root"
        onNewThreadInProject={vi.fn()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.queryByRole("button", { name: "Branch feature/issue-204" })).toBeNull();
    const branchRow = [...container.querySelectorAll(".environment-row")].find(
      (row) => row.textContent?.includes("feature/issue-204") === true,
    );
    expect(branchRow?.tagName).toBe("P");
  });

  it("switches to a real listed local branch against the preview's state token, dropping the current, held, and remote refs", async () => {
    const onSwitchBranch = vi.fn(async () => ({ status: "ok", branch: "main" }) as const);
    const { user } = await openBranchMenuClicked({ onSwitchBranch });
    await user.click(await screen.findByRole("menuitem", { name: "Switch branch…" }));

    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    expect(await within(dialog).findByRole("button", { name: "main" })).toBeEnabled();
    for (const absent of ["feature/issue-204", "held", "origin/main"]) {
      expect(within(dialog).queryByRole("button", { name: absent })).toBeNull();
    }

    await user.click(within(dialog).getByRole("button", { name: "main" }));
    await user.click(within(dialog).getByRole("button", { name: "Switch" }));

    await waitFor(() =>
      expect(onSwitchBranch).toHaveBeenCalledWith({
        branch: "main",
        dirty: "refuse",
        expectedStateToken: "token-1",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the observed changes before a stash choice and sends the preview's token on both attempts", async () => {
    const onOpenGit = vi.fn();
    const onSwitchBranch = vi
      .fn()
      .mockResolvedValueOnce({
        status: "refused",
        reason: "dirty-checkout",
        message: "The checkout has uncommitted changes.",
      })
      .mockResolvedValueOnce({ status: "ok", branch: "main" });
    const { user } = await openBranchMenuClicked({ onOpenGit, onSwitchBranch });
    await user.click(await screen.findByRole("menuitem", { name: "Switch branch…" }));

    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    await user.click(within(dialog).getByRole("button", { name: "main" }));
    await user.click(within(dialog).getByRole("button", { name: "Switch" }));

    expect(await within(dialog).findByText(/uncommitted changes/)).toBeVisible();
    // The list is the preview's own entries — what the person consents against.
    expect(within(dialog).getByText("src/a.ts")).toBeVisible();
    expect(within(dialog).getByText("new-file.ts")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Commit in Git" })).toBeEnabled();

    await user.click(within(dialog).getByRole("button", { name: "Stash and switch" }));
    await waitFor(() =>
      expect(onSwitchBranch).toHaveBeenLastCalledWith({
        branch: "main",
        dirty: "stash",
        expectedStateToken: "token-1",
      }),
    );
    expect(onSwitchBranch).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onOpenGit).not.toHaveBeenCalled();
  });

  it("re-reads and re-shows the checkout before a second stash after a stale answer", async () => {
    const onObserveBranchState = vi
      .fn()
      .mockResolvedValueOnce(preview("token-1"))
      .mockResolvedValueOnce(preview("token-2"));
    const onSwitchBranch = vi
      .fn()
      .mockResolvedValueOnce({
        status: "refused",
        reason: "dirty-checkout",
        message: "The checkout has uncommitted changes.",
      })
      .mockResolvedValueOnce({
        status: "refused",
        reason: "stale-state",
        message: "The checkout changed since it was read.",
      })
      .mockResolvedValueOnce({ status: "ok", branch: "main" });
    const { user } = await openBranchMenuClicked({ onObserveBranchState, onSwitchBranch });
    await user.click(await screen.findByRole("menuitem", { name: "Switch branch…" }));

    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    await user.click(within(dialog).getByRole("button", { name: "main" }));
    await user.click(within(dialog).getByRole("button", { name: "Switch" }));
    await within(dialog).findByText(/uncommitted changes/);

    await user.click(within(dialog).getByRole("button", { name: "Stash and switch" }));
    // Stale means the checkout moved since what was shown: it is read again
    // and said plainly, and nothing goes out until the person chooses again.
    expect(await within(dialog).findByText(/changed since it was read/)).toBeVisible();
    expect(onSwitchBranch).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onObserveBranchState).toHaveBeenCalledTimes(2));

    await user.click(within(dialog).getByRole("button", { name: "Stash and switch" }));
    await waitFor(() =>
      expect(onSwitchBranch).toHaveBeenLastCalledWith({
        branch: "main",
        dirty: "stash",
        expectedStateToken: "token-2",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the reviewed commit flow instead of stashing when the person picks Commit", async () => {
    const onOpenGit = vi.fn();
    const onSwitchBranch = vi.fn(async () => ({
      status: "refused" as const,
      reason: "dirty-checkout",
      message: "The checkout has uncommitted changes.",
    }));
    const { user } = await openBranchMenuClicked({ onOpenGit, onSwitchBranch });
    await user.click(await screen.findByRole("menuitem", { name: "Switch branch…" }));

    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    await user.click(within(dialog).getByRole("button", { name: "main" }));
    await user.click(within(dialog).getByRole("button", { name: "Switch" }));

    await user.click(await within(dialog).findByRole("button", { name: "Commit in Git" }));
    expect(onOpenGit).toHaveBeenCalledOnce();
    expect(onSwitchBranch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the person cancels the switch", async () => {
    const onSwitchBranch = vi.fn();
    const { user } = await openBranchMenuClicked({ onSwitchBranch });
    await user.click(await screen.findByRole("menuitem", { name: "Switch branch…" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    await within(dialog).findByRole("button", { name: "main" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onSwitchBranch).not.toHaveBeenCalled();
  });

  it("routes the connected repository to the Project's pull requests and hides it when unconnected", async () => {
    const onOpenPullRequests = vi.fn();
    const connected = {
      ...codeProject(),
      connectedRepository: { host: "github.com", owner: "Ogard-Labs", repository: "octant" },
    } as ProjectSummary;
    const first = render(
      <CodeThreadEnvironment
        environmentOpen
        onOpenPullRequests={onOpenPullRequests}
        project={connected}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Ogard-Labs/octant" }));
    expect(onOpenPullRequests).toHaveBeenCalledOnce();
    first.unmount();

    render(
      <CodeThreadEnvironment
        environmentOpen
        onOpenPullRequests={onOpenPullRequests}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    expect(screen.queryByRole("button", { name: "Ogard-Labs/octant" })).toBeNull();
  });

  it("opens the shared move dialog from the Project row while another same-folder Code Project could take it", async () => {
    const onMoveToProject = vi.fn();
    const sibling = {
      ...codeProject(decodeProjectId("00000000-0000-4000-8000-000000000902")),
      name: "Octant again",
    } as ProjectSummary;
    const user = userEvent.setup();
    const { container } = render(
      <CodeThreadEnvironment
        environmentOpen
        onMoveToProject={onMoveToProject}
        project={codeProject()}
        projects={[codeProject(), sibling]}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();

    const row = projectRowElement(container);
    expect(row?.tagName).toBe("BUTTON");
    await user.click(row as HTMLElement);
    expect(onMoveToProject).toHaveBeenCalledOnce();
  });

  it("states the Project row as a fact when no other same-folder Code Project could take it", async () => {
    const elsewhere = {
      ...codeProject(decodeProjectId("00000000-0000-4000-8000-000000000903")),
      binding: { canonicalRoot: "/Users/example/Dev/Repos/elsewhere" },
    } as ProjectSummary;
    const { container, unmount } = render(
      <CodeThreadEnvironment
        environmentOpen
        onMoveToProject={vi.fn()}
        project={codeProject()}
        projects={[codeProject(), elsewhere]}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    expect(projectRowElement(container)?.tagName).toBe("P");
    unmount();

    const withoutList = render(
      <CodeThreadEnvironment
        environmentOpen
        onMoveToProject={vi.fn()}
        project={codeProject()}
        projectClient={projectClient(readyObservation())}
        tab={codeTab()}
      >
        <div />
      </CodeThreadEnvironment>,
    );
    await openEnvironment();
    expect(projectRowElement(withoutList.container)?.tagName).toBe("P");
  });
});
