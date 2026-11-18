import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import {
  decodeWorkThreadId,
  decodeWorkThreadBootstrap,
  decodeProjectId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type ProjectSummary,
  type WorkspaceTab,
} from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeProjectExtraFolder } from "@octant/contracts/projects";
import { describe, expect, it, vi } from "vitest";
import { WorkThreadEnvironment } from "./WorkThreadEnvironment";

const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000701");
const tabId = decodeWorkspaceTabId("30000000-0000-4000-8000-00000000000b");

function workTab(): Extract<WorkspaceTab, { readonly kind: "work-thread" }> {
  return decodeWorkspaceTab({
    kind: "work-thread",
    id: tabId,
    threadId,
    mode: "work",
    title: "Research brief",
  }) as Extract<WorkspaceTab, { readonly kind: "work-thread" }>;
}

function workProject(): ProjectSummary {
  return {
    id: projectId,
    type: "work",
    name: "Knowledge Base",
    lifecycle: "active",
    pinned: true,
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["createdAt"],
    updatedAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["updatedAt"],
    binding: { canonicalRoot: "/Users/example/Documents/work-root" },
    bindingRevisionId: "30000000-0000-4000-8000-000000000101" as never,
  } as ProjectSummary;
}

function threadClient(result: "ready" | "failed" = "ready"): WorkThreadClient {
  return {
    searchTranscript: vi.fn(),
    bootstrap:
      result === "ready"
        ? vi.fn(async () =>
            decodeWorkThreadBootstrap({
              threads: [
                {
                  id: threadId,
                  projectId,
                  title: "Research brief",
                  lifecycle: "active",
                  providerInstanceId: "00000000-0000-4000-8000-000000000902",
                  modelId: "gpt-4",
                  workingDirectory: ".",
                  version: 1,
                  createdAt: "2026-07-16T08:00:00.000Z",
                  updatedAt: "2026-07-16T08:00:00.000Z",
                },
              ],
            }),
          )
        : vi.fn(async () => Promise.reject(new Error("offline"))),
    navigation: vi.fn(async () => ({ threads: [], runtime: [] })),
    execute: vi.fn(),
    queryBoard: vi.fn(),
  };
}

async function openEnvironment(): Promise<void> {
  await screen.findByRole("region", { name: "Environment details" });
}

