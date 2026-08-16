import { describe, expect, it } from "vitest";
import { isApplePlatform } from "./platform";

describe("isApplePlatform", () => {
  it("reads the supported platform hint first", () => {
    expect(isApplePlatform({ userAgentData: { platform: "macOS" }, platform: "Win32" })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: "Windows" }, platform: "MacIntel" })).toBe(
      false,
    );
  });

  it("falls back to the deprecated reading the current WebKit build still answers", () => {
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: "" }, platform: "iPhone" })).toBe(true);
    expect(isApplePlatform({ platform: "Win32" })).toBe(false);
    expect(isApplePlatform({ platform: "Linux x86_64" })).toBe(false);
  });

  it("claims nothing when the host reports no platform at all", () => {
    // `undefined` would fall back to the real `globalThis.navigator`, so an
    // empty navigator is how a caller states "no platform reported".
    expect(isApplePlatform({})).toBe(false);
    expect(isApplePlatform({ userAgentData: {}, platform: "" })).toBe(false);
  });
});
