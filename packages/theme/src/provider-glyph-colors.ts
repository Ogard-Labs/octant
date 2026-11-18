/**
 * Brand-adjacent fallback colors for provider glyphs.
 *
 * These are owned by the theme package so components do not hardcode
 * per-provider colors. Callers can still override a kind with
 * `--octant-glyph-<kind>`.
 *
 * A provider whose own mark is black or white (an ink mark with no colour of
 * its own) is left out on purpose: it draws in the text ink, which is its
 * colour. The renderer drops every colour under the Mono style, where a logo
 * is an ink mark like any other glyph.
 */

export const PROVIDER_GLYPH_COLOR_FALLBACKS: Readonly<Record<string, string>> = {
  claude: "#d9885a",
  "anthropic-compatible": "#d9885a",
  codex: "#10a37f",
  "openai-image": "#10a37f",
  copilot: "#8957e5",
  gemini: "#5b8def",
  glm: "#3859ff",
  qwen: "#615ced",
  opencode: "#7fa7c9",
  kilo: "#8b7cf6",
  pi: "#4f8ef7",
  "oh-my-pi": "#e879b8",
  devin: "#2dbfa8",
  "mistral-vibe": "#f6862b",
  "kimi-code": "#5b6cff",
  "azure-foundry": "#2f88d8",
  "gemini-native-image": "#5b8def",
};

export function providerGlyphColorForKind(
  driverKind: string,
  fallback = "var(--octant-text-secondary)",
): string {
  const color = PROVIDER_GLYPH_COLOR_FALLBACKS[driverKind];
  return `var(--octant-glyph-${driverKind}, ${color ?? fallback})`;
}
