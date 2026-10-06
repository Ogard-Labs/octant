import { describe, expect, it } from "vitest";
import {
  CHART_BAR_GAP,
  CHART_BAR_RADIUS,
  CHART_DOT_RADIUS,
  CHART_GRID_LINE_COUNT,
  CHART_LINE_WIDTH,
} from "./chartMarks";

describe("chart mark specifications", () => {
  it("keeps a bar corner within the 1-4px a mark lets a corner be", () => {
    expect(CHART_BAR_RADIUS).toBeGreaterThanOrEqual(1);
    expect(CHART_BAR_RADIUS).toBeLessThanOrEqual(4);
  });

  it("keeps a line stroke and a dot sized for a small plot", () => {
    expect(CHART_LINE_WIDTH).toBe(2);
    expect(CHART_DOT_RADIUS).toBe(3);
    expect(CHART_BAR_GAP).toBeGreaterThanOrEqual(1);
    expect(CHART_GRID_LINE_COUNT).toBeGreaterThan(0);
  });
});
