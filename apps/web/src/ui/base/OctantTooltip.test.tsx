import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OctantTooltip } from "./OctantTooltip";

describe("OctantTooltip", () => {
  it("describes an icon control on hover and closes when the control is used", async () => {
    const user = userEvent.setup();
    render(
      <OctantTooltip label="Toggle environment">
        <button aria-label="Toggle environment" type="button" />
      </OctantTooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle environment" });
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Toggle environment");

    await user.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
