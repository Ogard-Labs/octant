import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkSettingsController } from "./useWorkSettings";
import { WorkSettingsView } from "./WorkSettingsView";

function controller(overrides: Partial<WorkSettingsController> = {}): WorkSettingsController {
  return {
    status: "ready",
    settings: {
      defaultAccess: "ask-first",
      version: 3 as never,
      updatedAt: "2026-09-25T12:00:00.000Z" as never,
    },
    message: undefined,
    busy: false,
    update: vi.fn(async () => true),
    ...overrides,
  };
}

describe("WorkSettingsView", () => {
  it("saves Accept edits as the default access and says what it allows", () => {
    const work = controller();
    const { rerender } = render(<WorkSettingsView controller={work} />);

    expect(screen.getByText(/asks before it runs a command or changes a file/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Accept edits" }));
    expect(work.update).toHaveBeenCalledWith({ defaultAccess: "auto-accept-edits" });

    rerender(
      <WorkSettingsView
        controller={controller({
          settings: {
            defaultAccess: "auto-accept-edits",
            version: 4 as never,
            updatedAt: "2026-09-25T12:01:00.000Z" as never,
          },
        })}
      />,
    );
    expect(screen.getByText(/Anything outside the folder is still refused/)).toBeVisible();
  });

  it("offers Auto and Full access as the Work default, warning once before Full access", () => {
    localStorage.removeItem("octant.full-access-warned.machine");
    const work = controller();
    render(<WorkSettingsView controller={work} />);

    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(work.update).toHaveBeenCalledWith({ defaultAccess: "auto" });

    fireEvent.click(screen.getByRole("button", { name: "Full access" }));
    expect(work.update).not.toHaveBeenCalledWith({ defaultAccess: "full-access" });
    fireEvent.click(screen.getByRole("button", { name: "Use Full access" }));
    expect(work.update).toHaveBeenCalledWith({ defaultAccess: "full-access" });
  });

  it("says so while the host has not answered, instead of showing controls that cannot save", () => {
    render(<WorkSettingsView controller={controller({ settings: undefined })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Work settings");
    expect(screen.queryByRole("group", { name: "Default Work access" })).toBeNull();
  });
});
