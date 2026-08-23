import { describe, expect, it } from "vitest";
import { assertNativeTitlebarTargetsBelowInset } from "./smoke-packaged-titlebar";

const bounds = { x: 100, y: 200 };

function button(label: string, y: number) {
  return { label, role: "AXButton", frame: { x: 500, y, w: 26, h: 26 } };
}

describe("packaged native titlebar smoke geometry", () => {
  it("rejects controls whose centers are inside hiddenInset's native strip", () => {
    expect(() =>
      assertNativeTitlebarTargetsBelowInset(
        {
          window_bounds: bounds,
          elements: [button("Open bottom panel", 200 + 10)],
        },
        24,
        ["Open bottom panel"],
      ),
    ).toThrow("inside the native movement strip");
  });

  it("accepts controls whose centers are below the native strip", () => {
    expect(() =>
      assertNativeTitlebarTargetsBelowInset(
        {
          window_bounds: bounds,
          elements: [button("Open bottom panel", 200 + 24)],
        },
        24,
        ["Open bottom panel"],
      ),
    ).not.toThrow();
  });
});
