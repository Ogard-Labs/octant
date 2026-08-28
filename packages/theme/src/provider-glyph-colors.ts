/**
 * Brand-adjacent fallback colors for provider glyphs.
 *
 * These are owned by the theme package so components do not hardcode
 * per-provider colors. Callers can still override a kind with
 * `--octant-glyph-<kind>`.
 */

export const PROVIDER_GLYPH_COLOR_FALLBACKS: Readonly<Record<string, string>> = {
  claude: "#d9885a",
  "anthropic-compatible": "#d9885a",
  opencode: "#7fa7c9",
  kilo: "#8b7cf6",
  pi: "#4f8ef7",
  "oh-my-pi": "#e879b8",
  devin: "#2dbfa8",
  "mistral-vibe": "#f6862b",
  "kimi-code": "#5b6cff",
  "azure-foundry": "#2f88d8",
};

export function providerGlyphColorForKind(
  driverKind: string,
  fallback = "var(--octant-text-secondary)",
): string {
  const color = PROVIDER_GLYPH_COLOR_FALLBACKS[driverKind];
  return `var(--octant-glyph-${driverKind}, ${color ?? fallback})`;
}
