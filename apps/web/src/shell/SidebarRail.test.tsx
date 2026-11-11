import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { resolveRailPins, savedRailPins, SidebarRail } from "./SidebarRail";

describe("SidebarRail", () => {
  it("names each icon beside the rail when the pointer rests on it", async () => {
    const user = userEvent.setup();
    render(
      <SidebarRail
        activeMode="code"
        destinations={[]}
        modes={["chat", "work", "code"]}
        nativeHost={false}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projects={[{ id: "p1", name: "octant", active: false, onOpen: vi.fn() }]}
        tiles={[{ id: "running", count: 1, onSelect: vi.fn() }]}
      />,
    );

    await user.hover(screen.getByRole("button", { name: "Running, 1" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Running, 1");

    await user.hover(screen.getByRole("button", { name: "octant" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("octant");
  });

  it("marks only the four count icons with the count they stand for", () => {
    render(
      <SidebarRail
        activeMode="code"
        destinations={[]}
        modes={["chat", "work", "code"]}
        nativeHost={false}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projects={[]}
        tiles={[
          { id: "inbox", count: 3, onSelect: vi.fn() },
          { id: "running", count: 1, onSelect: vi.fn() },
          { id: "review", count: 2, onSelect: vi.fn() },
          { id: "done", count: 4, onSelect: vi.fn() },
        ]}
      />,
    );

    const counts = screen
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("data-tile"))
      .map((button) => button.getAttribute("data-tile"));
    expect(counts).toEqual(["inbox", "running", "review", "done"]);
    expect(screen.getByRole("button", { name: "Settings" })).not.toHaveAttribute("data-tile");
  });

  it("draws Work with the same mark as the sidebar's mode switcher", () => {
    render(
      <SidebarRail
        activeMode="work"
        destinations={[]}
        modes={["chat", "work", "code"]}
        nativeHost={false}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        projects={[]}
        tiles={[]}
      />,
    );

    const work = screen.getByRole("button", { name: "Work" });
    expect(work.querySelector("svg.lucide-message-square")).not.toBeNull();
    expect(work.querySelector("svg.lucide-folder-open")).toBeNull();
  });

  describe("pinned Projects", () => {
    const project = (id: string, name: string, onOpen = vi.fn()) => ({
      id,
      name,
      active: false,
      onOpen,
    });
    const rail = (props: {
      placement?: "collapsed" | "beside";
      projects?: ReadonlyArray<ReturnType<typeof project>>;
      pinned?: ReadonlyArray<ReturnType<typeof project>>;
      onUnpin?: (id: string) => void;
    }) => (
      <SidebarRail
        activeMode="code"
        destinations={[]}
        modes={["chat", "work", "code"]}
        nativeHost={false}
        onOpenSettings={vi.fn()}
        onSelectMode={vi.fn()}
        {...(props.onUnpin === undefined ? {} : { onUnpinProject: props.onUnpin })}
        {...(props.placement === undefined ? {} : { placement: props.placement })}
        {...(props.pinned === undefined ? {} : { pinnedProjects: props.pinned })}
        projects={props.projects ?? []}
        tiles={[]}
      />
    );

    it("shows a pinned Project as a tile in both placements and opens it", async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      const pinned = [project("p1", "Harbor", onOpen)];
      const { rerender } = render(rail({ placement: "beside", pinned }));
      await user.click(screen.getByRole("button", { name: "Harbor" }));
      expect(onOpen).toHaveBeenCalledOnce();
      expect(screen.getByText("H")).toBeInTheDocument();
      rerender(rail({ placement: "collapsed", pinned }));
      expect(screen.getByRole("button", { name: "Harbor" })).toBeInTheDocument();
    });

    it("lists the pinned Projects first in the collapsed rail without repeating one", () => {
      render(
        rail({
          projects: [project("a", "Alpha"), project("b", "Beta"), project("c", "Gamma")],
          pinned: [project("c", "Gamma")],
        }),
      );
      const names = screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
        .filter((name) => ["Alpha", "Beta", "Gamma"].includes(name ?? ""));
      expect(names).toEqual(["Gamma", "Alpha", "Beta"]);
    });

    it("keeps the rail to six Project tiles so Settings stays in the window", () => {
      const many = Array.from({ length: 10 }, (_, index) => project(`p${index}`, `Pin ${index}`));
      render(rail({ projects: [project("z", "Zed")], pinned: many }));
      expect(screen.getAllByRole("button", { name: /^Pin \d$/ })).toHaveLength(6);
      expect(screen.queryByRole("button", { name: "Zed" })).toBeNull();
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    });

    it("unpins a Project from the tile's context menu", async () => {
      const user = userEvent.setup();
      const onUnpin = vi.fn();
      render(rail({ pinned: [project("p1", "Harbor")], onUnpin }));
      fireEvent.contextMenu(screen.getByRole("button", { name: "Harbor" }));
      await user.click(await screen.findByRole("menuitem", { name: "Unpin from rail" }));
      expect(onUnpin).toHaveBeenCalledWith("p1");
    });

    it("draws nothing for a pin whose Project is gone and drops it on the next save", () => {
      const existing = [project("a", "Alpha")];
      expect(resolveRailPins(["gone", "a"], existing).map((entry) => entry.id)).toEqual(["a"]);
      expect(savedRailPins(["gone", "a"], new Set(["a", "b"]), "b", true)).toEqual(["a", "b"]);
      expect(savedRailPins(["a", "b"], new Set(["a", "b"]), "a", false)).toEqual(["b"]);
    });
  });
});
