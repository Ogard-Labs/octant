import { decodeWindowId } from "@octant/contracts/shell";
import { defaultShellSettings, defaultWindowWorkspace } from "@octant/domain/shell-policy";
import { ALL_ENVIRONMENTS } from "@octant/client-runtime/environment-selection";
import type { FederatedHostState } from "@octant/client-runtime";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectSidebarSection } from "../projects/ProjectSidebarSection";
import { ShellSidebar } from "./ShellSidebar";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");

describe("ShellSidebar", () => {
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

  it("exposes Work destinations backed by exact actions, including the Thread board", async () => {
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
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "work" }}
      />,
    );

    for (const label of ["New thread", "Thread board"]) {
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
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    for (const label of ["New thread", "Thread board", "Pull requests"]) {
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
        settings={defaultShellSettings()}
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
      const modeLabel = mode === "chat" ? "Chat" : mode === "work" ? "Work" : "Code";
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

  it("places Search and activity view in the mode-switcher chrome", () => {
    window.localStorage.clear();
    const { container } = render(
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
            threads={[{ threadId: "thread-one", title: "Planning" }]}
          />
        }
        settings={defaultShellSettings()}
        workspace={defaultWindowWorkspace(windowId)}
      />,
    );

    const chrome = container.querySelector(".sidebar__chrome");
    const search = screen.getByRole("button", { name: "Search" });
    const activity = screen.getByRole("button", { name: "Turn on activity view" });
    expect(chrome).not.toBeNull();
    expect(chrome).toContainElement(search);
    expect(chrome).toContainElement(activity);
    expect(activity.compareDocumentPosition(search)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(search).toHaveClass("shell-icon-button");
    expect(search).not.toHaveTextContent("Search");
    expect(search.querySelector("svg")).toHaveAttribute("width", "16");
    expect(activity).toHaveClass("shell-icon-button");
    expect(activity.querySelector("svg")).toHaveAttribute("width", "16");
    expect(activity).not.toHaveTextContent("Turn on activity view");
    expect(screen.getByRole("button", { name: "New chat" })).toHaveClass("sidebar-item");
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
});
