import { ZEN_BACKGROUND_MEDIA_TYPES, type ZenBackgroundMediaType } from "./zen";

export const MAX_ZEN_BACKGROUND_WIDTH = 4096;
export const MAX_ZEN_BACKGROUND_HEIGHT = 4096;
export const MAX_ZEN_BACKGROUND_PIXELS = 12_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export class ZenBackgroundMediaError extends Error {
  override readonly name = "ZenBackgroundMediaError";
  constructor(message: string) {
    super(message);
  }
}

export interface ZenBackgroundMediaInspection {
  readonly mediaType: ZenBackgroundMediaType;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}

export function isZenBackgroundMediaType(value: string): value is ZenBackgroundMediaType {
  return (ZEN_BACKGROUND_MEDIA_TYPES as readonly string[]).includes(value);
}

export function sniffZenBackgroundMedia(bytes: Uint8Array): ZenBackgroundMediaType | null {
  if (
    bytes.byteLength >= 24 &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value) &&
    ascii(bytes, 12, 16) === "IHDR"
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.byteLength >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.byteLength >= 6) {
    const header = ascii(bytes, 0, 6);
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  return null;
}

export function inspectZenBackgroundMedia(bytes: Uint8Array): ZenBackgroundMediaInspection {
  const mediaType = sniffZenBackgroundMedia(bytes);
  if (mediaType === null) throw new ZenBackgroundMediaError("Zen background format is invalid.");
  if (mediaType === "image/png") {
    return {
      mediaType,
      width: readUint32BE(bytes, 16),
      height: readUint32BE(bytes, 20),
      animated: false,
    };
  }
  if (mediaType === "image/jpeg") {
    return { mediaType, ...jpegDimensions(bytes), animated: false };
  }
  if (mediaType === "image/gif") {
    return { mediaType, ...gifDimensions(bytes), animated: gifIsAnimated(bytes) };
  }
  return { mediaType, ...webpDimensions(bytes), animated: webpIsAnimated(bytes) };
}

export function validateZenBackgroundDimensions(width: number, height: number): void {
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_ZEN_BACKGROUND_WIDTH ||
    height > MAX_ZEN_BACKGROUND_HEIGHT ||
    width * height > MAX_ZEN_BACKGROUND_PIXELS
  ) {
    throw new ZenBackgroundMediaError("Zen background dimensions exceed the safe limit.");
  }
}

export function extractZenBackgroundStillFrame(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly mediaType: ZenBackgroundMediaType;
} {
  const inspection = inspectZenBackgroundMedia(bytes);
  validateZenBackgroundDimensions(inspection.width, inspection.height);
  if (!inspection.animated) return { bytes, mediaType: inspection.mediaType };
  if (inspection.mediaType === "image/gif") {
    return { bytes: extractGifStillFrame(bytes), mediaType: "image/gif" };
  }
  return { bytes: extractWebpStillFrame(bytes), mediaType: "image/webp" };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) * 0x1000000)) >>>
    0
  );
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  let offset = 2;
  while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) };
    }
    if (offset + 4 > bytes.length) break;
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    offset += 2 + length;
  }
  throw new ZenBackgroundMediaError("JPEG dimensions are malformed.");
}

function gifDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  if (bytes.length < 10) throw new ZenBackgroundMediaError("GIF dimensions are malformed.");
  return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
}

function gifIsAnimated(bytes: Uint8Array): boolean {
  return countGifFrames(bytes) > 1;
}

function countGifFrames(bytes: Uint8Array): number {
  let frames = 0;
  for (const block of iterateGifBlocks(bytes)) {
    if (block.kind === "image") frames += 1;
  }
  return frames;
}

function extractGifStillFrame(bytes: Uint8Array): Uint8Array {
  const first = [...iterateGifBlocks(bytes)].find((block) => block.kind === "image");
  if (first === undefined) throw new ZenBackgroundMediaError("GIF frame is malformed.");
  const packed = bytes[10] ?? 0;
  const tableSize = packed & 0x80 ? 3 * (2 << (packed & 0x07)) : 0;
  const output = new Uint8Array(13 + tableSize + first.bytes.byteLength + 1);
  output.set(bytes.subarray(0, 13 + tableSize), 0);
  output.set(first.bytes, 13 + tableSize);
  output[output.length - 1] = 0x3b;
  return output;
}

