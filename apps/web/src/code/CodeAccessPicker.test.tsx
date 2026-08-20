import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeAccessPicker } from "./CodeAccessPicker";

describe("CodeAccessPicker", () => {
  it("shows the posture the next turn will use and offers only what the thread grants", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <CodeAccessPicker ceiling="approval-gated" onSelect={onSelect} value="approval-gated" />,
    );

    expect(screen.getByRole("combobox", { name: "Next turn access" })).toHaveTextContent(
      "Ask for approvals",
    );
    await user.click(screen.getByRole("combobox", { name: "Next turn access" }));
    expect(await screen.findByRole("option", { name: "Plan · read-only" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Ask for approvals" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Auto-accept edits" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Full access" })).not.toBeInTheDocument();
  });

  it("lets a full-access thread pick auto-accept edits for the next turn", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CodeAccessPicker ceiling="full-access" onSelect={onSelect} value="full-access" />);

    await user.click(screen.getByRole("combobox", { name: "Next turn access" }));
    await user.click(await screen.findByRole("option", { name: "Auto-accept edits" }));
    expect(onSelect).toHaveBeenCalledWith("auto-accept-edits");
  });

  it("locks Plan mode so the composer cannot override it", () => {
    render(<CodeAccessPicker ceiling="plan" onSelect={vi.fn()} value="plan" />);

    const picker = screen.getByRole("combobox", { name: "Next turn access" });
    expect(picker).toHaveTextContent("Plan · read-only");
    expect(picker).toBeDisabled();
  });
});
