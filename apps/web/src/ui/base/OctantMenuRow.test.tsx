import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantContextMenu } from "./OctantContextMenu";
import { OctantMenu } from "./OctantMenu";

/**
 * jsdom has no layout, so the one text edge is asserted by structure: every
 * row of a menu where any row has an icon starts with the same 16px icon
 * column, and a menu with no icons reserves none.
 */
const ICON_COLUMN = "size-(--oct-icon-md)";
const firstChildReservesColumn = (row: HTMLElement) =>
  (row.firstElementChild?.getAttribute("class") ?? "").includes(ICON_COLUMN);

describe("a menu's rows", () => {
  it("keeps one text edge in a context menu that mixes rows with and without an icon", async () => {
    const user = userEvent.setup();
    render(
      <OctantContextMenu
        items={[
          { label: "Rename", value: "rename", icon: <svg data-testid="icon" /> },
          { label: "Archive", value: "archive" },
        ]}
        onValueChange={vi.fn()}
        triggerClassName="recipe-trigger"
      >
        <span>Project</span>
      </OctantContextMenu>,
    );
    await user.pointer({
      target: screen.getByText("Project").closest(".recipe-trigger")!,
      keys: "[MouseRight]",
    });
    const rows = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(rows).toHaveLength(2);
    expect(rows.map(firstChildReservesColumn)).toEqual([true, true]);
  });

  it("keeps one text edge in a dropdown that mixes rows with and without an icon", async () => {
    const user = userEvent.setup();
    render(
      <OctantMenu
        items={[
          { label: "Rename", value: "rename", icon: <svg /> },
          { label: "Archive", value: "archive" },
        ]}
        onValueChange={vi.fn()}
        selectionMode="action"
        value="rename"
        trigger="Open"
        triggerLabel="Open menu"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const rows = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(rows.map(firstChildReservesColumn)).toEqual([true, true]);
  });

  it("reserves no icon column in a menu where no row has an icon", async () => {
    const user = userEvent.setup();
    render(
      <OctantMenu
        items={[
          { label: "Rename", value: "rename" },
          { label: "Archive", value: "archive" },
        ]}
        onValueChange={vi.fn()}
        selectionMode="action"
        value="rename"
        trigger="Open"
        triggerLabel="Open menu"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const rows = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(rows.map(firstChildReservesColumn)).toEqual([false, false]);
  });
});
