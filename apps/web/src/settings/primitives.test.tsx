import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ScopeIndicator,
  scopeLabel,
  SettingGroup,
  SettingRow,
  SettingsCompactRow,
  SettingsDisclosure,
  SettingsFactList,
  SettingsOutlineRegistration,
  SettingsOutputWell,
  SettingsSkeletonRows,
  SettingsPanel,
  SettingsSection,
  SettingsState,
} from "./primitives";

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

  it("associates an explicit label with its control", () => {
    render(
      <SettingRow
        htmlFor="sidebar-width-control"
        settingId="sidebar-width"
        label="Sidebar width"
        scope="app"
      >
        <input id="sidebar-width-control" type="range" />
      </SettingRow>,
    );

    expect(screen.getByLabelText("Sidebar width")).toHaveAttribute("id", "sidebar-width-control");
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

  it("focuses the explanation when a deep-linked setting is disabled", () => {
    render(
      <SettingRow
        settingId="code-default-folder-threads"
        label="Threads without a Project"
        description="Turn off the Git requirement first."
        scope="mode"
        focused
      >
        <button disabled role="switch" aria-checked={false}>
          Threads without a Project
        </button>
      </SettingRow>,
    );
    const row = screen.getByTestId("setting-row");
    expect(row).toHaveFocus();
    expect(row).toHaveAccessibleName("Threads without a Project setting");
    expect(row).toHaveAccessibleDescription(/Turn off the Git requirement first/);
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

describe("a SettingRow that keeps the rest behind More", () => {
  function row() {
    return render(
      <SettingRow
        description="Keeps agents out of these files."
        label="Protected files"
        more={<p>A file here is refused at every access level, Full access included.</p>}
        scope="host"
        settingId="protected-files"
      >
        <button type="button">Add file</button>
      </SettingRow>,
    );
  }

  it("shows one sentence at rest and the rest once More is opened, and closes again", async () => {
    const user = userEvent.setup();
    row();
    const rest = screen.getByText(/refused at every access level/);
    expect(screen.getByText("Keeps agents out of these files.")).toBeVisible();
    expect(rest).not.toBeVisible();

    const more = screen.getByText("More").closest("summary")!;
    await user.click(more);
    expect(rest).toBeVisible();
    await user.click(more);
    expect(rest).not.toBeVisible();
  });

  it("is a native disclosure, which the keyboard and find-in-page open without script", () => {
    row();
    const more = screen.getByText("More").closest("summary")!;
    expect(more.parentElement?.tagName).toBe("DETAILS");
    more.focus();
    expect(more).toHaveFocus();
  });

  it("names the setting More is about, and keeps it out of the control's cell", () => {
    row();
    const more = screen.getByText("More").closest("summary")!;
    expect(more).toHaveAccessibleName("More about Protected files");
    // The control's cell holds the control alone: opening More adds a line
    // under the sentence and leaves the control where it was.
    const control = screen.getByRole("button", { name: "Add file" }).parentElement!;
    expect(control).toHaveClass("setrow-control");
    expect(control).not.toContainElement(more);
    expect(more.closest("details")?.parentElement).toBe(screen.getByTestId("setting-row"));
  });

  it("draws no More on a row that has nothing further to say", () => {
    render(
      <SettingRow description="One sentence." label="Plain" scope="app" settingId="plain">
        <button type="button">Go</button>
      </SettingRow>,
    );
    expect(screen.queryByText("More")).not.toBeInTheDocument();
  });
});

describe("a SettingRow that names its default", () => {
  function row(value: number) {
    return render(
      <SettingRow
        atDefault={value === 8}
        defaultValue="8"
        description="How many wake-ups may wait in one thread."
        label="Wake-ups waiting"
        scope="host"
        settingId="thread-wakeups-waiting"
      >
        <input aria-label="Wake-ups waiting" readOnly type="number" value={value} />
      </SettingRow>,
    );
  }

  it("names the default beside the control once the value differs from it", () => {
    row(12);
    const note = screen.getByText("Default 8");
    expect(note).toBeVisible();
    expect(note.parentElement).toHaveClass("setrow-control");
    expect(
      screen.getByRole("group", { name: "Wake-ups waiting setting" }),
    ).toHaveAccessibleDescription(/^How many wake-ups may wait in one thread\..*Default 8$/);
  });

  it("keeps the note's place while the value is the default, so a change moves nothing", () => {
    row(8);
    // Present and marked, not removed: the stylesheet hides it and keeps its
    // width, so the sentence does not rewrap when the value changes.
    expect(screen.getByText("Default 8")).toHaveAttribute("data-at-default", "true");
  });

  it("draws no note for a row that names no default", () => {
    render(
      <SettingRow description="One sentence." label="Plain" scope="app" settingId="plain">
        <button type="button">Go</button>
      </SettingRow>,
    );
    expect(document.querySelector(".setrow-default")).toBeNull();
  });
});

describe("shared Settings surfaces", () => {
  it("keeps a section title and note outside its open row content", () => {
    render(
      <SettingsSection description="Defaults for new threads." title="Thread defaults">
        <div className="setgroup">
          <SettingRow settingId="thread-default" label="Access" scope="mode">
            <button type="button">Ask</button>
          </SettingRow>
        </div>
      </SettingsSection>,
    );

    const section = screen.getByRole("region", { name: "Thread defaults" });
    expect(section).toHaveClass("settings-card-section", "settings-card-section--open");
    expect(within(section).getByText("Defaults for new threads.")).toHaveClass(
      "settings-section-note",
    );
    expect(within(section).getByTestId("setting-row")).toBeInTheDocument();
  });

  it("anchors a section, marks a destructive one, and reports itself to the page outline", () => {
    const register = vi.fn(() => vi.fn());
    const { unmount } = render(
      <SettingsOutlineRegistration.Provider value={register}>
        <SettingsSection id="danger-zone" title="Revoke access" tone="danger">
          <p>Body</p>
        </SettingsSection>
      </SettingsOutlineRegistration.Provider>,
    );

    const section = screen.getByRole("region", { name: "Revoke access" });
    expect(section).toHaveAttribute("id", "danger-zone");
    expect(section).toHaveAttribute("data-tone", "danger");
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ id: "danger-zone", title: "Revoke access", element: section }),
    );
    const unregister = register.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    unmount();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("gives a section without an id a stable anchor of its own", () => {
    render(
      <SettingsSection title="Files">
        <p>Body</p>
      </SettingsSection>,
    );
    expect(screen.getByRole("region", { name: "Files" }).id).not.toBe("");
  });

  it("puts a section's actions on its label line", () => {
    render(<SettingsSection actions={<button type="button">Refresh</button>} title="Identity" />);
    const head = screen.getByRole("heading", { name: "Identity" }).parentElement;
    expect(head).toHaveClass("settings-section-head");
    expect(within(head as HTMLElement).getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  it("renders one quiet panel hierarchy", () => {
    render(
      <SettingsPanel title="Identity" description="Facts reported by this host.">
        <p>Panel content</p>
      </SettingsPanel>,
    );

    const panel = screen.getByRole("region", { name: "Identity" });
    expect(panel).toHaveClass("settings-panel");
    expect(screen.getByText("Facts reported by this host.")).toBeVisible();
  });

  it("renders aligned facts without inventing controls", () => {
    render(
      <SettingsFactList
        facts={[
          { label: "Owner mode", value: "Web session" },
          { label: "Wire version", value: "1" },
        ]}
      />,
    );

    expect(screen.getByText("Owner mode").tagName).toBe("DT");
    expect(screen.getByText("Web session").tagName).toBe("DD");
  });

  it("uses one state treatment for loading and errors", () => {
    const { rerender } = render(<SettingsState kind="loading">Loading host status…</SettingsState>);
    expect(screen.getByRole("status")).toHaveClass("settings-state", "settings-state--loading");

    rerender(<SettingsState kind="error">Host is unavailable.</SettingsState>);
    expect(screen.getByRole("alert")).toHaveClass("settings-state", "settings-state--error");
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "danger");
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

describe("SettingsDisclosure", () => {
  it("keeps an unfinished field mounted when its details are closed and reopened", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDisclosure title="Stored data" description="Inspect local records.">
        <input aria-label="Draft" defaultValue="unfinished" />
      </SettingsDisclosure>,
    );
    const input = screen.getByLabelText("Draft");
    expect(input).not.toBeVisible();
    await user.click(screen.getByText("Stored data"));
    expect(input).toBeVisible();
    await user.type(input, " text");
    await user.click(screen.getByText("Stored data"));
    await user.click(screen.getByText("Stored data"));
    expect(screen.getByLabelText("Draft")).toBe(input);
    expect(input).toHaveValue("unfinished text");
  });

  it("reveals a deep-linked field inside closed settings details", () => {
    render(
      <SettingsDisclosure title="Advanced preferences">
        <SettingRow settingId="example" label="Example" scope="app" focused>
          <input aria-label="Example" />
        </SettingRow>
      </SettingsDisclosure>,
    );
    expect(screen.getByLabelText("Example")).toBeVisible();
    expect(screen.getByLabelText("Example")).toHaveFocus();
  });

  it("renders the compact inline disclosure recipe", () => {
    render(
      <SettingsDisclosure title="Inline details" variant="inline">
        <p>Disclosure body</p>
      </SettingsDisclosure>,
    );
    const title = screen.getByText("Inline details");
    const details = title.closest("details");
    expect(details).not.toBeNull();
    if (details === null) throw new Error("expected an inline disclosure");
    const summary = details.querySelector("summary");
    const chevron = summary?.querySelector("svg");
    expect(summary?.textContent).toContain("Inline details");
    expect(chevron).toHaveAttribute("width", "12");
    expect(chevron).toHaveAttribute("height", "12");
    expect(details).not.toHaveClass("settings-disclosure--section");
    expect(details).toHaveClass("settings-disclosure--inline");
    expect(details.querySelector(".settings-disclosure__body")).toContainElement(
      screen.getByText("Disclosure body"),
    );
  });

  it("keeps a compact row's state on its line and opens its detail from the name", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <SettingsCompactRow
        detail={<p>~/.kube/config</p>}
        label="Cluster configuration"
        meta="Protected"
      >
        <button onClick={onRemove} type="button">
          Remove
        </button>
      </SettingsCompactRow>,
    );
    expect(screen.getByText("Protected")).toBeVisible();
    const toggle = screen.getByRole("button", { name: "Cluster configuration" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("~/.kube/config")).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveFocus();
    expect(screen.getByText("~/.kube/config")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("opens a collapsed section from its label and says what it holds while closed", async () => {
    const user = userEvent.setup();
    render(
      <SettingsSection collapse={{ summary: "None remembered" }} title="Remembered websites">
        <p>Body</p>
      </SettingsSection>,
    );
    const toggle = screen.getByRole("button", { name: "Remembered websites" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("None remembered")).toBeVisible();
    expect(toggle.closest("section")).toHaveClass("settings-card-section--collapsed");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.closest("section")).not.toHaveClass("settings-card-section--collapsed");
  });

  it("opens a collapsed section when a deep link lands on a row inside it", async () => {
    render(
      <SettingsSection collapse={{ summary: "None remembered" }} title="Remembered websites">
        <SettingRow focused label="Forget" scope="host" settingId="x">
          <button type="button">Forget</button>
        </SettingRow>
      </SettingsSection>,
    );
    const toggle = screen.getByRole("button", { name: "Remembered websites" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Forget setting" })).getByRole("button"),
      ).toHaveFocus(),
    );
  });
});

describe("SettingsOutputWell", () => {
  it("keeps a command's raw output collapsed until it is asked for", () => {
    const { container } = render(
      <SettingsOutputWell summary="Show the output">line one{"\n"}line two</SettingsOutputWell>,
    );
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Show the output")).toBeInTheDocument();
  });
});

describe("SettingsSkeletonRows", () => {
  it("names the wait for a screen reader and draws the requested rows", () => {
    const { container } = render(<SettingsSkeletonRows label="Reading things…" rows={4} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reading things…");
    expect(container.querySelectorAll(".settings-skeleton__row")).toHaveLength(4);
  });
});
