import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserMarkupStage } from "./BrowserMarkupStage";
import { RENDERER_OVERLAY_SELECTOR } from "./BrowserWorkspace";

const originalImage = globalThis.Image;

class LoadedImage {
  naturalWidth = 400;
  naturalHeight = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

afterEach(() => {
  globalThis.Image = originalImage;
});

async function renderStage(onKeyDown = vi.fn()) {
  globalThis.Image = LoadedImage as unknown as typeof Image;
  const view = render(
    // The wrapper stands for whatever sits above the stage and listens for keys.
    <div onKeyDown={onKeyDown}>
      <BrowserMarkupStage
        dataUrl="data:image/png;base64,iVBORw0KGgo="
        onAddToChat={vi.fn()}
        onClose={vi.fn()}
      />
    </div>,
  );
  const layer = await screen.findByRole("application", { name: "Page capture to draw on" });
  return { view, layer, onKeyDown };
}

describe("the drawing stage", () => {
  it("is matched by the selector that takes the native page out of the window", async () => {
    const { view } = await renderStage();
    const stage = view.container.querySelector(".browser-markup");
    expect(stage).not.toBeNull();
    expect(stage?.matches(RENDERER_OVERLAY_SELECTOR)).toBe(true);
  });

  it("says that drawing needs a pointer and names the keyboard commands that work", async () => {
    const { layer } = await renderStage();
    const help = document.getElementById(layer.getAttribute("aria-describedby") ?? "");
    expect(help).toHaveTextContent("Drawing needs a pointer");
    for (const command of ["undo", "redo", "Delete", "Escape"]) {
      expect(help).toHaveTextContent(command);
    }
  });

  it("keeps Escape to itself when it drops a stroke and lets it go on when it does nothing", async () => {
    const { layer, onKeyDown } = await renderStage();
    fireEvent.keyDown(layer, { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledOnce();

    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
    fireEvent(
      layer,
      new MouseEvent("pointerdown", { clientX: 20, clientY: 20, button: 0, bubbles: true }),
    );
    fireEvent.keyDown(layer, { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});
