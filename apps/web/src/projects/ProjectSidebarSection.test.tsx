import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectSidebarSection } from "./ProjectSidebarSection";

const chatProjectA = {
  id: "11111111-1111-4111-8111-111111111111" as ProjectId,
  name: "Test",
  pinned: false,
  type: "chat",
} as ProjectSummary;

const chatProjectB = {
  id: "22222222-2222-4222-8222-222222222222" as ProjectId,
  name: "Research",
  pinned: false,
  type: "chat",
} as ProjectSummary;

describe("ProjectSidebarSection chat thread nesting", () => {
  it("nests chat threads under their Project and keeps Unfiled for threads with none", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    const onNewChatInProject = vi.fn();
    const onProjectOpen = vi.fn();

    render(
      <ProjectSidebarSection
        activeThreadId="thread-unfiled"
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onNewChatInProject={onNewChatInProject}
        onProjectOpen={onProjectOpen}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        onSelectThread={onSelectThread}
        projects={[chatProjectA, chatProjectB]}
        threads={[
          {
            projectId: String(chatProjectA.id),
            threadId: "thread-a",
            title: "Planning",
            unread: true,
          },
          {
            projectId: String(chatProjectB.id),
            threadId: "thread-b",
            title: "Notes",
          },
          {
            threadId: "thread-unfiled",
            title: "Loose chat",
          },
        ]}
      />,
    );

    const projects = screen.getByRole("navigation", { name: "Projects" });
    expect(within(projects).getByRole("button", { name: /Planning/i })).toBeVisible();
    expect(within(projects).getByRole("button", { name: /Notes/i })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Unfiled" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Loose chat/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("navigation", { name: "Recent chats" })).not.toBeInTheDocument();

    const disclosure = screen.getByRole("button", { name: "Collapse Test" });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await user.click(disclosure);
    expect(screen.queryByRole("button", { name: /Planning/i })).not.toBeInTheDocument();
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(screen.getByRole("button", { name: /Planning/i })).toBeVisible();

    screen.getByRole("button", { name: "Project organization" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitemradio", { name: /Manual order/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("menuitemradio", { name: /Alphabetical/i }));
    expect(
      screen
        .getAllByRole("button", { name: /^(Collapse|Expand) (Test|Research)$/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Collapse Research", "Collapse Test"]);

    const projectActions = screen.getByRole("button", {
      name: "Project actions for Test",
    });
    projectActions.focus();
    await user.keyboard("{ArrowDown}");
    await user.click(await screen.findByRole("menuitem", { name: "Open Project" }));
    expect(onProjectOpen).toHaveBeenCalledWith(chatProjectA);

    const newChat = screen.getByRole("button", { name: "New chat in Test" });
    expect(newChat).toHaveClass("project-row__new-thread");
    expect(newChat.closest(".project-row")).not.toBeNull();
    expect(newChat.closest(".project-threads")).toBeNull();
    expect(newChat).not.toHaveTextContent("New chat in Test");
    await user.click(newChat);
    expect(onNewChatInProject).toHaveBeenCalledWith(chatProjectA.id);
    await user.click(screen.getByRole("button", { name: /Planning/i }));
    expect(onSelectThread).toHaveBeenCalledWith("thread-a");
  });

  it("expands and focuses the requested Project thread list", async () => {
    const user = userEvent.setup();
    const props = {
      archivedProjects: [],
      availabilityByProject: new Map(),
      onArchive: vi.fn(),
      onMove: vi.fn(),
      onProjectOpen: vi.fn(),
      onReorder: vi.fn(),
      onRestore: vi.fn(),
      onSelectThread: vi.fn(),
      projects: [chatProjectA],
      threads: [
        {
          projectId: String(chatProjectA.id),
          threadId: "thread-a",
          title: "Planning",
        },
      ],
    };
    const { rerender } = render(<ProjectSidebarSection {...props} />);

    await user.click(screen.getByRole("button", { name: "Collapse Test" }));
    expect(screen.queryByRole("button", { name: "Planning" })).not.toBeInTheDocument();

    rerender(
      <ProjectSidebarSection
        {...props}
        expandProjectThreadsRequest={{
          projectId: chatProjectA.id,
          sequence: 1,
        }}
      />,
    );

    const threads = await screen.findByRole("region", {
      name: "Threads in Test",
    });
    expect(within(threads).getByRole("button", { name: "Planning" })).toBeVisible();
    await waitFor(() => expect(threads).toHaveFocus());
  });

  it("shows the complete thread hierarchy without segmented filters", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();

    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        onSelectThread={onSelectThread}
        projects={[]}
        threadGroups={{
          recents: [
            {
              navigationId: "local:code:00000000-0000-4000-8000-000000000901",
              threadId: "00000000-0000-4000-8000-000000000901",
              title: "Duplicate title",
              meta: "GPT-5",
            },
          ],
          all: [
            {
              navigationId: "local:code:00000000-0000-4000-8000-000000000901",
              threadId: "00000000-0000-4000-8000-000000000901",
              title: "Duplicate title",
              meta: "GPT-5",
            },
            {
              navigationId: "host-b:code:00000000-0000-4000-8000-000000000901",
              threadId: "00000000-0000-4000-8000-000000000901",
              title: "Duplicate title",
              meta: "Claude",
            },
          ],
          unfiled: [
            {
              navigationId: "host-b:code:00000000-0000-4000-8000-000000000901",
              threadId: "00000000-0000-4000-8000-000000000901",
              title: "Duplicate title",
              meta: "Claude",
            },
          ],
        }}
      />,
    );

    expect(screen.queryByRole("tab", { name: "Recents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "All" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Unfiled" })).not.toBeInTheDocument();
    const duplicateTitles = screen.getAllByRole("button", {
      name: /Duplicate title/,
    });
    expect(duplicateTitles).toHaveLength(2);
    await user.click(duplicateTitles[1]!);
    expect(onSelectThread).toHaveBeenCalledWith("host-b:code:00000000-0000-4000-8000-000000000901");
    expect(screen.getByRole("heading", { name: "Unfiled" })).toBeVisible();
  });

  it("keeps an unavailable thread list actionable without hiding Projects", async () => {
    const user = userEvent.setup();
    const onRetryThreads = vi.fn();
    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        onRetryThreads={onRetryThreads}
        projects={[chatProjectA]}
        threadErrorMessage="Unfiled threads are unavailable."
        threadStatus="unavailable"
      />,
    );

    expect(screen.getByRole("button", { name: "Collapse Test" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Thread list status" })).toHaveTextContent(
      "Unfiled threads are unavailable.",
    );
    await user.click(screen.getByRole("button", { name: "Retry threads" }));
    expect(onRetryThreads).toHaveBeenCalledOnce();
  });
});

describe("ProjectSidebarSection pinned ordering", () => {
  const pinnedBeta = {
    id: "33333333-3333-4333-8333-333333333333" as ProjectId,
    name: "Beta",
    pinned: true,
    type: "chat",
  } as ProjectSummary;
  const pinnedAlpha = {
    id: "44444444-4444-4444-8444-444444444444" as ProjectId,
    name: "Alpha",
    pinned: true,
    type: "chat",
  } as ProjectSummary;

  it("disables manual moves for pinned Projects while a sort is active", async () => {
    const user = userEvent.setup();
    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projects={[pinnedBeta, pinnedAlpha, chatProjectA]}
      />,
    );

    screen.getByRole("button", { name: "Project organization" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(await screen.findByRole("menuitemradio", { name: /Alphabetical/i }));

    const pinnedNav = screen.getByRole("navigation", { name: "Projects" });
    const pinnedActions = within(pinnedNav).getByRole("button", {
      name: "Project actions for Alpha",
    });
    pinnedActions.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");

    screen.getByRole("button", { name: "Project organization" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(await screen.findByRole("menuitemradio", { name: /Manual order/i }));
    const manualActions = screen.getByRole("button", {
      name: "Project actions for Alpha",
    });
    manualActions.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "Move up" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("ProjectSidebarSection archive", () => {
  it("archives a Project from its row menu", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={onArchive}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projects={[chatProjectA]}
      />,
    );

    screen.getByRole("button", { name: `Project actions for ${chatProjectA.name}` }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(await screen.findByRole("menuitem", { name: "Archive Project" }));
    expect(onArchive).toHaveBeenCalledWith(chatProjectA.id);
  });
});

describe("ProjectSidebarSection activity view", () => {
  it("toggles a recency inbox that keeps Project attribution and attention glyphs", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    const now = "2026-08-14T15:00:00.000Z";
    window.localStorage.clear();

    try {
      render(
        <ProjectSidebarSection
          archivedProjects={[]}
          availabilityByProject={new Map()}
          now={new Date(now)}
          onArchive={vi.fn()}
          onMove={vi.fn()}
          onProjectOpen={vi.fn()}
          onReorder={vi.fn()}
          onRestore={vi.fn()}
          onSelectThread={onSelectThread}
          projects={[chatProjectA]}
          threads={[
            {
              followUp: true,
              projectId: String(chatProjectA.id),
              threadId: "thread-priority",
              title: "Review sidebar activity features",
              updatedAt: "2026-08-12T10:00:00.000Z",
            },
            {
              projectId: String(chatProjectA.id),
              threadId: "thread-today",
              title: "Update AuroraDocs logos",
              unread: true,
              updatedAt: "2026-08-14T12:00:00.000Z",
            },
            {
              threadId: "thread-yesterday",
              title: "Estimate app rebrand effort",
              updatedAt: "2026-08-13T18:00:00.000Z",
            },
          ]}
        />,
      );

      const activityToggle = screen.getByRole("button", { name: "Turn on activity view" });
      expect(activityToggle).toBeVisible();
      expect(activityToggle).toHaveClass("shell-icon-button");
      expect(activityToggle).not.toHaveTextContent("Turn on activity view");
      expect(screen.getByRole("button", { name: "Collapse Test" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Priority" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Turn on activity view" }));

      expect(screen.getByRole("button", { name: "Turn off activity view" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Collapse Test" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Priority" })).toBeVisible();
      expect(screen.getByRole("heading", { name: "Yesterday" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument();

      const priority = screen.getByRole("region", { name: "Priority" });
      expect(
        within(priority).getByRole("button", {
          name: /Update AuroraDocs logos/,
        }),
      ).toBeVisible();
      expect(
        within(priority).getByRole("button", {
          name: /Review sidebar activity features/,
        }),
      ).toBeVisible();
      expect(within(priority).getAllByText("Test")).toHaveLength(2);
      expect(within(priority).getByLabelText("Unread")).toBeVisible();
      expect(within(priority).getByLabelText("Follow-up")).toBeVisible();
      expect(screen.getByRole("button", { name: /Estimate app rebrand effort/ })).toHaveTextContent(
        "Unfiled",
      );

      await user.click(screen.getByRole("button", { name: /Update AuroraDocs logos/ }));
      expect(onSelectThread).toHaveBeenCalledWith("thread-today");

      await user.click(screen.getByRole("button", { name: "Turn off activity view" }));
      expect(screen.getByRole("button", { name: "Collapse Test" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Priority" })).not.toBeInTheDocument();
    } finally {
      window.localStorage.clear();
    }
  });

  it("restores an independent activity preference when the mode changes", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();

    try {
      const { rerender } = render(
        <ProjectSidebarSection
          activityMode="chat"
          archivedProjects={[]}
          availabilityByProject={new Map()}
          now={new Date("2026-08-14T15:00:00.000Z")}
          onArchive={vi.fn()}
          onMove={vi.fn()}
          onProjectOpen={vi.fn()}
          onReorder={vi.fn()}
          onRestore={vi.fn()}
          onSelectThread={vi.fn()}
          projects={[chatProjectA]}
          threads={[
            {
              projectId: String(chatProjectA.id),
              threadId: "thread-today",
              title: "Update AuroraDocs logos",
              updatedAt: "2026-08-14T12:00:00.000Z",
            },
          ]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Turn on activity view" }));
      expect(screen.getByRole("heading", { name: "Today" })).toBeVisible();

      rerender(
        <ProjectSidebarSection
          activityMode="code"
          archivedProjects={[]}
          availabilityByProject={new Map()}
          now={new Date("2026-08-14T15:00:00.000Z")}
          onArchive={vi.fn()}
          onMove={vi.fn()}
          onProjectOpen={vi.fn()}
          onReorder={vi.fn()}
          onRestore={vi.fn()}
          onSelectThread={vi.fn()}
          projects={[chatProjectA]}
          unfiledLabel="Recents"
          threads={[
            {
              projectId: String(chatProjectA.id),
              threadId: "thread-today",
              title: "Update AuroraDocs logos",
              updatedAt: "2026-08-14T12:00:00.000Z",
            },
          ]}
        />,
      );

      expect(screen.getByRole("button", { name: "Turn on activity view" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Collapse Test" })).toBeVisible();
    } finally {
      window.localStorage.clear();
    }
  });
});

const codeProjectA = {
  id: "55555555-5555-4555-8555-555555555555" as ProjectId,
  name: "octant",
  pinned: false,
  type: "code",
} as ProjectSummary;

const codeProjectB = {
  id: "66666666-6666-4666-8666-666666666666" as ProjectId,
  name: "auroradocs",
  pinned: false,
  type: "code",
} as ProjectSummary;

describe("ProjectSidebarSection code project views", () => {
  it("does not expose Code project views in Chat", () => {
    window.localStorage.clear();
    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projects={[chatProjectA]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Project view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project view" })).not.toBeInTheDocument();
  });

  it("creates a named Code view that shows only the selected Projects", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();

    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projectViewsEnabled
        projects={[codeProjectA, codeProjectB]}
      />,
    );

    expect(screen.getByRole("button", { name: "Collapse octant" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse auroradocs" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "New project view" }));
    await user.type(screen.getByLabelText("Project view name"), "Main");
    await user.click(screen.getByRole("checkbox", { name: "octant" }));
    await user.click(screen.getByRole("button", { name: "Rocket" }));
    await user.click(screen.getByRole("button", { name: "Purple" }));
    await user.click(screen.getByRole("button", { name: "Create project view" }));

    expect(screen.getByRole("button", { name: "Project view" })).toHaveTextContent("Main");
    expect(
      JSON.parse(window.localStorage.getItem("octant.code.project-views.v1") ?? "{}"),
    ).toMatchObject({ views: [{ name: "Main", icon: "rocket", color: "purple" }] });
    expect(screen.getByRole("button", { name: "Collapse octant" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Collapse auroradocs" })).not.toBeInTheDocument();
    // Nothing about the view is pinned under the rail: the count and the two
    // edits are answers to a right-click, not a permanent row.
    expect(screen.queryByText(/Projects 1/)).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Edit view" })).not.toBeInTheDocument();
  });

  it("tells a right-clicked view how many Projects it holds, and offers its two edits", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    window.localStorage.setItem(
      "octant.code.project-views.v1",
      JSON.stringify({
        activeViewId: "all",
        views: [{ id: "view-main", name: "Main", projectIds: [codeProjectA.id] }],
      }),
    );

    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projectViewSwitcherPresentation="inline"
        projectViewsEnabled
        projects={[codeProjectA, codeProjectB]}
      />,
    );

    const group = screen.getByRole("group", { name: "Project views" });
    fireEvent.contextMenu(within(group).getByRole("button", { name: "Main" }));

    // The menu answers for the view that was right-clicked, not for the one
    // currently showing: All Projects is active and holds both.
    expect(await screen.findByText("Main · Projects 1")).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Edit view" }));
    expect(screen.getByLabelText("Project view name")).toHaveValue("Main");
  });

  it("keeps All Projects free of edits it cannot take", async () => {
    window.localStorage.clear();

    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projectViewSwitcherPresentation="inline"
        projectViewsEnabled
        projects={[codeProjectA, codeProjectB]}
      />,
    );

    const group = screen.getByRole("group", { name: "Project views" });
    fireEvent.contextMenu(within(group).getByRole("button", { name: "All Projects" }));

    expect(await screen.findByText("All Projects · Projects 2")).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Edit view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete view" })).not.toBeInTheDocument();
  });

  it("offers saved views as inline icon buttons when configured, and a dropdown otherwise", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    window.localStorage.setItem(
      "octant.code.project-views.v1",
      JSON.stringify({
        activeViewId: "all",
        views: [
          {
            id: "view-main",
            name: "Main",
            projectIds: [codeProjectA.id],
            icon: "rocket",
            color: "purple",
          },
          { id: "view-docs", name: "Docs", projectIds: [codeProjectB.id] },
        ],
      }),
    );
    const sharedProps = {
      archivedProjects: [],
      availabilityByProject: new Map(),
      onArchive: vi.fn(),
      onMove: vi.fn(),
      onProjectOpen: vi.fn(),
      onReorder: vi.fn(),
      onRestore: vi.fn(),
      projectViewsEnabled: true,
      projects: [codeProjectA, codeProjectB],
    } as const;

    const { rerender } = render(
      <ProjectSidebarSection {...sharedProps} projectViewSwitcherPresentation="inline" />,
    );

    expect(screen.queryByRole("button", { name: "Project view" })).not.toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Project views" });
    expect(within(group).getByRole("button", { name: "All Projects" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const mainButton = within(group).getByRole("button", { name: "Main" });
    expect(mainButton).toHaveAttribute("title", "Main");
    expect(within(group).getByRole("button", { name: "Docs" })).toHaveAttribute("title", "Docs");
    expect(within(group).getByRole("button", { name: "New project view" })).toBeVisible();

    await user.click(mainButton);
    expect(mainButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Collapse octant" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Collapse auroradocs" })).not.toBeInTheDocument();

    rerender(<ProjectSidebarSection {...sharedProps} projectViewSwitcherPresentation="dropdown" />);
    expect(screen.queryByRole("group", { name: "Project views" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project view" })).toHaveTextContent("Main");
  });

  it("initializes project views when Code becomes enabled after Chat", async () => {
    window.localStorage.clear();
    const { rerender } = render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projects={[codeProjectA, codeProjectB]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Project view" })).not.toBeInTheDocument();

    rerender(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projectViewsEnabled
        projects={[codeProjectA, codeProjectB]}
      />,
    );

    expect(screen.getByRole("button", { name: "Project view" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New project view" })).toBeVisible();
  });
});

describe("ProjectSidebarSection Code and Work recents", () => {
  it("puts a discrete add control on the Projects header and lists unfiled threads under Recents", async () => {
    const user = userEvent.setup();
    const onAddProject = vi.fn();
    const onSelectThread = vi.fn();

    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onAddProject={onAddProject}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        onSelectThread={onSelectThread}
        projects={[codeProjectA]}
        unfiledLabel="Recents"
        threads={[
          {
            projectId: String(codeProjectA.id),
            threadId: "thread-bound",
            title: "Bound work",
          },
          {
            threadId: "thread-rootless",
            title: "hei",
          },
        ]}
      />,
    );

    const add = screen.getByRole("button", { name: "Add folder" });
    expect(add).toHaveClass("project-section__add");
    expect(add).not.toHaveTextContent("Add folder");
    expect(add.compareDocumentPosition(screen.getByRole("heading", { name: "Projects" }))).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(screen.getByRole("heading", { name: "Recents" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Unfiled" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hei/i })).toBeVisible();
    await user.click(add);
    expect(onAddProject).toHaveBeenCalledOnce();
  });

  it("puts a discrete New Chat Project control on the Projects header", async () => {
    const user = userEvent.setup();
    const onAddProject = vi.fn();

    render(
      <ProjectSidebarSection
        addProjectLabel="chat-project"
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onAddProject={onAddProject}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projects={[chatProjectA]}
        threads={[
          {
            projectId: String(chatProjectA.id),
            threadId: "thread-a",
            title: "Planning",
          },
        ]}
      />,
    );

    const add = screen.getByRole("button", { name: "New Chat Project" });
    expect(add).toHaveClass("project-section__add");
    expect(add).not.toHaveTextContent("New Chat Project");
    expect(add.compareDocumentPosition(screen.getByRole("heading", { name: "Projects" }))).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    await user.click(add);
    expect(onAddProject).toHaveBeenCalledOnce();
  });
});
