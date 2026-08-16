import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeSettingsView } from "./CodeSettingsView";

const settings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  version: 1,
  updatedAt: "2026-07-21T12:00:00.000Z",
} as const;

describe("CodeSettingsView", () => {
  it("saves defaults for new threads without implying existing-thread mutation", async () => {
    const update = vi.fn(async () => true);
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    expect(screen.getByText(/apply only to new Code threads/i)).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Default Code access" })).toHaveValue(
      "approval-gated",
    );
    expect(screen.getByRole("combobox", { name: "Default approval persistence" })).toHaveValue(
      "current-session",
    );

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Default Code access" }), "plan");
    await user.type(
      screen.getByRole("textbox", { name: "External editor executable" }),
      "/usr/local/bin/code",
    );
    await user.click(screen.getByRole("textbox", { name: "External editor arguments" }));
    await user.paste("--goto\n{file}:{line}:{column}");
    await user.click(screen.getByRole("button", { name: "Save Code defaults" }));

    expect(update).toHaveBeenCalledWith({
      defaultExecutionPolicy: "plan",
      defaultPermissionPersistence: "current-session",
      externalEditor: {
        executable: "/usr/local/bin/code",
        arguments: ["--goto", "{file}:{line}:{column}"],
      },
    });
  });
});
