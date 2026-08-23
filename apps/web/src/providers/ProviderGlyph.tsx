import azureAiLogo from "@lobehub/icons-static-svg/icons/azureai.svg?no-inline";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude.svg?no-inline";
import codexLogo from "@lobehub/icons-static-svg/icons/codex.svg?no-inline";
import devinLogo from "@lobehub/icons-static-svg/icons/devin.svg?no-inline";
import grokLogo from "@lobehub/icons-static-svg/icons/grok.svg?no-inline";
import kiloLogo from "@lobehub/icons-static-svg/icons/kilocode.svg?no-inline";
import kimiLogo from "@lobehub/icons-static-svg/icons/kimi.svg?no-inline";
import mistralLogo from "@lobehub/icons-static-svg/icons/mistral.svg?no-inline";
import ollamaLogo from "@lobehub/icons-static-svg/icons/ollama.svg?no-inline";
import openCodeLogo from "@lobehub/icons-static-svg/icons/opencode.svg?no-inline";
import piLogo from "@lobehub/icons-static-svg/icons/pi.svg?no-inline";
import type { ProviderDriverKind } from "@octant/contracts";

export interface ProviderGlyphProps {
  readonly driverKind: ProviderDriverKind | string;
  readonly displayName: string;
  readonly size?: number;
  readonly className?: string;
}

interface GlyphSpec {
  /** Brand color remains overridable by a theme or a high-contrast projection. */
  readonly color: string;
  readonly url: string;
}

/*
 * Provider-owned marks from the MIT-licensed @lobehub/icons-static-svg set.
 * They are bundled by Vite and rendered as masks, so Octant makes no network
 * request and the same vector stays legible in light, dark, and custom themes.
 * Protocol-compatible drivers intentionally keep the monogram fallback: an
 * OpenAI-shaped endpoint is not necessarily operated by OpenAI.
 */
const GLYPHS: Readonly<Partial<Record<ProviderDriverKind, GlyphSpec>>> = {
  claude: { color: "#d97757", url: claudeLogo },
  codex: { color: "var(--octant-text-secondary)", url: codexLogo },
  opencode: { color: "#8ca9c4", url: openCodeLogo },
  kilo: { color: "#8b7cf6", url: kiloLogo },
  pi: { color: "#4f8ef7", url: piLogo },
  "oh-my-pi": { color: "#e879b8", url: piLogo },
  devin: { color: "#2dbfa8", url: devinLogo },
  "mistral-vibe": { color: "#f6862b", url: mistralLogo },
  ollama: { color: "var(--octant-text-secondary)", url: ollamaLogo },
  "kimi-code": { color: "#5b6cff", url: kimiLogo },
  grok: { color: "var(--octant-text-secondary)", url: grokLogo },
  "azure-foundry": { color: "#2f88d8", url: azureAiLogo },
};

export function providerGlyphColor(driverKind: string): string {
  const spec = GLYPHS[driverKind as ProviderDriverKind];
  return `var(--octant-glyph-${driverKind}, ${spec?.color ?? "var(--octant-text-secondary)"})`;
}

export function ProviderGlyph(props: ProviderGlyphProps) {
  const size = props.size ?? 16;
  const spec = GLYPHS[props.driverKind as ProviderDriverKind];
  const className = `provider-glyph${props.className === undefined ? "" : ` ${props.className}`}`;
  if (spec === undefined) {
    return (
      <span
        aria-hidden="true"
        className={`${className} provider-glyph--monogram`}
        data-driver-kind={props.driverKind}
        style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)) }}
      >
        {monogram(props.displayName)}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} provider-glyph--brand`}
      data-driver-kind={props.driverKind}
      style={{
        width: size,
        height: size,
        color: providerGlyphColor(props.driverKind),
        maskImage: `url("${spec.url}")`,
        WebkitMaskImage: `url("${spec.url}")`,
      }}
    />
  );
}

export function monogram(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  const first = words[0]?.[0] ?? "?";
  const second = words[1]?.[0] ?? "";
  return `${first}${second}`.toUpperCase();
}
