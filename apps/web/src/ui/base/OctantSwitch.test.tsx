import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantSwitch } from "./OctantSwitch";

describe("OctantSwitch", () => {
  it("exposes controlled switch semantics for pointer and keyboard input", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <OctantSwitch
        checked
        describedBy="switch-description"
        label="Translucent sidebar"
        onCheckedChange={onCheckedChange}
      />,
    );

    const control = screen.getByRole("switch", { name: "Translucent sidebar" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveAttribute("aria-describedby", "switch-description");
    expect(control).toHaveClass("octant-switch");

    await user.click(control);
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);

    rerender(
      <OctantSwitch
        checked={false}
        describedBy="switch-description"
        label="Translucent sidebar"
        onCheckedChange={onCheckedChange}
      />,
    );
    control.focus();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
  });

  it("prevents interaction while disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <OctantSwitch
        checked={false}
        disabled
        label="Translucent sidebar"
        onCheckedChange={onCheckedChange}
      />,
    );

    await user.click(screen.getByRole("switch", { name: "Translucent sidebar" }));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("explains a disabled switch through its accessible description and on hover", async () => {
    const user = userEvent.setup();
    const reason = "The latest scan did not find its binary on this Mac.";
    render(
      <OctantSwitch
        checked={false}
        disabled
        disabledReason={reason}
        label="Enable Existing CLI"
        onCheckedChange={vi.fn()}
      />,
    );

    const control = screen.getByRole("switch", { name: "Enable Existing CLI" });
    expect(control).toHaveAccessibleDescription(reason);
    // The disabled switch takes no pointer events; its wrapper shows the reason.
    const wrapper = control.parentElement;
    if (wrapper === null) throw new Error("expected the disabled reason wrapper");
    await user.hover(wrapper);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
  });
});
