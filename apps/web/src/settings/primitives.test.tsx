import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScopeIndicator, scopeLabel, SettingGroup, SettingRow } from "./primitives";

describe("scopeLabel", () => {
  it("maps each scope to a human label", () => {
    expect(scopeLabel("app")).toBe("This app");
    expect(scopeLabel("host")).toBe("Selected host");
    expect(scopeLabel("mode")).toBe("Mode");
    expect(scopeLabel("project")).toBe("Project");
    expect(scopeLabel("thread")).toBe("Thread");
  });
});

describe("ScopeIndicator", () => {
  it("renders the scope label with an accessible name", () => {
    render(<ScopeIndicator scope="app" />);
    const badge = screen.getByText("This app");
    expect(badge).toHaveAttribute("aria-label", "Scope: This app");
  });

  it("renders the host scope without exposing unsafe host details", () => {
    render(<ScopeIndicator scope="host" />);
    expect(screen.getByText("Selected host")).toBeInTheDocument();
    // No host id, name, or address is rendered.
    expect(screen.queryByText(/host-|localhost|127\./i)).not.toBeInTheDocument();
  });
});

describe("SettingRow", () => {
  it("renders the label, description, scope indicator, and control", () => {
    render(
      <SettingRow
        settingId="sidebar-width"
        label="Sidebar width"
        description="Width of the left sidebar in pixels."
        scope="app"
      >
        <input aria-label="Sidebar width" type="range" />
      </SettingRow>,
    );

    expect(screen.getByText("Sidebar width")).toBeInTheDocument();
    expect(screen.getByText("Width of the left sidebar in pixels.")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Sidebar width" })).toBeInTheDocument();
    expect(screen.getByText("This app")).toBeInTheDocument();
  });

  it("anchors the row by setting id so deep links can target it", () => {
    render(
      <SettingRow settingId="sidebar-width" label="Sidebar width" scope="app">
        <input aria-label="Sidebar width" type="range" />
      </SettingRow>,
    );
    const row = screen.getByText("Sidebar width").closest("[data-setting-id]");
    expect(row).toHaveAttribute("data-setting-id", "sidebar-width");
  });

  it("marks the focused row and focuses the first focusable control", () => {
    render(
      <SettingRow settingId="sidebar-width" label="Sidebar width" scope="app" focused>
        <input aria-label="Sidebar width" type="range" />
      </SettingRow>,
    );
    const row = screen.getByText("Sidebar width").closest("[data-setting-id]");
    expect(row).toHaveAttribute("data-focused", "true");
    expect(screen.getByRole("slider", { name: "Sidebar width" })).toHaveFocus();
  });

  it("does not steal focus when not focused", () => {
    render(
      <SettingRow settingId="sidebar-width" label="Sidebar width" scope="app">
        <input aria-label="Sidebar width" type="range" />
      </SettingRow>,
    );
    const row = screen.getByText("Sidebar width").closest("[data-setting-id]");
    expect(row).toHaveAttribute("data-focused", "false");
    expect(screen.getByRole("slider", { name: "Sidebar width" })).not.toHaveFocus();
  });

  it("forwards onChange of an embedded switch through the control slot", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SettingRow settingId="enable-chat" label="Enable Chat" scope="app">
        <button aria-checked={false} role="switch" type="button" onClick={onChange}>
          Enable Chat
        </button>
      </SettingRow>,
    );
    await user.click(screen.getByRole("switch", { name: "Enable Chat" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("SettingGroup", () => {
  it("renders a labelled group of rows", () => {
    render(
      <SettingGroup label="Appearance" description="Visual workspace preferences.">
        <SettingRow settingId="sidebar-width" label="Sidebar width" scope="app">
          <input aria-label="Sidebar width" type="range" />
        </SettingRow>
      </SettingGroup>,
    );
    const group = screen.getByRole("group", { name: "Appearance" });
    expect(group).toBeInTheDocument();
    expect(screen.getByText("Visual workspace preferences.")).toBeInTheDocument();
    expect(within(group).getByRole("slider", { name: "Sidebar width" })).toBeInTheDocument();
  });
});
