import { describe, expect, it } from "vitest";
import { SWIPE_STEP_MS, swipeEdge, swipePath } from "./swipePath";

describe("swipe paths", () => {
  it("moves the finger in even steps over the whole drag instead of jumping at the end", () => {
    const path = swipePath({ x: 0.5, y: 1 }, { x: 0.5, y: 0.2 }, 320);
    expect(path).toHaveLength(1 + 320 / SWIPE_STEP_MS);
    expect(path[0]).toEqual({ x: 0.5, y: 1, atMs: 0 });
    expect(path.at(-1)).toEqual({ x: 0.5, y: 0.2, atMs: 320 });
    for (const [index, sample] of path.entries()) {
      expect(sample.atMs).toBeCloseTo(index * SWIPE_STEP_MS);
      expect(sample.y).toBeCloseTo(1 - (0.8 * index) / (path.length - 1));
    }
  });

  it("stretches the last steps evenly when the duration is not a whole number of steps", () => {
    const path = swipePath({ x: 0, y: 0 }, { x: 1, y: 0.5 }, 300);
    const moves = Math.ceil(300 / SWIPE_STEP_MS);
    expect(path).toHaveLength(moves + 1);
    expect(path.at(-1)).toEqual({ x: 1, y: 0.5, atMs: 300 });
    const gaps = path.slice(1).map((sample, index) => sample.atMs - (path[index]?.atMs ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(300 / moves);
      expect(gap).toBeLessThanOrEqual(SWIPE_STEP_MS);
    }
  });

  it("still moves once to the end of a swipe given no time", () => {
    expect(swipePath({ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }, 0)).toEqual([
      { x: 0.1, y: 0.2, atMs: 0 },
      { x: 0.3, y: 0.4, atMs: 0 },
    ]);
  });

  it("names the screen edge a swipe starts on, and none for a swipe inside the screen", () => {
    expect(swipeEdge({ x: 0.5, y: 0.99 })).toBe("bottom");
    expect(swipeEdge({ x: 0.5, y: 0.005 })).toBe("top");
    expect(swipeEdge({ x: 0.01, y: 0.5 })).toBe("left");
    expect(swipeEdge({ x: 1, y: 0.5 })).toBe("right");
    expect(swipeEdge({ x: 0.5, y: 0.9 })).toBeUndefined();
    // In a corner the nearer edge wins.
    expect(swipeEdge({ x: 0.015, y: 0.995 })).toBe("bottom");
  });
});
