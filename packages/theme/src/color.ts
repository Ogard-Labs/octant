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
