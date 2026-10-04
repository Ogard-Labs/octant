import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OctantPreviewCard } from "./OctantPreviewCard";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OctantContextMenuRoot,
  OctantContextMenuTrigger,
  OctantContextMenuContent,
  OctantContextMenuItem,
  OctantContextMenuSub,
  OctantContextMenuSubTrigger,
  OctantContextMenuSubContent,
  OctantContextMenuSeparator,
} from "./OctantContextMenu";

afterEach(() => {
  Reflect.deleteProperty(window, "octantHost");
});

function menu(onCopy = vi.fn()) {
  return (
    <OctantContextMenuRoot>
      <OctantContextMenuTrigger render={<button type="button" />}>Thread</OctantContextMenuTrigger>
      <OctantContextMenuContent>
        <OctantContextMenuItem label="Rename" disabled>
          Rename
        </OctantContextMenuItem>
        <OctantContextMenuSeparator />
        <OctantContextMenuSub>
          <OctantContextMenuSubTrigger label="Copy">Copy</OctantContextMenuSubTrigger>
          <OctantContextMenuSubContent>
            <OctantContextMenuItem label="Copy title" onClick={onCopy}>
              Copy title
            </OctantContextMenuItem>
          </OctantContextMenuSubContent>
        </OctantContextMenuSub>
      </OctantContextMenuContent>
    </OctantContextMenuRoot>
  );
}

describe("desktop context menus", () => {
  it("opens OS menus with nested actions and returns selection to the existing action", async () => {
    const copy = vi.fn();
    const popup = vi.fn(async () => ({ kind: "selected", id: "2.0" }));
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    render(menu(copy));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Thread" }), {
      clientX: 34,
      clientY: 56,
    });
    await waitFor(() =>
      expect(popup).toHaveBeenCalledWith({
        x: 34,
        y: 56,
        items: [
          { kind: "item", id: "0", label: "Rename", enabled: false },
          { kind: "separator" },
          {
            kind: "submenu",
            label: "Copy",
            enabled: true,
            items: [{ kind: "item", id: "2.0", label: "Copy title", enabled: true }],
          },
        ],
      }),
    );
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("restores trigger focus on dismissal and does not invoke disabled or stale actions", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const popup = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    const copy = vi.fn();
    const view = render(menu(copy));
    const trigger = screen.getByRole("button", { name: "Thread" });
    trigger.focus();
    fireEvent.contextMenu(trigger);
    await waitFor(() => expect(popup).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await act(async () => finish({ kind: "dismissed" }));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.contextMenu(trigger);
    await waitFor(() => expect(popup).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => finish({ kind: "selected", id: "2.0" }));
    expect(copy).not.toHaveBeenCalled();
  });

  it("hides the row preview while its native context menu is open", async () => {
    const popup = vi.fn(() => new Promise(() => undefined));
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    render(
      <OctantContextMenuRoot>
        <OctantPreviewCard label="Thread details" content={<span>Preview</span>}>
          <OctantContextMenuTrigger render={<button type="button" />}>
            Thread
          </OctantContextMenuTrigger>
        </OctantPreviewCard>
        <OctantContextMenuContent>
          <OctantContextMenuItem label="Copy">Copy</OctantContextMenuItem>
        </OctantContextMenuContent>
      </OctantContextMenuRoot>,
    );
    const trigger = screen.getByRole("button", { name: "Thread" });
    await userEvent.hover(trigger);
    expect(await screen.findByRole("group", { name: "Thread details" })).toBeVisible();
    fireEvent.contextMenu(trigger);
    await waitFor(() => expect(popup).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Thread details" })).not.toBeInTheDocument(),
    );
  });

  it("keeps browser menus accessible when no native bridge exists", async () => {
    render(menu());
    fireEvent.contextMenu(screen.getByRole("button", { name: "Thread" }));
    expect(await screen.findByRole("menu")).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
