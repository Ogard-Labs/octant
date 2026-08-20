import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { ProjectSummary } from "@octant/contracts/projects";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectMemoryInspectorProvider } from "./ProjectMemoryInspector";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectThreadsProvider, type ProjectThreadsAccess } from "./ProjectThreadsSection";

describe("ProjectOverview", () => {
  it("composes the Chat overview into a virtual Chat Project", () => {
    render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectOverview
          chatOverview={<section aria-label="Chat Project Overview">Chat-only overview</section>}
          onArchive={vi.fn()}
          onRelink={vi.fn()}
          onRename={vi.fn()}
          project={
            {
              id: "20000000-0000-4000-8000-000000000000",
              name: "Launch planning",
              lifecycle: "active",
              pinned: true,
              rank: "0/1",
              version: 1,
              createdAt: "2026-07-21T12:00:00.000Z",
              updatedAt: "2026-07-21T12:00:00.000Z",
              type: "chat",
            } as never
          }
        />
      </ProjectMemoryInspectorProvider>,
    );

    expect(screen.getByRole("region", { name: "Chat Project Overview" })).toHaveTextContent(
      "Chat-only overview",
    );
    expect(screen.queryByRole("heading", { name: "Project workspace" })).not.toBeInTheDocument();
    expect(screen.queryByText("CHAT PROJECT")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Virtual organization with approved memory/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review memory" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive" })).toBeVisible();
  });

  it("composes the authoritative Code overview into a Code Project", () => {
    render(
      <ProjectOverview
        codeOverview={<section aria-label="Code sessions">Authoritative sessions</section>}
        onArchive={vi.fn()}
        onRelink={vi.fn()}
        onRename={vi.fn()}
        project={
          {
            id: "20000000-0000-4000-8000-000000000001",
            name: "Octant",
            lifecycle: "active",
            pinned: true,
            rank: "0/1",
            version: 1,
            createdAt: "2026-07-21T12:00:00.000Z",
            updatedAt: "2026-07-21T12:00:00.000Z",
            type: "code",
            binding: { canonicalRoot: "/opaque/repository" },
            codeAccessPersistence: "current-session",
          } as never
        }
      />,
    );

    expect(screen.getByRole("region", { name: "Code sessions" })).toHaveTextContent(
      "Authoritative sessions",
    );
    expect(screen.queryByRole("heading", { name: "Project workspace" })).not.toBeInTheDocument();
  });

  it("shows a Code Project's threads once: the sessions list owns the page", () => {
    render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectThreadsProvider
          value={{
            onSelectThread: vi.fn(),
            status: "ready",
            threads: [
              {
                projectId: "20000000-0000-4000-8000-000000000001",
                threadId: "thread-code",
                title: "Fix the flaky smoke",
                updatedAt: "2026-08-14T09:00:00.000Z",
              },
            ],
          }}
        >
          <ProjectOverview
            codeOverview={<section aria-label="Code sessions">Authoritative sessions</section>}
            onArchive={vi.fn()}
            onRelink={vi.fn()}
            onRename={vi.fn()}
            project={
              {
                id: "20000000-0000-4000-8000-000000000001",
                name: "Octant",
                lifecycle: "active",
                pinned: true,
                rank: "0/1",
                version: 1,
                createdAt: "2026-07-21T12:00:00.000Z",
                updatedAt: "2026-07-21T12:00:00.000Z",
                type: "code",
                binding: { canonicalRoot: "/opaque/repository" },
                codeAccessPersistence: "current-session",
              } as never
            }
          />
        </ProjectThreadsProvider>
      </ProjectMemoryInspectorProvider>,
    );

    expect(screen.getByRole("region", { name: "Code sessions" })).toBeVisible();
    expect(
      screen.queryByRole("region", { name: /Threads and recent activity/ }),
    ).not.toBeInTheDocument();
  });

  it("composes the Work overview into a Work Project without Code affordances", () => {
    render(
      <ProjectOverview
        workOverview={<section aria-label="Work overview">Confined overview</section>}
        onArchive={vi.fn()}
        onRelink={vi.fn()}
        onRename={vi.fn()}
        project={
          {
            id: "20000000-0000-4000-8000-000000000002",
            name: "Knowledge work",
            lifecycle: "active",
            pinned: true,
            rank: "0/1",
            version: 1,
            createdAt: "2026-07-21T12:00:00.000Z",
            updatedAt: "2026-07-21T12:00:00.000Z",
            type: "work",
            binding: { canonicalRoot: "/opaque/work-root" },
          } as never
        }
      />,
    );

    expect(screen.getByRole("region", { name: "Work overview" })).toHaveTextContent(
      "Confined overview",
    );
    expect(screen.queryByRole("heading", { name: "Project workspace" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Git|worktree|pull request/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Bound to one confined directory. Knowledge-work stays inside the Project root.",
      ),
    ).toBeVisible();
  });

  it("offers ordinary authenticated-web relink for an available bound Project", async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn(async () => true);
    const folderBrowseClient: FolderBrowseClient = {
      browse: vi.fn(async () => ({
        candidates: [
          {
            candidateId: "20000000-0000-4000-8000-000000000003" as never,
            displayName: "replacement",
            isGitRepository: false,
            isSelectable: true,
          },
        ],
        breadcrumbs: [{ label: "Home" }],
        hasMore: false,
        browsedAt: "2026-07-28T12:00:00.000Z" as never,
      })),
      select: vi.fn(async () => ({
        receiptId: "R".repeat(43),
        displayName: "replacement",
        selectedAt: "2026-07-28T12:00:01.000Z" as never,
      })),
    };
    const project = {
      id: "20000000-0000-4000-8000-000000000002",
      name: "Knowledge work",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-07-21T12:00:00.000Z",
      updatedAt: "2026-07-21T12:00:00.000Z",
      type: "work",
      binding: { canonicalRoot: "/opaque/work-root" },
    } as unknown as ProjectSummary;

    render(
      <ProjectOverview
        availability={
          {
            projectId: project.id,
            status: "available",
            observedAt: "2026-07-28T12:00:00.000Z",
          } as never
        }
        folderBrowseClient={folderBrowseClient}
        hostId={LOCAL_HOST_ID}
        onArchive={vi.fn()}
        onRelink={onRelink}
        onRename={vi.fn()}
        project={project}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Relink folder" }));
    await user.click(await screen.findByRole("button", { name: "Select" }));
    await waitFor(() => expect(onRelink).toHaveBeenCalledWith(project.id, "R".repeat(43)));
  });

  it("announces an authoritative relink rejection and keeps the picker available for retry", async () => {
    const user = userEvent.setup();
    const folderBrowseClient: FolderBrowseClient = {
      browse: vi.fn(async () => ({
        candidates: [
          {
            candidateId: "20000000-0000-4000-8000-000000000004" as never,
            displayName: "replacement",
            isGitRepository: false,
            isSelectable: true,
          },
        ],
        breadcrumbs: [{ label: "Home" }],
        hasMore: false,
        browsedAt: "2026-07-28T12:00:00.000Z" as never,
      })),
      select: vi.fn(async () => ({
        receiptId: "R".repeat(43),
        displayName: "replacement",
        selectedAt: "2026-07-28T12:00:01.000Z" as never,
      })),
    };

    render(
      <ProjectOverview
        folderBrowseClient={folderBrowseClient}
        hostId={LOCAL_HOST_ID}
        onArchive={vi.fn()}
        onRelink={vi.fn(async () => false)}
        onRename={vi.fn()}
        project={
          {
            id: "20000000-0000-4000-8000-000000000005",
            name: "Knowledge work",
            lifecycle: "active",
            pinned: true,
            rank: "0/1",
            version: 1,
            createdAt: "2026-07-21T12:00:00.000Z",
            updatedAt: "2026-07-21T12:00:00.000Z",
            type: "work",
            binding: { canonicalRoot: "/opaque/work-root" },
          } as never
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "Relink folder" }));
    await user.click(await screen.findByRole("button", { name: "Select" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Project root could not be relinked. Review the Project status and retry.",
    );
    expect(screen.getByRole("dialog", { name: "Add folder" })).toBeVisible();
  });

  it("labels a stale remote snapshot read-only and hides root relink affordances", () => {
    render(
      <ProjectOverview
        allowRootRelink={false}
        connectionStale={true}
        onArchive={vi.fn()}
        onRelink={vi.fn()}
        onRename={vi.fn()}
        project={
          {
            id: "20000000-0000-4000-8000-000000000005",
            name: "Knowledge work",
            lifecycle: "active",
            pinned: true,
            rank: "0/1",
            version: 1,
            createdAt: "2026-07-21T12:00:00.000Z",
            updatedAt: "2026-07-21T12:00:00.000Z",
            type: "work",
            binding: { canonicalRoot: "/opaque/work-root" },
          } as never
        }
      />,
    );

    expect(screen.getByText(/Stale Project snapshot/i)).toBeInTheDocument();
    expect(screen.getByText(/Stale snapshot · read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /relink/i })).not.toBeInTheDocument();
  });
});

