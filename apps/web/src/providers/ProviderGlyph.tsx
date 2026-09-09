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

// Generic endpoint and Octant-owned fallback marks. They draw on a 16×16 grid
// with `currentColor`; named provider identities live in the licensed
// `PROVIDER_LOGOS` table.
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
