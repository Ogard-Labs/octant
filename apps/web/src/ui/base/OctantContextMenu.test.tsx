import { render, screen } from "@testing-library/react";
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
});
