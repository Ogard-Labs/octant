import { Platform, StyleSheet, type ViewStyle } from "react-native";
import {
  darkColors,
  lightColors,
  radii,
  type GlassMaterial,
  type ThemeColors,
  type ThemeScheme,
} from "./tokens";

export interface GlassMaterialRecipe {
  readonly fill: string;
  readonly blurIntensity: number;
  readonly blurTint: "dark" | "light" | "default";
  readonly borderColor: string;
  readonly shadowOpacity: number;
}

function buildGlassMaterials(
  c: ThemeColors,
  blurTint: "light" | "dark",
): Record<GlassMaterial, GlassMaterialRecipe> {
  return {
    ultraThin: {
      fill: blurTint === "light" ? "rgba(255, 255, 255, 0.22)" : "rgba(38, 37, 30, 0.22)",
      blurIntensity: 22,
      blurTint,
      borderColor: c.glassStroke,
      shadowOpacity: blurTint === "light" ? 0.05 : 0.24,
    },
    thin: {
      fill: c.glassFillThin,
      blurIntensity: 32,
      blurTint,
      borderColor: c.glassStroke,
      shadowOpacity: blurTint === "light" ? 0.06 : 0.28,
    },
    regular: {
      fill: c.glassFillRegular,
      blurIntensity: 48,
      blurTint,
      borderColor: c.glassStroke,
      shadowOpacity: blurTint === "light" ? 0.08 : 0.32,
    },
    thick: {
      fill: c.glassFillThick,
      blurIntensity: 62,
      blurTint,
      borderColor: c.glassStrokeStrong,
      shadowOpacity: blurTint === "light" ? 0.1 : 0.36,
    },
    chrome: {
      fill: c.glassFillChrome,
      blurIntensity: 40,
      blurTint,
      borderColor: c.glassStrokeStrong,
      shadowOpacity: blurTint === "light" ? 0.08 : 0.32,
    },
  };
}

export const lightGlassMaterials = buildGlassMaterials(lightColors, "light");
export const darkGlassMaterials = buildGlassMaterials(darkColors, "dark");

/** @deprecated Prefer useTheme().materials — static light fallback. */
export const glassMaterials = lightGlassMaterials;

export function materialsForScheme(
  scheme: ThemeScheme,
): Record<GlassMaterial, GlassMaterialRecipe> {
  return scheme === "dark" ? darkGlassMaterials : lightGlassMaterials;
}

export function glassChromeStyle(
  material: GlassMaterial = "regular",
  radius: number = radii.md,
  scheme: ThemeScheme = "light",
): ViewStyle {
  const colors = scheme === "dark" ? darkColors : lightColors;
  const recipe = materialsForScheme(scheme)[material];
  const base: ViewStyle = {
    backgroundColor: recipe.fill,
    borderRadius: radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: recipe.borderColor,
    overflow: "hidden",
  };

  if (Platform.OS === "web") {
    return {
      ...base,
      ...({
        backdropFilter: `blur(${recipe.blurIntensity}px)`,
        WebkitBackdropFilter: `blur(${recipe.blurIntensity}px)`,
        boxShadow: `0 10px 30px rgba(0,0,0,${recipe.shadowOpacity})`,
      } as ViewStyle),
    };
  }

  return {
    ...base,
    shadowColor: colors.ink,
    shadowOpacity: recipe.shadowOpacity,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  };
}

export function glassPressedOverlayFor(scheme: ThemeScheme): string {
  return scheme === "dark" ? "rgba(247, 247, 244, 0.06)" : "rgba(38, 37, 30, 0.04)";
}

/** @deprecated Prefer glassPressedOverlayFor(scheme). */
export const glassPressedOverlay = glassPressedOverlayFor("light");
