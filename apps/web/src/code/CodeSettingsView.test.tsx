import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
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
    expect(screen.getByRole("combobox", { name: "Default Code access" })).toHaveTextContent(
      "Approval",
    );
    expect(screen.getByRole("button", { name: "Session" })).toHaveAttribute("aria-pressed", "true");

    const user = userEvent.setup();
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Default Code access" }),
      "Plan",
    );
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

  it("presents routine defaults as open sections rather than one raised settings card", () => {
    const { container } = render(
      <CodeSettingsView onUpdate={async () => true} settings={settings as never} />,
    );

    expect(screen.getByRole("heading", { name: "Thread defaults" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "External editor" })).toBeVisible();
    expect(container.querySelector(".code-settings [data-slot='card']")).toBeNull();
    expect(container.querySelectorAll(".code-settings .settings-card-section--open")).toHaveLength(
      2,
    );
    // The four-way access choice is a select like the Agents posture; only
    // the two-way persistence choice stays segmented.
    expect(screen.getByRole("combobox", { name: "Default Code access" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Default approval persistence" })).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "External editor executable" }).closest(".setrow"),
    ).not.toBeNull();
  });
});
