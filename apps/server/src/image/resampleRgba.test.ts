import { describe, expect, it } from "vitest";
import { resampleRgba } from "./resampleRgba";

const CHANNELS = 4;

function solidRgba(
  size: number,
  rgba: readonly [number, number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * CHANNELS);
  for (let index = 0; index < data.length; index += CHANNELS) data.set(rgba, index);
  return data;
}

describe("resampleRgba", () => {
  it("keeps a solid colour exact at every size", () => {
    const colour: [number, number, number, number] = [200, 90, 30, 255];
    const resized = resampleRgba(
      { width: 1024, height: 1024, data: solidRgba(1024, colour) },
      180,
      180,
    );
    expect(resized.length).toBe(180 * 180 * CHANNELS);
    expect([...resized.slice(0, CHANNELS)]).toEqual([...colour]);
    const last = resized.length - CHANNELS;
    expect([...resized.slice(last)]).toEqual([...colour]);
  });

  it("does not darken transparent edges", () => {
    // Half the 1024-wide rows are opaque white, half fully transparent black:
    // premultiplied resampling must keep the colour rather than smear black in.
    const data = new Uint8ClampedArray(8 * 8 * CHANNELS);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const index = (y * 8 + x) * CHANNELS;
        const rgba: [number, number, number, number] = x < 4 ? [255, 255, 255, 255] : [0, 0, 0, 0];
        data.set(rgba, index);
      }
    }
    const resized = resampleRgba({ width: 8, height: 8, data }, 4, 4);
    // The boundary output pixels sit over the white half: still bright, and
    // the rightmost column is still transparent, not grey.
    const nearEdge = (1 * 4 + 1) * CHANNELS;
    expect(resized[nearEdge]).toBeGreaterThan(200);
    const last = (1 * 4 + 3) * CHANNELS;
    expect(resized[last + 3]).toBe(0);
  });

  it("hits the exact pixel sizes for big shrinks", () => {
    const source = { width: 1024, height: 1024, data: solidRgba(1024, [1, 2, 3, 255]) };
    expect(resampleRgba(source, 16, 16).length).toBe(16 * 16 * CHANNELS);
    expect(resampleRgba(source, 180, 180).length).toBe(180 * 180 * CHANNELS);
  });

  it("averages a checkerboard to its mean", () => {
    // Alternating black/white texels downscale to ~50% grey (±1 for rounding).
    const size = 64;
    const data = new Uint8ClampedArray(size * size * CHANNELS);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = (x + y) % 2 === 0 ? 255 : 0;
        const index = (y * size + x) * CHANNELS;
        data.set([value, value, value, 255], index);
      }
    }
    const resized = resampleRgba({ width: size, height: size, data }, 4, 4);
    for (let index = 0; index < resized.length; index += CHANNELS) {
      expect(Math.abs((resized[index] ?? -1) - 128)).toBeLessThanOrEqual(1);
      expect(resized[index + 3]).toBe(255);
    }
  });

  it("stretches a two-by-two source through the Lanczos path", () => {
    const data = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const resized = resampleRgba({ width: 2, height: 2, data }, 4, 4);
    expect(resized.length).toBe(4 * 4 * CHANNELS);
    // Each corner keeps its quarter's dominant channel; Lanczos ringing may
    // leave a small residue in the others.
    const pixel = (x: number, y: number) => [
      ...resized.slice((y * 4 + x) * CHANNELS, (y * 4 + x) * CHANNELS + 3),
    ];
    expect(pixel(0, 0)[0]).toBeGreaterThan(200);
    expect(pixel(3, 0)[1]).toBeGreaterThan(200);
    expect(pixel(0, 3)[2]).toBeGreaterThan(200);
    expect(Math.min(...pixel(3, 3).slice(0, 2))).toBeGreaterThan(200);
  });
});
