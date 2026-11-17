import type { ReactNode } from "react";

/**
 * The one stroke every interface icon is drawn at: Lucide's own, applied inside
 * each icon. Call sites pass no `strokeWidth`, and `iconScaleContract` refuses
 * one that is not this.
 */
export const ICON_STROKE_WIDTH = 2;

/**
 * A tick or dot drawn inside a filled or bordered mark (a step marker, a done
 * mark, a checkbox in a mock-up), and the stroke a selected glyph takes. A
 * heavier line keeps the tick above the 3:1 bar for graphics against an accent
 * fill at 12px.
 */
export const MARK_TICK_STROKE_WIDTH = 2.5;

/**
 * Mount once above every rendered surface, portals included. Icons carry their
 * own stroke, so this renders its children unchanged; it stays so the surfaces
 * that mount it need no edit.
 */
export function IconDefaults(props: { readonly children: ReactNode }) {
  return props.children;
}
