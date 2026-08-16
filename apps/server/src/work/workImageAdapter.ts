import { deflateSync } from "node:zlib";
import type { WorkArtifactFormat } from "@octant/contracts/work-artifacts";
import {
  WorkAdapterBudgetError,
  type WorkFormatAdapter,
  registerWorkFormatAdapter,
} from "./workFormatAdapter";
import { MAX_WORK_OUTPUT_BYTES } from "./workBudget";

/**
 * Image format adapter for Work generate-and-review artifacts. The agent
 * generates a valid PNG image from a text spec (`PNG <width> <height>
 * <#rrggbb>`); the user reviews it beside the thread. Images cannot be
 * round-tripped back to the text spec, so `decode` returns `undefined` and
 * the renderer offers external-app handoff via the existing export contract.
 * Active content is a non-goal; this encoder emits only a solid-color
 * raster. External-app handoff is handled by the existing `external-handoff`
 * export contract.
 */

const textEncoder = new TextEncoder();

/** PNG signature bytes (the first 8 bytes of every PNG file). */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * CRC-32 lookup table (PNG uses the standard CRC-32 with polynomial
 * 0xedb88320). Precomputed for performance.
 */
const CRC_TABLE: readonly number[] = (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  return table;
})();

/** Compute the CRC-32 of a byte sequence (PNG chunk CRC covers type + data). */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const entry = CRC_TABLE[(crc ^ bytes[i]!) & 0xff];
    crc = (entry ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Parse a `#rrggbb` hex color into RGB components. Throws on invalid format. */
function parseColor(hex: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (match === null) {
    throw new Error(`invalid color spec: ${hex}`);
  }
  const value = match[1];
  if (value === undefined) throw new Error(`invalid color spec: ${hex}`);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/**
 * Parse an image spec line of the form `PNG <width> <height> <#rrggbb>`.
 * Throws on invalid format so the mutation service surfaces `parse-failed`.
 */
function parseImageSpec(content: string): {
  width: number;
  height: number;
  color: { r: number; g: number; b: number };
} {
  const trimmed = content.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 4 || parts[0] !== "PNG") {
    throw new Error(`invalid image spec: expected "PNG <width> <height> <#rrggbb>"`);
  }
  const widthRaw = parts[1] ?? "";
  const heightRaw = parts[2] ?? "";
  // Strict decimal-integer validation: `parseInt` accepts numeric prefixes
  // like "10px", "1.5", or "1e6", which would silently coerce to a wrong
  // dimension. Reject anything that is not a pure run of decimal digits.
  if (!/^\d+$/.test(widthRaw) || !/^\d+$/.test(heightRaw)) {
    throw new Error(`invalid image dimensions: width and height must be positive integers`);
  }
  const width = Number.parseInt(widthRaw, 10);
  const height = Number.parseInt(heightRaw, 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid image dimensions: width and height must be positive integers`);
  }
  const color = parseColor(parts[3] ?? "");
  return { width, height, color };
}

/** Build a PNG chunk: 4-byte length + 4-byte type + data + 4-byte CRC. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = textEncoder.encode(type);
  const crcInput = new Uint8Array(typeBytes.byteLength + data.byteLength);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.byteLength);
  const crc = crc32(crcInput);

  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength, false); // big-endian length
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.byteLength, crc, false); // big-endian CRC
  return chunk;
}

/**
 * Generate a valid PNG (solid color) from an image spec. The PNG contains
 * the signature, an IHDR chunk, a single IDAT chunk (zlib-compressed raw
 * scanlines with filter byte 0 per row), and an IEND chunk. No external
 * library is used beyond Node's `zlib.deflateSync` for compression.
 */
function encodeImage(content: string): Uint8Array {
  const { width, height, color } = parseImageSpec(content);

  // Preflight the projected raw pixel buffer size before allocating. A spec
  // like `PNG 50000 50000` passes the input budget but would try to reserve
  // ~7.5 GB for the uncompressed scanlines. Reject early so the mutation
  // service's try/catch surfaces this as `oversize` instead of an OOM.
  const rowBytes = width * 3;
  const projectedRawBytes = height * (1 + rowBytes);
  if (projectedRawBytes > MAX_WORK_OUTPUT_BYTES || projectedRawBytes > Number.MAX_SAFE_INTEGER) {
    throw new WorkAdapterBudgetError(
      `image dimensions exceed output budget: ${width}x${height} requires ${projectedRawBytes} bytes`,
    );
  }

  // IHDR data: width (4) + height (4) + bit depth (1) + color type (1) + compression (1) + filter (1) + interlace (1)
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  // Raw scanlines: each row starts with a filter byte (0 = None) followed by RGB pixels.
  const raw = new Uint8Array(projectedRawBytes);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    raw[pos] = 0; // filter byte: None
    pos += 1;
    for (let x = 0; x < width; x += 1) {
      raw[pos] = color.r;
      raw[pos + 1] = color.g;
      raw[pos + 2] = color.b;
      pos += 3;
    }
  }

  const idat = deflateSync(raw);

  // Assemble: signature + IHDR + IDAT + IEND
  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", idat);
  const iendChunk = pngChunk("IEND", new Uint8Array(0));

  const total =
    PNG_SIGNATURE.byteLength + ihdrChunk.byteLength + idatChunk.byteLength + iendChunk.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  result.set(PNG_SIGNATURE, offset);
  offset += PNG_SIGNATURE.byteLength;
  result.set(ihdrChunk, offset);
  offset += ihdrChunk.byteLength;
  result.set(idatChunk, offset);
  offset += idatChunk.byteLength;
  result.set(iendChunk, offset);
  return result;
}

/**
 * Image format adapter. Images can be generated (`canCreate`) and exported
 * same-format (`canExport`) but not round-trip edited (`canMutate` and
 * `canRoundTrip` are false). There are no derived export formats.
 */
const imageAdapter: WorkFormatAdapter = {
  format: "image" as WorkArtifactFormat,
  encode: encodeImage,
  decode: () => undefined,
  capabilities: {
    canRead: true,
    canCreate: true,
    // canMutate allows rename/delete and full-content revise (replace the image
    // entirely). canRoundTrip is false because an image cannot be safely
    // decoded back to the original spec for structural edits; same-format
    // transform is denied by the authority check's canRoundTrip gate.
    canMutate: true,
    canRoundTrip: false,
    canExport: true,
    canVersion: true,
  },
  exportFormats: [],
  convertTo: (targetFormat, sourceBytes) => (targetFormat === "image" ? sourceBytes : undefined),
};

registerWorkFormatAdapter(imageAdapter);

export { imageAdapter as workImageAdapter };
