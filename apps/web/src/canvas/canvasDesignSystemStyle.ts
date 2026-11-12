import type { CanvasDesignSystem } from "@octant/contracts/canvas";
import { canvasDesignSystemProperties } from "@octant/domain/canvas-design-system-policy";
import type { CSSProperties } from "react";

/**
 * The inline custom properties that make a Canvas's typed blocks draw with its
 * design system, or undefined when it follows none. Set on the document and
 * on any surface drawn outside it (a deck's player opens in a dialog), so a
 * chart reads the same wherever it is shown.
 */
export function canvasDesignSystemStyle(
  designSystem: CanvasDesignSystem | undefined,
): CSSProperties | undefined {
  const properties = canvasDesignSystemProperties(designSystem);
  if (properties.length === 0) return undefined;
  // React passes a custom property through its style object by name.
  const style: Record<string, string> = Object.fromEntries(properties);
  return style;
}
