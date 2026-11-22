import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngWithoutAlpha } from "./pngOpacity";

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
});
