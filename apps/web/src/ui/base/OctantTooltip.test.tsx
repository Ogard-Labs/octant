import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OctantTooltip } from "./OctantTooltip";
import { OctantButton } from "./OctantButton";

describe("OctantTooltip", () => {
  it("describes an icon control on hover and closes when the control is used", async () => {
    const user = userEvent.setup();
    render(
      <OctantTooltip label="Toggle environment">
        <OctantButton aria-label="Toggle environment" type="button" />
      </OctantTooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle environment" });
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Toggle environment");

    await user.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not open for focus that a click or a returning sheet caused", async () => {
    const user = userEvent.setup();
    render(
      <>
        <OctantTooltip label="Settings">
          <OctantButton aria-label="Settings" type="button" />
        </OctantTooltip>
        <button type="button">Elsewhere</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Settings" });
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    // A sheet closed by a click hands focus back to its trigger in code.
    act(() => trigger.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    act(() => trigger.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens for keyboard focus and closes on Escape and on pointer leave", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <OctantTooltip label="Settings">
          <OctantButton aria-label="Settings" type="button" />
        </OctantTooltip>
      </>,
    );
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Settings");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    const trigger = screen.getByRole("button", { name: "Settings" });
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.unhover(trigger);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });
});
