import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The chunks that say how to read the RGB values: an ICC profile, gamma,
 * chromaticities and the sRGB intent. They describe colour, not alpha, so the
 * RGB re-encode keeps them; dropping them would change how the icon renders.
 */
const COLOUR_CHUNKS: ReadonlySet<string> = new Set(["iCCP", "sRGB", "gAMA", "cHRM"]);

export type PngOpacity =
  | { readonly status: "opaque"; readonly png: Uint8Array }
  | { readonly status: "transparent" }
  | { readonly status: "unreadable" };

/**
 * Whether a PNG shows any transparency, and if not, the same image without its
 * alpha channel. An image model's PNG often stores an alpha channel whose every
 * value is opaque; App Store Connect rejects an iOS icon with an alpha channel
 * at all, so such an image is re-encoded as RGB rather than refused. Only the
 * 8-bit, non-interlaced RGBA and RGB layouts `sips` writes are read; anything
 * else is unreadable and the caller refuses it.
 */
export function pngWithoutAlpha(bytes: Uint8Array): PngOpacity {
  const parsed = parsePng(bytes);
  if (parsed === undefined) return { status: "unreadable" };
  const { width, height, colorType, data, colour } = parsed;
  const channels = colorType === 6 ? 4 : 3;
  const pixels = unfilter(data, width, height, channels);
  if (pixels === undefined) return { status: "unreadable" };
  if (channels === 3) return { status: "opaque", png: bytes };
  const rgb = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const out = y * (1 + width * 3);
    rgb[out] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      if (pixels[source + 3] !== 255) return { status: "transparent" };
      rgb[out + 1 + x * 3] = pixels[source] ?? 0;
      rgb[out + 2 + x * 3] = pixels[source + 1] ?? 0;
      rgb[out + 3 + x * 3] = pixels[source + 2] ?? 0;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return {
    status: "opaque",
    png: concat([
      Uint8Array.from(PNG_SIGNATURE),
      chunk("IHDR", header),
      ...colour,
      chunk("IDAT", new Uint8Array(deflateSync(rgb))),
      chunk("IEND", new Uint8Array()),
    ]),
  };
}

/**
 * The colour-description chunks a source carried, spliced into a PNG the
 * host re-encoded from it: the profile, gamma, chromaticities and sRGB
 * intent travel with the image so the icon keeps the colour the source
 * declared. A source that is not a readable PNG declares none, so the
 * re-encode is returned as it is.
 */
export function carryPngColour(source: Uint8Array, png: Uint8Array): Uint8Array {
  // Byte 25 of a whole PNG is the colour type in its IHDR; it is read only
  // once the bytes are long enough to hold one.
  const targetColorType = png.byteLength > 25 ? png[25] : undefined;
  const colour = pngColourChunks(source, targetColorType);
  if (colour === undefined || colour.length === 0 || !hasSignature(png)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Colour chunks belong before IDAT; right after the leading IHDR is always
  // one such place.
  const ihdrEnd = 8 + 12 + view.getUint32(8);
  if (ihdrEnd >= png.byteLength) return png;
  return concat([png.subarray(0, ihdrEnd), ...colour, png.subarray(ihdrEnd)]);
}

/**
 * The colour-description chunks a PNG declares ahead of its image data, read
 * without inflating or decoding a pixel: an indexed, interlaced or 16-bit
 * source describes colour the same way an RGB or RGBA one does, so the
 * re-encode keeps it regardless of the layout the pixels are stored in.
 * `targetColorType`, when given, is the re-encode's own colour type: an ICC
 * profile names one colour space, so it travels only when source and target
 * share a family — grayscale (0, 4) or RGB (2, 3, 6). Gamma, chromaticities
 * and the sRGB intent read the same in either.
 */
function pngColourChunks(
  bytes: Uint8Array,
  targetColorType?: number,
): ReadonlyArray<Uint8Array> | undefined {
  if (!hasSignature(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header = false;
  let sourceColorType: number | undefined;
  const colour: Uint8Array[] = [];
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    if (start + length + 4 > bytes.byteLength) return undefined;
    if (type === "IHDR") {
      header = true;
      sourceColorType = bytes[start + 9];
    } else if (
      type === "iCCP" &&
      targetColorType !== undefined &&
      colourFamily(sourceColorType) !== colourFamily(targetColorType)
    ) {
      // A profile for a grayscale source would misread an RGB re-encode.
    } else if (COLOUR_CHUNKS.has(type)) {
      colour.push(bytes.subarray(offset, start + length + 4));
    } else if (type === "IDAT" || type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  return header ? colour : undefined;
}

/** PNG colour types live in two colour spaces: grayscale (0, 4) or RGB (2, 3, 6). */
function colourFamily(colorType: number | undefined): "gray" | "rgb" | undefined {
  if (colorType === 0 || colorType === 4) return "gray";
  if (colorType === 2 || colorType === 3 || colorType === 6) return "rgb";
  return undefined;
}

function parsePng(bytes: Uint8Array):
  | {
      readonly width: number;
      readonly height: number;
      readonly colorType: 2 | 6;
      readonly data: Uint8Array;
      /** The colour-description chunks, whole, in their original order. */
      readonly colour: ReadonlyArray<Uint8Array>;
    }
  | undefined {
  if (!hasSignature(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header: { width: number; height: number; colorType: 2 | 6 } | undefined;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    if (start + length + 4 > bytes.byteLength) return undefined;
    const body = bytes.subarray(start, start + length);
    if (type === "IHDR") {
      const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        return undefined;
      }
      header = { width: bodyView.getUint32(0), height: bodyView.getUint32(4), colorType };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  if (header === undefined || idat.length === 0) return undefined;
  try {
    return {
      ...header,
      colour: pngColourChunks(bytes) ?? [],
      data: new Uint8Array(inflateSync(concat(idat))),
    };
  } catch {
    return undefined;
  }
}

/** Reverses the PNG row filters (None, Sub, Up, Average, Paeth) into raw pixels. */
function unfilter(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array | undefined {
  const stride = width * channels;
  if (data.byteLength !== height * (stride + 1)) return undefined;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[row + x] ?? 0;
      const left = x >= channels ? (pixels[out + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[out - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[out - stride + x - channels] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          value =
            raw + (toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft);
          break;
        }
        default:
          return undefined;
      }
      pixels[out + x] = value & 0xff;
    }
  }
  return pixels;
}

function hasSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.byteLength, crc32(out.subarray(4, 8 + body.byteLength)));
  return out;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
