import type { ImageSourcePropType } from "react-native";

/**
 * Bundled Distilled atmospheric canvases.
 * Light: wireframe mesh technical canvas.
 * Dark: monochrome aurora for liquid-glass depth.
 * Drawn under translucent glass — not opaque wallpapers.
 */
export const themeAtmosphereSources = {
  light: require("../assets/backgrounds/canvas-light-wireframe.jpg") as ImageSourcePropType,
  dark: require("../assets/backgrounds/canvas-dark-aurora.jpg") as ImageSourcePropType,
} as const;

/** Image opacity over the solid canvas fill so glass remains readable. */
export const themeAtmosphereOpacity = {
  light: 0.58,
  /** Keep dark aurora quiet so UI chrome stays primary. */
  dark: 0.36,
} as const;
