import type { SidebarNavigationInput } from "./navigationModel";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarNavigation } from "./SidebarNavigation";

const truthfulInput = {
  activeMode: "code",
  automationsEnabled: false,
  createThread: "unavailable",
  plugins: "unavailable",
  projects: "available",
  pullRequests: "unavailable",
  threadBoard: "unavailable",
} as const satisfies SidebarNavigationInput;

describe("SidebarNavigation", () => {
  it("renders capability-backed Code destinations and invokes their exact handlers", async () => {
    const user = userEvent.setup();
    const actions = {
      "new-code-thread": vi.fn(),
      automations: vi.fn(),
      plugins: vi.fn(),
      "pull-requests": vi.fn(),
      "thread-board": vi.fn(),
    };
    render(
      <SidebarNavigation
        actions={actions}
        input={{
          ...truthfulInput,
          automationsEnabled: true,
          createThread: "available",
          plugins: "available",
          pullRequests: "available",
          threadBoard: "available",
        }}
        projectAction={<button type="button">New Code Project</button>}
        projectSection={<nav aria-label="Projects">Octant</nav>}
      />,
    );

    for (const label of ["New thread", "Automations", "Plugins", "Thread board", "Pull requests"]) {
      await user.click(screen.getByRole("button", { name: label }));
    }
    expect(actions["new-code-thread"]).toHaveBeenCalledOnce();
    expect(actions.automations).toHaveBeenCalledOnce();
    expect(actions.plugins).toHaveBeenCalledOnce();
    expect(actions["thread-board"]).toHaveBeenCalledOnce();
    expect(actions["pull-requests"]).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "New thread" })).toHaveClass("sidebar__utility");
    // Search is a mode-switcher icon and thread rows nest under Projects, so
    // neither is a navigation row here.
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Threads" })).not.toBeInTheDocument();
  });

  it("does not forward the click event to the Chat creation handler", async () => {
    const user = userEvent.setup();
    const createChat = vi.fn<(prompt?: string) => void>();
    render(
      <SidebarNavigation
        actions={{ "new-chat": createChat }}
        input={{ ...truthfulInput, activeMode: "chat", createThread: "available" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(createChat).toHaveBeenCalledOnce();
    expect(createChat).toHaveBeenCalledWith();
  });

  it("renders only model descriptors backed by real handlers and content", async () => {
    const user = userEvent.setup();
    const onPlugins = vi.fn();
    render(
      <SidebarNavigation
        actions={{ plugins: onPlugins }}
        input={{ ...truthfulInput, plugins: "available" }}
        projectAction={<button type="button">New Code Project</button>}
        projectSection={<nav aria-label="Projects">Octant</nav>}
      />,
    );

    const plugins = screen.getByRole("button", { name: "Plugins" });
    const createProject = screen.getByRole("button", { name: "New Code Project" });
    const projects = screen.getByRole("navigation", { name: "Projects" });
    expect(plugins.compareDocumentPosition(createProject)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(createProject.compareDocumentPosition(projects)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("button", { name: /new thread/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /thread board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pull requests/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /automations/i })).not.toBeInTheDocument();

    plugins.focus();
    expect(plugins).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPlugins).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "unavailable", "unauthorized"] as const)(
    "omits %s descriptors instead of rendering dead destinations",
    (availability) => {
      render(
        <SidebarNavigation
          actions={{ plugins: vi.fn() }}
          input={{ ...truthfulInput, plugins: availability, projects: availability }}
          projectAction={<button type="button">New Code Project</button>}
          projectSection={<nav aria-label="Projects">Octant</nav>}
        />,
      );

      expect(screen.queryByRole("button", { name: "Plugins" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New Code Project" })).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Projects" })).not.toBeInTheDocument();
    },
  );

  it("fails closed when availability and a real action disagree", () => {
    render(
      <SidebarNavigation
        actions={{}}
        input={{ ...truthfulInput, plugins: "available" }}
        projectSection={<nav aria-label="Projects">Octant</nav>}
      />,
    );

    expect(screen.queryByRole("button", { name: "Plugins" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Projects" })).toBeVisible();
  });

  it("styles New chat like the standard sidebar rows and leaves Chat threads to Projects nesting", () => {
    render(
      <SidebarNavigation
        actions={{ "new-chat": vi.fn(), plugins: vi.fn() }}
        input={{
          activeMode: "chat",
          automationsEnabled: false,
          createThread: "available",
          plugins: "available",
          projects: "available",
          pullRequests: "unavailable",
          threadBoard: "unavailable",
        }}
        projectSection={<nav aria-label="Projects">Projects</nav>}
      />,
    );

    expect(screen.getByRole("button", { name: "New chat" })).toHaveClass("sidebar__utility");
    // Plugins reach Chat too; boards and a second thread list do not.
    expect(screen.getByRole("button", { name: "Plugins" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /thread board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Recent chats" })).not.toBeInTheDocument();
  });
});
