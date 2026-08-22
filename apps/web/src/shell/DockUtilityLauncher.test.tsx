import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockUtilityLauncher } from "./DockUtilityLauncher";

describe("right sidebar tool launcher", () => {
  it("opens available tools and restores focus to the trigger", () => {
    const onOpen = vi.fn();
    render(
      <DockUtilityLauncher
        onOpen={onOpen}
        surfaces={[
          { id: "browser", label: "Browser" },
          { id: "terminal", label: "Terminal" },
          { id: "ios-simulator", label: "iOS Simulator" },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Add tool" });
    fireEvent.click(trigger);
    expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "",
      "Browser",
      "Terminal",
      "iOS Simulator",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "iOS Simulator" }));
    expect(onOpen).toHaveBeenCalledWith("ios-simulator");
    expect(trigger).toHaveFocus();
  });

  it("omits Add tool when no tools remain to open", () => {
    render(<DockUtilityLauncher onOpen={vi.fn()} surfaces={[]} />);
    expect(screen.queryByRole("button", { name: "Add tool" })).not.toBeInTheDocument();
  });
});
