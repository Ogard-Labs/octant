import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkSettingsController } from "./useWorkSettings";
import { WorkSettingsView } from "./WorkSettingsView";

function controller(overrides: Partial<WorkSettingsController> = {}): WorkSettingsController {
  return {
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
  it("saves Auto-accept edits as the default access and says what it allows", () => {
    const work = controller();
    const { rerender } = render(<WorkSettingsView controller={work} />);

    expect(screen.getByText(/asks before it changes any file/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Auto-accept edits" }));
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

  it("says so while the host has not answered, instead of showing controls that cannot save", () => {
    render(<WorkSettingsView controller={controller({ settings: undefined })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Work settings");
    expect(screen.queryByRole("group", { name: "Default Work access" })).toBeNull();
  });
});
