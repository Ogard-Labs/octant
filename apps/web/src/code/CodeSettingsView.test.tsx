import { fireEvent, render, screen } from "@testing-library/react";
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
  it("refreshes saved defaults without replacing an unfinished editor field", () => {
    const onUpdate = vi.fn(async () => true);
    const { rerender } = render(
      <CodeSettingsView onUpdate={onUpdate} settings={settings as never} />,
    );
    const field = screen.getByRole("textbox", { name: "External editor executable" });
    field.focus();
    fireEvent.change(field, { target: { value: "/unfinished" } });
    rerender(
      <CodeSettingsView
        onUpdate={onUpdate}
        settings={{ ...settings, version: 2, defaultExecutionPolicy: "plan" } as never}
      />,
    );
    expect(screen.getByRole("textbox", { name: "External editor executable" })).toBe(field);
    expect(field).toHaveValue("/unfinished");
    expect(field).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "Default Code access" })).toHaveTextContent("Plan");
  });

  it("keeps a chosen default the moment it is chosen, with no Save step", async () => {
    const update = vi.fn(async () => true);
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    expect(screen.getByText(/Access defaults apply only to new Code threads/i)).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Default Code access" })).toHaveTextContent(
      "Ask for approvals",
    );
    expect(screen.getByRole("button", { name: "Session" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /Save/i })).toBeNull();

    const user = userEvent.setup();
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Default Code access" }),
      "Plan · read-only",
    );

    expect(update).toHaveBeenCalledWith({
      defaultExecutionPolicy: "plan",
      defaultPermissionPersistence: "current-session",
      defaultDiffLayout: "unified",
    });
  });

  it("lets one Git requirement switch decide plain folders and threads without a Project", async () => {
    const update = vi.fn(async () => true);
    render(
      <CodeSettingsView
        onUpdate={update}
        settings={{ ...settings, requireGitRepository: true } as never}
      />,
    );

    const requirement = screen.getByRole("switch", { name: "Code needs a Git repository" });
    expect(requirement).toBeChecked();
    expect(screen.getByText(/the default folder included/)).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Threads without a Project" })).toBeNull();

    await userEvent.setup().click(requirement);

    expect(update).toHaveBeenCalledWith({
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      requireGitRepository: false,
      defaultDiffLayout: "unified",
    });
  });

  it("keeps an external editor path once the field is finished, not mid-keystroke", async () => {
    const update = vi.fn(async () => true);
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "External editor executable" }),
      "/usr/local/bin/code",
    );
    // A path is not valid halfway through typing it, so nothing is written
    // until the field is left.
    expect(update).not.toHaveBeenCalled();

    await user.click(screen.getByRole("textbox", { name: "External editor arguments" }));
    await user.paste("--goto\n{file}:{line}:{column}");
    await user.tab();

    expect(update).toHaveBeenLastCalledWith({
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      defaultDiffLayout: "unified",
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
    expect(screen.getByRole("heading", { name: "Editor" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "External editor" })).toBeVisible();
    expect(container.querySelector(".code-settings [data-slot='card']")).toBeNull();
    expect(container.querySelectorAll(".code-settings .settings-card-section--open")).toHaveLength(
      3,
    );
    // The four-way access choice is a select like the Agents posture; only
    // the two-way persistence choice stays segmented.
    expect(screen.getByRole("combobox", { name: "Default Code access" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Default approval persistence" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Default diff layout" })).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "External editor executable" }).closest(".setrow"),
    ).not.toBeNull();
  });

  it("marks the default diff layout row when Settings search lands on it", () => {
    render(
      <CodeSettingsView
        focusedSetting="code-default-diff-layout"
        onUpdate={async () => true}
        settings={settings as never}
      />,
    );

    expect(screen.getByRole("group", { name: "Default diff layout setting" })).toHaveAttribute(
      "data-focused",
      "true",
    );
  });

  it("keeps a default diff layout the moment it is chosen, with no Save step", async () => {
    const update = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    expect(screen.getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Side by side" }));
    expect(update).toHaveBeenCalledWith({
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      defaultDiffLayout: "side-by-side",
    });
  });

  it("shows the bundled language server on until a person turns it off, and keeps that choice", async () => {
    const update = vi.fn(async () => true);
    const { rerender } = render(
      <CodeSettingsView onUpdate={update} settings={settings as never} />,
    );

    const services = screen.getByRole("switch", { name: "Language services" });
    expect(services).toBeChecked();
    expect(
      screen.getByText(/cannot write, run other programs, or reach the network/),
    ).toBeVisible();

    await userEvent.setup().click(services);
    expect(update).toHaveBeenLastCalledWith({
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      defaultDiffLayout: "unified",
      bundledLanguageServer: false,
    });

    rerender(
      <CodeSettingsView
        onUpdate={update}
        settings={{ ...settings, version: 2, bundledLanguageServer: false } as never}
      />,
    );
    expect(screen.getByRole("switch", { name: "Language services" })).not.toBeChecked();
  });

  it("shows the host's choice again when it refuses a switch or pick, and keeps typed text", async () => {
    const update = vi.fn(async () => false);
    const user = userEvent.setup();
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    const services = screen.getByRole("switch", { name: "Language services" });
    await user.click(services);
    expect(await screen.findByText("Code defaults could not be saved.")).toBeVisible();
    expect(services).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");

    const field = screen.getByRole("textbox", { name: "External editor executable" });
    await user.type(field, "/opt/editor");
    fireEvent.blur(field);
    expect(await screen.findByText("Code defaults could not be saved.")).toBeVisible();
    expect(field).toHaveValue("/opt/editor");
  });
});