describe("ProjectOverview threads and recent activity", () => {
  const chatProject = {
    id: "20000000-0000-4000-8000-000000000010",
    name: "Launch planning",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    type: "chat",
  } as unknown as ProjectSummary;

  function renderWithThreads(access: ProjectThreadsAccess) {
    return render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectThreadsProvider value={access}>
          <ProjectOverview
            onArchive={vi.fn()}
            onRelink={vi.fn()}
            onRename={vi.fn()}
            project={chatProject}
          />
        </ProjectThreadsProvider>
      </ProjectMemoryInspectorProvider>,
    );
  }

  it("lists this Project's threads newest first and opens one through the shared handler", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    renderWithThreads({
      onSelectThread,
      status: "ready",
      threads: [
        {
          projectId: String(chatProject.id),
          threadId: "thread-older",
          title: "Kickoff notes",
          updatedAt: "2026-08-10T09:00:00.000Z",
        },
        {
          followUp: true,
          projectId: String(chatProject.id),
          threadId: "thread-newer",
          title: "Launch checklist",
          unread: true,
          updatedAt: "2026-08-14T09:00:00.000Z",
        },
        {
          projectId: "20000000-0000-4000-8000-000000000011",
          threadId: "thread-elsewhere",
          title: "Someone else's work",
          updatedAt: "2026-08-15T09:00:00.000Z",
        },
        { threadId: "thread-rootless", title: "Loose chat" },
      ],
    });

    const list = screen.getByRole("region", {
      name: "Threads and recent activity in Launch planning",
    });
    expect(
      within(list)
        .getAllByRole("button")
        .map((button) => button.getAttribute("data-thread-id")),
    ).toEqual(["thread-newer", "thread-older"]);
    expect(screen.queryByRole("button", { name: /Someone else's work/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Loose chat/ })).not.toBeInTheDocument();
    // A dot beside the thread, not a bar wrapped underneath it.
    expect(within(list).getByLabelText("Needs attention")).toBeVisible();
    expect(within(list).queryByText("Needs attention")).not.toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: /Launch checklist/ }));
    expect(onSelectThread).toHaveBeenCalledWith("thread-newer");
  });

  it("says why threads are missing instead of rendering an empty list", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderWithThreads({
      onSelectThread: vi.fn(),
      status: "loading",
      threads: [],
    });

    expect(screen.getByRole("status")).toHaveTextContent("Loading threads…");
    expect(screen.queryByText("No threads in this Project yet.")).not.toBeInTheDocument();

    rerender(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectThreadsProvider
          value={{
            errorMessage: "The host refused the thread list.",
            onRetry,
            onSelectThread: vi.fn(),
            status: "unavailable",
            threads: [],
          }}
        >
          <ProjectOverview
            onArchive={vi.fn()}
            onRelink={vi.fn()}
            onRename={vi.fn()}
            project={chatProject}
          />
        </ProjectThreadsProvider>
      </ProjectMemoryInspectorProvider>,
    );

    expect(screen.getByRole("status", { name: "Thread list status" })).toHaveTextContent(
      "The host refused the thread list.",
    );
    expect(screen.queryByText("No threads in this Project yet.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry threads" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectThreadsProvider value={{ onSelectThread: vi.fn(), status: "ready", threads: [] }}>
          <ProjectOverview
            onArchive={vi.fn()}
            onRelink={vi.fn()}
            onRename={vi.fn()}
            project={chatProject}
          />
        </ProjectThreadsProvider>
      </ProjectMemoryInspectorProvider>,
    );

    expect(screen.getByText("No threads in this Project yet.")).toBeVisible();
  });

  it("claims nothing about threads on a surface that never published them", () => {
    render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectOverview
          onArchive={vi.fn()}
          onRelink={vi.fn()}
          onRename={vi.fn()}
          project={chatProject}
        />
      </ProjectMemoryInspectorProvider>,
    );

    expect(
      screen.queryByRole("heading", { name: "Threads and recent activity" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No threads in this Project yet.")).not.toBeInTheDocument();
  });
});
