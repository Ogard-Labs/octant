import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockUtilityLauncher } from "./DockUtilityLauncher";

describe("right sidebar utility launcher", () => {
  it("opens available utilities as sidebar tabs and restores focus to the trigger", () => {
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

    const trigger = screen.getByRole("button", { name: "Add utility tab" });
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
});
