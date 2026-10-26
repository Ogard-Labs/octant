/**
 * Removes the metadata a photo carries about where, when, and on what it was
 * taken (EXIF, XMP, IPTC, comments, content credentials) before the host keeps
 * the image or sends it to a provider. A phone camera writes GPS coordinates
 * and the device model into every JPEG by default, and pickers differ in what
 * they strip, so the host does it once for every image a paired device sends.
 *
 * Each format keeps an allow-list of the structures that draw the picture (and
 * its colour profile and, for JPEG, which way up it is shown), and drops
 * everything else, including bytes after the
 * image's end marker, where some cameras append their own metadata. An image
 * whose structure cannot be walked to its end is refused rather than passed on
 * partly read.
 */
export type ImageMetadataRemoval =
  | { readonly status: "stripped"; readonly bytes: Uint8Array<ArrayBuffer> }
  | {
      readonly status: "refused";
      readonly reason: "unsupported-type" | "mismatched-type" | "malformed";
    };

type CleanableImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const MALFORMED: ImageMetadataRemoval = { status: "refused", reason: "malformed" };

export function removeImageMetadata(
  bytes: Uint8Array,
  declaredMediaType: string,
): ImageMetadataRemoval {
  const declared = cleanableImageType(declaredMediaType);
  if (declared === undefined) return { status: "refused", reason: "unsupported-type" };
  if (sniffImageType(bytes) !== declared) return { status: "refused", reason: "mismatched-type" };
  const cleaned = CLEANERS[declared](bytes);
  return cleaned === undefined ? MALFORMED : { status: "stripped", bytes: cleaned };
}

function cleanableImageType(mediaType: string): CleanableImageType | undefined {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/webp" ||
    normalized === "image/gif"
    ? normalized
    : undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function sniffImageType(bytes: Uint8Array): CleanableImageType | undefined {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  return undefined;
}

const CLEANERS: Readonly<
  Record<CleanableImageType, (bytes: Uint8Array) => Uint8Array<ArrayBuffer> | undefined>
> = {
  "image/jpeg": cleanJpeg,
  "image/png": cleanPng,
  "image/webp": cleanWebp,
  "image/gif": cleanGif,
};

/**
 * What a cleaner keeps, copied into one buffer as it is walked. Holding a view
 * per kept piece instead cost an object per segment: a 10 MiB upload of empty
 * JPEG markers grew the host by about 470 MB and held it for over a second.
 */
class KeptBytes {
  readonly #buffer: Uint8Array<ArrayBuffer>;
  #length = 0;

  constructor(capacity: number) {
    this.#buffer = new Uint8Array(capacity);
  }

  get length(): number {
    return this.#length;
  }

  keep(part: Uint8Array): void {
    this.#buffer.set(part, this.#length);
    this.#length += part.byteLength;
  }

  setByte(offset: number, value: number): void {
    this.#buffer[offset] = value;
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return this.#buffer.subarray(0, this.#length);
  }
}

// JPEG: APP0 JFIF (density only), APP2 ICC profile, and APP14 Adobe (the
// colour transform a CMYK decoder needs) are kept; every other APPn and COM
// segment is metadata. A JFIF thumbnail and JFXX are pictures of the original
// before any crop, so they are dropped. Of EXIF only the orientation survives,
// rewritten on its own: without it a photo picked from Files whose pixels are
// stored sideways is shown sideways.
function keptJpegSegment(
  marker: number,
  segment: Uint8Array,
  payload: Uint8Array,
): Uint8Array | undefined {
  if (marker === 0xfe) return undefined;
  if (marker < 0xe0 || marker > 0xef) return segment;
  if (marker === 0xe0) {
    return ascii(payload, 0, 5) === "JFIF\0" && payload.byteLength >= JFIF_HEADER_BYTES
      ? jfifWithoutThumbnail(payload)
      : undefined;
  }
  if (marker === 0xe1) {
    const orientation = exifOrientation(payload);
    return orientation === undefined ? undefined : orientationSegment(orientation);
  }
  if (marker === 0xe2) return ascii(payload, 0, 12) === "ICC_PROFILE\0" ? segment : undefined;
  if (marker === 0xee) return ascii(payload, 0, 5) === "Adobe" ? segment : undefined;
  return undefined;
}

/** Identifier, version, units, and densities; the thumbnail's size follows. */
const JFIF_HEADER_BYTES = 14;

function jfifWithoutThumbnail(payload: Uint8Array): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xe0,
    0x00,
    JFIF_HEADER_BYTES + 2,
    ...payload.subarray(0, JFIF_HEADER_BYTES - 2),
    0,
    0,
  ]);
}

