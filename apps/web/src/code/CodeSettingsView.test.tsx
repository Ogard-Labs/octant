import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { CodeSettingsView, type CodeSettingsUpdate } from "./CodeSettingsView";

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
    expect(screen.getByRole("combobox", { name: "Default mode" })).toHaveTextContent("Plan");
  });

  it("saves Starting workers and the open-worker bound from Settings › Code › Coordinators", async () => {
    const update = vi.fn(async (_input: CodeSettingsUpdate) => true);
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);
    const user = userEvent.setup();

    const starting = screen.getByRole("combobox", { name: "Starting workers" });
    expect(starting).toHaveTextContent("Start without asking");
    await chooseSelectFieldOption(user, starting, "Propose for approval");
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ coordinatorStarting: "propose-for-approval" }),
    );

    const limit = screen.getByRole("combobox", { name: "Open workers per coordinator" });
    expect(limit).toHaveTextContent("6");
    await chooseSelectFieldOption(user, limit, "10");
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ coordinatorOpenWorkerLimit: 10 }),
    );
    // A later change carries only what it changed; the host keeps the rest.
    expect(update.mock.lastCall?.[0]).not.toHaveProperty("coordinatorStarting");
  });

  it("returns Starting workers to the stored choice when the host refuses it", async () => {
    const update = vi.fn(async () => false);
    render(
      <CodeSettingsView
        onUpdate={update}
        settings={{ ...settings, coordinatorStarting: "propose-for-approval" } as never}
      />,
    );
    const user = userEvent.setup();
    const starting = screen.getByRole("combobox", { name: "Starting workers" });
    await chooseSelectFieldOption(user, starting, "Start without asking");

    expect(starting).toHaveTextContent("Propose for approval");
    expect(
      within(screen.getByRole("region", { name: "Coordinators" })).getByText(
        "Code defaults could not be saved.",
      ),
    ).toBeVisible();
  });

  it("keeps a chosen default mode the moment it is chosen, with no Save step", async () => {
    const update = vi.fn(async () => true);
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    expect(screen.getByRole("combobox", { name: "Default mode" })).toHaveTextContent("Ask first");
    expect(screen.queryByRole("button", { name: /Save/i })).toBeNull();

    const user = userEvent.setup();
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Default mode" }),
      "Auto · Recommended",
    );

    expect(update).toHaveBeenCalledWith({
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      defaultAutoApprove: true,
      defaultDiffLayout: "unified",
    });
  });

  it("warns once before this machine's first Full access default, and has no Off switch", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
    try {
      const update = vi.fn(async () => true);
      const user = userEvent.setup();
      const { unmount } = render(
        <CodeSettingsView onUpdate={update} settings={settings as never} />,
      );
      // The retired switch turned Full access's sandbox off. The only sandbox
      // switch now is the opt-in that keeps one, and it starts off.
      expect(screen.queryByRole("switch", { name: /sandbox off|no sandbox/i })).toBeNull();
      expect(
        screen.getByRole("switch", { name: "Keep the sandbox at Full access" }),
      ).not.toBeChecked();

      await chooseSelectFieldOption(
        user,
        screen.getByRole("combobox", { name: "Default mode" }),
        "Full access",
      );
      expect(update).not.toHaveBeenCalled();
      const warning = await screen.findByRole("dialog", { name: "Use Full access?" });
      expect(warning).toHaveTextContent(
        "Agents can change any file and run any command without asking, with no sandbox. Protected files, such as SSH and cloud keys, are guarded by Octant's own tools and redaction only, and a shell command can read them.",
      );
      await user.click(screen.getByRole("button", { name: "Use Full access" }));
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({ defaultExecutionPolicy: "full-access" }),
      );
      unmount();

      // The second pick on this machine goes straight through.
      const again = vi.fn(async () => true);
      render(<CodeSettingsView onUpdate={again} settings={settings as never} />);
      await chooseSelectFieldOption(
        user,
        screen.getByRole("combobox", { name: "Default mode" }),
        "Full access",
      );
      expect(screen.queryByRole("dialog", { name: "Use Full access?" })).toBeNull();
      expect(again).toHaveBeenCalledWith(
        expect.objectContaining({ defaultExecutionPolicy: "full-access" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
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

    expect(screen.getByRole("heading", { name: "Access" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Thread defaults" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Coordinators" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Editor" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "External editor" })).toBeVisible();
    expect(container.querySelector(".code-settings [data-slot='card']")).toBeNull();
    expect(container.querySelectorAll(".code-settings .settings-card-section--open")).toHaveLength(
      5,
    );
    // The five-way mode choice is a select like the Agents posture.
    expect(screen.getByRole("combobox", { name: "Default mode" })).toBeVisible();
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

  it("shows Continue after restart on until a person turns it off, and sends only that change", async () => {
    const update = vi.fn(async () => true);
    const { rerender } = render(
      <CodeSettingsView onUpdate={update} settings={settings as never} />,
    );

    const restart = screen.getByRole("switch", { name: "Continue after restart" });
    expect(restart).toBeChecked();

    await userEvent.setup().click(restart);
    expect(update).toHaveBeenLastCalledWith({
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      defaultDiffLayout: "unified",
      restartContinuation: false,
    });

    rerender(
      <CodeSettingsView
        onUpdate={update}
        settings={{ ...settings, version: 2, restartContinuation: false } as never}
      />,
    );
    expect(screen.getByRole("switch", { name: "Continue after restart" })).not.toBeChecked();
  });

  it("shows the host's choice again when it refuses a switch or pick, and keeps typed text", async () => {
    const update = vi.fn(async () => false);
    const user = userEvent.setup();
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    const editorSection = screen.getByRole("region", { name: "Editor" });
    const externalSection = screen.getByRole("region", { name: "External editor" });
    const threadSection = screen.getByRole("region", { name: "Thread defaults" });
    const services = screen.getByRole("switch", { name: "Language services" });
    await user.click(services);
    // The refusal is said beside the switch that asked, not two sections down.
    expect(
      await within(editorSection).findByText("Code defaults could not be saved."),
    ).toBeVisible();
    expect(within(externalSection).queryByText("Code defaults could not be saved.")).toBeNull();
    expect(services).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");
    expect(within(threadSection).getByText("Code defaults could not be saved.")).toBeVisible();
    expect(screen.getAllByText("Code defaults could not be saved.")).toHaveLength(1);

    const field = screen.getByRole("textbox", { name: "External editor executable" });
    await user.type(field, "/opt/editor");
    fireEvent.blur(field);
    expect(
      await within(externalSection).findByText("Code defaults could not be saved."),
    ).toBeVisible();
    expect(screen.getAllByText("Code defaults could not be saved.")).toHaveLength(1);
    expect(field).toHaveValue("/opt/editor");
  });

  it("shows what the host holds when a quick second change is refused after the first was saved", async () => {
    let saveFirst: (saved: boolean) => void = () => undefined;
    let refuseSecond: (saved: boolean) => void = () => undefined;
    const update = vi
      .fn<(input: unknown) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise((resolve) => (saveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (refuseSecond = resolve)));
    const user = userEvent.setup();
    const { rerender } = render(
      <CodeSettingsView onUpdate={update} settings={settings as never} />,
    );

    const services = screen.getByRole("switch", { name: "Language services" });
    await user.click(services);
    await user.click(services);
    // The host saved the first change and refused the second as stale; the
    // reloaded settings arrive before the refusal does.
    rerender(
      <CodeSettingsView
        onUpdate={update}
        settings={{ ...settings, version: 2, bundledLanguageServer: false } as never}
      />,
    );
    await act(async () => saveFirst(true));
    await act(async () => refuseSecond(false));

    expect(await screen.findByText("Code defaults could not be saved.")).toBeVisible();
    expect(services).not.toBeChecked();
  });

  it("puts a switch back when an unfinished editor path keeps the change from being sent", async () => {
    const update = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);

    const field = screen.getByRole("textbox", { name: "External editor executable" });
    await user.type(field, "editor");
    fireEvent.blur(field);
    await user.click(screen.getByRole("switch", { name: "Language services" }));

    expect(update).not.toHaveBeenCalled();
    // Said at the field that needs finishing, not beside the switch that
    // happened to send the change.
    expect(
      within(screen.getByRole("region", { name: "External editor" })).getByText(
        "External editor executable must be an absolute path.",
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText("External editor executable must be an absolute path."),
    ).toHaveLength(1);
    expect(screen.getByRole("switch", { name: "Language services" })).toBeChecked();
    expect(field).toHaveValue("editor");
  });
});
