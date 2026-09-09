import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarDestinationSettings } from "./SidebarDestinationSettings";

const untouched = { order: [], visibility: [] } as const;

describe("SidebarDestinationSettings", () => {
  it("lists every destination with its effective visibility", () => {
    render(<SidebarDestinationSettings customization={untouched} onChange={vi.fn()} />);

    for (const label of [
      "New thread",
      "Inbox",
      "Board",
      "Pull requests",
      "Issues",
      "Linear",
      "Projects",
      "Agents",
      "Automations",
      "Artifacts",
      "Image generator",
      "Plugins",
    ]) {
      expect(screen.getByRole("combobox", { name: `${label} visibility` })).toHaveTextContent(
        ["New thread", "Inbox", "Board", "Pull requests", "Issues", "Linear", "Projects"].includes(
          label,
        )
          ? "Always show"
          : "Menu only",
      );
    }
  });

  it("hides a primary destination and clears back to the default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SidebarDestinationSettings customization={untouched} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: "Inbox visibility" }));
    await user.click(await screen.findByRole("option", { name: "Don't show" }));
    expect(onChange).toHaveBeenLastCalledWith({
      order: [],
      visibility: [{ id: "inbox", visibility: "hidden" }],
    });
  });

  it("promotes a menu destination and returns it to the menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <SidebarDestinationSettings customization={untouched} onChange={onChange} />,
    );

    await user.click(screen.getByRole("combobox", { name: "Plugins visibility" }));
    await user.click(await screen.findByRole("option", { name: "Always show" }));
    expect(onChange).toHaveBeenLastCalledWith({
      order: [],
      visibility: [{ id: "plugins", visibility: "shown" }],
    });

    rerender(
      <SidebarDestinationSettings
        customization={{ order: [], visibility: [{ id: "plugins", visibility: "shown" }] }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Plugins visibility" }));
    await user.click(await screen.findByRole("option", { name: "Menu only" }));
    expect(onChange).toHaveBeenLastCalledWith({ order: [], visibility: [] });
  });

  it("reorders a destination with the move controls", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SidebarDestinationSettings customization={untouched} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Move Inbox down" }));
    expect(onChange).toHaveBeenLastCalledWith({
      order: ["new-thread", "board", "inbox"],
      visibility: [],
    });
  });

  it("returns the sidebar to the untouched shell", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SidebarDestinationSettings
        customization={{ order: ["inbox"], visibility: [{ id: "plugins", visibility: "shown" }] }}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset sidebar destinations" }));
    expect(onChange).toHaveBeenLastCalledWith({ order: [], visibility: [] });
  });
});
