/**
 * Colour arithmetic for palette faces, so a tile can take a hue's tint or a
 * mix of the hue and its foreground the way the desktop's `color-mix` does.
 * Only `#rrggbb` theme values come through here; anything else is returned as
 * given rather than guessed at.
 */

function channels(hex: string): readonly [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) return undefined;
  const value = Number.parseInt(match[1] ?? "", 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The hue at `alpha` opacity, for a tint over the page. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = channels(hex);
  if (rgb === undefined) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.min(1, Math.max(0, alpha))})`;
}

/** `amount` of `a` mixed into `b`, as an opaque colour. */
export function mix(a: string, b: string, amount: number): string {
  const first = channels(a);
  const second = channels(b);
  if (first === undefined || second === undefined) return a;
  const t = Math.min(1, Math.max(0, amount));
  const part = (index: 0 | 1 | 2) =>
    Math.round(first[index] * t + second[index] * (1 - t))
      .toString(16)
      .padStart(2, "0");
  return `#${part(0)}${part(1)}${part(2)}`;
}
