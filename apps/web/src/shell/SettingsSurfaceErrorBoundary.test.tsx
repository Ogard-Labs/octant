import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsSurfaceErrorBoundary } from "./SettingsSurfaceErrorBoundary";

function FailedSettingsSurface(): never {
  throw new Error("Settings chunk failed");
}

describe("SettingsSurfaceErrorBoundary", () => {
  it("keeps a failed Settings chunk inside an actionable shell state", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      render(
        <SettingsSurfaceErrorBoundary onReload={onReload}>
          <FailedSettingsSurface />
        </SettingsSurfaceErrorBoundary>,
      );

      expect(screen.getByRole("alert")).toHaveTextContent("Settings unavailable");
      await user.click(screen.getByRole("button", { name: "Reload Octant" }));
      expect(onReload).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});
