import { decodeWindowId } from "@octant/contracts/shell";
import { defaultShellSettings, defaultWindowWorkspace } from "@octant/domain/shell-policy";
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
        onAddFolder={vi.fn()}
        onOpenSearch={vi.fn()}
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
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={<nav aria-label="Projects">Project navigation</nav>}
        settings={defaultShellSettings()}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    for (const label of ["New thread", "Plugins", "Thread board", "Pull requests"]) {
      await user.click(screen.getByRole("button", { name: label }));
    }
    expect(actions["new-code-thread"]).toHaveBeenCalledOnce();
    expect(actions.automations).not.toHaveBeenCalled();
    expect(actions.plugins).toHaveBeenCalledOnce();
    expect(actions["thread-board"]).toHaveBeenCalledOnce();
    expect(actions["pull-requests"]).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Threads" })).not.toBeInTheDocument();
  });

  it("keeps Automations hidden when the gate prop is off and reveals it when the gate flips", async () => {
    const user = userEvent.setup();
    const automations = vi.fn();
    const sidebar = (automationsEnabled?: boolean) => (
      <ShellSidebar
        {...(automationsEnabled === undefined ? {} : { automationsEnabled })}
        codeNavigation={{ actions: { "new-code-thread": vi.fn(), automations } }}
        onAddFolder={vi.fn()}
        onOpenSearch={vi.fn()}
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
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
    gated.unmount();

    render(sidebar(true));
    await user.click(screen.getByRole("button", { name: "Automations" }));
    expect(automations).toHaveBeenCalledOnce();
  });

  it("keeps Code threads under Projects rather than a dead Threads destination", () => {
    render(
      <ShellSidebar
        codeNavigation={{ actions: { "new-code-thread": vi.fn() } }}
        onAddFolder={vi.fn()}
        onOpenSearch={vi.fn()}
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
          onOpenSearch={onOpenSearch}
          onOpenSettings={onOpenSettings}
          onSelectMode={vi.fn()}
          projectSection={<nav aria-label="Projects">Project navigation</nav>}
          settings={defaultShellSettings()}
          workspace={workspace}
        />,
      );

      const modes = screen.getByRole("group", { name: "Workspace mode" });
      const search = screen.getByRole("button", { name: "Search" });
      const projects = screen.getByRole("navigation", { name: "Projects" });
      const settings = screen.getByRole("button", { name: "Settings" });

      expect(modes.compareDocumentPosition(search)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(search.compareDocumentPosition(projects)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(projects.compareDocumentPosition(settings)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(container.querySelector(".sidebar__utility--filled")).toBeNull();
      expect(search).toHaveClass("shell-icon-button");
      expect(search).not.toHaveTextContent("Search");
      expect(search).toHaveAttribute("data-navigation-id", "search");
      expect(screen.queryByRole("button", { name: "Add folder" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New Chat Project" })).not.toBeInTheDocument();

      await user.click(search);
      await user.click(settings);
      expect(onOpenSearch).toHaveBeenCalledOnce();
      expect(onOpenSettings).toHaveBeenCalledOnce();
    },
  );

  it("omits disabled modes instead of rendering unavailable controls", () => {
    render(
      <ShellSidebar
        onAddFolder={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projectSection={null}
        settings={{ ...defaultShellSettings(), chatEnabled: false, workEnabled: false }}
        workspace={{ ...defaultWindowWorkspace(windowId), activeMode: "code" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Work" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code" })).toBeVisible();
  });

  it("keeps New chat available while Chat is reconnecting or unauthorized", () => {
    const onNewChat = vi.fn();
    render(
      <ShellSidebar
        chatErrorMessage="Chat request is unauthorized."
        chatNavigation={{ actions: { "new-chat": onNewChat } }}
        chatStatus="disconnected"
        onAddFolder={vi.fn()}
        onOpenSearch={vi.fn()}
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
        onOpenSearch={vi.fn()}
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
        onOpenSearch={vi.fn()}
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
    expect(search).toHaveClass("shell-icon-button");
    expect(search).not.toHaveTextContent("Search");
    expect(activity).toHaveClass("shell-icon-button");
    expect(activity).not.toHaveTextContent("Turn on activity view");
    expect(screen.getByRole("button", { name: "New chat" })).toHaveClass("sidebar__utility");
  });
});
