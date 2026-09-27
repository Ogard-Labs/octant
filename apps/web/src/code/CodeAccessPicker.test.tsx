import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeAccessPicker } from "./CodeAccessPicker";

describe("CodeAccessPicker", () => {
  it("keeps provider approval review inside the access menu and reports its current state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CodeAccessPicker
        autoApprove={{ checked: false, onChange }}
        ceiling="approval-gated"
        nativeConfirmationAvailable
        onLowerThread={vi.fn()}
        onRaiseThread={vi.fn()}
        onSelect={vi.fn()}
        value="approval-gated"
      />,
    );

    expect(screen.queryByText("Approve for me")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    const review = await screen.findByRole("menuitemcheckbox", { name: "Approve for me" });
    expect(review).toHaveAttribute("aria-checked", "false");
    await user.click(review);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows the posture the next turn will use and offers a path to raise the thread", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRaiseThread = vi.fn();
    render(
      <CodeAccessPicker
        ceiling="approval-gated"
        nativeConfirmationAvailable
        onLowerThread={vi.fn()}
        onRaiseThread={onRaiseThread}
        onSelect={onSelect}
        value="approval-gated"
      />,
    );

    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Ask");
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(await screen.findByRole("menuitemradio", { name: "Plan · read-only" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Ask for approvals" })).toBeVisible();
    expect(
      screen.getByRole("menuitemradio", { name: "Raise thread · Auto-accept edits" }),
    ).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Raise thread · Full access" })).toBeVisible();
  });

  it("shows enabled provider review on the closed control only where the posture supports it", async () => {
    const user = userEvent.setup();
    const props = {
      autoApprove: { checked: true, onChange: vi.fn() },
      ceiling: "full-access" as const,
      nativeConfirmationAvailable: true,
      onLowerThread: vi.fn(),
      onRaiseThread: vi.fn(),
      onSelect: vi.fn(),
    };
    const { rerender } = render(<CodeAccessPicker {...props} value="approval-gated" />);
    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent(
      "Approve for me",
    );

    rerender(<CodeAccessPicker {...props} value="plan" />);
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Plan");
    expect(props.autoApprove.onChange).not.toHaveBeenCalled();
  });

  it("lets a full-access thread pick auto-accept edits for the next turn", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <CodeAccessPicker
        ceiling="full-access"
        nativeConfirmationAvailable
        onLowerThread={vi.fn()}
        onRaiseThread={vi.fn()}
        onSelect={onSelect}
        value="full-access"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Auto-accept edits" }));
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
        onLowerThread={vi.fn()}
        onRaiseThread={onRaiseThread}
        onSelect={onSelect}
        value="approval-gated"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    );
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
        onLowerThread={vi.fn()}
        onRaiseThread={onRaiseThread}
        onSelect={vi.fn()}
        value="plan"
      />,
    );

    const picker = screen.getByRole("button", { name: "Next turn access" });
    expect(picker).toHaveTextContent("Plan");
    expect(picker).toBeEnabled();
    await user.click(picker);
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Ask for approvals" }),
    );
    expect(onRaiseThread).toHaveBeenCalledWith("approval-gated");
  });

  it("offers Full access as unavailable when the host cannot confirm it", async () => {
    const user = userEvent.setup();
    render(
      <CodeAccessPicker
        ceiling="approval-gated"
        nativeConfirmationAvailable={false}
        onLowerThread={vi.fn()}
        onRaiseThread={vi.fn()}
        onSelect={vi.fn()}
        value="approval-gated"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("offers to lower a Full access thread back to Ask for approvals", async () => {
    const user = userEvent.setup();
    const onLowerThread = vi.fn();
    const onSelect = vi.fn();
    const onRaiseThread = vi.fn();
    render(
      <CodeAccessPicker
        ceiling="full-access"
        nativeConfirmationAvailable
        onLowerThread={onLowerThread}
        onRaiseThread={onRaiseThread}
        onSelect={onSelect}
        value="full-access"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Lower thread · Ask for approvals" }),
    );
    expect(onLowerThread).toHaveBeenCalledWith("approval-gated");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRaiseThread).not.toHaveBeenCalled();
  });

  it("does not offer to lower an approval-gated or Plan thread", async () => {
    const user = userEvent.setup();
    const props = {
      nativeConfirmationAvailable: true,
      onLowerThread: vi.fn(),
      onRaiseThread: vi.fn(),
      onSelect: vi.fn(),
    };
    const { rerender } = render(
      <CodeAccessPicker {...props} ceiling="approval-gated" value="approval-gated" />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(
      screen.queryByRole("menuitem", { name: "Lower thread · Ask for approvals" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next turn access" }));

    rerender(<CodeAccessPicker {...props} ceiling="plan" value="plan" />);
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(
      screen.queryByRole("menuitem", { name: "Lower thread · Ask for approvals" }),
    ).not.toBeInTheDocument();
  });
});
