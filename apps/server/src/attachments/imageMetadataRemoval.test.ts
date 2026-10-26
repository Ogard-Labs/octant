import { describe, expect, it } from "vitest";
import { removeImageMetadata } from "./imageMetadataRemoval";

const ascii = (text: string) => [...Buffer.from(text, "latin1")];

function concat(...parts: ReadonlyArray<ReadonlyArray<number> | Uint8Array>): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

function contains(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(text, "latin1"));
}

function jpegSegment(marker: number, payload: ReadonlyArray<number>): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

const JPEG_SCAN_DATA = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78];

function photographedJpeg(): Uint8Array {
  return concat(
    [0xff, 0xd8],
    jpegSegment(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    jpegSegment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPSLatitude 59.33 iPhone 15 Pro")]),
    jpegSegment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Home</x:xmpmeta>")]),
    jpegSegment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, 0x61, 0x62]),
    jpegSegment(0xed, [...ascii("Photoshop 3.0\0"), ...ascii("IPTC Byline Jane Doe")]),
    jpegSegment(0xfe, ascii("Taken at the cabin")),
    jpegSegment(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    jpegSegment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    jpegSegment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    JPEG_SCAN_DATA,
    // Progressive files may carry markers between scans; metadata there is
    // still metadata.
    jpegSegment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPSLongitude 18.06")]),
    jpegSegment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    [0x9a],
    [0xff, 0xd9],
    ascii("Samsung trailer GPS"),
  );
}

function pngChunk(type: string, data: ReadonlyArray<number>): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...ascii(type),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR = pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);

function webpChunk(type: string, data: ReadonlyArray<number>): number[] {
  const size = data.length;
  return [
    ...ascii(type),
    size & 0xff,
    (size >>> 8) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 24) & 0xff,
    ...data,
    ...(size % 2 === 1 ? [0] : []),
  ];
}

function riff(chunks: ReadonlyArray<number>): Uint8Array {
  const size = chunks.length + 4;
  return concat(
    ascii("RIFF"),
    [size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff],
    ascii("WEBP"),
    chunks,
  );
}

function gifSubBlocks(data: ReadonlyArray<number>): number[] {
  return [data.length, ...data, 0];
}

