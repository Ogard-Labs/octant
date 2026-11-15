import type { Icon, IconProps, IconWeight } from "@phosphor-icons/react";
import { forwardRef, type ReactNode } from "react";

/** What an icon in the app is: a sized, tinted glyph that forwards its ref. */
export type IconComponent = Icon;
export type { IconProps };

/** The stroke at which a call site asked for a bold tick (see MARK_TICK_STROKE_WIDTH). */
const BOLD_FROM_STROKE = 2.5;

/** The largest size drawn bold: the 12, 14 and 16 steps of the icon scale. */
const BOLD_UP_TO_SIZE = 16;

/** The size the previous family drew an icon at when none was given. */
const DEFAULT_SIZE = 24;

function weightFor(props: IconProps): IconWeight {
  if (props.weight !== undefined) return props.weight;
  // A call site that filled the glyph (a stop square, a selected star) asked
  // for the solid drawing.
  if (props.fill === "currentColor") return "fill";
  // The previous family drew a tick inside a small filled mark with a heavier
  // stroke; the family's own bold weight is that request.
  if (Number(props.strokeWidth) >= BOLD_FROM_STROKE) return "bold";
  // Bold at 16px and below, regular above. A regular stroke at 12 to 16px read
  // weak and soft beside 13px text; at 20 and 24 the same stroke is already
  // strong, and bold there reads heavy. A selected destination asks for fill.
  const size = Number(props.size ?? DEFAULT_SIZE);
  return size <= BOLD_UP_TO_SIZE ? "bold" : "regular";
}

/**
 * Wraps a glyph so a call site written for the previous family keeps working.
 * `strokeWidth` and `fill` choose a weight instead of drawing a stroke, because
 * this family is drawn as filled outlines at fixed weights; `size` defaults to
 * 24 as before; the glyph is hidden from assistive technology unless it is
 * named; and a stable `octant-icon-<name>` class lets a test find it.
 */
export function makeIcon(
  name: string,
  Glyph: Icon,
  options: { readonly mirrored?: boolean } = {},
): IconComponent {
  const Wrapped = forwardRef<SVGSVGElement, IconProps>(function OctantIcon(props, ref) {
    const { strokeWidth: _strokeWidth, fill: _fill, className, ...rest } = props;
    const named =
      rest["aria-label"] !== undefined ||
      rest["aria-labelledby"] !== undefined ||
      rest.alt !== undefined;
    return (
      <Glyph
        aria-hidden={named ? undefined : true}
        {...(options.mirrored === true ? { mirrored: true } : {})}
        {...rest}
        className={
          className === undefined ? `octant-icon-${name}` : `octant-icon-${name} ${className}`
        }
        ref={ref}
        size={rest.size ?? DEFAULT_SIZE}
        weight={weightFor(props)}
      />
    );
  });
  Wrapped.displayName = `Icon(${name})`;
  return Wrapped;
}

/**
 * Kept so the surface that mounts the icon defaults need not change: this family
 * has no provider, because the weight is chosen from the size inside each icon.
 */
export function IconProvider(props: {
  readonly children: ReactNode;
  readonly strokeWidth?: number;
}) {
  return props.children;
}
