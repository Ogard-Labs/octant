import { describe, expect, it } from "vitest";
import {
  categoryCenter,
  computeYDomain,
  pieWedges,
  ringPath,
  scaleX,
  scaleY,
  type ChartSeriesData,
} from "./chartGeometry";

const series = (ys: number[]): ChartSeriesData => ({
  seriesId: "s",
  label: "S",
  points: ys.map((y) => ({ x: 0, y })),
});

describe("chartGeometry", () => {
  it("computes a y domain across every series", () => {
    expect(computeYDomain([series([2, 8]), series([5])])).toEqual({ min: 2, max: 8 });
  });

  it("pads a degenerate domain so all values center", () => {
    expect(computeYDomain([series([4, 4])]).max).toBeGreaterThan(
      computeYDomain([series([4, 4])]).min,
    );
  });

  it("maps y values monotonically into the plot height", () => {
    const domain = { min: 0, max: 10 } as const;
    const high = scaleY(10, domain, 200, 0);
    const low = scaleY(0, domain, 200, 0);
    expect(high).toBeLessThan(low);
  });

  it("maps x by index across the width", () => {
    const a = scaleX(0, 3, 300, 0);
    const b = scaleX(2, 3, 300, 0);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThanOrEqual(300);
  });

  it("splits a whole into clockwise wedges that sum to one turn", () => {
    const wedges = pieWedges([1, 1, 2]);
    expect(wedges.map((wedge) => wedge.fraction)).toEqual([0.25, 0.25, 0.5]);
    const span = wedges.reduce((sum, wedge) => sum + (wedge.end - wedge.start), 0);
    expect(span).toBeCloseTo(Math.PI * 2);
    expect(ringPath(10, 10, 8, 0, wedges[0]?.start ?? 0, wedges[0]?.end ?? 0)).toContain("A");
    expect(ringPath(10, 10, 8, 4, -Math.PI / 2, Math.PI * 1.5)).toContain("A 4.00");
    expect(ringPath(10, 10, 8, 0, 0, 0)).toBe("");
  });

  it("centers category slots across the plot", () => {
    expect(categoryCenter(0, 2, 100, 0)).toBe(25);
    expect(categoryCenter(1, 2, 100, 0)).toBe(75);
  });
});