describe("removing identifying metadata from an uploaded image", () => {
  it("drops a photo's location, camera, and caption but keeps the picture and its colour profile", () => {
    const result = removeImageMetadata(photographedJpeg(), "image/jpeg");

    expect(result.status).toBe("stripped");
    if (result.status !== "stripped") return;
    for (const secret of [
      "GPSLatitude",
      "GPSLongitude",
      "iPhone",
      "xmpmeta",
      "IPTC",
      "Jane Doe",
      "cabin",
      "Samsung trailer",
    ]) {
      expect(contains(result.bytes, secret)).toBe(false);
    }
    expect(contains(result.bytes, "JFIF")).toBe(true);
    expect(contains(result.bytes, "ICC_PROFILE")).toBe(true);
    expect(Buffer.from(result.bytes).includes(Buffer.from(JPEG_SCAN_DATA))).toBe(true);
    expect([...result.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...result.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("keeps which way up a photo is shown but drops the rest of its EXIF and any JFIF thumbnail", () => {
    // Little-endian TIFF: Make, then Orientation 6 (rotate 90°), in IFD0.
    const tiff = [
      ...ascii("II*\0"),
      8,
      0,
      0,
      0,
      2,
      0,
      // Make: ASCII, 6 bytes, at offset 38.
      0x0f,
      0x01,
      2,
      0,
      6,
      0,
      0,
      0,
      38,
      0,
      0,
      0,
      // Orientation: SHORT, 1, value 6.
      0x12,
      0x01,
      3,
      0,
      1,
      0,
      0,
      0,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...ascii("Apple\0"),
    ];
    const jpeg = concat(
      [0xff, 0xd8],
      // A 1x1 thumbnail of the original picture, before any crop.
      jpegSegment(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 1, 1, ...ascii("ORG")]),
      jpegSegment(0xe1, [...ascii("Exif\0\0"), ...tiff]),
      jpegSegment(0xda, [1, 1, 0, 0, 0x3f, 0]),
      JPEG_SCAN_DATA,
      [0xff, 0xd9],
    );

    const result = removeImageMetadata(jpeg, "image/jpeg");

    expect(result.status).toBe("stripped");
    if (result.status !== "stripped") return;
    expect(contains(result.bytes, "Apple")).toBe(false);
    expect(contains(result.bytes, "ORG")).toBe(false);
    expect(contains(result.bytes, "JFIF")).toBe(true);
    const orientation = Buffer.from(result.bytes).indexOf(Buffer.from([0x01, 0x12, 0x00, 0x03]));
    expect(orientation).toBeGreaterThan(0);
    expect(result.bytes[orientation + 9]).toBe(6);
  });

  it("drops a PNG's text, EXIF, time, and unknown ancillary chunks", () => {
    const png = concat(
      PNG_SIGNATURE,
      PNG_IHDR,
      pngChunk("tEXt", ascii("Author\0Jane Doe")),
      pngChunk("iTXt", ascii("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>")),
      pngChunk("eXIf", ascii("MM\0*GPSLatitude")),
      pngChunk("tIME", [7, 234, 10, 26, 12, 0, 0]),
      pngChunk("caBX", ascii("content credentials")),
      pngChunk("pHYs", [0, 0, 11, 19, 0, 0, 11, 19, 1]),
      pngChunk("IDAT", [1, 2, 3]),
      pngChunk("IEND", []),
      ascii("trailing GPS"),
    );

    const result = removeImageMetadata(png, "image/png");

    expect(result.status).toBe("stripped");
    if (result.status !== "stripped") return;
    for (const secret of ["Jane Doe", "xmpmeta", "GPSLatitude", "tIME", "content credentials"]) {
      expect(contains(result.bytes, secret)).toBe(false);
    }
    for (const kept of ["IHDR", "pHYs", "IDAT", "IEND"]) {
      expect(contains(result.bytes, kept)).toBe(true);
    }
    expect(contains(result.bytes, "trailing")).toBe(false);
  });

  it("drops a WebP's EXIF and XMP chunks and clears the flags that announced them", () => {
    const webp = riff([
      ...webpChunk("VP8X", [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ...webpChunk("VP8 ", [1, 2, 3]),
      ...webpChunk("EXIF", ascii("GPSLatitude")),
      ...webpChunk("XMP ", ascii("<x:xmpmeta/>")),
    ]);

    const result = removeImageMetadata(webp, "image/webp");

    expect(result.status).toBe("stripped");
    if (result.status !== "stripped") return;
    expect(contains(result.bytes, "GPSLatitude")).toBe(false);
    expect(contains(result.bytes, "xmpmeta")).toBe(false);
    expect(result.bytes[20]).toBe(0);
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset);
    expect(view.getUint32(4, true)).toBe(result.bytes.byteLength - 8);
  });

  it("drops a GIF's comments and XMP but keeps its frames and looping", () => {
    const gif = concat(
      ascii("GIF89a"),
      [1, 0, 1, 0, 0x80, 0, 0],
      [0, 0, 0, 255, 255, 255],
      [0x21, 0xfe, ...gifSubBlocks(ascii("Taken at the cabin"))],
      [0x21, 0xff, 11, ...ascii("XMP DataXMP"), ...gifSubBlocks(ascii("<x:xmpmeta/>"))],
      [0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), 3, 1, 0, 0, 0],
      [0x21, 0xf9, 4, 0, 0, 0, 0, 0],
      [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, ...gifSubBlocks([0x44, 0x01])],
      [0x3b],
    );

    const result = removeImageMetadata(gif, "image/gif");

    expect(result.status).toBe("stripped");
    if (result.status !== "stripped") return;
    expect(contains(result.bytes, "cabin")).toBe(false);
    expect(contains(result.bytes, "xmpmeta")).toBe(false);
    expect(contains(result.bytes, "NETSCAPE2.0")).toBe(true);
    expect(result.bytes.at(-1)).toBe(0x3b);
  });

  it("refuses bytes that are not the image type the upload names", () => {
    expect(removeImageMetadata(photographedJpeg(), "image/png")).toEqual({
      status: "refused",
      reason: "mismatched-type",
    });
  });

  it("refuses an image type it cannot clean", () => {
    expect(removeImageMetadata(photographedJpeg(), "image/heic")).toEqual({
      status: "refused",
      reason: "unsupported-type",
    });
  });

  it("refuses a truncated image rather than passing on what it could not read", () => {
    const truncated = photographedJpeg().subarray(0, 40);
    expect(removeImageMetadata(truncated, "image/jpeg")).toEqual({
      status: "refused",
      reason: "malformed",
    });
    const noEnd = concat(PNG_SIGNATURE, PNG_IHDR, pngChunk("IDAT", [1]));
    expect(removeImageMetadata(noEnd, "image/png")).toEqual({
      status: "refused",
      reason: "malformed",
    });
  });

  it("refuses a PNG with a critical chunk it does not know, since dropping it would change the picture", () => {
    const png = concat(
      PNG_SIGNATURE,
      PNG_IHDR,
      pngChunk("ZZZZ", [1]),
      pngChunk("IDAT", [1]),
      pngChunk("IEND", []),
    );
    expect(removeImageMetadata(png, "image/png")).toEqual({
      status: "refused",
      reason: "malformed",
    });
  });
});
