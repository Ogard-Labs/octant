import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BottomUtilityPanel } from "./BottomUtilityPanel";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";

function surface(id: "browser" | "terminal") {
  const found = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
  return found;
}

const terminal = surface("terminal");
const browser = surface("browser");

describe("BottomUtilityPanel", () => {
  it("hosts the active thread Terminal and closes from a visible control", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenTool = vi.fn();
    render(
      <BottomUtilityPanel
        activeSurface={terminal}
        height={260}
        launchableSurfaces={[terminal, browser]}
        onClose={onClose}
        onCommitHeight={vi.fn()}
        onOpenTool={onOpenTool}
        onPreviewHeight={vi.fn()}
        content={<p>Live Terminal</p>}
      />,
    );

    expect(screen.getByRole("region", { name: "Bottom panel" })).toHaveStyle(
      "--octant-bottom-panel-height: 260px",
    );
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Live Terminal")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add tool" }));
    await user.click(screen.getByRole("button", { name: "Browser" }));
    expect(onOpenTool).toHaveBeenCalledWith("browser");
    await user.click(screen.getByRole("button", { name: "Hide bottom panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
