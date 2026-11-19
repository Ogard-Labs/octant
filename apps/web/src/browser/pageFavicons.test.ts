import { describe, expect, it } from "vitest";
import { forgetPageFavicons, recallPageFavicon, rememberPageFavicon } from "./pageFavicons";

const ICON_A = "data:image/png;base64,AAAA";
const ICON_B = "data:image/png;base64,BBBB";

describe("pageFavicons", () => {
  it("keeps one site's icon per profile instead of letting profiles share it", () => {
    forgetPageFavicons();
    rememberPageFavicon("profile:personal", "https://example.com/a", ICON_A);
    rememberPageFavicon("profile:project", "https://example.com/b", ICON_B);
    expect(recallPageFavicon("profile:personal", "https://example.com/c")).toBe(ICON_A);
    expect(recallPageFavicon("profile:project", "https://example.com/c")).toBe(ICON_B);
    expect(recallPageFavicon("private", "https://example.com/c")).toBeUndefined();
  });

  it("forgets a profile's icon without touching another's", () => {
    forgetPageFavicons();
    rememberPageFavicon("private", "https://example.com/", ICON_A);
    rememberPageFavicon("profile:personal", "https://example.com/", ICON_B);
    expect(recallPageFavicon("private", "https://example.com/")).toBe(ICON_A);
    expect(recallPageFavicon("profile:personal", "https://example.com/")).toBe(ICON_B);
  });
});
