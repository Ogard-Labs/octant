import { hexToOklch, oklchToHex, type OklchColor } from "./color";

/**
 * The two data scales a Canvas chart or heatmap draws from.
 *
 * A categorical series set answers "which series is this"; a scale answers
 * "how much". They are different questions, so they are different roles: the
 * scale must read as ordered even in greyscale, which means its steps vary in
 * lightness, not only in hue.
 *
 * Both scales are derived from the palette roles rather than restated. The
 * sequential ramp keeps the teal family's hue; the diverging ramp runs from
 * the red family through a neutral grey to the blue family. Lightness bands
 * are narrower than the palette's own and stay clear of the workspace in each
 * mode, so every step clears the 3:1 a graphical mark needs (WCAG 1.4.11)
 * against the surface it is drawn on.
 */

export const CHART_SEQUENTIAL_STEPS = 5;
export const CHART_DIVERGING_STEPS = 5;

export const CHART_SEQUENTIAL_ROLE_IDS: ReadonlyArray<string> = Array.from(
  { length: CHART_SEQUENTIAL_STEPS },
  (_value, index) => `chart-sequential-${String(index + 1)}`,
);

/** Index 1 is the strongest negative, 3 the neutral midpoint, 5 the strongest positive. */
export const CHART_DIVERGING_ROLE_IDS: ReadonlyArray<string> = Array.from(
  { length: CHART_DIVERGING_STEPS },
  (_value, index) => `chart-diverging-${String(index + 1)}`,
);

export const CHART_SCALE_ROLE_IDS: ReadonlyArray<string> = [
  ...CHART_SEQUENTIAL_ROLE_IDS,
  ...CHART_DIVERGING_ROLE_IDS,
];

export interface ChartScaleSteps {
  /** Index 1 is the low end, 5 the high end. */
  readonly sequential: ReadonlyArray<string>;
  /** Index 1 is the strongest negative, 5 the strongest positive. */
  readonly diverging: ReadonlyArray<string>;
}

/** The palette roles each scale family is drawn from. */
const SEQUENTIAL_PALETTE_ROLE = "palette-teal";
const NEGATIVE_PALETTE_ROLE = "palette-red";
const POSITIVE_PALETTE_ROLE = "palette-blue";

// A mark sits on the workspace, and the workspace is the stricter ground in
// both modes. These bands keep every step at least 3:1 against it: in light
// mode against white, in dark mode against the reading surface.
const SEQUENTIAL_LIGHTNESS = {
  light: [0.6, 0.53, 0.46, 0.39, 0.32],
  dark: [0.58, 0.65, 0.72, 0.79, 0.86],
} as const;

const DIVERGING_LIGHTNESS = {
  light: [0.4, 0.5, 0.6, 0.5, 0.4],
  dark: [0.8, 0.72, 0.66, 0.72, 0.8],
} as const;

const SEQUENTIAL_CHROMA = [0.06, 0.08, 0.1, 0.12, 0.14] as const;
const DIVERGING_CHROMA = [0.14, 0.1, 0, 0.1, 0.14] as const;

function step(hue: number, chroma: number, lightness: number): string {
  const color: OklchColor = { l: lightness, c: chroma, h: hue };
  return oklchToHex(color);
}

/**
 * The scale steps for one mode, drawn from the palette roles in `palette`.
 *
 * A palette missing a role it draws from falls back to a mid grey for that
 * hue, so a custom theme that overrode nothing still gets a usable scale.
 */
export function deriveChartScales(
  mode: "light" | "dark",
  palette: Readonly<Record<string, string>>,
): ChartScaleSteps {
  const hueOf = (role: string): number => {
    const hex = palette[role];
    return hex === undefined ? 220 : hexToOklch(hex).h;
  };
  const sequentialHue = hueOf(SEQUENTIAL_PALETTE_ROLE);
  const negativeHue = hueOf(NEGATIVE_PALETTE_ROLE);
  const positiveHue = hueOf(POSITIVE_PALETTE_ROLE);

  const sequentialLightness = SEQUENTIAL_LIGHTNESS[mode];
  const sequential = sequentialLightness.map((lightness, index) =>
    step(sequentialHue, SEQUENTIAL_CHROMA[index] ?? 0.1, lightness),
  );

  const divergingLightness = DIVERGING_LIGHTNESS[mode];
  const diverging = divergingLightness.map((lightness, index) => {
    const chroma = DIVERGING_CHROMA[index] ?? 0;
    const hue = index < 2 ? negativeHue : positiveHue;
    return step(hue, chroma, lightness);
  });

  return { sequential, diverging };
}
