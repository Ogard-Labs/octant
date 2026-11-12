import { describe, expect, it } from "vitest";
import {
  addressWidth,
  BROWSER_ADDRESS_MIN_WIDTH,
  BROWSER_BUTTON_WIDTH,
  BROWSER_COUNTED_BUTTON_WIDTH,
  foldedTrailing,
  type BrowserToolbarTrailing,
  type BrowserToolbarTrailingItem,
} from "./browserToolbarFold";

const item = (
  id: BrowserToolbarTrailing,
  width = BROWSER_BUTTON_WIDTH,
): BrowserToolbarTrailingItem => ({
  id,
  width,
});
const all = [item("status"), item("hold"), item("extensions"), item("profile")];

describe("which trailing icons the Browser toolbar folds into More", () => {
  it("folds nothing when three icons fit with room for the address", () => {
    expect([
      ...foldedTrailing({
        rowWidth: 800,
        visible: [item("hold"), item("profile")],
        moreHasItems: true,
      }),
    ]).toEqual([]);
  });

  it("folds the left-most icon first when four would trail the address", () => {
    expect([...foldedTrailing({ rowWidth: 1200, visible: all, moreHasItems: true })]).toEqual([
      "status",
    ]);
  });

  it("folds from the left until the address keeps its floor", () => {
    const folded = foldedTrailing({ rowWidth: 310, visible: all, moreHasItems: true });
    expect([...folded]).toEqual(["status", "hold", "extensions"]);
    const drawn = all.filter((each) => !folded.has(each.id)).map((each) => each.width);
    expect(addressWidth(310, [...drawn, BROWSER_BUTTON_WIDTH])).toBeGreaterThanOrEqual(
      BROWSER_ADDRESS_MIN_WIDTH,
    );
  });

  it("counts the extensions button's count so the address still keeps its floor", () => {
    const counted = [item("extensions", BROWSER_COUNTED_BUTTON_WIDTH), item("profile")];
    // The count makes the button 12px wider, so it folds at a width where a bare one fits.
    const bare = [item("extensions"), item("profile")];
    expect(foldedTrailing({ rowWidth: 328, visible: bare, moreHasItems: true }).size).toBe(0);
    expect(
      foldedTrailing({ rowWidth: 328, visible: counted, moreHasItems: true }).has("extensions"),
    ).toBe(true);
  });

  it("keeps the address at its floor at the narrowest page-open dock by folding the profile into More", () => {
    const folded = foldedTrailing({
      rowWidth: 288,
      visible: [item("profile")],
      moreHasItems: true,
    });
    expect([...folded]).toEqual(["profile"]);
    expect(addressWidth(288, [BROWSER_BUTTON_WIDTH])).toBeGreaterThanOrEqual(
      BROWSER_ADDRESS_MIN_WIDTH,
    );
  });

  it("draws the profile alone, with no More menu, at the narrowest dock with no page", () => {
    expect([
      ...foldedTrailing({ rowWidth: 288, visible: [item("profile")], moreHasItems: false }),
    ]).toEqual([]);
  });

  it("does not fold other icons because a signed-in profile has a name", () => {
    // The name shrinks first, so the profile counts as its icon.
    const named = [item("hold"), item("profile", 106)];
    expect(foldedTrailing({ rowWidth: 340, visible: named, moreHasItems: true }).size).toBe(0);
  });

  it("applies only the count limit while the width is unknown", () => {
    expect([...foldedTrailing({ rowWidth: undefined, visible: all, moreHasItems: false })]).toEqual(
      ["status"],
    );
  });
});
