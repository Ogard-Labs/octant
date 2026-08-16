import { contrastRatio } from "./color";

export type ContrastLevel = "normal-text" | "large-text" | "ui" | "non-text";

export const MINIMUM_CONTRAST: Readonly<Record<ContrastLevel, number>> = {
  "normal-text": 4.5,
  "large-text": 3,
  ui: 3,
  "non-text": 3,
};

export function meetsContrast(
  foreground: string,
  background: string,
  level: ContrastLevel,
): boolean {
  return contrastRatio(foreground, background) >= MINIMUM_CONTRAST[level];
}
