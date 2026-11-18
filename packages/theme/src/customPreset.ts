import type { ThemeCustomContrast, ThemeCustomSeeds } from "@octant/contracts/theme";
import { contrastRatio, parseHexColor, type RgbChannels } from "./color";
import { validateThemePreset } from "./presets";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS } from "./tokens";

/**
 * The factor each contrast step puts on every derived mix: the card, control,
 * hover, border and selection washes all move one step each way from standard.
 */
export const CUSTOM_CONTRAST_SCALE: Readonly<Record<ThemeCustomContrast, number>> = {
  soft: 0.75,
  standard: 1,
  firm: 1.5,
};

export type CustomPresetResult =
  | { readonly status: "built"; readonly tokens: Readonly<Record<string, string>> }
  | { readonly status: "refused"; readonly role: string; readonly reason: string };

const toHex = (channels: RgbChannels): string =>
  `#${[channels.r, channels.g, channels.b]
    .map((value) =>
      Math.round(Math.min(255, Math.max(0, value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** `base` with `amount` (0 to 1) of `toward` mixed in, in sRGB. */
function mix(base: string, toward: string, amount: number): string {
  const a = parseHexColor(base);
  const b = parseHexColor(toward);
  const t = Math.min(1, Math.max(0, amount));
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

/**
 * Builds the full role map for one mode from three seeds and a contrast step.
 * Every role the seeds do not name keeps the mode's default, so status hues and
 * diff colours stay recognisable. A seed set that cannot keep a text role at
 * its contrast bar is refused and names the failing role; the caller keeps the
 * preset it had.
 */
export function customThemeTokens(
  seeds: ThemeCustomSeeds,
  mode: "light" | "dark",
): CustomPresetResult {
  const defaults = mode === "light" ? DEFAULT_LIGHT_TOKENS : DEFAULT_DARK_TOKENS;
  const scale = CUSTOM_CONTRAST_SCALE[seeds.contrast];
  const ground = String(seeds.ground);
  const ink = String(seeds.ink);
  const accent = String(seeds.accent);
  const wash = (amount: number) => mix(ground, ink, amount * scale);
  // The surfaces text sits on keep one fixed step off the ground: the status
  // hues are chosen against them, so the contrast step moves the controls,
  // edges and selection and leaves the reading surfaces where they are.
  const surface = (amount: number) => mix(ground, ink, amount);
  const onAccent =
    contrastRatio("#ffffff", accent) >= contrastRatio("#000000", accent) ? "#ffffff" : "#000000";
  const tokens: Record<string, string> = {
    ...defaults,
    "app-background": surface(0.015),
    chrome: surface(0.02),
    sidebar: ground,
    "sidebar-opaque": ground,
    workspace: surface(0.035),
    surface: surface(0.035),
    floating: surface(0.09),
    control: wash(0.1),
    "control-hover": wash(0.15),
    "control-pressed": wash(0.2),
    border: wash(0.14),
    "border-strong": wash(0.28),
    "divider-strong": mix(ground, ink, 0.55),
    selection: wash(0.14),
    "text-primary": ink,
    "text-secondary": mix(ink, ground, 0.26),
    "text-muted": mix(ink, ground, 0.34),
    accent,
    "accent-text": accent,
    "focus-ring": accent,
    "accent-foreground": onAccent,
    "primary-foreground": onAccent,
  };
  const known = new Set(Object.keys(defaults));
  for (const role of Object.keys(tokens)) {
    if (!known.has(role)) delete tokens[role];
  }
  const validation = validateThemePreset({
    id: "custom",
    displayName: "Custom",
    description: "Built from three seeds.",
    supportedModes: [mode],
    tokens: { [mode]: tokens },
  });
  if (!validation.valid) {
    const first = validation.errors[0] ?? "";
    const role = /tokens\.(?:light|dark)\.([a-z-]+)/.exec(first)?.[1] ?? "unknown";
    return { status: "refused", role, reason: first };
  }
  return { status: "built", tokens };
}
