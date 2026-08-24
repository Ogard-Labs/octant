import { fireEvent, render, screen } from "@testing-library/react";
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
