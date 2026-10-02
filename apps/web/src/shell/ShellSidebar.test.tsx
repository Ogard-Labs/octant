import { decodeWindowId, type ShellSettings } from "@octant/contracts/shell";
import { defaultShellSettings, defaultWindowWorkspace } from "@octant/domain/shell-policy";
import { ALL_ENVIRONMENTS } from "@octant/client-runtime/environment-selection";
import type { FederatedHostState } from "@octant/client-runtime";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectSidebarSection } from "../projects/ProjectSidebarSection";
import { ShellSidebar } from "./ShellSidebar";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");

describe("ShellSidebar", () => {
  it("restores the saved sidebar decoration after workspace coverage ends", () => {
    const props = {
      projectSection: <nav aria-label="Project threads">Project threads</nav>,
      onAddFolder: vi.fn(),
      onOpenNavigator: vi.fn(),
      onOpenSettings: vi.fn(),
      onSelectMode: vi.fn(),
      settings: defaultShellSettings(),
      workspace: defaultWindowWorkspace(windowId),
      backgroundFetcher: vi.fn(),
      resolvedSidebarBackground: {
        kind: "preset" as const,
        backgroundCss: "linear-gradient(red, blue)",
        backgroundId: null,
        overlayColor: "#1a1a1c",
        overlayOpacity: 50,
        vibrancyMode: "off" as const,
      },
    };
    const { container, rerender } = render(
      <ShellSidebar {...props} backgroundCoveredByWorkspace />,
    );
    expect(container.querySelector("[data-octant-sidebar-background]")).toBeNull();
    rerender(<ShellSidebar {...props} backgroundCoveredByWorkspace={false} />);
    expect(container.querySelector("[data-octant-sidebar-background]")).not.toBeNull();
  });

  it("renders the Projects collection as a dedicated sidebar pane", () => {
    const { container } = render(
      <ShellSidebar
        activeDestination="projects"
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Project threads">Project threads</nav>}
        projectsDirectory={<nav aria-label="Projects">All Projects</nav>}
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "Octant sidebar" });
    const projectsPane = screen.getByRole("region", { name: "Projects sidebar" });
    expect(sidebar).toHaveClass("sidebar--projects");
    expect(sidebar).toContainElement(projectsPane);
    expect(projectsPane).toContainElement(screen.getByRole("navigation", { name: "Projects" }));
    expect(container.querySelector(".sidebar__primary")).not.toContainElement(projectsPane);
    expect(screen.queryByRole("navigation", { name: "Project threads" })).toBeNull();
  });

  it("keeps the native leading row unbranded while preserving window affordances", () => {
    const { container } = render(
      <ShellSidebar
        nativeHost
        onAddFolder={vi.fn()}
        onCollapseSidebar={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    expect(container.querySelector(".sidebar__brand-mark")).toBeNull();
    expect(container.querySelector(".sidebar__brand")).toBeNull();
    expect(container.querySelector("[data-traffic-light-safe-space]")).toBeInTheDocument();
    expect(container.querySelector(".sidebar__drag-surface")).toBeInTheDocument();
    expect(container.querySelector(".sidebar__native-leading")).toContainElement(
      screen.getByRole("button", { name: "Hide sidebar" }),
    );
  });

  it("places browser collapse beside sidebar search instead of reserving traffic-light space", () => {
    const { container } = render(
      <ShellSidebar
        onAddFolder={vi.fn()}
        onCollapseSidebar={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    expect(container.querySelector(".sidebar__native-leading")).not.toBeInTheDocument();
    expect(container.querySelector("[data-traffic-light-safe-space]")).not.toBeInTheDocument();
    const cluster = container.querySelector(".sidebar__primary-actions");
    const search = screen.getByRole("button", { name: "Search" });
    const collapse = screen.getByRole("button", { name: "Hide sidebar" });
    expect(cluster).toContainElement(search);
    expect(cluster).toContainElement(collapse);
    expect(search.compareDocumentPosition(collapse)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("exposes Work destinations backed by exact actions, including the Board", async () => {
    const user = userEvent.setup();
    const actions = {
      "new-work-thread": vi.fn(),
      automations: vi.fn(),
      plugins: vi.fn(),
      "thread-board": vi.fn(),
    };
    render(
      <ShellSidebar
        automationsEnabled={false}
        workNavigation={{ actions }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={{ ...defaultShellSettings(), sidebarMoreEnabled: false }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "work" }}
      />,
    );

    for (const label of ["New task", "Board"]) {
      await user.click(screen.getByRole("button", { name: label }));
    }
    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    await user.click(await screen.findByRole("menuitem", { name: "Plugins" }));
    expect(actions["new-work-thread"]).toHaveBeenCalledOnce();
    expect(actions.plugins).toHaveBeenCalledOnce();
    expect(actions["thread-board"]).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Pull requests" })).not.toBeInTheDocument();
  });

  it("exposes Code destinations backed by exact actions", async () => {
    const user = userEvent.setup();
    const actions = {
      "new-code-thread": vi.fn(),
      automations: vi.fn(),
      plugins: vi.fn(),
      "thread-board": vi.fn(),
      "pull-requests": vi.fn(),
    };
    render(
      <ShellSidebar
        automationsEnabled={false}
        codeNavigation={{ actions }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={{ ...defaultShellSettings(), sidebarMoreEnabled: false }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    for (const label of ["New task", "Board", "Pull requests"]) {
      await user.click(screen.getByRole("button", { name: label }));
    }
    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    await user.click(await screen.findByRole("menuitem", { name: "Plugins" }));
    expect(actions["new-code-thread"]).toHaveBeenCalledOnce();
    expect(actions.automations).not.toHaveBeenCalled();
    expect(actions.plugins).toHaveBeenCalledOnce();
    expect(actions["thread-board"]).toHaveBeenCalledOnce();
    expect(actions["pull-requests"]).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Issues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Automations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Threads" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Linear" })).not.toBeInTheDocument();
  });

  it("omits Linear when the plugin is not effective even if an action is wired", () => {
    render(
      <ShellSidebar
        automationsEnabled={false}
        codeNavigation={{ actions: { "linear-issues": vi.fn() } }}
        firstPartyPluginsEffective={new Map([["linear-integration", false]])}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Linear" })).not.toBeInTheDocument();
  });

  it("shows Linear in Code only when the plugin is effective and the action is wired", async () => {
    const user = userEvent.setup();
    const openLinear = vi.fn();
    render(
      <ShellSidebar
        automationsEnabled={false}
        codeNavigation={{ actions: { "linear-issues": openLinear } }}
        firstPartyPluginsEffective={new Map([["linear-integration", true]])}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Linear" }));
    expect(openLinear).toHaveBeenCalledOnce();
  });

  it("shows Issues only when the contribution, action, and issues-read capability are all present", async () => {
    const user = userEvent.setup();
    const openIssues = vi.fn();
    render(
      <ShellSidebar
        automationsEnabled={false}
        codeNavigation={{
          actions: {
            "new-code-thread": vi.fn(),
            "github-issues": openIssues,
            "pull-requests": vi.fn(),
            "thread-board": vi.fn(),
          },
        }}
        githubIssuesReadAvailable
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Issues" }));
    expect(openIssues).toHaveBeenCalledOnce();
  });

  it("hides Issues when the GitHub plugin is not effective", () => {
    render(
      <ShellSidebar
        automationsEnabled={false}
        codeNavigation={{
          actions: {
            "new-code-thread": vi.fn(),
            "github-issues": vi.fn(),
            "pull-requests": vi.fn(),
            "thread-board": vi.fn(),
          },
        }}
        firstPartyPluginsEffective={
          new Map([
            ["board", true],
            ["github-integration", false],
            ["appearance-pack", true],
            ["preview-viewers", true],
          ])
        }
        githubIssuesReadAvailable
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Issues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pull requests" })).not.toBeInTheDocument();
  });

  it("hides Issues when issues-read is not available", () => {
    render(
      <ShellSidebar
        automationsEnabled={false}
        codeNavigation={{
          actions: {
            "new-code-thread": vi.fn(),
            "github-issues": vi.fn(),
            "pull-requests": vi.fn(),
            "thread-board": vi.fn(),
          },
        }}
        githubIssuesReadAvailable={false}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Issues" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull requests" })).toBeInTheDocument();
  });

  it("keeps Automations hidden when the gate prop is off and reveals it when the gate flips", async () => {
    const user = userEvent.setup();
    const automations = vi.fn();
    const sidebar = (automationsEnabled?: boolean) => (
      <ShellSidebar
        {...(automationsEnabled === undefined ? {} : { automationsEnabled })}
        codeNavigation={{ actions: { "new-code-thread": vi.fn(), automations } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={{ ...defaultShellSettings(), sidebarMoreEnabled: false }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />
    );

    // Explicit false overrides the production gate so the prop still controls
    // visibility even when AUTOMATION_CENTER_NAVIGATION_ENABLED is true.
    const gated = render(sidebar(false));
    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    expect(screen.queryByRole("menuitem", { name: "Automations" })).not.toBeInTheDocument();
    gated.unmount();

    render(sidebar(true));
    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    await user.click(await screen.findByRole("menuitem", { name: "Automations" }));
    expect(automations).toHaveBeenCalledOnce();
  });

  it("keeps Code threads under Projects rather than a dead Threads destination", () => {
    render(
      <ShellSidebar
        codeNavigation={{ actions: { "new-code-thread": vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Nested project threads live here</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    // Mode navigation carries actions only; every thread row comes from the
    // Project section, so the sidebar cannot render a thread list twice.
    expect(screen.queryByRole("button", { name: "Threads" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Projects" })).toBeInTheDocument();
  });

  it.each(["chat", "work", "code"] as const)(
    "keeps %s navigation compact, truthful, and keyboard operable",
    async (mode) => {
      const user = userEvent.setup();
      const onAddFolder = vi.fn();
      const onOpenSearch = vi.fn();
      const onOpenSettings = vi.fn();
      const workspace = { ...defaultWindowWorkspace(windowId), activeMode: mode };
      // Chat and Work are one visible mode, so a Chat thread's sidebar reads Work.
      const modeLabel = mode === "code" ? "Code" : "Work";
      const { container } = render(
        <ShellSidebar
          {...(mode === "work"
            ? { workNavigation: { actions: { "new-work-thread": vi.fn() } } }
            : {})}
          {...(mode === "code"
            ? { codeNavigation: { actions: { "new-code-thread": vi.fn() } } }
            : {})}
          {...(mode === "chat" ? { chatNavigation: { actions: { "new-chat": vi.fn() } } } : {})}
          onAddFolder={onAddFolder}
          onOpenNavigator={vi.fn()}
          onOpenSearch={onOpenSearch}
          onOpenSettings={onOpenSettings}
          onSelectMode={vi.fn()}
          projectSection={<nav aria-label="Projects">Project navigation</nav>}
          settings={defaultShellSettings()}
          workspace={workspace}
        />,
      );

      const modes = screen.getByRole("button", { name: `Workspace mode, ${modeLabel}` });
      const search = screen.getByRole("button", { name: "Search" });
      const projects = screen.getByRole("navigation", { name: "Projects" });
      // The foot of the sidebar names the person, and their settings are one
      // of the places their own row leads to.
      const profile = screen.getByRole("button", { name: "Account menu, Set your name" });

      expect(modes.compareDocumentPosition(search)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(search.compareDocumentPosition(projects)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(projects.compareDocumentPosition(profile)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(container.querySelector(".sidebar__utility--filled")).toBeNull();
      expect(search).toHaveClass("shell-icon-button");
      expect(search).not.toHaveTextContent("Search");
      expect(search).toHaveAttribute("data-navigation-id", "search");
      expect(screen.queryByRole("button", { name: "Add folder" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New Chat Project" })).not.toBeInTheDocument();

      await user.click(search);
      expect(onOpenSearch).toHaveBeenCalledOnce();
      await user.click(profile);
      await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
      expect(onOpenSettings).toHaveBeenCalledOnce();
    },
  );

  it("omits disabled modes instead of rendering unavailable controls", () => {
    render(
      <ShellSidebar
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{ ...defaultShellSettings(), chatEnabled: false, workEnabled: false }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Workspace mode, Code" });
    expect(trigger).toHaveTextContent("Code");
    expect(screen.queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Work" })).not.toBeInTheDocument();
  });

  it("keeps New chat available while Chat is reconnecting or unauthorized", () => {
    const onNewChat = vi.fn();
    render(
      <ShellSidebar
        chatErrorMessage="Chat request is unauthorized."
        chatNavigation={{ actions: { "new-chat": onNewChat } }}
        chatStatus="disconnected"
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Projects</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "chat" }}
      />,
    );

    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Chat request is unauthorized.");
  });

  it("surfaces Chat setup failures and offers a direct Settings path", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <ShellSidebar
        chatErrorMessage="Configure a default Chat provider and model before creating a conversation."
        chatNavigation={{ actions: { "new-chat": vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={onOpenSettings}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "chat" }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Configure a default Chat provider and model before creating a conversation.",
    );
    await user.click(screen.getByRole("button", { name: "Open Chat settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("puts Search and New chat in the header and the Projects/Activity switch over the list", () => {
    window.localStorage.clear();
    const newChat = vi.fn();
    const { container } = render(
      <ShellSidebar
        chatNavigation={{ actions: { "new-chat": newChat } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={
          <ProjectSidebarSection
            archivedProjects={[]}
            availabilityByProject={new Map()}
            onArchive={vi.fn()}
            onMove={vi.fn()}
            onProjectOpen={vi.fn()}
            onReorder={vi.fn()}
            onRestore={vi.fn()}
            onSelectThread={vi.fn()}
            projects={[]}
            threads={[{ threadId: "thread-one", title: "Planning" }]}
          />
        }
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    const chrome = container.querySelector(".sidebar__chrome");
    const search = screen.getByRole("button", { name: "Search" });
    const create = screen.getByRole("button", { name: "New chat" });
    expect(chrome).toContainElement(search);
    expect(chrome).toContainElement(create);
    expect(search).toHaveClass("shell-icon-button");
    expect(search.querySelector("svg")).toHaveAttribute("width", "16");
    // The header button replaces the row; the same destination is not offered twice.
    expect(screen.getAllByRole("button", { name: "New chat" })).toHaveLength(1);
    fireEvent.click(create);
    expect(newChat).toHaveBeenCalledOnce();
    const listSwitch = screen.getByRole("group", { name: "Thread list" });
    expect(chrome).not.toContainElement(listSwitch);
    expect(within(listSwitch).getByRole("button", { name: "Activity feed" })).toBeVisible();
  });

  it("offers no Projects/Activity switch before there is a Project or thread to arrange", () => {
    window.localStorage.clear();
    render(
      <ShellSidebar
        chatNavigation={{ actions: { "new-chat": vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={
          <ProjectSidebarSection
            archivedProjects={[]}
            availabilityByProject={new Map()}
            onArchive={vi.fn()}
            onMove={vi.fn()}
            onProjectOpen={vi.fn()}
            onReorder={vi.fn()}
            onRestore={vi.fn()}
            onSelectThread={vi.fn()}
            projects={[]}
            threads={[]}
          />
        }
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    expect(screen.queryByRole("group", { name: "Thread list" })).not.toBeInTheDocument();
  });

  it("moves Inbox and Board into count tiles, and brings the rows back when tiles are off", async () => {
    const user = userEvent.setup();
    const actions = { "new-code-thread": vi.fn(), inbox: vi.fn(), "thread-board": vi.fn() };
    const onOpenReview = vi.fn();
    const onOpenDone = vi.fn();
    const sidebar = (settings: ShellSettings) => (
      <ShellSidebar
        codeNavigation={{ actions }}
        countTiles={{ running: 2, toReview: 1, doneToday: 4, onOpenReview, onOpenDone }}
        inboxCount={3}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={settings}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />
    );
    const { rerender } = render(sidebar(defaultShellSettings()));

    const tiles = screen.getByRole("group", { name: "Thread counts" });
    for (const name of ["Inbox, 3", "Running, 2", "To review, 1", "Done today, 4"]) {
      expect(within(tiles).getByRole("button", { name })).toBeVisible();
    }
    expect(screen.getAllByRole("button", { name: /^Inbox/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
    await user.click(within(tiles).getByRole("button", { name: "Inbox, 3" }));
    await user.click(within(tiles).getByRole("button", { name: "Running, 2" }));
    await user.click(within(tiles).getByRole("button", { name: "To review, 1" }));
    await user.click(within(tiles).getByRole("button", { name: "Done today, 4" }));
    expect(actions.inbox).toHaveBeenCalledOnce();
    expect(actions["thread-board"]).toHaveBeenCalledOnce();
    expect(onOpenReview).toHaveBeenCalledOnce();
    expect(onOpenDone).toHaveBeenCalledOnce();

    rerender(sidebar({ ...defaultShellSettings(), sidebarCountTiles: false }));
    expect(screen.queryByRole("group", { name: "Thread counts" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inbox, 3 waiting" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Board" })).toBeVisible();
  });

  it("opens the thread filter from Search, and keeps it shown when Settings asks", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onOpenSearch = vi.fn();
    const sidebar = (settings: ShellSettings, query = "") => (
      <ShellSidebar
        chatNavigation={{ actions: { "new-chat": vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSearch={onOpenSearch}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={settings}
        threadFilter={{ query, onQueryChange }}
        workspace={defaultWindowWorkspace(windowId)}
      />
    );
    const { rerender } = render(sidebar(defaultShellSettings()));

    expect(screen.queryByRole("searchbox", { name: "Filter threads" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Search" }));
    const field = screen.getByRole("searchbox", { name: "Filter threads" });
    expect(field).toHaveFocus();
    await user.type(field, "p");
    expect(onQueryChange).toHaveBeenLastCalledWith("p");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox", { name: "Filter threads" })).not.toBeInTheDocument();
    expect(onQueryChange).toHaveBeenLastCalledWith("");
    // The command overlay stays on its own shortcut; the icon now filters in place.
    expect(onOpenSearch).not.toHaveBeenCalled();

    rerender(sidebar({ ...defaultShellSettings(), sidebarSearchPresentation: "field" }, "plan"));
    expect(screen.getByRole("searchbox", { name: "Filter threads" })).toHaveValue("plan");
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("offers the environments filter once at least two hosts are known", async () => {
    const user = userEvent.setup();
    const hostStates = [
      { hostId: "host-local", hostDisplayName: "This Mac", freshness: "ready", itemCount: 3 },
      { hostId: "host-devbox", hostDisplayName: "Devbox", freshness: "unavailable", itemCount: 0 },
    ] as unknown as ReadonlyArray<FederatedHostState>;
    const onSelectionChange = vi.fn();

    render(
      <ShellSidebar
        environments={{
          hostStates,
          selection: ALL_ENVIRONMENTS,
          localHostId: "host-local",
          onSelectionChange,
        }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    expect(screen.getByText("All environments")).toBeVisible();
    // The filter menu starts closed; open the toggle to see the host rows.
    await user.click(screen.getByRole("button", { name: "All environments" }));
    expect(screen.getByText("Local")).toBeVisible();
    expect(screen.getByText("Devbox")).toBeVisible();
    expect(screen.getByText("unreachable")).toBeVisible();
  });

  it("hides the environments filter when fewer than two hosts are known", () => {
    const hostStates = [
      { hostId: "host-local", hostDisplayName: "This Mac", freshness: "ready", itemCount: 3 },
    ] as unknown as ReadonlyArray<FederatedHostState>;

    render(
      <ShellSidebar
        environments={{
          hostStates,
          selection: ALL_ENVIRONMENTS,
          localHostId: "host-local",
          onSelectionChange: vi.fn(),
        }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    expect(screen.queryByText("All environments")).not.toBeInTheDocument();
  });

  it("routes sidebar Search to the App-level overlay", async () => {
    const user = userEvent.setup();
    const onOpenSearch = vi.fn();
    render(
      <ShellSidebar
        chatNavigation={{ actions: { "new-chat": vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSearch={onOpenSearch}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("honours the persisted customization: hidden Inbox gone, promoted Automations a row", async () => {
    const user = userEvent.setup();
    const automations = vi.fn();
    render(
      <ShellSidebar
        codeNavigation={{
          actions: { "new-code-thread": vi.fn(), inbox: vi.fn(), automations },
        }}
        automationsEnabled
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{
          ...defaultShellSettings(),
          sidebarDestinations: {
            order: [],
            visibility: [
              { id: "inbox", visibility: "hidden" },
              { id: "automations", visibility: "shown" },
            ],
          },
        }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Inbox" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Automations" }));
    expect(automations).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    await screen.findByRole("menuitem", { name: "Settings" });
    expect(screen.queryByRole("menuitem", { name: "Automations" })).not.toBeInTheDocument();
  });

  it("renders an available Image generator promoted from the account menu", async () => {
    const user = userEvent.setup();
    const imageLibrary = vi.fn();
    render(
      <ShellSidebar
        codeNavigation={{
          actions: { "new-code-thread": vi.fn(), "image-library": imageLibrary },
        }}
        imageLibraryAvailable
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{
          ...defaultShellSettings(),
          sidebarDestinations: {
            order: [],
            visibility: [{ id: "image-library", visibility: "shown" }],
          },
        }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Image generator" }));
    expect(imageLibrary).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    await screen.findByRole("menuitem", { name: "Settings" });
    expect(screen.queryByRole("menuitem", { name: "Image generator" })).not.toBeInTheDocument();
  });

  it("closes the destination rows with a More row that reveals the menu-only ones", async () => {
    const user = userEvent.setup();
    const plugins = vi.fn();
    render(
      <ShellSidebar
        codeNavigation={{
          actions: { "new-code-thread": vi.fn(), automations: vi.fn(), plugins },
        }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    const more = screen.getByRole("button", { name: "More destinations" });
    const newTask = screen.getByRole("button", { name: "New task" });
    // More is the last destination row: after the rows, before the Project tree.
    expect(newTask.compareDocumentPosition(more)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "Plugins" }));
    expect(plugins).toHaveBeenCalledOnce();
  });

  it("marks More and its menu item current while a destination it holds is open", async () => {
    const user = userEvent.setup();
    render(
      <ShellSidebar
        activeDestination="plugins"
        codeNavigation={{
          actions: { "new-code-thread": vi.fn(), automations: vi.fn(), plugins: vi.fn() },
        }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    const more = screen.getByRole("button", { name: "More destinations" });
    expect(more).toHaveAttribute("aria-current", "page");
    await user.click(more);
    expect(await screen.findByRole("menuitem", { name: "Plugins" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("menuitem", { name: "Automations" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("leaves a destination the rail already carries out of the More popup", async () => {
    const user = userEvent.setup();
    render(
      <ShellSidebar
        codeNavigation={{
          actions: { "new-code-thread": vi.fn(), automations: vi.fn(), plugins: vi.fn() },
        }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{
          ...defaultShellSettings(),
          sidebarDestinations: {
            order: [],
            visibility: [{ id: "automations", visibility: "shown" }],
          },
        }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    expect(screen.getByRole("button", { name: "Automations" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "More destinations" }));
    expect(await screen.findByRole("menuitem", { name: "Plugins" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Automations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
  });

  it("puts Customize sidebar behind the destination rows in the More popup", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <ShellSidebar
        codeNavigation={{ actions: { "new-code-thread": vi.fn(), plugins: vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={onOpenSettings}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More destinations" }));
    const customize = await screen.findByRole("menuitem", { name: "Customize sidebar" });
    const plugins = screen.getByRole("menuitem", { name: "Plugins" });
    expect(plugins.compareDocumentPosition(customize)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(customize);
    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "appearance",
      setting: "sidebar-destinations",
    });
  });

  it("keeps the More row off and the destinations in the account menu when it is turned off", async () => {
    const user = userEvent.setup();
    render(
      <ShellSidebar
        codeNavigation={{ actions: { "new-code-thread": vi.fn(), plugins: vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{ ...defaultShellSettings(), sidebarMoreEnabled: false }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "More destinations" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    expect(await screen.findByRole("menuitem", { name: "Plugins" })).toBeVisible();
  });

  it("omits the More row when nothing is left to reveal", () => {
    render(
      <ShellSidebar
        codeNavigation={{ actions: { "new-code-thread": vi.fn() } }}
        automationsEnabled={false}
        agentsCenterEnabled={false}
        artifactLibraryAvailable={false}
        imageLibraryAvailable={false}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{
          ...defaultShellSettings(),
          sidebarDestinations: {
            order: [],
            visibility: [{ id: "plugins", visibility: "hidden" }],
          },
        }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "More destinations" })).not.toBeInTheDocument();
  });

  it("collapses to an icon rail that keeps the modes, counts, and Projects in reach", async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    const onSelectMode = vi.fn();
    const openProject = vi.fn();
    const actions = { "new-code-thread": vi.fn(), inbox: vi.fn(), "thread-board": vi.fn() };
    render(
      <ShellSidebar
        codeNavigation={{ actions }}
        countTiles={{ running: 2, toReview: 0, doneToday: 1 }}
        inboxCount={3}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={onSelectMode}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        rail={{
          onExpand,
          projects: [{ id: "p1", name: "octant", active: true, onOpen: openProject }],
        }}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "Octant sidebar, collapsed" });
    expect(screen.queryByRole("complementary", { name: "Octant sidebar" })).toBeNull();
    expect(within(rail).getByRole("button", { name: "Code" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(within(rail).getByRole("button", { name: "Work" }));
    expect(onSelectMode).toHaveBeenCalledWith("work");
    await user.click(within(rail).getByRole("button", { name: "Running, 2" }));
    expect(actions["thread-board"]).toHaveBeenCalledOnce();
    expect(within(rail).getByRole("button", { name: "Inbox, 3" })).toHaveTextContent("3");
    await user.click(within(rail).getByRole("button", { name: "octant" }));
    expect(openProject).toHaveBeenCalledOnce();
    await user.click(within(rail).getByRole("button", { name: "Show sidebar" }));
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("renders the rows in the customized order", () => {
    render(
      <ShellSidebar
        codeNavigation={{
          actions: {
            "new-code-thread": vi.fn(),
            "thread-board": vi.fn(),
            "pull-requests": vi.fn(),
          },
        }}
        onAddFolder={vi.fn()}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{
          ...defaultShellSettings(),
          sidebarDestinations: {
            order: ["pull-requests", "board"],
            visibility: [],
          },
        }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    const pullRequests = screen.getByRole("button", { name: "Pull requests" });
    const board = screen.getByRole("button", { name: "Board" });
    expect(pullRequests.compareDocumentPosition(board)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
