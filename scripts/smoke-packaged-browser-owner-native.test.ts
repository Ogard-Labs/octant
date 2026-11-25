import { describe, expect, it } from "vitest";
import { workModeEntryReady } from "./smoke-packaged-browser-owner-native";

// Rows as the packaged app's accessibility tree gave them: Settings lists its
// Work section by title, and the app's Work button carries a description.
const settingsWorkRow = "AXButton | Work |  | ";
const appWorkRow = "AXButton |  | Work | ";

describe("packaged Browser owner native smoke", () => {
  it("keeps waiting while Settings is open with a Work section of its own", () => {
    expect(
      workModeEntryReady(["AXButton |  | Close Settings | ", settingsWorkRow].join("\n")),
    ).toBe(false);
    expect(workModeEntryReady(["AXButton | Back to app |  | ", settingsWorkRow].join("\n"))).toBe(
      false,
    );
  });

  it("waits for Settings to leave while the app's Work button is already drawn behind it", () => {
    expect(
      workModeEntryReady(
        [appWorkRow, "AXButton |  | Close Settings | ", settingsWorkRow].join("\n"),
      ),
    ).toBe(false);
  });

  it("keeps waiting once Settings is gone until the app's Work button is drawn", () => {
    expect(workModeEntryReady("AXButton |  | Code | ")).toBe(false);
  });

  it("finds the app's Work button once Settings is gone", () => {
    expect(workModeEntryReady([appWorkRow, "AXButton |  | Code | "].join("\n"))).toBe(true);
  });
});
