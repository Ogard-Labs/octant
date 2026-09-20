import { describe, expect, it } from "vitest";
import { gestureFrom, keyIntentFor } from "./simulatorGestures";

// A 1206×2622 screen drawn at a third of its size, 300 px in from the left.
const box = { left: 300, top: 20, width: 402, height: 874 };
const screen = { width: 1206, height: 2622 };

describe("reading a pointer gesture on the Simulator screen", () => {
  it("reads a press and release in one place as a tap on the device's own pixels", () => {
    expect(
      gestureFrom({ x: 501, y: 457, atMs: 0 }, { x: 503, y: 459, atMs: 90 }, box, screen),
    ).toEqual({ kind: "tap", point: { x: 603, y: 1311 } });
  });

  it("reads a drag as a swipe that takes as long as the drag did", () => {
    expect(
      gestureFrom({ x: 501, y: 800, atMs: 0 }, { x: 501, y: 300, atMs: 240 }, box, screen),
    ).toEqual({
      kind: "swipe",
      from: { x: 603, y: 2340 },
      to: { x: 603, y: 840 },
      durationMs: 240,
    });
  });

  it("keeps a swipe's pace inside what a finger does", () => {
    const quick = gestureFrom(
      { x: 501, y: 800, atMs: 0 },
      { x: 501, y: 300, atMs: 5 },
      box,
      screen,
    );
    const slow = gestureFrom(
      { x: 501, y: 800, atMs: 0 },
      { x: 501, y: 300, atMs: 9_000 },
      box,
      screen,
    );
    expect(quick).toMatchObject({ kind: "swipe", durationMs: 80 });
    expect(slow).toMatchObject({ kind: "swipe", durationMs: 2_000 });
  });

  it("ends a drag that leaves the screen at the screen's edge", () => {
    expect(
      gestureFrom({ x: 501, y: 457, atMs: 0 }, { x: 40, y: 1_500, atMs: 200 }, box, screen),
    ).toMatchObject({ kind: "swipe", to: { x: 0, y: 2622 } });
  });

  it("reads nothing when the press began beside the screen or the screen has no size", () => {
    expect(
      gestureFrom({ x: 120, y: 457, atMs: 0 }, { x: 501, y: 457, atMs: 200 }, box, screen),
    ).toBeUndefined();
    expect(
      gestureFrom(
        { x: 501, y: 457, atMs: 0 },
        { x: 501, y: 457, atMs: 50 },
        { ...box, width: 0 },
        screen,
      ),
    ).toBeUndefined();
  });
});

describe("reading a key pressed while the Simulator screen has focus", () => {
  it("types a character and names the keys a device understands", () => {
    expect(keyIntentFor({ key: "a" })).toEqual({ kind: "text", text: "a" });
    expect(keyIntentFor({ key: "Q" })).toEqual({ kind: "text", text: "Q" });
    expect(keyIntentFor({ key: " " })).toEqual({ kind: "text", text: " " });
    expect(keyIntentFor({ key: "Enter" })).toEqual({ kind: "key", key: "return" });
    expect(keyIntentFor({ key: "Backspace" })).toEqual({ kind: "key", key: "delete" });
    expect(keyIntentFor({ key: "Escape" })).toEqual({ kind: "key", key: "escape" });
    expect(keyIntentFor({ key: "ArrowLeft" })).toEqual({ kind: "key", key: "left" });
  });

  it("leaves shortcuts and keys a device has no use for to the app", () => {
    expect(keyIntentFor({ key: "c", metaKey: true })).toBeUndefined();
    expect(keyIntentFor({ key: "k", ctrlKey: true })).toBeUndefined();
    expect(keyIntentFor({ key: "Shift" })).toBeUndefined();
    expect(keyIntentFor({ key: "F5" })).toBeUndefined();
    // Tab moves focus out of the screen; trapping it would strand keyboard users.
    expect(keyIntentFor({ key: "Tab" })).toBeUndefined();
  });
});
