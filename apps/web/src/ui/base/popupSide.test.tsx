import { afterEach, describe, expect, it, vi } from "vitest";
import { sideWithRoom } from "./popupSide";

function buttonAt(top: number, height = 24): Element {
  const button = document.createElement("button");
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    top,
    bottom: top + height,
    left: 0,
    right: 80,
    width: 80,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  return button;
}

const realHeight = window.innerHeight;
function windowHeight(height: number): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

describe("the side a popup opens on", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    windowHeight(realHeight);
  });

  it("opens a popup that prefers the top downward when its button stands in the upper half of the window", () => {
    windowHeight(800);
    expect(sideWithRoom("top", buttonAt(120))).toBe("bottom");
    expect(sideWithRoom("top", buttonAt(700))).toBe("top");
  });

  it("leaves a popup that prefers the bottom where it is, and one whose button has no layout", () => {
    windowHeight(800);
    expect(sideWithRoom("bottom", buttonAt(700))).toBe("bottom");
    expect(sideWithRoom("top", document.createElement("button"))).toBe("top");
    expect(sideWithRoom("top", null)).toBe("top");
  });
});
