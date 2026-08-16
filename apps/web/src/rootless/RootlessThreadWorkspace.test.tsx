import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RootlessThreadWorkspace } from "./RootlessThreadWorkspace";
import type { RootlessThreadSummary } from "@octant/contracts/rootless-thread";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";

const rootlessThread: RootlessThreadSummary = {
  threadId: "00000000-0000-4000-8000-000000000001" as never,
  title: "Rootless brief",
  mode: "work",
  hostId: "local" as never,
  providerInstanceId: "00000000-0000-4000-8000-000000000010" as never,
  modelId: "model-a" as never,
  workspaceKind: "rootless",
  createdAt: "2026-07-29T12:00:00.000Z" as never,
  updatedAt: "2026-07-29T12:00:00.000Z" as never,
  initialTurn: {
    requestId: "00000000-0000-4000-8000-000000000030" as never,
    threadId: "00000000-0000-4000-8000-000000000001" as never,
    turnId: "00000000-0000-4000-8000-000000000031" as never,
    status: "completed",
    prompt: "Summarize the launch plan",
    response: "The launch plan is ready for review.",
    capabilities: {
      workspace: "rootless",
      rootBackedTools: {
        availability: "unavailable",
        reason:
          "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools.",
      },
    },
    acceptedAt: "2026-07-29T12:00:00.000Z" as never,
    updatedAt: "2026-07-29T12:00:05.000Z" as never,
  },
};

const projectBackedThread: RootlessThreadSummary = {
  ...rootlessThread,
  workspaceKind: "project-backed",
  projectId: "00000000-0000-4000-8000-000000000020" as ProjectId,
};

const project = {
  id: projectBackedThread.projectId!,
  type: "work",
  name: "Attached Docs",
  binding: { canonicalRoot: "/docs" },
  lifecycle: "active",
  pinned: false,
  version: 1,
  createdAt: "2026-07-29T12:00:00.000Z" as never,
  updatedAt: "2026-07-29T12:00:00.000Z" as never,
} as unknown as ProjectSummary;

const codeProject = {
  ...project,
  id: "00000000-0000-4000-8000-000000000021" as ProjectId,
  type: "code",
  name: "Codebase",
  binding: { canonicalRoot: "/code" },
  codeAccessPersistence: "current-session",
} as unknown as ProjectSummary;

const codeProjectBackedThread: RootlessThreadSummary = {
  ...projectBackedThread,
  mode: "code",
  projectId: codeProject.id,
};

describe("RootlessThreadWorkspace", () => {
  it("invokes onAttachFolder with the full thread when Attach folder is clicked", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    render(<RootlessThreadWorkspace thread={rootlessThread} onAttachFolder={onAttach} />);
    await user.click(screen.getByRole("button", { name: "Attach folder" }));
    expect(onAttach).toHaveBeenCalledWith(rootlessThread);
  });

  it("renders the durable first prompt and provider reply as a conversation", () => {
    render(<RootlessThreadWorkspace thread={rootlessThread} />);
    expect(screen.getByText("Summarize the launch plan")).toBeVisible();
    expect(screen.getByText("The launch plan is ready for review.")).toBeVisible();
  });

  it("reflects a project-backed thread with the bound Project name", () => {
    render(<RootlessThreadWorkspace thread={projectBackedThread} projects={[project]} />);
    expect(screen.getByText(/Attached to Attached Docs/)).toBeInTheDocument();
  });

  it("does not show Attach folder for a project-backed thread", () => {
    render(<RootlessThreadWorkspace thread={projectBackedThread} projects={[project]} />);
    expect(screen.queryByRole("button", { name: "Attach folder" })).not.toBeInTheDocument();
  });

  it("renders rootless capability guidance for an unbound thread", () => {
    render(<RootlessThreadWorkspace thread={rootlessThread} />);
    expect(screen.getByText(/Unfiled · No folder/)).toBeInTheDocument();
    expect(screen.getByText(/Attach a folder to continue/)).toBeInTheDocument();
  });

  it("surfaces the failed turn request ID for Settings support", () => {
    render(
      <RootlessThreadWorkspace
        thread={{
          ...rootlessThread,
          initialTurn: {
            ...rootlessThread.initialTurn!,
            status: "failed",
            failure: { category: "failed", message: "Provider rejected the turn." },
            response: undefined,
          },
        }}
      />,
    );

    expect(screen.getByLabelText("Support correlation")).toHaveTextContent(
      rootlessThread.initialTurn!.requestId,
    );
    expect(screen.getByRole("button", { name: "Copy support ID" })).toBeVisible();
  });

  it("does not claim unsupported continuation for an attached Work thread", () => {
    render(<RootlessThreadWorkspace thread={projectBackedThread} projects={[project]} />);
    const status = screen.getByRole("status", { name: "Folder attached" });
    expect(status).toHaveTextContent(/preserves its first turn and Project context/);
    expect(status).toHaveTextContent(/Start a new Project thread to continue with Work tools/);
  });

  it("does not claim unsupported continuation for an attached Code thread", () => {
    render(<RootlessThreadWorkspace thread={codeProjectBackedThread} projects={[codeProject]} />);
    const status = screen.getByRole("status", { name: "Folder attached" });
    expect(status).toHaveTextContent(/Start a new Project thread to continue with Code tools/);
  });
});
