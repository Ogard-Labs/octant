import { describe, expect, it } from "vitest";
import {
  assertNativeTitlebarActionResult,
  assertNativeTitlebarTargetsInRail,
  assertNativeWindowMoved,
} from "./smoke-packaged-titlebar";

const bounds = { x: 100, y: 200 };

function button(label: string, y: number) {
  return { label, role: "AXButton", frame: { x: 500, y, w: 26, h: 26 } };
}

describe("packaged native titlebar smoke geometry", () => {
  it("rejects a top-strip drag that leaves the native window in place", () => {
    expect(() =>
      assertNativeWindowMoved(
        { window_bounds: bounds, elements: [] },
        { window_bounds: bounds, elements: [] },
      ),
    ).toThrow("did not move");
  });

  it("accepts a top-strip drag that changes native window bounds", () => {
    expect(() =>
      assertNativeWindowMoved(
        { window_bounds: bounds, elements: [] },
        { window_bounds: { x: 124, y: 215 }, elements: [] },
      ),
    ).not.toThrow();
  });

  it.each([
    ["bottom-panel", "Open bottom panel", "Close bottom panel"],
    ["right-dock", "Open Right sidebar", "Close Right sidebar"],
    ["sidebar", "Show sidebar", "Hide sidebar"],
  ] as const)("requires a real %s state transition", (action, beforeLabel, afterLabel) => {
    const before = {
      window_bounds: bounds,
      elements: [button(beforeLabel, 224)],
    };
    expect(() => assertNativeTitlebarActionResult(before, before, action)).toThrow(
      "did not change",
    );
    expect(() =>
      assertNativeTitlebarActionResult(
        before,
        { window_bounds: bounds, elements: [button(afterLabel, 224)] },
        action,
      ),
    ).not.toThrow();
  });

  it("requires Open in to expose a native menu item", () => {
    const before = {
      window_bounds: bounds,
      elements: [button("Open checkout in an application. Default Finder", 224)],
    };
    expect(() => assertNativeTitlebarActionResult(before, before, "open-in")).toThrow(
      "did not change",
    );
    expect(() =>
      assertNativeTitlebarActionResult(
        before,
        {
          window_bounds: bounds,
          elements: [
            button("Open checkout in an application. Default Finder", 224),
            { label: "Finder", role: "AXMenuItem" },
          ],
        },
        "open-in",
      ),
    ).not.toThrow();
  });

  it("requires Environment to expose its dialog", () => {
    const before = {
      window_bounds: bounds,
      elements: [button("Toggle environment", 224)],
    };
    expect(() => assertNativeTitlebarActionResult(before, before, "environment")).toThrow(
      "did not change",
    );
    expect(() =>
      assertNativeTitlebarActionResult(
        before,
        {
          window_bounds: bounds,
          elements: [button("Toggle environment", 224), { label: "Environment", role: "AXDialog" }],
        },
        "environment",
      ),
    ).not.toThrow();
  });

  it("accepts controls layered into the compact native title rail", () => {
    expect(() =>
      assertNativeTitlebarTargetsInRail(
        {
          window_bounds: bounds,
          elements: [button("Open bottom panel", 200 + 10)],
        },
        30,
        ["Open bottom panel"],
      ),
    ).not.toThrow();
  });

  it("rejects controls whose centers drift below the compact title rail", () => {
    expect(() =>
      assertNativeTitlebarTargetsInRail(
        {
          window_bounds: bounds,
          elements: [button("Open bottom panel", 200 + 24)],
        },
        30,
        ["Open bottom panel"],
      ),
    ).toThrow("outside the compact title rail");
  });

  it("accepts controls centered exactly on the compact rail boundary", () => {
    expect(() =>
      assertNativeTitlebarTargetsInRail(
        {
          window_bounds: bounds,
          elements: [button("Open bottom panel", 200 + 11)],
        },
        24,
        ["Open bottom panel"],
      ),
    ).not.toThrow();
  });

  it("matches the dynamic default application suffix on Open in", () => {
    expect(() =>
      assertNativeTitlebarTargetsInRail(
        {
          window_bounds: bounds,
          elements: [
            button("Open checkout in an application. Default Visual Studio Code", 200 + 24),
          ],
        },
        40,
        ["Open checkout in an application."],
      ),
    ).not.toThrow();
  });
});
