import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarRail } from "./SidebarRail";

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

  it("marks only the four count icons with their hue role", () => {
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

    const hued = screen
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("data-tile"))
      .map((button) => button.getAttribute("data-tile"));
    expect(hued).toEqual(["inbox", "running", "review", "done"]);
    expect(screen.getByRole("button", { name: "Settings" })).not.toHaveAttribute("data-tile");
  });
});
