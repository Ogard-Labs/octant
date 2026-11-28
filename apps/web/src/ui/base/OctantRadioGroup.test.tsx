import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { OctantRadioGroup, OctantRadioGroupItem } from "./OctantRadioGroup";

function DemoGroup(props: {
  readonly initial?: "system" | "light" | "dark" | "custom";
  readonly disableLight?: boolean;
  readonly numberShortcuts?: boolean;
  readonly includeCustomInput?: boolean;
}) {
  const [value, setValue] = useState<"system" | "light" | "dark" | "custom">(
    props.initial ?? "system",
  );
  const [text, setText] = useState("hello");
  return (
    <div>
      <button type="button">Before</button>
      <OctantRadioGroup
        aria-label="Theme mode"
        numberShortcuts={props.numberShortcuts}
        onValueChange={(next) => setValue(next)}
        value={value}
      >
        <OctantRadioGroupItem value="system">System</OctantRadioGroupItem>
        <OctantRadioGroupItem disabled={props.disableLight} value="light">
          Light
        </OctantRadioGroupItem>
        <OctantRadioGroupItem value="dark">Dark</OctantRadioGroupItem>
        <OctantRadioGroupItem value="custom">Custom</OctantRadioGroupItem>
        {props.includeCustomInput ? (
          <input
            aria-label="Custom value"
            onChange={(event) => setText(event.target.value)}
            value={text}
          />
        ) : null}
      </OctantRadioGroup>
      <button type="button">After</button>
    </div>
  );
}

describe("OctantRadioGroup", () => {
  it("lands Tab once on the active radio and keeps only the active option in tab order", async () => {
    const user = userEvent.setup();
    render(<DemoGroup initial="dark" />);

    const system = screen.getByRole("radio", { name: "System" });
    const light = screen.getByRole("radio", { name: "Light" });
    const dark = screen.getByRole("radio", { name: "Dark" });
    const custom = screen.getByRole("radio", { name: "Custom" });

    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(dark).toHaveAttribute("tabindex", "0");
    expect(system).toHaveAttribute("tabindex", "-1");
    expect(light).toHaveAttribute("tabindex", "-1");
    expect(custom).toHaveAttribute("tabindex", "-1");

    await user.tab();
    expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
    await user.tab();
    expect(dark).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("moves and selects with Arrow, Home, and End keys while skipping disabled options", async () => {
    const user = userEvent.setup();
    render(<DemoGroup disableLight initial="system" />);

    const system = screen.getByRole("radio", { name: "System" });
    const light = screen.getByRole("radio", { name: "Light" });
    const dark = screen.getByRole("radio", { name: "Dark" });
    const custom = screen.getByRole("radio", { name: "Custom" });

    expect(light).toBeDisabled();
    system.focus();

    await user.keyboard("{ArrowRight}");
    expect(dark).toHaveFocus();
    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(dark).toHaveAttribute("tabindex", "0");
    expect(system).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{End}");
    expect(custom).toHaveFocus();
    expect(custom).toHaveAttribute("aria-checked", "true");

    await user.keyboard("{Home}");
    expect(system).toHaveFocus();
    expect(system).toHaveAttribute("aria-checked", "true");

    await user.keyboard("{ArrowLeft}");
    expect(custom).toHaveFocus();
    expect(custom).toHaveAttribute("aria-checked", "true");
  });

  it("supports pointer selection, optional number shortcuts, and leaves nested text inputs untouched", async () => {
    const user = userEvent.setup();
    render(<DemoGroup includeCustomInput initial="system" numberShortcuts />);

    const dark = screen.getByRole("radio", { name: "Dark" });
    const light = screen.getByRole("radio", { name: "Light" });
    const custom = screen.getByRole("radio", { name: "Custom" });
    const input = screen.getByRole("textbox", { name: "Custom value" });

    await user.click(dark);
    expect(dark).toHaveAttribute("aria-checked", "true");

    await user.keyboard("2");
    expect(light).toHaveFocus();
    expect(light).toHaveAttribute("aria-checked", "true");

    await user.click(custom);
    input.focus();
    await user.keyboard("{ArrowLeft}{Home}1");
    expect(input).toHaveFocus();
    expect(custom).toHaveAttribute("aria-checked", "true");
  });
});
