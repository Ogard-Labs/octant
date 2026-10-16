import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { FirstRunProjectStep } from "./FirstRunProjectStep";
import type { FirstRunTaskMode } from "./firstRunHandoffModel";

function Step(props: { readonly initial: FirstRunTaskMode }) {
  const [mode, setMode] = useState<FirstRunTaskMode>(props.initial);
  return (
    <FirstRunProjectStep
      mode={mode}
      onChooseFolder={() => {}}
      onSelectMode={setMode}
      onSelectProject={() => {}}
      projects={[]}
      selectedProjectId={undefined}
      workEnabled
    />
  );
}

describe("FirstRunProjectStep mode choice", () => {
  it("wraps from the last mode to the first and selects the one it lands on", async () => {
    const user = userEvent.setup();
    render(<Step initial="code" />);
    screen.getByRole("radio", { name: "Code" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Work" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Code" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Code" })).toBeChecked();
  });

  it("jumps to the first and last mode with Home and End", async () => {
    const user = userEvent.setup();
    render(<Step initial="code" />);
    screen.getByRole("radio", { name: "Code" }).focus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Code" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Code" })).toHaveFocus();
  });
});
