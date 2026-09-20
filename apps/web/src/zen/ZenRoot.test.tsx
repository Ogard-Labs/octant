import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ZenRoot } from "./ZenRoot";

describe("ZenRoot", () => {
  it("renders the Zen surface instead of the shell children when active", () => {
    render(
      <ZenRoot active onExit={() => undefined} onToggle={() => undefined} zen={<div>Zen view</div>}>
        <div>Ordinary shell</div>
      </ZenRoot>,
    );

    expect(screen.getByText("Zen view")).toBeInTheDocument();
    expect(screen.getByText("Ordinary shell").closest(".zen-root__shell")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("keeps the ordinary shell visible when Zen is inactive", () => {
    render(
      <ZenRoot
        active={false}
        onExit={() => undefined}
        onToggle={() => undefined}
        zen={<div>Zen view</div>}
      >
        <div>Ordinary shell</div>
      </ZenRoot>,
    );

    expect(screen.getByText("Ordinary shell")).toBeInTheDocument();
    expect(screen.queryByText("Zen view")).not.toBeInTheDocument();
  });

  it("toggles Zen with the dedicated keyboard shortcut", () => {
    const onToggle = vi.fn();
    render(
      <ZenRoot active onExit={() => undefined} onToggle={onToggle} zen={<div>Zen view</div>}>
        <div>Ordinary shell</div>
      </ZenRoot>,
    );

    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("leaves Redo to the composer instead of opening Zen while someone is typing", () => {
    const onToggle = vi.fn();
    render(
      <ZenRoot active={false} onExit={() => undefined} onToggle={onToggle} zen={<div>Zen</div>}>
        <textarea aria-label="Message" />
      </ZenRoot>,
    );

    // Mod+Shift+Z is Redo in every text field. Outside Zen the chord was taken
    // anyway, so redoing in the composer threw the window into Zen.
    const redo = fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "z",
      metaKey: true,
      shiftKey: true,
    });

    expect(onToggle).not.toHaveBeenCalled();
    // `fireEvent` returns false when the event was cancelled; Redo must survive.
    expect(redo).toBe(true);
  });
});
