import type { LucideIcon, LucideProps } from "lucide-react";
import { forwardRef } from "react";

/**
 * The weights a call site may name. The family is stroked at one width, so a
 * weight is a request for a heavier stroke, never for a filled drawing:
 * "fill" marks a selected or pressed glyph, "bold" a tick inside a filled mark.
 */
export type IconWeight = "regular" | "bold" | "fill";

export type IconProps = LucideProps & { readonly weight?: IconWeight };

/** What an icon in the app is: a sized, tinted glyph that forwards its ref. */
export type IconComponent = ReturnType<typeof forwardRef<SVGSVGElement, IconProps>>;

/** The stroke of every icon: Lucide's own, restated so the contract can read it. */
const REGULAR_STROKE = 2;

/** The stroke of a selected or pressed glyph, and of a tick inside a filled mark. */
const HEAVY_STROKE = 2.5;

/** The size an icon is drawn at when none is given. */
const DEFAULT_SIZE = 24;

function strokeFor(weight: IconWeight | undefined, strokeWidth: LucideProps["strokeWidth"]) {
  if (strokeWidth !== undefined) return strokeWidth;
  return weight === "fill" || weight === "bold" ? HEAVY_STROKE : REGULAR_STROKE;
}

/**
 * Wraps a Lucide glyph so every call site gets the same defaults: `size` is 24
 * unless given; the glyph is hidden from assistive technology unless it is
 * named; `weight` chooses the stroke; `fill` and `strokeWidth` pass through;
 * and a stable `octant-icon-<name>` class lets a test find it.
 */
export function makeIcon(name: string, Glyph: LucideIcon): IconComponent {
  const Wrapped = forwardRef<SVGSVGElement, IconProps>(function OctantIcon(props, ref) {
    const { weight, strokeWidth, className, size, ...rest } = props;
    const named = rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;
    return (
      <Glyph
        aria-hidden={named ? undefined : true}
        {...rest}
        className={
          className === undefined ? `octant-icon-${name}` : `octant-icon-${name} ${className}`
        }
        ref={ref}
        size={size ?? DEFAULT_SIZE}
        strokeWidth={strokeFor(weight, strokeWidth)}
      />
    );
  });
  Wrapped.displayName = `Icon(${name})`;
  return Wrapped;
}
