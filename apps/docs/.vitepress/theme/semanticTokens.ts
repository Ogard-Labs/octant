import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_ROLE_IDS,
} from "@octant/theme/tokens";

function renderTokenBlock(tokens: Readonly<Record<string, string>>): string {
  return THEME_TOKEN_ROLE_IDS.map((role) => `  --octant-docs-${role}: ${tokens[role]};`).join("\n");
}

export function createSemanticTokenCss(): string {
  return [
    ":root {",
    "  color-scheme: light;",
    renderTokenBlock(DEFAULT_LIGHT_TOKENS),
    "}",
    "",
    ".dark {",
    "  color-scheme: dark;",
    renderTokenBlock(DEFAULT_DARK_TOKENS),
    "}",
  ].join("\n");
}

export const SEMANTIC_TOKEN_CSS = createSemanticTokenCss();
