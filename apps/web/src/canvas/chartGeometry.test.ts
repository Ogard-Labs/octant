import { describe, expect, it } from "vitest";
import {
  categoryCenter,
  formatTick,
  niceAxis,
  smoothPath,
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

describe("value axis gridlines", () => {
  it("lands gridlines on round numbers that enclose every reading", () => {
    const axis = niceAxis({ min: 120, max: 310 }, false);
    expect(axis.ticks).toEqual([100, 150, 200, 250, 300, 350]);
    expect(axis.domain).toEqual({ min: 100, max: 350 });
  });

  it("keeps the zero baseline for bars and areas", () => {
    expect(niceAxis({ min: 120, max: 310 }, true).ticks[0]).toBe(0);
  });

  it("labels small steps without floating-point noise and large values compactly", () => {
    expect(niceAxis({ min: 0.1, max: 0.3 }, false).ticks).toEqual([0.1, 0.15, 0.2, 0.25, 0.3]);
    expect(formatTick(1_250_000)).toBe("1.25M");
    expect(formatTick(42_000)).toBe("42k");
    expect(formatTick(2500)).toBe("2500");
  });
});

describe("smooth line through readings", () => {
  it("draws a straight segment for two readings and a curve through every reading for more", () => {
    expect(
      smoothPath([
        { x: 0, y: 10 },
        { x: 10, y: 0 },
      ]),
    ).toBe("M 0.00 10.00 L 10.00 0.00");
    const path = smoothPath([
      { x: 0, y: 50 },
      { x: 10, y: 20 },
      { x: 20, y: 40 },
    ]);
    expect(path.startsWith("M 0.00 50.00 C")).toBe(true);
    expect(path).toContain(" 10.00 20.00 C");
    expect(path.endsWith(" 20.00 40.00")).toBe(true);
  });

  it("keeps a peak's control points level so the curve never draws past the reading", () => {
    const path = smoothPath([
      { x: 0, y: 50 },
      { x: 10, y: 20 },
      { x: 20, y: 50 },
    ]);
    // Both handles beside the peak sit at its height: a flat tangent at the turn.
    expect(path).toContain("6.67 20.00 10.00 20.00 C 13.33 20.00");
  });
});

describe("smooth line tangents", () => {
  it("passes straight through evenly rising readings instead of flattening between them", () => {
    // Three evenly spaced readings on one straight rise: the smooth line is that straight line.
    const path = smoothPath([
      { x: 0, y: 30 },
      { x: 30, y: 20 },
      { x: 60, y: 10 },
    ]);
    expect(path).toBe(
      "M 0.00 30.00 C 10.00 26.67 20.00 23.33 30.00 20.00 C 40.00 16.67 50.00 13.33 60.00 10.00",
    );
  });
});
