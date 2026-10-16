import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { OctantButton } from "./OctantButton";
import { moveWithinRadioGroup } from "./radioGroupKeys";

function ThemeModeChoice() {
  const [value, setValue] = useState("system");
  return (
    <div aria-label="Theme mode" onKeyDown={moveWithinRadioGroup} role="radiogroup">
      {["system", "light", "dark"].map((option) => (
        <OctantButton
          aria-checked={value === option}
          key={option}
          onClick={() => setValue(option)}
          role="radio"
          type="button"
        >
          {option}
        </OctantButton>
      ))}
    </div>
  );
}

describe("moveWithinRadioGroup", () => {
  it("wraps past either end and selects the radio it lands on", async () => {
    const user = userEvent.setup();
    render(<ThemeModeChoice />);
    screen.getByRole("radio", { name: "dark" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "system" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "system" })).toBeChecked();

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "dark" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "dark" })).toBeChecked();
  });

  it("jumps to the first and last radio with Home and End", async () => {
    const user = userEvent.setup();
    render(<ThemeModeChoice />);
    screen.getByRole("radio", { name: "light" }).focus();

    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "dark" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "system" })).toHaveFocus();
  });
});
