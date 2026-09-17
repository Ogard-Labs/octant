import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { resolveEffectiveTokens } from "@octant/theme/fallback";
import { describe, expect, it } from "vitest";
import { approvalSurfacePalette } from "./approvalSurfacePalette";

describe("approvalSurfacePalette", () => {
  it("reports the roles an approval view draws, in the resolved mode", () => {
    const resolved = resolveEffectiveTokens({ ...DEFAULT_THEME_SETTINGS, mode: "dark" }, false);
    expect(approvalSurfacePalette(resolved)).toEqual({
      mode: "dark",
      surface: "#232323",
      text: "#f0f0f0",
      muted: "#a9a9a9",
      border: "#303030",
      control: "#2b2b2b",
      controlHover: "#333333",
      accent: "#f0f0f0",
      accentForeground: "#171717",
    });
  });

  it("reports nothing when the theme does not resolve every role it needs", () => {
    expect(
      approvalSurfacePalette({
        mode: "dark",
        tokens: { "text-primary": "#f0f0f0" },
        droppedOverrides: [],
      }),
    ).toBeUndefined();
  });
});
