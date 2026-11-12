import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantContextMenu } from "./OctantContextMenu";

describe("OctantContextMenu", () => {
  it("tells assistive technology when the menu it opened is showing", async () => {
    const user = userEvent.setup();
    render(
      <OctantContextMenu
        items={[{ label: "Rename", value: "rename" }]}
        onValueChange={vi.fn()}
        triggerClassName="recipe-trigger"
      >
        <span>Project</span>
      </OctantContextMenu>,
    );

    const trigger = screen.getByText("Project").closest(".recipe-trigger")!;
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.pointer({ target: trigger, keys: "[MouseRight]" });

    // Base UI leaves `aria-expanded` to the caller for a context menu, so a
    // recipe that never set it left every surface using it silent about the
    // menu it had just opened.
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("opens nothing for an empty item list, on the web and on the desktop's native path", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <OctantContextMenu items={[]} onValueChange={vi.fn()} triggerClassName="recipe-trigger">
        <span>Tab</span>
      </OctantContextMenu>,
    );
    let trigger = screen.getByText("Tab").closest(".recipe-trigger")!;
    await user.pointer({ target: trigger, keys: "[MouseRight]" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    unmount();

    const popup = vi.fn(async () => ({ kind: "cancelled" }));
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    try {
      render(
        <OctantContextMenu items={[]} onValueChange={vi.fn()} triggerClassName="recipe-trigger">
          <span>Tab</span>
        </OctantContextMenu>,
      );
      trigger = screen.getByText("Tab").closest(".recipe-trigger")!;
      fireEvent.contextMenu(trigger, { clientX: 10, clientY: 10 });
      expect(popup).not.toHaveBeenCalled();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    } finally {
      Object.defineProperty(window, "octantHost", { configurable: true, value: undefined });
    }
  });
});
