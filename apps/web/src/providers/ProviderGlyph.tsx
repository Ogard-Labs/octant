import type { ProviderDriverKind } from "@octant/contracts";
import type { ReactNode } from "react";

export interface ProviderGlyphProps {
  readonly driverKind: ProviderDriverKind | string;
  readonly displayName: string;
  readonly size?: number;
  readonly className?: string;
}

interface GlyphSpec {
  /** Brand-adjacent fallback color; overridable via `--octant-glyph-<kind>`. */
  readonly color: string;
  readonly mark: ReactNode;
}

// Original abstract marks, one per driver kind. All draw on a 16×16 grid with
// `currentColor` so the color token can be themed. These are not vendor logos.
const GLYPHS: Readonly<Record<string, GlyphSpec>> = {
  claude: {
    color: "#d9885a",
    mark: (
      <g stroke="currentColor" strokeLinecap="round" strokeWidth="1.8">
        <path d="M8 2.5v11M2.5 8h11M4.1 4.1l7.8 7.8M11.9 4.1l-7.8 7.8" />
      </g>
    ),
  },
  "anthropic-compatible": {
    color: "#d9885a",
    mark: (
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5">
        <path d="M8 3v10M3 8h10M4.5 4.5l7 7M11.5 4.5l-7 7" />
        <circle cx="8" cy="8" r="2.4" fill="var(--octant-surface, #111)" />
      </g>
    ),
  },
  codex: {
    color: "var(--octant-text-secondary)",
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" />
        <path d="M8 5.2l2.4 1.4v2.8L8 10.8 5.6 9.4V6.6z" />
      </g>
    ),
  },
  "openai-compatible": {
    color: "var(--octant-text-secondary)",
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      </g>
    ),
  },
  cursor: {
    color: "var(--octant-text-primary)",
    mark: (
      <path
        d="M3.5 2.5l10 5.2-4.4 1.4-1.6 4.4z"
        fill="currentColor"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    ),
  },
  opencode: {
    color: "#7fa7c9",
    mark: (
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect height="11.5" rx="3" width="11.5" x="2.25" y="2.25" />
        <rect fill="currentColor" height="4" rx="1" stroke="none" width="4" x="6" y="6" />
      </g>
    ),
  },
  kilo: {
    color: "#8b7cf6",
    mark: (
      <path
        d="M8 1.8l6.2 6.2L8 14.2 1.8 8z M8 5.4L5.4 8 8 10.6 10.6 8z"
        fill="currentColor"
        fillRule="evenodd"
      />
    ),
  },
  pi: {
    color: "#4f8ef7",
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M10.6 5.4L9 9 7 7z" fill="currentColor" />
        <path d="M5.4 10.6L7 7l2 2z" />
      </g>
    ),
  },
  "oh-my-pi": {
    color: "#e879b8",
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6.2" strokeDasharray="2.6 1.9" />
        <path d="M10.6 5.4L9 9 7 7z" fill="currentColor" />
        <path d="M5.4 10.6L7 7l2 2z" />
      </g>
    ),
  },
  devin: {
    color: "#2dbfa8",
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <path d="M8 2.2l6 10.6H2z" />
        <circle cx="8" cy="9.4" r="1.4" fill="currentColor" stroke="none" />
      </g>
    ),
  },
  "mistral-vibe": {
    color: "#f6862b",
    mark: (
      <g fill="currentColor">
        <rect height="2.4" rx="0.8" width="12" x="2" y="2.6" />
        <rect height="2.4" rx="0.8" width="8.5" x="2" y="6.8" />
        <rect height="2.4" rx="0.8" width="5" x="2" y="11" />
      </g>
    ),
  },
  ollama: {
    color: "var(--octant-text-secondary)",
    mark: (
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      >
        <path d="M3 4.2L7.2 8 3 11.8M8.6 12.2h4.4" />
      </g>
    ),
  },
  "kimi-code": {
    color: "#5b6cff",
    mark: (
      <g fill="currentColor">
        <path d="M2.2 9.2c0-3 2.4-5.2 5.4-5.2 2.9 0 5.2 2 5.6 4.6l.1.5c.1.7-.5 1.3-1.2 1.3H3.4c-.7 0-1.2-.5-1.2-1.2z" />
        <path d="M12.6 4.4c.9-.7 1.6-.9 2.2-.6-.1.9-.5 1.7-1.2 2.4z" />
      </g>
    ),
  },
  "azure-foundry": {
    color: "#2f88d8",
    mark: (
      <g fill="currentColor">
        <path d="M6.2 2.5h3.2L4.6 13.5H1.5z" opacity="0.65" />
        <path d="M9.9 5.4L14.5 13.5H6.4l3.9-1.6-2.4-3.5z" />
      </g>
    ),
  },
};

export function providerGlyphColor(driverKind: string): string {
  const spec = GLYPHS[driverKind];
  return `var(--octant-glyph-${driverKind}, ${spec?.color ?? "var(--octant-text-secondary)"})`;
}

export function ProviderGlyph(props: ProviderGlyphProps) {
  const size = props.size ?? 16;
  const spec = GLYPHS[props.driverKind];
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
    <svg
      aria-hidden="true"
      className={className}
      data-driver-kind={props.driverKind}
      focusable="false"
      height={size}
      style={{ color: providerGlyphColor(props.driverKind) }}
      viewBox="0 0 16 16"
      width={size}
    >
      {spec.mark}
    </svg>
  );
}

export function monogram(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  const first = words[0]?.[0] ?? "?";
  const second = words[1]?.[0] ?? "";
  return `${first}${second}`.toUpperCase();
}
