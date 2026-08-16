import { describe, expect, it } from "vitest";
import { workImageAdapter } from "./workImageAdapter";

const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Read a 4-byte big-endian unsigned integer from a byte offset. */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/** Read a 4-byte ASCII chunk type starting at a byte offset. */
function readChunkType(bytes: Uint8Array, offset: number): string {
  return textDecoder.decode(bytes.subarray(offset, offset + 4));
}

describe("workImageAdapter", () => {
  it("encode produces bytes starting with the PNG signature", () => {
    const bytes = workImageAdapter.encode("PNG 2 2 #ff0000");
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });

  it("the generated PNG contains IHDR, IDAT, and IEND chunks at expected offsets", () => {
    const bytes = workImageAdapter.encode("PNG 4 4 #00ff00");
    // After the 8-byte signature, each chunk is: 4-byte length + 4-byte type + data + 4-byte CRC.
    const ihdrOffset = 8;
    expect(readChunkType(bytes, ihdrOffset + 4)).toBe("IHDR");
    const ihdrLength = readUint32(bytes, ihdrOffset);
    expect(ihdrLength).toBe(13); // IHDR is always 13 bytes.

    const idatOffset = ihdrOffset + 12 + ihdrLength;
    expect(readChunkType(bytes, idatOffset + 4)).toBe("IDAT");
    const idatLength = readUint32(bytes, idatOffset);
    expect(idatLength).toBeGreaterThan(0);

    const iendOffset = idatOffset + 12 + idatLength;
    expect(readChunkType(bytes, iendOffset + 4)).toBe("IEND");
    const iendLength = readUint32(bytes, iendOffset);
    expect(iendLength).toBe(0); // IEND has no data.
  });

  it("the IHDR chunk encodes the correct width, height, and color type", () => {
    const bytes = workImageAdapter.encode("PNG 10 6 #ff0000");
    const ihdrDataOffset = 8 + 8; // signature + length + type
    expect(readUint32(bytes, ihdrDataOffset)).toBe(10); // width
    expect(readUint32(bytes, ihdrDataOffset + 4)).toBe(6); // height
    expect(bytes[ihdrDataOffset + 8]).toBe(8); // bit depth
    expect(bytes[ihdrDataOffset + 9]).toBe(2); // color type: truecolor RGB
  });

  it("encode throws on an invalid spec", () => {
    expect(() => workImageAdapter.encode("not an image")).toThrow();
  });

  it("encode throws on an invalid color", () => {
    expect(() => workImageAdapter.encode("PNG 2 2 red")).toThrow();
  });

  it("encode throws on non-positive dimensions", () => {
    expect(() => workImageAdapter.encode("PNG 0 2 #ff0000")).toThrow();
  });

  it("encode throws when image dimensions would exceed the output budget", () => {
    // PNG 50000 50000 would require ~7.5 GB of raw pixel buffer.
    expect(() => workImageAdapter.encode("PNG 50000 50000 #000000")).toThrow();
  });

  it("encode succeeds for a reasonable image size within the budget", () => {
    const bytes = workImageAdapter.encode("PNG 100 100 #ff0000");
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
  });

  it("encode throws on partial numeric dimensions (10px)", () => {
    expect(() => workImageAdapter.encode("PNG 10px 20 #00ff00")).toThrow();
  });

  it("encode throws on partial numeric dimensions (1.5)", () => {
    expect(() => workImageAdapter.encode("PNG 1.5 2 #00ff00")).toThrow();
  });

  it("encode throws on partial numeric dimensions (1e6)", () => {
    expect(() => workImageAdapter.encode("PNG 1e6 2 #00ff00")).toThrow();
  });

  it("encode accepts valid pure-decimal dimensions", () => {
    expect(() => workImageAdapter.encode("PNG 10 20 #00ff00")).not.toThrow();
  });

  it("decode always returns undefined", () => {
    const bytes = workImageAdapter.encode("PNG 2 2 #ff0000");
    expect(workImageAdapter.decode(bytes)).toBeUndefined();
  });

  it("convertTo(image, bytes) returns the same bytes", () => {
    const bytes = workImageAdapter.encode("PNG 2 2 #ff0000");
    const result = workImageAdapter.convertTo("image", bytes);
    expect(result).toBe(bytes);
  });

  it("convertTo(pdf, bytes) returns undefined", () => {
    const bytes = workImageAdapter.encode("PNG 2 2 #ff0000");
    expect(workImageAdapter.convertTo("pdf", bytes)).toBeUndefined();
  });

  it("reports canMutate true (rename/delete/revise), canRoundTrip false, canCreate true", () => {
    expect(workImageAdapter.capabilities.canMutate).toBe(true);
    expect(workImageAdapter.capabilities.canRoundTrip).toBe(false);
    expect(workImageAdapter.capabilities.canCreate).toBe(true);
    expect(workImageAdapter.capabilities.canExport).toBe(true);
    expect(workImageAdapter.capabilities.canRead).toBe(true);
    expect(workImageAdapter.capabilities.canVersion).toBe(true);
  });

  it("has empty exportFormats", () => {
    expect(workImageAdapter.exportFormats).toEqual([]);
  });
});
