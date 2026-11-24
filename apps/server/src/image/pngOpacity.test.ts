import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { carryPngColour, pngWithoutAlpha } from "./pngOpacity";

/**
 * A 10×10 RGBA PNG whose rows use every filter in turn (row y uses filter
 * y % 5), encoded outside Octant and checked with an independent decoder.
 * Pixel (x, y) is ((37x + 11y) % 256, (5x + 53y) % 256, (7xy) % 256, 255).
 */
const EVERY_FILTER_RGBA =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAA4klEQVR4nI3Pv2rCUBgF8OOfi2gghdZIhFwJDaIEK6QQlVoa6NBB8A2Ezu3iK7TQsaODT+Dq7DO49QF8hi6dT08cqovY4cd3h49zvwMAbBtwUgPnF+CiDm6a4K4FliKw2wWnN2DBSfPFCs4pahFOWhFXPAkkklgSGUmGUuMVb7514dtL8aQpgYRY2kizIzHK+0RFO0aJRokm+NM+emNYBWduxPerJ678F27tJ7+v1/Q6X7zr/fA58fkxGLPw+JCXiXHO/8vczvMyoQ4+HL60fc1EUhnJ/akyStR3jlGiUaLJ8As2TD6JRfrVGAAAAABJRU5ErkJggg==";

function rowsOf(png: Uint8Array): ReadonlyArray<ReadonlyArray<number>> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  let offset = 8;
  const parts: Uint8Array[] = [];
  while (offset < png.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(parts)));
  const rows: Array<ReadonlyArray<number>> = [];
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + width * 3);
    // The re-encoded image uses filter None on every row.
    expect(raw[start]).toBe(0);
    rows.push([...raw.subarray(start + 1, start + 1 + width * 3)]);
  }
  return rows;
}

function rgbaPng(width: number, height: number, alphaAt: (x: number, y: number) => number) {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      raw.set([10, 20, 30, alphaAt(x, y)], y * (1 + width * 4) + 1 + x * 4);
    }
  }
  const base = Buffer.from(EVERY_FILTER_RGBA, "base64");
  // Reuse the fixture's signature and IHDR layout with a new size and data.
  const header = Buffer.from(base.subarray(0, 33));
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const idatBody = deflateSync(raw);
  const idat = Buffer.alloc(12 + idatBody.byteLength);
  idat.writeUInt32BE(idatBody.byteLength, 0);
  idat.write("IDAT", 4, "latin1");
  idatBody.copy(idat, 8);
  return new Uint8Array(
    Buffer.concat([header, idat, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0])]),
  );
}

