import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LucideIcon, LucideProps } from "lucide-react";
import { IconButton } from "./IconButton";

const TestIcon = function TestIcon({ size, strokeWidth, ...props }: LucideProps) {
  return (
    <svg {...props} data-testid="test-icon" height={size} strokeWidth={strokeWidth} width={size} />
  );
} as LucideIcon;

describe("IconButton", () => {
  it("keeps icon-only shell actions named, titled, and outside drag regions", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton icon={TestIcon} label="Reset layout" onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Reset layout" });
    expect(button).toHaveAttribute("title", "Reset layout");
    expect(button).toHaveClass("shell-icon-button", "window-no-drag");
    expect(screen.getByTestId("test-icon")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("test-icon")).toHaveAttribute("width", "16");
    expect(screen.getByTestId("test-icon")).toHaveAttribute("stroke-width", "1.7");

    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("merges caller classes and forwards disclosure state", () => {
    render(
      <IconButton
        aria-controls="actions"
        aria-expanded="false"
        className="window-chrome__button"
        icon={TestIcon}
        label="More actions"
      />,
    );

    expect(screen.getByRole("button", { name: "More actions" })).toHaveClass(
      "shell-icon-button",
      "window-no-drag",
      "window-chrome__button",
    );
    expect(screen.getByRole("button", { name: "More actions" })).toHaveAttribute(
      "aria-controls",
      "actions",
    );
  });
});
