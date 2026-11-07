import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS, contrastRatio } from "@octant/theme";

/**
 * The colour each connector mark's source records for its brand, keyed by
 * connector id (the same ids as `CONNECTOR_LOGOS`). Theme data, so the hex
 * literals live here and nowhere in a view. A connector with no entry here is
 * drawn in the ink colour.
 */
export const CONNECTOR_BRAND_COLORS: Readonly<Record<string, string>> = {
  linear: "#5e6ad2",
  notion: "#000000",
  stripe: "#635bff",
  sentry: "#362d59",
  supabase: "#3fcf8e",
  vercel: "#000000",
  github: "#181717",
  figma: "#f24e1e",
  asana: "#f06a6a",
  todoist: "#e44332",
  cloudflare: "#f38020",
  "cloudflare-docs": "#f38020",
  neon: "#34d59a",
  posthog: "#000000",
  netlify: "#00c7b7",
  prisma: "#2d3748",
  railway: "#0b0d0e",
  webflow: "#146ef5",
  cloudinary: "#3448c5",
  convex: "#ee342f",
  paypal: "#002991",
  square: "#3e4348",
  zapier: "#ff4f00",
  intercom: "#6afdef",
  "mercado-pago": "#00b1ea",
  "hugging-face": "#ffd21e",
  dropbox: "#0061ff",
  box: "#0061d5",
  gitlab: "#fc6d26",
  clickup: "#7b68ee",
  miro: "#050038",
  calendly: "#006bff",
  buildkite: "#14cc80",
};

const MINIMUM_MARK_CONTRAST = 3;

/**
 * The brand colour to draw a mark in, per theme mode, or undefined where it
 * would not read on the Library tile (a near-black mark on a dark tile, a pale
 * one on a light tile) and the ink colour is used instead.
 */
export function connectorLogoInks(connectorId: string): {
  readonly light: string | undefined;
  readonly dark: string | undefined;
} {
  const brand = CONNECTOR_BRAND_COLORS[connectorId];
  const reads = (ground: string | undefined) =>
    brand !== undefined &&
    ground !== undefined &&
    contrastRatio(brand, ground) >= MINIMUM_MARK_CONTRAST;
  return {
    light: reads(DEFAULT_LIGHT_TOKENS["control"]) ? brand : undefined,
    dark: reads(DEFAULT_DARK_TOKENS["control"]) ? brand : undefined,
  };
}