describe("PNG opacity", () => {
  it("decodes every row filter and re-encodes an opaque image as RGB with the same pixels", () => {
    const result = pngWithoutAlpha(new Uint8Array(Buffer.from(EVERY_FILTER_RGBA, "base64")));
    if (result.status !== "opaque") throw new Error(result.status);
    expect(result.png[25]).toBe(2);
    const rows = rowsOf(result.png);
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        expect(rows[y]?.slice(x * 3, x * 3 + 3)).toEqual([
          (37 * x + 11 * y) % 256,
          (5 * x + 53 * y) % 256,
          (7 * x * y) % 256,
        ]);
      }
    }
  });

  it("finds a single transparent pixel", () => {
    expect(pngWithoutAlpha(rgbaPng(4, 4, (x, y) => (x === 3 && y === 2 ? 254 : 255)))).toEqual({
      status: "transparent",
    });
  });

  it("calls bytes that are not a PNG it can read unreadable", () => {
    expect(pngWithoutAlpha(Uint8Array.from([1, 2, 3]))).toEqual({ status: "unreadable" });
  });

  it("keeps the chunks that say how to read the colours, byte for byte, when it drops the alpha channel", () => {
    const source = Buffer.from(EVERY_FILTER_RGBA, "base64");
    // A valid gAMA chunk for gamma 1.0 (100000), placed after IHDR as PNG requires.
    const body = Buffer.from([0x67, 0x41, 0x4d, 0x41, 0, 1, 0x86, 0xa0]);
    const gama = Buffer.alloc(12 + 4);
    gama.writeUInt32BE(4, 0);
    body.copy(gama, 4);
    gama.writeUInt32BE(crc32(body), 12);
    const tagged = Buffer.concat([source.subarray(0, 33), gama, source.subarray(33)]);
    const result = pngWithoutAlpha(new Uint8Array(tagged));
    if (result.status !== "opaque") throw new Error(result.status);
    const out = Buffer.from(result.png);
    // The same 16 bytes, CRC included, straight after the RGB IHDR.
    expect(out.subarray(33, 49).equals(gama)).toBe(true);
    expect(out[25]).toBe(2);
  });

  it("carries an indexed source's colour chunks into a re-encode without reading its pixels", () => {
    const source = Buffer.from(EVERY_FILTER_RGBA, "base64");
    // A colourType-3 (palette) header: the opacity parser refuses its pixels,
    // but the colour description a re-encode carries is read from chunks alone.
    const ihdr = Buffer.from(source.subarray(0, 33));
    ihdr[25] = 3;
    const body = Buffer.from([0x67, 0x41, 0x4d, 0x41, 0, 1, 0x86, 0xa0]);
    const gama = Buffer.alloc(12 + 4);
    gama.writeUInt32BE(4, 0);
    body.copy(gama, 4);
    gama.writeUInt32BE(crc32(body), 12);
    const indexed = Buffer.concat([ihdr, gama, source.subarray(33)]);
    const reencoded = pngWithoutAlpha(new Uint8Array(source));
    if (reencoded.status !== "opaque") throw new Error(reencoded.status);
    const carried = carryPngColour(new Uint8Array(indexed), reencoded.png);
    expect(Buffer.from(carried).subarray(33, 49).equals(gama)).toBe(true);
  });

  it("carries a grayscale source's ICC profile only into a grayscale re-encode", () => {
    const source = pngWith(0, [iccpChunk, gamaChunk]);
    // A grayscale destination shares the source's colour family, so the
    // profile travels with the gamma.
    expect(chunkTypes(carryPngColour(source, pngWith(4, [])))).toEqual([
      "IHDR",
      "iCCP",
      "gAMA",
      "IDAT",
      "IEND",
    ]);
    // An RGB re-encode would misread a grayscale profile: gamma still travels.
    expect(chunkTypes(carryPngColour(source, pngWith(6, [])))).toEqual([
      "IHDR",
      "gAMA",
      "IDAT",
      "IEND",
    ]);
  });

  it("carries an RGB or palette source's ICC profile into an RGB or RGBA re-encode", () => {
    const iccp = chunkBytes("iCCP", new TextEncoder().encode("sRGB\0\0profile"));
    for (const sourceType of [2, 3, 6] as const) {
      for (const targetType of [2, 6] as const) {
        expect(
          chunkTypes(carryPngColour(pngWith(sourceType, [iccp]), pngWith(targetType, []))),
        ).toEqual(["IHDR", "iCCP", "IDAT", "IEND"]);
      }
    }
  });

  it("carries gamma, chromaticities and the sRGB intent across colour families", () => {
    const source = pngWith(0, [gamaChunk, chrmChunk, srgbChunk]);
    expect(chunkTypes(carryPngColour(source, pngWith(6, [])))).toEqual([
      "IHDR",
      "gAMA",
      "cHRM",
      "sRGB",
      "IDAT",
      "IEND",
    ]);
  });
});

/** A whole PNG: signature, one-colour-type IHDR, the given ancillary chunks, IDAT, IEND. */
function pngWith(colorType: number, ancillary: ReadonlyArray<Uint8Array>): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr.set([8, colorType, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkBytes("IHDR", ihdr),
    ...ancillary,
    chunkBytes("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 0])))),
    chunkBytes("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A whole PNG chunk: length, type, body and a valid CRC. */
function chunkBytes(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.byteLength, crc32(out.subarray(4, 8 + body.byteLength)));
  return out;
}

const iccpChunk = chunkBytes("iCCP", new TextEncoder().encode("gray\0\0profile"));
const gamaChunk = chunkBytes("gAMA", Uint8Array.from([0, 1, 0x86, 0xa0]));
const chrmChunk = chunkBytes("cHRM", new Uint8Array(32));
const srgbChunk = chunkBytes("sRGB", Uint8Array.from([0]));

/** The type of every chunk in a PNG, in order. */
function chunkTypes(png: Uint8Array): ReadonlyArray<string> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= png.byteLength) {
    const length = view.getUint32(offset);
    types.push(String.fromCharCode(...png.subarray(offset + 4, offset + 8)));
    offset += 12 + length;
  }
  return types;
}

/** The PNG chunk CRC (CRC-32 over the type and data). */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
