// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bayerThreshold,
  ditherPixels,
  drawDitheredPhoto,
  drawPhoto,
  PHOTO_CELL_PX,
  watchDisplayPixelRatio,
} from "./appBackdropPhoto";

afterEach(() => {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 1,
  });
});

function setDevicePixelRatio(ratio: number): void {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: ratio,
  });
}

describe("welcome photo dither", () => {
  it("spreads a flat mid-grey across neighbouring levels instead of one flat tone", () => {
    const width = 8;
    const height = 8;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(128);
    ditherPixels(pixels, width, height);

    const levels = new Set<number>();
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const value = pixels[index] ?? -1;
      levels.add(value);
      sum += value;
      // Alpha is left alone: the photo stays opaque where it was.
      expect(pixels[index + 3]).toBe(128);
    }
    // Four levels per channel is the print: nothing lands between them.
    for (const level of levels) expect([0, 85, 170, 255]).toContain(level);
    expect(levels.size).toBeGreaterThan(1);
    // The pattern keeps the average tone, which is what makes it read as grey.
    expect(sum / (width * height)).toBeGreaterThan(110);
    expect(sum / (width * height)).toBeLessThan(146);
  });

  it("uses an ordered threshold that repeats every eight cells and covers the full range", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const threshold = bayerThreshold(x, y);
        expect(threshold).toBeGreaterThan(0);
        expect(threshold).toBeLessThan(1);
        expect(bayerThreshold(x + 8, y + 16)).toBe(threshold);
        seen.add(Math.round(threshold * 64 - 0.5));
      }
    }
    expect(seen.size).toBe(64);
  });
});

describe("welcome photo backing store", () => {
  const image = { width: 80, height: 60 };
  const source = () => document.createElement("canvas");

  it("draws a clean photo at physical display pixels, including a 2× display", () => {
    const canvas = document.createElement("canvas");
    setDevicePixelRatio(1);
    drawPhoto(canvas, source(), image, { width: 1280, height: 800 });
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(800);

    setDevicePixelRatio(2);
    drawPhoto(canvas, source(), image, { width: 1280, height: 800 });
    expect(canvas.width).toBe(2560);
    expect(canvas.height).toBe(1600);
  });

  it("resizes a clean photo with the viewport and keeps a narrow frame at device pixels", () => {
    const canvas = document.createElement("canvas");
    setDevicePixelRatio(2);
    drawPhoto(canvas, source(), image, { width: 1280, height: 800 });
    expect(canvas.width).toBe(2560);

    drawPhoto(canvas, source(), image, { width: 390, height: 844 });
    expect(canvas.width).toBe(780);
    expect(canvas.height).toBe(1688);
  });

  it("keeps a dithered photo coarse in CSS cells even on a 2× display", () => {
    const canvas = document.createElement("canvas");
    setDevicePixelRatio(2);
    drawDitheredPhoto(canvas, source(), image, { width: 200, height: 100 });
    expect(canvas.width).toBe(Math.ceil(200 / PHOTO_CELL_PX));
    expect(canvas.height).toBe(Math.ceil(100 / PHOTO_CELL_PX));
  });

  it("asks the photo to redraw when the display's pixel ratio changes", () => {
    const listeners = new Map<string, EventListener>();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) => {
      const media = {
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (_event: string, listener: EventListener) => {
          listeners.set(query, listener);
        },
        removeEventListener: (_event: string, listener: EventListener) => {
          if (listeners.get(query) === listener) listeners.delete(query);
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
      return media;
    };

    const onChange = vi.fn();
    try {
      const stop = watchDisplayPixelRatio(onChange);
      expect(listeners.size).toBe(1);

      setDevicePixelRatio(2);
      const first = [...listeners.values()][0];
      if (first === undefined) {
        throw new Error("expected a resolution media-query listener");
      }
      first(new Event("change"));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect([...listeners.keys()].some((query) => query.includes("2"))).toBe(true);
      stop();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe("welcome photo sampling", () => {
  it("pixelates only the pattern and a dithered photo, not a clean one", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../styles/surface.css"),
      "utf8",
    );
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].map((match) => ({
      selector: (match[1] ?? "").replace(/\s+/g, " ").trim(),
      body: (match[2] ?? "").replace(/\s+/g, " ").trim(),
    }));
    const pixelated = rules.filter((rule) => /image-rendering:\s*pixelated/.test(rule.body));
    expect(pixelated.some((rule) => rule.selector.includes(".app-backdrop__pattern"))).toBe(true);
    expect(
      pixelated.some((rule) =>
        rule.selector.includes('.app-backdrop__photo[data-dithered="true"]'),
      ),
    ).toBe(true);
    expect(
      pixelated.some(
        (rule) =>
          /(^|,) \.app-backdrop__photo(,|$)/.test(` ${rule.selector} `) &&
          !rule.selector.includes("data-dithered"),
      ),
    ).toBe(false);
  });
});
