export interface RgbChannels {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function parseHexColor(value: string): RgbChannels {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new Error(`Invalid hex color: ${value}`);
  }
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(channels: RgbChannels): number {
  return (
    0.2126 * channelLuminance(channels.r) +
    0.7152 * channelLuminance(channels.g) +
    0.0722 * channelLuminance(channels.b)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(parseHexColor(foreground));
  const backgroundLuminance = relativeLuminance(parseHexColor(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface OklchColor {
  /** Perceptual lightness, 0 to 1. */
  readonly l: number;
  /** Chroma; 0 is grey, 0.15 is vivid for most hues. */
  readonly c: number;
  /** Hue angle in degrees. */
  readonly h: number;
}

function linearToSrgbChannel(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const gamma = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(gamma * 255);
}

function oklchToLinearRgb(color: OklchColor): readonly [number, number, number] {
  const radians = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(radians);
  const b = color.c * Math.sin(radians);
  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(rgb: readonly [number, number, number]): boolean {
  return rgb.every((channel) => channel >= -0.0005 && channel <= 1.0005);
}

/**
 * An OKLCH colour as six-digit hex. A hue the screen cannot show at the
 * asked chroma is pulled toward grey at the same lightness until it can, so
 * a preset keeps its lightness (and its contrast) and gives up saturation
 * instead.
 */
export function oklchToHex(color: OklchColor): string {
  let chroma = Math.max(0, color.c);
  let rgb = oklchToLinearRgb({ ...color, c: chroma });
  while (!inGamut(rgb) && chroma > 0.0005) {
    chroma = Math.max(0, chroma - 0.004);
    rgb = oklchToLinearRgb({ ...color, c: chroma });
  }
  const hex = (channel: number) => linearToSrgbChannel(channel).toString(16).padStart(2, "0");
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}
