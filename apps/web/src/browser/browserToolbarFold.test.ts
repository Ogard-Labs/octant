import { describe, expect, it } from "vitest";
import {
  addressWidth,
  BROWSER_ADDRESS_MIN_WIDTH,
  foldedTrailing,
  type BrowserToolbarTrailing,
} from "./browserToolbarFold";

const all: ReadonlyArray<BrowserToolbarTrailing> = ["status", "hold", "extensions", "profile"];

describe("which trailing icons the Browser toolbar folds into More", () => {
  it("folds nothing when three icons fit with room for the address", () => {
    expect([
      ...foldedTrailing({ rowWidth: 800, visible: ["hold", "profile"], moreHasItems: true }),
    ]).toEqual([]);
  });

  it("folds the left-most icon first when four would trail the address", () => {
    expect([...foldedTrailing({ rowWidth: 1200, visible: all, moreHasItems: true })]).toEqual([
      "status",
    ]);
  });

  it("folds from the left until the address keeps its floor, and never the profile", () => {
    const folded = foldedTrailing({ rowWidth: 300, visible: all, moreHasItems: true });
    expect([...folded]).toEqual(["status", "hold", "extensions"]);
    const drawn = all.length - folded.size;
    expect(addressWidth(300, drawn + 1)).toBeGreaterThanOrEqual(BROWSER_ADDRESS_MIN_WIDTH - 2);
  });

  it("applies only the count limit while the width is unknown", () => {
    expect([...foldedTrailing({ rowWidth: undefined, visible: all, moreHasItems: false })]).toEqual(
      ["status"],
    );
  });

  it("draws the profile alone, with no More menu, at the narrowest dock", () => {
    expect([
      ...foldedTrailing({ rowWidth: 288, visible: ["profile"], moreHasItems: false }),
    ]).toEqual([]);
    expect(addressWidth(288, 1)).toBeGreaterThanOrEqual(BROWSER_ADDRESS_MIN_WIDTH);
  });
});