/** The EXIF orientation when it turns or flips the picture (2 to 8). */
function exifOrientation(payload: Uint8Array): number | undefined {
  if (ascii(payload, 0, 6) !== "Exif\0\0") return undefined;
  const tiff = payload.subarray(6);
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  if (tiff.byteLength < 8) return undefined;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, little) !== 42) return undefined;
  const directory = view.getUint32(4, little);
  if (directory + 2 > tiff.byteLength) return undefined;
  const entries = view.getUint16(directory, little);
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > tiff.byteLength) return undefined;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    // One SHORT, held in the entry itself.
    if (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) {
      return undefined;
    }
    const orientation = view.getUint16(entry + 8, little);
    return orientation >= 2 && orientation <= 8 ? orientation : undefined;
  }
  return undefined;
}

/** An APP1 holding a big-endian TIFF with one tag, Orientation, and no next directory. */
function orientationSegment(orientation: number): Uint8Array {
  const segment = Uint8Array.from(ORIENTATION_SEGMENT);
  segment[ORIENTATION_VALUE_OFFSET] = orientation;
  return segment;
}

const ORIENTATION_SEGMENT = [
  // APP1, length 34, "Exif\0\0".
  0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
  // "MM", 42, the first directory at offset 8, holding one entry.
  0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
  // Orientation, SHORT, count 1, value 1 until set; then no next directory.
  0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
] as const;
const ORIENTATION_VALUE_OFFSET = 29;
const ORIENTATION_SEGMENT_BYTES = ORIENTATION_SEGMENT.length;

function cleanJpeg(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  // The orientation segment can be a few bytes longer than the EXIF it
  // replaces, and only one is kept; everything else only shrinks.
  const kept = new KeptBytes(bytes.byteLength + ORIENTATION_SEGMENT_BYTES);
  kept.keep(bytes.subarray(0, 2));
  let position = 2;
  let sawScan = false;
  let keptOrientation = false;
  while (position < bytes.byteLength) {
    if (bytes[position] !== 0xff) return undefined;
    // Fill bytes may pad a marker.
    while (bytes[position + 1] === 0xff) position += 1;
    const marker = bytes[position + 1];
    if (marker === undefined) return undefined;
    if (marker === 0xd9) {
      if (!sawScan) return undefined;
      kept.keep(bytes.subarray(position, position + 2));
      return kept.bytes();
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.keep(bytes.subarray(position, position + 2));
      position += 2;
      continue;
    }
    if (marker === 0x00 || marker === 0xd8) return undefined;
    const length = readUint16BE(bytes, position + 2);
    if (length === undefined || length < 2) return undefined;
    const end = position + 2 + length;
    if (end > bytes.byteLength) return undefined;
    const segment = keptJpegSegment(
      marker,
      bytes.subarray(position, end),
      bytes.subarray(position + 4, end),
    );
    if (segment !== undefined && !(marker === 0xe1 && keptOrientation)) {
      kept.keep(segment);
      keptOrientation ||= marker === 0xe1;
    }
    position = end;
    if (marker === 0xda) {
      sawScan = true;
      const scanEnd = entropyCodedEnd(bytes, position);
      kept.keep(bytes.subarray(position, scanEnd));
      position = scanEnd;
    }
  }
  return undefined;
}

/** The first marker after a scan's entropy-coded data: not a stuffed 0x00 or a restart. */
function entropyCodedEnd(bytes: Uint8Array, start: number): number {
  let position = start;
  while (position < bytes.byteLength) {
    if (bytes[position] === 0xff) {
      const next = bytes[position + 1];
      if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
        position += 2;
        continue;
      }
      return position;
    }
    position += 1;
  }
  return position;
}

// PNG: the chunks that draw the picture, its colour, its scale, and APNG
// animation. Text, EXIF, time, and every other ancillary chunk (including
// private ones such as content credentials) are dropped. An unknown critical
// chunk refuses the image, since the format forbids dropping one.
const KEPT_PNG_CHUNKS: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "bKGD",
  "hIST",
  "pHYs",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);

function cleanPng(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  const kept = new KeptBytes(bytes.byteLength);
  kept.keep(bytes.subarray(0, PNG_SIGNATURE.length));
  let position: number = PNG_SIGNATURE.length;
  let first = true;
  while (position + 12 <= bytes.byteLength) {
    const length = readUint32BE(bytes, position);
    if (length === undefined || length > 0x7fffffff) return undefined;
    const type = ascii(bytes, position + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return undefined;
    if (first && type !== "IHDR") return undefined;
    first = false;
    const end = position + 12 + length;
    if (end > bytes.byteLength) return undefined;
    const critical = type.charCodeAt(0) < 0x61;
    if (KEPT_PNG_CHUNKS.has(type)) {
      kept.keep(bytes.subarray(position, end));
    } else if (critical) {
      return undefined;
    }
    if (type === "IEND") return kept.bytes();
    position = end;
  }
  return undefined;
}

// WebP: image data, alpha, animation, and the colour profile are kept; EXIF,
// XMP, and unknown chunks are dropped, and the extended header's EXIF (0x08)
// and XMP (0x04) flags are cleared so no decoder looks for them.
const KEPT_WEBP_CHUNKS: ReadonlySet<string> = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ALPH",
  "ANIM",
  "ANMF",
  "ICCP",
]);
const WEBP_METADATA_FLAGS = 0x08 | 0x04;

