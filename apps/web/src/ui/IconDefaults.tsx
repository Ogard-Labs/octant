import { LucideProvider } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The one stroke every interface icon is drawn at. Ten strokes between 1.25
 * and 3 had accumulated because each call site chose its own and nothing
 * checked them; one lighter stroke reads as one drawing hand. Call sites pass
 * no `strokeWidth`, and `iconScaleContract` refuses one that is not this.
 */
export const ICON_STROKE_WIDTH = 1.5;

/** Mount once above every rendered surface, portals included. */
export function IconDefaults(props: { readonly children: ReactNode }) {
  return <LucideProvider strokeWidth={ICON_STROKE_WIDTH}>{props.children}</LucideProvider>;
}
