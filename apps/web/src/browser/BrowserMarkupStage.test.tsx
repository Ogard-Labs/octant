import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserMarkupStage } from "./BrowserMarkupStage";
import { ZenRoot } from "../zen/ZenRoot";
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

  it("opens with the layer focused so the keys work at once", async () => {
    const { layer } = await renderStage();
    // The layer is in the document one step before the stage focuses it: the
    // focus comes from an effect that runs after the commit. A few milliseconds
    // between the two on a slow runner let this read see the body focused.
    await waitFor(() => expect(layer).toHaveFocus());
  });

  it("redoes on Shift+Cmd+Z without toggling Zen", async () => {
    globalThis.Image = LoadedImage as unknown as typeof Image;
    const onToggle = vi.fn();
    render(
      <ZenRoot active={false} onExit={() => undefined} onToggle={onToggle} zen={<div>Zen</div>}>
        <BrowserMarkupStage
          dataUrl="data:image/png;base64,iVBORw0KGgo="
          onAddToChat={vi.fn()}
          onClose={vi.fn()}
        />
      </ZenRoot>,
    );
    const layer = await screen.findByRole("application", { name: "Page capture to draw on" });
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
    const at = (type: string, x: number, y: number) =>
      fireEvent(layer, new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    at("pointerdown", 20, 20);
    at("pointermove", 80, 50);
    at("pointerup", 120, 60);
    expect(layer.querySelectorAll("polyline")).toHaveLength(1);
    fireEvent.keyDown(layer, { key: "z", metaKey: true });
    expect(layer.querySelectorAll("polyline")).toHaveLength(0);
    fireEvent.keyDown(layer, { key: "z", metaKey: true, shiftKey: true });
    expect(layer.querySelectorAll("polyline")).toHaveLength(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("keeps the six inks behind one control: arrows move, Enter picks, Escape closes and returns focus", async () => {
    const user = userEvent.setup();
    await renderStage();
    const trigger = screen.getByRole("button", { name: "Ink colour: Red" });
    expect(screen.queryByRole("radio", { name: "Blue" })).toBeNull();
    await user.click(trigger);
    const radios = await screen.findAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Red",
      "Yellow",
      "Green",
      "Blue",
      "White",
      "Black",
    ]);
    expect(screen.getByRole("radio", { name: "Red" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Green" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Green" })).toBeNull());
    expect(screen.getByRole("button", { name: "Ink colour: Green" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Ink colour: Green" }));
    await screen.findAllByRole("radio");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Green" })).toBeNull());
    expect(screen.getByRole("button", { name: "Ink colour: Green" })).toHaveFocus();
  });

  it("marks the chosen tool and width as pressed and keeps Add to chat and Discard as the last two controls", async () => {
    await renderStage();
    expect(screen.getByRole("button", { name: "Pen" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Thick stroke" }));
    expect(screen.getByRole("button", { name: "Thick stroke" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const bar = screen.getByRole("toolbar", { name: "Drawing tools" });
    const last = bar.querySelector(".browser-markup__group--trailing");
    expect(
      Array.from(last?.querySelectorAll("button") ?? []).map(
        (b) => b.textContent?.trim() || b.getAttribute("aria-label"),
      ),
    ).toEqual(["Add to chat", "Discard drawing"]);
  });
});
