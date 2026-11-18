import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantNumberStepper } from "./OctantNumberStepper";

describe("OctantNumberStepper", () => {
  it("increments, decrements, and accepts a bounded typed value", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <OctantNumberStepper
        label="Interface font size"
        max={32}
        min={8}
        onChange={onChange}
        suffix="px"
        value={13}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Increase Interface font size" }));
    expect(onChange).toHaveBeenLastCalledWith(14);

    rerender(
      <OctantNumberStepper
        label="Interface font size"
        max={32}
        min={8}
        onChange={onChange}
        suffix="px"
        value={14}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Decrease Interface font size" }));
    expect(onChange).toHaveBeenLastCalledWith(13);

    const input = screen.getByRole("spinbutton", { name: "Interface font size" });
    await user.clear(input);
    await user.type(input, "18");
    expect(onChange).toHaveBeenLastCalledWith(18);
  });
});

describe("OctantNumberStepper as a field", () => {
  it("draws no buttons, keeps its unit inside, and clamps a typed value on blur", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <OctantNumberStepper
        field
        label="CPU target"
        max={90}
        min={20}
        onChange={onChange}
        suffix="%"
        value={60}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("%")).toBeVisible();
    const input = screen.getByRole("spinbutton", { name: "CPU target" });
    await user.clear(input);
    await user.type(input, "75");
    expect(onChange).toHaveBeenLastCalledWith(75);
    await user.clear(input);
    await user.type(input, "5");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(20);
  });
});
