import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PanelTab, PanelTabStrip } from "./PanelTabs";

function strip(options: { readonly dirty?: boolean; readonly onClose?: () => void } = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onSelect = vi.fn();
  const view = render(
    <PanelTabStrip label="Pages" selectedId="b">
      {["a", "b", "c"].map((id) => (
        <PanelTab
          dirty={options.dirty === true && id === "b"}
          icon={<svg aria-hidden="true" />}
          id={id}
          key={id}
          label={`Tab ${id}`}
          onClose={() => onClose(id)}
          onSelect={() => onSelect(id)}
          roving={id === "b"}
          selected={id === "b"}
        />
      ))}
    </PanelTabStrip>,
  );
  return { onClose, onSelect, ...view };
}

describe("PanelTab without an icon", () => {
  it("shows the name alone, italic for a preview, with the close mark at the end", () => {
    render(
      <PanelTabStrip label="Open files" selectedId="a">
        <PanelTab
          id="a"
          label="main.ts"
          onClose={vi.fn()}
          onSelect={vi.fn()}
          preview
          roving
          selected
        />
      </PanelTabStrip>,
    );
    const tab = screen.getByRole("tab", { name: /main\.ts/ });
    expect(tab.querySelector("svg")).toBeNull();
    expect(tab.closest(".content-tab")).toHaveAttribute("data-preview", "true");
    expect(tab.closest(".content-tab")?.lastElementChild).toBe(
      screen.getByRole("button", { name: "Close main.ts" }),
    );
  });
});

describe("PanelTabStrip", () => {
  it("marks the open tab selected and keeps the others out of the tab order", () => {
    strip();
    expect(screen.getByRole("tablist", { name: "Pages" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tab b" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Tab a" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Tab a" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus and selection between tabs with the arrow keys", async () => {
    const { onSelect } = strip();
    screen.getByRole("tab", { name: "Tab b" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Tab c" })).toHaveFocus();
    expect(onSelect).toHaveBeenLastCalledWith("c");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Tab a" })).toHaveFocus();
  });

  it("closes a tab with a middle click, Delete or Cmd+W, and with the close button", async () => {
    const { onClose } = strip();
    const tab = screen.getByRole("tab", { name: "Tab a" });
    fireEvent(tab, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(onClose).toHaveBeenLastCalledWith("a");
    tab.focus();
    await userEvent.keyboard("{Delete}");
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(tab, { key: "w", metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(3);
    await userEvent.click(screen.getByRole("button", { name: "Close Tab c" }));
    expect(onClose).toHaveBeenLastCalledWith("c");
  });

  it("shows a dot for unsaved edits and still offers the close button", () => {
    strip({ dirty: true });
    expect(screen.getAllByTestId("tab-dirty-dot")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /Tab b, unsaved changes/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Tab b" })).toBeInTheDocument();
  });

  it("scrolls only the strip to bring a tab that is out of view into it", () => {
    const rects = new Map<string, DOMRect>();
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute("role") === "tablist")
        return { left: 0, right: 100, top: 0, bottom: 36, width: 100, height: 36 } as DOMRect;
      if (this.classList.contains("content-tab") && this.textContent?.includes("Tab b"))
        return { left: 150, right: 250, top: 0, bottom: 28, width: 100, height: 28 } as DOMRect;
      return rects.get("x") ?? original.call(this);
    };
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      strip();
      expect(screen.getByRole("tablist").scrollLeft).toBe(150);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });
});
