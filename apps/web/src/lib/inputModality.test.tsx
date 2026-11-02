import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followInputModality } from "./inputModality";

describe("following how focus last moved", () => {
  let stop: () => void;

  beforeEach(() => {
    delete document.documentElement.dataset.octantInput;
    stop = followInputModality();
  });

  afterEach(() => {
    stop();
    document.body.replaceChildren();
  });

  function press(key: string, target: EventTarget = window) {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  }

  it("says nothing until a person has pressed or navigated", () => {
    press("a");
    expect(document.documentElement.dataset.octantInput).toBeUndefined();
  });

  it("keeps the pointer's answer through Escape, so a closed dialog leaves no ring", () => {
    window.dispatchEvent(new Event("pointerdown"));
    press("Escape");
    expect(document.documentElement.dataset.octantInput).toBe("pointer");
  });

  it("switches to the keyboard on Tab and back on the next press", () => {
    press("Tab");
    expect(document.documentElement.dataset.octantInput).toBe("keyboard");
    window.dispatchEvent(new Event("pointerdown"));
    expect(document.documentElement.dataset.octantInput).toBe("pointer");
  });

  it("does not read arrow keys in a text field as moving focus", () => {
    const field = document.createElement("input");
    document.body.append(field);
    window.dispatchEvent(new Event("pointerdown"));
    press("ArrowLeft", field);
    expect(document.documentElement.dataset.octantInput).toBe("pointer");
    press("ArrowDown");
    expect(document.documentElement.dataset.octantInput).toBe("keyboard");
  });
});
