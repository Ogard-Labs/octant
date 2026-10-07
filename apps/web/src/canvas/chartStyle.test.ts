import { describe, expect, it } from "vitest";
import { CHART_GRID_LINE_COUNT } from "@octant/theme";
import { gridValues } from "./chartStyle";

describe("chart grid geometry", () => {
  it("stays inside the domain and never sits on its edges", () => {
    const domain = { min: 0, max: 100 };
    const values = gridValues(domain);
    expect(values).toHaveLength(CHART_GRID_LINE_COUNT);
    for (const value of values) {
      expect(value).toBeGreaterThan(domain.min);
      expect(value).toBeLessThan(domain.max);
    }
  });

  it("increases evenly from the bottom of the domain to the top", () => {
    const values = gridValues({ min: -4, max: 8 }, 4);
    expect(values).toHaveLength(4);
    expect(values[0]).toBeCloseTo(-1.6, 10);
    expect(values[1]).toBeCloseTo(0.8, 10);
    expect(values[2]).toBeCloseTo(3.2, 10);
    expect(values[3]).toBeCloseTo(5.6, 10);
    for (let index = 1; index < values.length; index += 1) {
      expect((values[index] ?? 0) - (values[index - 1] ?? 0)).toBeCloseTo(2.4, 10);
    }
  });

  it("draws no grid when the domain has no span", () => {
    expect(gridValues({ min: 5, max: 5 })).toEqual([]);
    expect(gridValues({ min: 0, max: 10 }, 0)).toEqual([]);
  });
});
