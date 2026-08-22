import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BottomUtilityPanel } from "./BottomUtilityPanel";

describe("BottomUtilityPanel", () => {
  it("hosts the active thread Terminal and closes from a visible control", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <BottomUtilityPanel
        height={260}
        onClose={onClose}
        onCommitHeight={vi.fn()}
        onPreviewHeight={vi.fn()}
        terminal={<p>Live Terminal</p>}
      />,
    );

    expect(screen.getByRole("region", { name: "Bottom panel" })).toHaveStyle(
      "--octant-bottom-panel-height: 260px",
    );
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Live Terminal")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide bottom panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
