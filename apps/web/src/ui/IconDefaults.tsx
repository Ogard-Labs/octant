import { LucideProvider } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The one stroke every interface icon is drawn at. Ten strokes between 1.25
 * and 3 had accumulated because each call site chose its own and nothing
 * checked them; one lighter stroke reads as one drawing hand. Call sites pass
 * no `strokeWidth`, and `iconScaleContract` refuses one that is not this.
 */
export const ICON_STROKE_WIDTH = 1.5;

/**
 * A tick or dot of 16px or less drawn inside a filled or bordered mark (a step
 * marker, a done mark, a checkbox in a mock-up). The stroke is in the icon's
 * own 24-unit grid, so 1.5 renders 0.75px at 12px and would fall under the 3:1
 * bar for graphics against an accent fill; this one renders 1.25px at 12px.
 */
export const MARK_TICK_STROKE_WIDTH = 2.5;

/** Mount once above every rendered surface, portals included. */
export function IconDefaults(props: { readonly children: ReactNode }) {
  return <LucideProvider strokeWidth={ICON_STROKE_WIDTH}>{props.children}</LucideProvider>;
}