describe("WorkThreadEnvironment", () => {
  it("renders the Work workspace inside a thread-scoped environment", async () => {
    render(
      <WorkThreadEnvironment
        environmentOpen
        projects={[workProject()]}
        tab={workTab()}
        threadClient={threadClient()}
      >
        <div data-testid="work-workspace-content">Work surface</div>
      </WorkThreadEnvironment>,
    );

    expect(screen.getByTestId("work-workspace-content")).toBeVisible();
    expect(await screen.findByRole("region", { name: "Environment details" })).toHaveAttribute(
      "data-environment-status",
      "available",
    );
    expect(screen.getByText(/Knowledge Base · work-root/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Environment" })).not.toBeInTheDocument();
  });

  it("fails closed when authoritative thread state cannot be loaded", async () => {
    render(
      <WorkThreadEnvironment
        environmentOpen
        projects={[workProject()]}
        tab={workTab()}
        threadClient={threadClient("failed")}
      >
        <div />
      </WorkThreadEnvironment>,
    );

    expect(await screen.findByRole("region", { name: "Environment details" })).toHaveAttribute(
      "data-environment-status",
      "unavailable",
    );
    expect(screen.getByText("Work · No folder Project")).toBeVisible();
  });

  it("shows no goal group until the task has a goal, and offers Set a goal in the plus menu", async () => {
    const goalClient = {
      read: vi.fn(async () => ({ goal: null, history: [] })),
      execute: vi.fn(),
    };
    const automationClient = {
      list: vi.fn(async () => ({ kind: "automation-list" as const, items: [] })),
    };
    const user = userEvent.setup();
    render(
      <WorkThreadEnvironment
        automationClient={automationClient as never}
        environmentOpen
        goalClient={goalClient as never}
        projects={[workProject()]}
        tab={workTab()}
        threadClient={threadClient()}
      >
        <div />
      </WorkThreadEnvironment>,
    );
    await openEnvironment();

    await waitFor(() => expect(goalClient.read).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^Goal/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Goal" })).not.toBeInTheDocument();
    expect(screen.queryByText("Keep working on this unattended")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add a routine" }));
    await user.click(await screen.findByRole("menuitem", { name: "Set a goal…" }));

    expect(await screen.findByRole("region", { name: "Goal" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Goal/ })).toBeVisible();
    expect(screen.getByLabelText("Goal objective")).toBeVisible();
  });

  it("shows the goal group, with one heading, when the task already has a goal", async () => {
    const goalClient = {
      read: vi.fn(async () => ({
        goal: {
          id: "00000000-0000-4000-8000-000000000206",
          threadId,
          revisionId: "00000000-0000-4000-8000-000000000207",
          objective: "Ship the brief",
          status: "active",
          budget: {},
          usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
          evidence: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          version: 1,
        },
        history: [],
      })),
      execute: vi.fn(),
    };
    render(
      <WorkThreadEnvironment
        environmentOpen
        goalClient={goalClient as never}
        projects={[workProject()]}
        tab={workTab()}
        threadClient={threadClient()}
      >
        <div />
      </WorkThreadEnvironment>,
    );
    await openEnvironment();

    expect(await screen.findByRole("region", { name: "Goal" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Goal" })).toBeVisible();
    expect(screen.queryByText("Keep working on this unattended")).not.toBeInTheDocument();
  });

  it("submits a bounded relative working directory through the focused Change working folder flow", async () => {
    const client = threadClient();
    vi.mocked(client.execute).mockResolvedValue({
      kind: "thread-updated",
      thread: {
        id: threadId,
        projectId,
        title: "Research brief",
        lifecycle: "active",
        providerInstanceId: "00000000-0000-4000-8000-000000000902",
        modelId: "gpt-4",
        workingDirectory: "research/brief",
        version: 2,
        createdAt: "2026-07-16T08:00:00.000Z",
        updatedAt: "2026-07-16T08:00:01.000Z",
      },
    } as never);
    const user = userEvent.setup();
    render(
      <WorkThreadEnvironment
        environmentOpen
        projects={[workProject()]}
        tab={workTab()}
        threadClient={client}
      >
        <div />
      </WorkThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.queryByLabelText("Working folder")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Working folder/ }));
    await user.click(screen.getByRole("button", { name: "Change working folder" }));
    const input = await screen.findByDisplayValue(".");
    await user.clear(input);
    await user.type(input, "research/brief");
    const apply = screen.getByRole("button", { name: "Apply working folder" });
    await waitFor(() => expect(apply).toBeEnabled(), { timeout: 5_000 });
    await user.click(apply);

    await waitFor(
      () =>
        expect(client.execute).toHaveBeenCalledWith({
          kind: "change-work-thread-working-directory",
          threadId,
          expectedVersion: 1,
          workingDirectory: "research/brief",
        }),
      { timeout: 5_000 },
    );
    // The field closes with the apply; focus lands on the row that now shows
    // the folder, not on the page.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Working folder/ })).toHaveFocus(),
    );
  });

  it("surfaces an authoritative Work working-directory rejection", async () => {
    const client = threadClient();
    vi.mocked(client.execute).mockResolvedValue({
      category: "invalid",
      message: "Work working directory is unavailable.",
    });
    render(
      <WorkThreadEnvironment
        environmentOpen
        projects={[workProject()]}
        tab={workTab()}
        threadClient={client}
      >
        <div />
      </WorkThreadEnvironment>,
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

  it("lists the Project's extra folders from home, and shows nothing when it has none", async () => {
    const user = userEvent.setup();
    const withExtras = {
      ...workProject(),
      extraFolders: [
        decodeProjectExtraFolder({
          canonicalRoot: "/Users/example/Dev/Research",
          addedBy: { kind: "local-user", actorId: "30000000-0000-4000-8000-000000000102" },
          addedAt: "2026-07-17T08:00:00.000Z",
        }),
      ],
    } as ProjectSummary;
    const { unmount } = render(
      <WorkThreadEnvironment
        environmentOpen
        projects={[workProject()]}
        tab={workTab()}
        threadClient={threadClient()}
      >
        <div />
      </WorkThreadEnvironment>,
    );
    await openEnvironment();
    expect(screen.queryByRole("button", { name: /^Extra folders/ })).not.toBeInTheDocument();
    unmount();

    render(
      <WorkThreadEnvironment
        environmentOpen
        projects={[withExtras]}
        tab={workTab()}
        threadClient={threadClient()}
      >
        <div />
      </WorkThreadEnvironment>,
    );
    await openEnvironment();
    await user.click(screen.getByRole("button", { name: /^Extra folders/ }));

    expect(screen.getByTitle("/Users/example/Dev/Research")).toHaveTextContent("~/Dev/Research");
  });
});
