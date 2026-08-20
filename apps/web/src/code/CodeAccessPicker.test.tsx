import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeAccessPicker } from "./CodeAccessPicker";

describe("CodeAccessPicker", () => {
  it("shows the posture the next turn will use and offers a path to raise the thread", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRaiseThread = vi.fn();
    render(
      <CodeAccessPicker
        ceiling="approval-gated"
        nativeConfirmationAvailable
        onRaiseThread={onRaiseThread}
        onSelect={onSelect}
        value="approval-gated"
      />,
    );

    expect(screen.getByRole("combobox", { name: "Next turn access" })).toHaveTextContent(
      "Ask for approvals",
    );
    await user.click(screen.getByRole("combobox", { name: "Next turn access" }));
    expect(await screen.findByRole("option", { name: "Plan · read-only" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Ask for approvals" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Raise thread · Auto-accept edits" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Raise thread · Full access" })).toBeVisible();
  });

  it("lets a full-access thread pick auto-accept edits for the next turn", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <CodeAccessPicker
        ceiling="full-access"
        nativeConfirmationAvailable
        onRaiseThread={vi.fn()}
        onSelect={onSelect}
        value="full-access"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Next turn access" }));
    await user.click(await screen.findByRole("option", { name: "Auto-accept edits" }));
    expect(onSelect).toHaveBeenCalledWith("auto-accept-edits");
  });

  it("raises the thread grant instead of trapping an approval-gated thread", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRaiseThread = vi.fn();
    render(
      <CodeAccessPicker
        ceiling="approval-gated"
        nativeConfirmationAvailable
        onRaiseThread={onRaiseThread}
        onSelect={onSelect}
        value="approval-gated"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Next turn access" }));
    await user.click(await screen.findByRole("option", { name: "Raise thread · Full access" }));
    expect(onRaiseThread).toHaveBeenCalledWith("full-access");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lets a Plan thread raise its grant even though one-shot writes stay impossible", async () => {
    const user = userEvent.setup();
    const onRaiseThread = vi.fn();
    render(
      <CodeAccessPicker
        ceiling="plan"
        nativeConfirmationAvailable
        onRaiseThread={onRaiseThread}
        onSelect={vi.fn()}
        value="plan"
      />,
    );

    const picker = screen.getByRole("combobox", { name: "Next turn access" });
    expect(picker).toHaveTextContent("Plan · read-only");
    expect(picker).toBeEnabled();
    await user.click(picker);
    await user.click(
      await screen.findByRole("option", { name: "Raise thread · Ask for approvals" }),
    );
    expect(onRaiseThread).toHaveBeenCalledWith("approval-gated");
  });

  it("offers Full access as unavailable when the host cannot confirm it", async () => {
    const user = userEvent.setup();
    render(
      <CodeAccessPicker
        ceiling="approval-gated"
        nativeConfirmationAvailable={false}
        onRaiseThread={vi.fn()}
        onSelect={vi.fn()}
        value="approval-gated"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Next turn access" }));
    expect(
      await screen.findByRole("option", { name: "Raise thread · Full access" }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});
