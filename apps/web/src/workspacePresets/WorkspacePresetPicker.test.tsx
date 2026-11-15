import { decodeWorkspacePreset } from "@octant/contracts/workspace-presets";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePresetPicker } from "./WorkspacePresetPicker";

const designStudio = decodeWorkspacePreset({
  id: "design-studio",
  displayName: "Design studio",
  summary: "A browser, an overview and a side chat for design work.",
  mode: "code",
  panes: ["code-overview", "browser", "side-chat"],
  defaultSkills: [],
});

function picker() {
  const onApply = vi.fn();
  render(
    <WorkspacePresetPicker busy={false} onApply={onApply} presets={[designStudio]} skills={[]} />,
  );
  return { onApply };
}

describe("choosing a workspace preset", () => {
  it("names each pane it opens in words, with the tool's glyph", () => {
    picker();

    const entry = screen.getByRole("listitem");
    expect(within(entry).getByText("Overview")).toBeInTheDocument();
    expect(within(entry).getByText("Browser")).toBeInTheDocument();
    expect(within(entry).getByText("Side chat")).toBeInTheDocument();
    expect(entry).not.toHaveTextContent("code-overview");
    expect(entry.querySelector(".octant-icon-globe")).not.toBeNull();
  });

  it("applies the preset from a primary action", async () => {
    const user = userEvent.setup();
    const { onApply } = picker();

    const apply = screen.getByRole("button", { name: "Apply Design studio" });
    expect(apply).toHaveAttribute("data-variant", "default");
    await user.click(apply);

    expect(onApply).toHaveBeenCalledWith(designStudio);
  });
});
