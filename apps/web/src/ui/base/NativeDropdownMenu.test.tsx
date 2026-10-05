import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeMenuEntry, NativeMenuRequest } from "@octant/contracts/shell";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";
import { ProjectSidebarSection } from "../../projects/ProjectSidebarSection";
import { OctantSelectField } from "./OctantSelect";
import { SidebarProfile } from "../../shell/SidebarProfile";
import { SidebarMore } from "../../shell/SidebarMore";
import {
  OctantMenuCheckboxItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuTrigger,
} from "./OctantMenu";

afterEach(() => {
  Reflect.deleteProperty(window, "octantHost");
});

describe("native dropdown menus", () => {
  it("opens More as an OS menu and activates the selected destination", async () => {
    const select = vi.fn();
    const popup = vi.fn(async () => ({ kind: "selected", id: "0" }));
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    render(
      <SidebarMore
        items={[{ id: "agents", label: "Agents", onSelect: select }]}
        onCustomizeSidebar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More destinations" }));
    await waitFor(() =>
      expect(popup).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        items: [
          { kind: "item", id: "0", label: "Agents", enabled: true },
          { kind: "separator" },
          { kind: "item", id: "2", label: "Customize sidebar", enabled: true },
        ],
      }),
    );
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens nested project filters natively and edits custom dates in a dialog", async () => {
    window.localStorage.clear();
    let selected = "Custom range";
    function find(items: ReadonlyArray<NativeMenuEntry>): string | undefined {
      for (const item of items) {
        if (item.kind === "submenu") {
          const id = find(item.items);
          if (id !== undefined) return id;
        } else if (item.kind !== "separator" && item.label === selected) return item.id;
      }
      return undefined;
    }
    const popup = vi.fn(async (request: NativeMenuRequest) => {
      const id = find(request.items);
      return id === undefined ? { kind: "dismissed" } : { kind: "selected", id };
    });
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    render(
      <ProjectSidebarSection
        archivedProjects={[]}
        availabilityByProject={new Map()}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        projectViewsEnabled
        projects={[
          {
            id: "11111111-1111-4111-8111-111111111111" as ProjectId,
            name: "Test",
            type: "chat",
            pinned: false,
          } as ProjectSummary,
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Project view filters/ }));
    await waitFor(() => expect(popup).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("dialog", { name: "Custom activity range" })).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Activity from"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("Activity to"), { target: { value: "2026-08-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    selected = "Custom range";
    fireEvent.click(screen.getByRole("button", { name: /Project view filters/ }));
    expect(await screen.findByRole("dialog", { name: "Custom activity range" })).toBeVisible();
    expect(screen.getByLabelText("Activity from")).toHaveValue("2026-08-01");
  });

  it("anchors the account menu above its footer control", async () => {
    const popup = vi.fn(async () => ({ kind: "dismissed" }));
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    render(
      <SidebarProfile
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        profile={{ avatar: { kind: "initials" }, accent: "indigo" }}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Account menu/ });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 600,
      left: 10,
      top: 600,
      right: 280,
      bottom: 632,
      width: 270,
      height: 32,
      toJSON: () => ({}),
    });
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(popup).toHaveBeenCalledWith(
        expect.objectContaining({ x: 10, y: 600, placement: "above" }),
      ),
    );
  });

  it("uses native choices without changing form values or disabled options", async () => {
    const changed = vi.fn();
    const popup = vi.fn(async (_request: NativeMenuRequest) => ({ kind: "selected", id: "1" }));
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    const { container } = render(
      <form>
        <OctantSelectField
          aria-label="Quality"
          name="quality"
          defaultValue=""
          onValueChange={changed}
          options={[
            { id: "", label: "Default" },
            { id: "high", label: "High" },
            { id: "low", label: "Low", disabled: true },
          ]}
        />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quality" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith("high"));
    expect(container.querySelector('input[name="quality"]')).toHaveValue("high");
    expect(popup.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        items: [
          { kind: "radio", id: "0", label: "Default", enabled: true, checked: true },
          { kind: "radio", id: "1", label: "High", enabled: true, checked: false },
          { kind: "radio", id: "2", label: "Low", enabled: false, checked: false },
        ],
      }),
    );
  });

  it("preserves checked choices, keyboard opening, and existing change callbacks", async () => {
    const radio = vi.fn();
    const check = vi.fn();
    const popup = vi
      .fn()
      .mockResolvedValueOnce({ kind: "selected", id: "1" })
      .mockResolvedValueOnce({ kind: "selected", id: "2" });
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    render(
      <OctantMenuRoot>
        <OctantMenuTrigger>Options</OctantMenuTrigger>
        <OctantMenuPortal>
          <OctantMenuPositioner>
            <OctantMenuPopup>
              <OctantMenuRadioGroup value="first" onValueChange={radio}>
                <OctantMenuRadioItem value="first">First</OctantMenuRadioItem>
                <OctantMenuRadioItem value="second">Second</OctantMenuRadioItem>
              </OctantMenuRadioGroup>
              <OctantMenuCheckboxItem checked={true} onCheckedChange={check}>
                Remember
              </OctantMenuCheckboxItem>
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>,
    );
    const trigger = screen.getByRole("button", { name: "Options" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(popup).toHaveBeenCalledTimes(1));
    expect(popup.mock.calls[0]?.[0].items).toEqual([
      { kind: "radio", id: "0", label: "First", enabled: true, checked: true },
      { kind: "radio", id: "1", label: "Second", enabled: true, checked: false },
      { kind: "checkbox", id: "2", label: "Remember", enabled: true, checked: true },
    ]);
    await waitFor(() => expect(radio).toHaveBeenCalledWith("second", expect.anything()));
    fireEvent.click(trigger);
    await waitFor(() => expect(check).toHaveBeenCalledWith(false, expect.anything()));
  });
});
