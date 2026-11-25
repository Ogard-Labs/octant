import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ShellResizeHandle } from "./ShellResizeHandle";

function renderHandle(overrides: Partial<React.ComponentProps<typeof ShellResizeHandle>> = {}) {
  const onCommit = vi.fn();
  const onPreview = vi.fn();
  const accessibleName = overrides.accessibleName ?? "Resize navigation sidebar";
  render(
    <ShellResizeHandle
      accessibleName={accessibleName}
      edge="trailing"
      maximum={420}
      minimum={220}
      onCommit={onCommit}
      onPreview={onPreview}
      value={260}
      {...overrides}
    />,
  );
  const separator = screen.getByRole("separator", { name: accessibleName });
  Object.assign(separator, {
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
  });
  return { onCommit, onPreview, separator };
}

describe("ShellResizeHandle", () => {
  it("previews a bounded pointer move and commits exactly once on release", () => {
    const { onCommit, onPreview, separator } = renderHandle();

    fireEvent.pointerDown(separator, { clientX: 260, pointerId: 7 });
    fireEvent.pointerMove(separator, { clientX: 460, pointerId: 7 });
    expect(onPreview).toHaveBeenLastCalledWith(420);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(separator, { clientX: 460, pointerId: 7 });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(420);
  });

  it("does not emit a preview or commit for a click without movement", () => {
    const { onCommit, onPreview, separator } = renderHandle();

    fireEvent.pointerDown(separator, { clientX: 260, pointerId: 8 });
    fireEvent.pointerUp(separator, { clientX: 260, pointerId: 8 });

    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "restores the committed width on %s without committing",
    (eventName) => {
      const { onCommit, onPreview, separator } = renderHandle();
      fireEvent.pointerDown(separator, { clientX: 260, pointerId: 9 });
      fireEvent.pointerMove(separator, { clientX: 300, pointerId: 9 });

      fireEvent[eventName](separator, { pointerId: 9 });

      expect(onPreview).toHaveBeenLastCalledWith(260);
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("cancels an active pointer gesture on Escape and window blur", () => {
    const { onCommit, onPreview, separator } = renderHandle();
    fireEvent.pointerDown(separator, { clientX: 260, pointerId: 10 });
    fireEvent.pointerMove(separator, { clientX: 300, pointerId: 10 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onPreview).toHaveBeenLastCalledWith(260);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerDown(separator, { clientX: 260, pointerId: 11 });
    fireEvent.pointerMove(separator, { clientX: 320, pointerId: 11 });
    fireEvent.blur(window);
    expect(onPreview).toHaveBeenLastCalledWith(260);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("exposes separator values and commits small and Shift-modified keyboard steps", () => {
    const { onCommit, onPreview, separator } = renderHandle();
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuemin", "220");
    expect(separator).toHaveAttribute("aria-valuemax", "420");
    expect(separator).toHaveAttribute("aria-valuenow", "260");
    expect(separator).toHaveAttribute("aria-valuetext", "260 px");
    expect(separator).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });

    expect(onPreview).toHaveBeenNthCalledWith(1, 268);
    expect(onCommit).toHaveBeenNthCalledWith(1, 268);
    expect(onPreview).toHaveBeenNthCalledWith(2, 228);
    expect(onCommit).toHaveBeenNthCalledWith(2, 228);
  });

  it("jumps to the minimum width on Home and the maximum on End", () => {
    const { onCommit, onPreview, separator } = renderHandle();

    fireEvent.keyDown(separator, { key: "Home" });
    expect(onPreview).toHaveBeenLastCalledWith(220);
    expect(onCommit).toHaveBeenLastCalledWith(220);

    fireEvent.keyDown(separator, { key: "End" });
    expect(onPreview).toHaveBeenLastCalledWith(420);
    expect(onCommit).toHaveBeenLastCalledWith(420);
  });

  it("reverses horizontal keyboard and pointer direction for a leading edge", () => {
    const { onCommit, onPreview, separator } = renderHandle({ edge: "leading", value: 360 });

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onPreview).toHaveBeenLastCalledWith(368);
    expect(onCommit).toHaveBeenLastCalledWith(368);

    fireEvent.pointerDown(separator, { clientX: 400, pointerId: 12 });
    fireEvent.pointerMove(separator, { clientX: 360, pointerId: 12 });
    expect(onPreview).toHaveBeenLastCalledWith(400);
  });

  it("resizes a bottom panel from its top edge", () => {
    const { onCommit, onPreview, separator } = renderHandle({
      accessibleName: "Resize bottom panel",
      edge: "top",
      maximum: 640,
      minimum: 160,
      value: 260,
    });

    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(onPreview).toHaveBeenLastCalledWith(268);
    expect(onCommit).toHaveBeenLastCalledWith(268);

    fireEvent.pointerDown(separator, { clientY: 500, pointerId: 13 });
    fireEvent.pointerMove(separator, { clientY: 450, pointerId: 13 });
    expect(onPreview).toHaveBeenLastCalledWith(310);
  });
});

function renderCollapsible(startCollapsed: boolean) {
  const onCommit = vi.fn();
  const onPreview = vi.fn();
  const onCollapsedChange = vi.fn();
  function Harness() {
    const [collapsed, setCollapsed] = useState(startCollapsed);
    const [value, setValue] = useState(300);
    return (
      <ShellResizeHandle
        accessibleName="Resize navigation sidebar"
        collapse={{
          collapsed,
          onCollapsedChange: (next) => {
            onCollapsedChange(next);
            setCollapsed(next);
          },
        }}
        edge="trailing"
        maximum={420}
        minimum={220}
        onCommit={onCommit}
        onPreview={(next) => {
          onPreview(next);
          setValue(next);
        }}
        value={value}
      />
    );
  }
  render(<Harness />);
  const separator = screen.getByRole("separator", { name: "Resize navigation sidebar" });
  const releasePointerCapture = vi.fn();
  Object.assign(separator, {
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture,
    setPointerCapture: vi.fn(),
  });
  return { onCommit, onPreview, onCollapsedChange, releasePointerCapture, separator };
}

describe("a resize handle whose panel can be dragged shut", () => {
  it("hides the panel once dragged well past the minimum, keeping the width from before", () => {
    const { onCommit, onPreview, onCollapsedChange, separator } = renderCollapsible(false);

    fireEvent.pointerDown(separator, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 100, pointerId: 1 });
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
    expect(onPreview).toHaveBeenLastCalledWith(300);

    fireEvent.pointerUp(separator, { clientX: 100, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCollapsedChange).toHaveBeenCalledOnce();
  });

  it("stays shown at the minimum after a small overshoot", () => {
    const { onCommit, onCollapsedChange, separator } = renderCollapsible(false);

    fireEvent.pointerDown(separator, { clientX: 300, pointerId: 2 });
    fireEvent.pointerMove(separator, { clientX: 219, pointerId: 2 });
    fireEvent.pointerMove(separator, { clientX: 156, pointerId: 2 });
    fireEvent.pointerUp(separator, { clientX: 156, pointerId: 2 });

    expect(onCollapsedChange).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith(220);
  });

  it("shows the panel again when the same drag comes back", () => {
    const { onCommit, onCollapsedChange, separator } = renderCollapsible(false);

    fireEvent.pointerDown(separator, { clientX: 300, pointerId: 3 });
    fireEvent.pointerMove(separator, { clientX: 20, pointerId: 3 });
    fireEvent.pointerMove(separator, { clientX: 330, pointerId: 3 });
    fireEvent.pointerUp(separator, { clientX: 330, pointerId: 3 });

    expect(onCollapsedChange.mock.calls).toEqual([[true], [false]]);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(330);
  });

  it.each([
    [40, 120, 220],
    [0, 350, 350],
    [0, 900, 420],
  ])("shows a hidden panel pulled from x=%i to x=%i at a width of %i", (from, to, width) => {
    const { onCommit, onCollapsedChange, separator } = renderCollapsible(true);

    fireEvent.pointerDown(separator, { clientX: from, pointerId: 4 });
    fireEvent.pointerMove(separator, { clientX: to, pointerId: 4 });
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
    fireEvent.pointerUp(separator, { clientX: to, pointerId: 4 });

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(width);
  });

  it("does nothing for a click or a short pull on a hidden panel's edge", () => {
    const { onCommit, onPreview, onCollapsedChange, separator } = renderCollapsible(true);

    fireEvent.pointerDown(separator, { clientX: 0, pointerId: 5 });
    fireEvent.pointerUp(separator, { clientX: 0, pointerId: 5 });
    fireEvent.pointerDown(separator, { clientX: 0, pointerId: 6 });
    fireEvent.pointerMove(separator, { clientX: 20, pointerId: 6 });
    fireEvent.pointerUp(separator, { clientX: 20, pointerId: 6 });

    expect(onCollapsedChange).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["escape", "blur", "pointerCancel", "lostPointerCapture"] as const)(
    "restores a shown panel and its width when the drag ends in %s",
    (ending) => {
      const { onCommit, onPreview, onCollapsedChange, separator } = renderCollapsible(false);
      fireEvent.pointerDown(separator, { clientX: 300, pointerId: 7 });
      fireEvent.pointerMove(separator, { clientX: 20, pointerId: 7 });

      if (ending === "escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (ending === "blur") fireEvent.blur(window);
      else fireEvent[ending](separator, { pointerId: 7 });

      expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
      expect(onPreview).toHaveBeenLastCalledWith(300);
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("hides the panel again when Escape ends a drag that had pulled it out", () => {
    const { onCommit, onPreview, onCollapsedChange, separator } = renderCollapsible(true);
    fireEvent.pointerDown(separator, { clientX: 0, pointerId: 8 });
    fireEvent.pointerMove(separator, { clientX: 360, pointerId: 8 });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
    expect(onPreview).toHaveBeenLastCalledWith(300);
    expect(onCommit).not.toHaveBeenCalled();
    expect(separator).toHaveAttribute("aria-valuenow", "0");
  });

  it("says a hidden panel is hidden, and shows it from the keyboard without losing focus", () => {
    const { onCommit, onCollapsedChange, separator } = renderCollapsible(true);
    expect(separator).toHaveAttribute("aria-valuemin", "0");
    expect(separator).toHaveAttribute("aria-valuenow", "0");
    expect(separator).toHaveAttribute("aria-valuemax", "420");
    expect(separator).toHaveAttribute("aria-valuetext", "Hidden");
    separator.focus();

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onCollapsedChange).not.toHaveBeenCalled();
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(onCollapsedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(separator).toHaveFocus();
    expect(separator).toHaveAttribute("aria-valuemin", "220");
    expect(separator).toHaveAttribute("aria-valuenow", "300");
  });

  it.each([
    ["Home", 220],
    ["End", 420],
  ])("shows a hidden panel on %s at a width of %i", (key, width) => {
    const { onCommit, onCollapsedChange, separator } = renderCollapsible(true);

    fireEvent.keyDown(separator, { key });

    expect(onCollapsedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(width);
  });

  it("never hides a panel whose handle did not opt in", () => {
    const { onCommit, onPreview, separator } = renderHandle();

    fireEvent.pointerDown(separator, { clientX: 260, pointerId: 9 });
    fireEvent.pointerMove(separator, { clientX: -900, pointerId: 9 });
    fireEvent.pointerUp(separator, { clientX: -900, pointerId: 9 });

    expect(onPreview).toHaveBeenLastCalledWith(220);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(220);
    expect(separator).toHaveAttribute("aria-valuemin", "220");
  });
});
