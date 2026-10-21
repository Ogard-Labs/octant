import { describe, expect, it } from "vitest";
import { isManagedWallpaperUri, managedWallpaperName } from "./managedWallpaper";

const DOCS = "file:///var/mobile/Documents/";

describe("managed wallpaper copies", () => {
  it("owns the copies the app names itself in its documents folder", () => {
    expect(isManagedWallpaperUri(`${DOCS}${managedWallpaperName(1760000000000)}`, DOCS)).toBe(true);
    expect(isManagedWallpaperUri(`${DOCS}background-5.jpg`, "file:///var/mobile/Documents")).toBe(
      true,
    );
  });

  it("never owns a user's photo, a picker cache file, or an inline image", () => {
    expect(isManagedWallpaperUri("file:///var/mobile/Pictures/IMG_0001.jpg", DOCS)).toBe(false);
    expect(isManagedWallpaperUri("file:///var/mobile/Caches/background-5.jpg", DOCS)).toBe(false);
    expect(isManagedWallpaperUri(`${DOCS}notes.jpg`, DOCS)).toBe(false);
    expect(isManagedWallpaperUri(`${DOCS}sub/background-5.jpg`, DOCS)).toBe(false);
    expect(isManagedWallpaperUri("data:image/png;base64,AAAA", DOCS)).toBe(false);
  });
});