function cleanWebp(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  const riffSize = readUint32LE(bytes, 4);
  if (riffSize === undefined || riffSize < 4) return undefined;
  const riffEnd = 8 + riffSize;
  if (riffEnd > bytes.byteLength) return undefined;
  const kept = new KeptBytes(riffEnd);
  kept.keep(bytes.subarray(0, 12));
  let sawImage = false;
  let position = 12;
  while (position < riffEnd) {
    if (position + 8 > riffEnd) return undefined;
    const type = ascii(bytes, position, 4);
    const size = readUint32LE(bytes, position + 4);
    if (size === undefined) return undefined;
    const end = position + 8 + size + (size % 2);
    if (end > riffEnd) return undefined;
    if (KEPT_WEBP_CHUNKS.has(type)) {
      if (type === "VP8X" && size < 10) return undefined;
      const flags = kept.length + 8;
      kept.keep(bytes.subarray(position, end));
      if (type === "VP8X") kept.setByte(flags, (bytes[position + 8] ?? 0) & ~WEBP_METADATA_FLAGS);
      if (type === "VP8 " || type === "VP8L" || type === "ANMF") sawImage = true;
    }
    position = end;
  }
  if (!sawImage) return undefined;
  const cleaned = kept.bytes();
  new DataView(cleaned.buffer, cleaned.byteOffset).setUint32(4, cleaned.byteLength - 8, true);
  return cleaned;
}

// GIF: graphic control and plain-text extensions draw frames, and the
// NETSCAPE2.0 / ANIMEXTS1.0 application blocks set looping. Comments and every
// other application block (XMP among them) are dropped.
const KEPT_GIF_APPLICATIONS: ReadonlySet<string> = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);

function cleanGif(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  const kept = new KeptBytes(bytes.byteLength);
  const screenEnd = 13;
  const screenPacked = bytes[10];
  if (screenPacked === undefined || bytes.byteLength < screenEnd) return undefined;
  const headerEnd = screenEnd + colorTableBytes(screenPacked);
  if (headerEnd > bytes.byteLength) return undefined;
  kept.keep(bytes.subarray(0, headerEnd));
  let position = headerEnd;
  let sawImage = false;
  while (position < bytes.byteLength) {
    const introducer = bytes[position];
    if (introducer === 0x3b) {
      if (!sawImage) return undefined;
      kept.keep(bytes.subarray(position, position + 1));
      return kept.bytes();
    }
    if (introducer === 0x2c) {
      const packed = bytes[position + 9];
      if (packed === undefined) return undefined;
      // Descriptor, local colour table, then the LZW minimum code size.
      const dataStart = position + 10 + colorTableBytes(packed) + 1;
      const end = subBlocksEnd(bytes, dataStart);
      if (end === undefined) return undefined;
      kept.keep(bytes.subarray(position, end));
      sawImage = true;
      position = end;
      continue;
    }
    if (introducer === 0x21) {
      const label = bytes[position + 1];
      const end = subBlocksEnd(bytes, position + 2);
      if (label === undefined || end === undefined) return undefined;
      const keeps =
        label === 0xf9 ||
        label === 0x01 ||
        (label === 0xff &&
          bytes[position + 2] === 11 &&
          KEPT_GIF_APPLICATIONS.has(ascii(bytes, position + 3, 11)));
      if (keeps) kept.keep(bytes.subarray(position, end));
      position = end;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function colorTableBytes(packed: number): number {
  return (packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
}

/** The offset just past a run of GIF data sub-blocks and its zero terminator. */
function subBlocksEnd(bytes: Uint8Array, start: number): number | undefined {
  let position = start;
  while (position < bytes.byteLength) {
    const size = bytes[position];
    if (size === undefined) return undefined;
    position += 1;
    if (size === 0) return position;
    position += size;
  }
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function readUint16BE(bytes: Uint8Array, offset: number): number | undefined {
  const high = bytes[offset];
  const low = bytes[offset + 1];
  return high === undefined || low === undefined ? undefined : (high << 8) | low;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint32LE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}
