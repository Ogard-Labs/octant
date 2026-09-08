import type { ProviderDriverKind } from "@octant/contracts";
import { providerGlyphColorForKind } from "@octant/theme";
import type { ReactNode } from "react";
import { PROVIDER_LOGOS } from "./providerLogoPaths";

export interface ProviderGlyphProps {
  readonly driverKind: ProviderDriverKind | string;
  readonly displayName: string;
  readonly size?: number;
  readonly className?: string;
}

interface GlyphSpec {
  readonly mark: ReactNode;
  readonly viewBox?: string;
}

// Generic endpoint, Octant-owned, and image-provider fallback marks. They draw
// on a 16×16 grid with `currentColor`; named provider identities live in the
// licensed `PROVIDER_LOGOS` table.
const GLYPHS: Readonly<Record<string, GlyphSpec>> = {
  // Octant's own harness: the eight-sided mark, hollow, with the core lit.
  "octant-harness": {
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <path d="M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4L1.8 10.6V5.4z" />
        <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
      </g>
    ),
  },
  // A refracting prism: distinct from the photo-frame (OpenAI Image) and
  // sparkle (Gemini Image) marks, abstract rather than a vendor logo.
  "bfl-image": {
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <rect height="9.5" rx="1.4" width="11.5" x="2.25" y="3.25" />
        <path d="M8 5.4l2.7 4.7H5.3z" />
        <path d="M8 5.4v4.7" strokeWidth="1" />
      </g>
    ),
  },
  // A cut facet: a four-point diamond with a center seam, distinct in point
  // count and silhouette from the triangular prism (BFL) mark beside it.
  "ideogram-image": {
    mark: (
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5">
        <rect height="9.5" rx="1.4" width="11.5" x="2.25" y="3.25" />
        <path d="M8 5.4l2.3 2.6L8 10.6l-2.3-2.6z" />
        <path d="M8 5.4v5.2" strokeWidth="1" />
      </g>
    ),
  },
};

export function providerGlyphColor(driverKind: string): string {
  return providerGlyphColorForKind(driverKind);
}

export function ProviderGlyph(props: ProviderGlyphProps) {
  const size = props.size ?? 16;
  const spec = PROVIDER_LOGOS[props.driverKind] ?? GLYPHS[props.driverKind];
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
      viewBox={spec.viewBox ?? "0 0 16 16"}
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
