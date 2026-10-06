import { describe, expect, it } from "vitest";
import { formatCanvasNumber, formatCanvasNumberWithUnit } from "./canvasNumberFormat";

describe("canvas number formatting", () => {
  it("groups a plain number by the caller's locale", () => {
    expect(formatCanvasNumber(1_234_567, "number", "en-US")).toBe("1,234,567");
    expect(formatCanvasNumber(1_234_567, undefined, "de-DE")).toBe("1.234.567");
  });

  it("reads a large value short without losing its leading digits", () => {
    expect(formatCanvasNumber(1_360_000, "compact", "en-US")).toBe("1.36M");
    expect(formatCanvasNumber(2_500, "compact", "en-US")).toBe("2.5K");
  });

  it("reads a ratio as a percentage where one is a hundred percent", () => {
    expect(formatCanvasNumber(0.42, "percent", "en-US")).toBe("42%");
    expect(formatCanvasNumber(0.425, "percent", "en-US")).toBe("42.5%");
    expect(formatCanvasNumber(1, "percent", "en-US")).toBe("100%");
  });

  it("reads a byte count in base-1024 units", () => {
    expect(formatCanvasNumber(0, "bytes", "en-US")).toBe("0 B");
    expect(formatCanvasNumber(512, "bytes", "en-US")).toBe("512 B");
    expect(formatCanvasNumber(1536, "bytes", "en-US")).toBe("1.5 KB");
    expect(formatCanvasNumber(1_048_576, "bytes", "en-US")).toBe("1 MB");
    expect(formatCanvasNumber(-1536, "bytes", "en-US")).toBe("-1.5 KB");
  });

  it("reads a second count as an hours, minutes, and seconds duration", () => {
    expect(formatCanvasNumber(0, "duration", "en-US")).toBe("0s");
    expect(formatCanvasNumber(45, "duration", "en-US")).toBe("45s");
    expect(formatCanvasNumber(160, "duration", "en-US")).toBe("2m 40s");
    expect(formatCanvasNumber(3725, "duration", "en-US")).toBe("1h 2m 5s");
    expect(formatCanvasNumber(-90, "duration", "en-US")).toBe("-1m 30s");
  });

  it("keeps a sub-second duration instead of rounding it away", () => {
    expect(formatCanvasNumber(0.5, "duration", "en-US")).toBe("0.5s");
  });

  it("draws a broken reading as an em dash rather than throwing", () => {
    expect(formatCanvasNumber(Number.NaN, "compact", "en-US")).toBe("—");
    expect(formatCanvasNumber(Number.POSITIVE_INFINITY, "bytes", "en-US")).toBe("—");
  });

  it("appends a metric's unit after the formatted value", () => {
    expect(formatCanvasNumberWithUnit(1536, "KB", "bytes", "en-US")).toBe("1.5 KB KB");
    expect(formatCanvasNumberWithUnit(42, "requests", "number", "en-US")).toBe("42 requests");
    expect(formatCanvasNumberWithUnit(42, undefined, "number", "en-US")).toBe("42");
  });
});