function iterateGifBlocks(
  bytes: Uint8Array,
): Iterable<{ readonly kind: "image" | "extension"; readonly bytes: Uint8Array }> {
  return {
    *[Symbol.iterator]() {
      let offset = 13;
      const packed = bytes[10] ?? 0;
      if (packed & 0x80) offset += 3 * (2 << (packed & 0x07));
      while (offset < bytes.length) {
        const introducer = bytes[offset] ?? 0;
        if (introducer === 0x3b) return;
        if (introducer === 0x2c) {
          if (offset + 10 > bytes.length) return;
          const localPacked = bytes[offset + 9] ?? 0;
          let end = offset + 10;
          if (localPacked & 0x80) end += 3 * (2 << (localPacked & 0x07));
          end += 1;
          while (end < bytes.length && (bytes[end] ?? 0) !== 0) end += 1 + (bytes[end] ?? 0);
          end += 1;
          yield { kind: "image", bytes: bytes.subarray(offset, end) };
          offset = end;
          continue;
        }
        if (introducer === 0x21) {
          let end = offset + 2;
          while (end < bytes.length && (bytes[end] ?? 0) !== 0) end += 1 + (bytes[end] ?? 0);
          end += 1;
          yield { kind: "extension", bytes: bytes.subarray(offset, end) };
          offset = end;
          continue;
        }
        return;
      }
    },
  };
}

function webpDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  if (bytes.length < 30) throw new ZenBackgroundMediaError("WebP dimensions are malformed.");
  const fourcc = ascii(bytes, 12, 16);
  if (fourcc === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new ZenBackgroundMediaError("WebP header is malformed.");
    }
    return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
  }
  if (fourcc === "VP8X") {
    return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 };
  }
  if (fourcc === "VP8L" && bytes[20] === 0x2f) {
    const packed = readUint32LE(bytes, 21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  throw new ZenBackgroundMediaError("WebP variant is unsupported.");
}

function webpIsAnimated(bytes: Uint8Array): boolean {
  return ascii(bytes, 12, 16) === "VP8X" && ((bytes[20] ?? 0) & 0x02) === 0x02;
}

function extractWebpStillFrame(bytes: Uint8Array): Uint8Array {
  const vp8x = readWebpChunk(bytes, 12);
  if (vp8x === undefined || vp8x.fourcc !== "VP8X") {
    throw new ZenBackgroundMediaError("WebP frame is malformed.");
  }
  const stillFlags = new Uint8Array(vp8x.payload);
  stillFlags[0] = (stillFlags[0] ?? 0) & ~0x02;
  const stillVp8x = webpChunk("VP8X", stillFlags);
  let offset = vp8x.end;
  while (offset + 8 <= bytes.length) {
    const chunk = readWebpChunk(bytes, offset);
    if (chunk === undefined) break;
    if (chunk.fourcc === "ANMF") {
      const bitstream = chunk.payload.subarray(16);
      const frame = readWebpChunk(bitstream, 0);
      if (frame === undefined) throw new ZenBackgroundMediaError("WebP frame is malformed.");
      return wrapWebp([stillVp8x, webpChunk(frame.fourcc, frame.payload)]);
    }
    offset = chunk.end;
  }
  throw new ZenBackgroundMediaError("WebP frame is malformed.");
}

function readWebpChunk(
  bytes: Uint8Array,
  offset: number,
): { readonly fourcc: string; readonly payload: Uint8Array; readonly end: number } | undefined {
  if (offset + 8 > bytes.length) return undefined;
  const fourcc = ascii(bytes, offset, offset + 4);
  const size = readUint32LE(bytes, offset + 4);
  const start = offset + 8;
  const end = start + size + (size & 1);
  if (start + size > bytes.length) return undefined;
  return { fourcc, payload: bytes.subarray(start, start + size), end };
}

function webpChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const padded = payload.byteLength & 1;
  const chunk = new Uint8Array(8 + payload.byteLength + padded);
  chunk[0] = fourcc.charCodeAt(0);
  chunk[1] = fourcc.charCodeAt(1);
  chunk[2] = fourcc.charCodeAt(2);
  chunk[3] = fourcc.charCodeAt(3);
  writeUint32LE(chunk, 4, payload.byteLength);
  chunk.set(payload, 8);
  return chunk;
}

function wrapWebp(chunks: readonly Uint8Array[]): Uint8Array {
  let payload = 4;
  for (const chunk of chunks) payload += chunk.byteLength;
  const output = new Uint8Array(8 + payload);
  output.set([0x52, 0x49, 0x46, 0x46], 0);
  writeUint32LE(output, 4, payload);
  output.set([0x57, 0x45, 0x42, 0x50], 8);
  let offset = 12;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
