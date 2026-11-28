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

  it("does not select all text when refocusing a nested custom-answer field", async () => {
    const user = userEvent.setup();
    function TextareaGroup() {
      const [value, setValue] = useState("custom");
      const [text, setText] = useState("Use the existing project");
      return (
        <div>
          <OctantRadioGroup aria-label="Decision" onValueChange={setValue} value={value}>
            <OctantRadioGroupItem value="a">Option A</OctantRadioGroupItem>
            <OctantRadioGroupItem value="custom">Write another answer</OctantRadioGroupItem>
            <textarea
              aria-label="Your answer"
              onChange={(event) => setText(event.target.value)}
              value={text}
            />
          </OctantRadioGroup>
          <button type="button">Note</button>
        </div>
      );
    }

    render(<TextareaGroup />);

    const textarea = screen.getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement;
    const note = screen.getByRole("button", { name: "Note" });

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    note.focus();
    expect(note).toHaveFocus();

    // Refocusing the textarea fires RadioGroup's onFocus; Base UI's
    // CompositeRoot would otherwise select the entire value on focus.
    textarea.focus();
    expect(textarea).toHaveFocus();
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
    await user.keyboard(".");
    expect(textarea).toHaveValue("Use the existing project.");
  });

  it("selects a focused unchecked radio option on Enter without overriding caller key handling", async () => {
    const user = userEvent.setup();
    let blockedEnter = false;
    function UncheckedGroup() {
      const [value, setValue] = useState("");
      return (
        <OctantRadioGroup aria-label="Choices" onValueChange={setValue} value={value}>
          <OctantRadioGroupItem value="first">First</OctantRadioGroupItem>
          <OctantRadioGroupItem
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                blockedEnter = true;
              }
            }}
            value="second"
          >
            Second
          </OctantRadioGroupItem>
        </OctantRadioGroup>
      );
    }

    render(<UncheckedGroup />);
    const first = screen.getByRole("radio", { name: "First" });
    const second = screen.getByRole("radio", { name: "Second" });

    await user.tab();
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Enter}");
    expect(first).toHaveAttribute("aria-checked", "true");

    second.focus();
    await user.keyboard("{Enter}");
    expect(blockedEnter).toBe(true);
    expect(second).toHaveAttribute("aria-checked", "false");
  });
});
