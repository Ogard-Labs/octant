import { describe, expect, it } from "vitest";
import { compareWithBudget } from "./benchmark-initial-renderer";

const BUDGET = { mainEntryBytes: 1_000, cssBytes: 500, gzipBytes: 800 };

describe("initial renderer budget", () => {
  it("accepts a renderer exactly at its budget", () => {
    expect(compareWithBudget(BUDGET, BUDGET)).toEqual([]);
  });

  it("refuses one byte of growth in any measure and names each overrun", () => {
    expect(
      compareWithBudget({ mainEntryBytes: 1_000, cssBytes: 501, gzipBytes: 801 }, BUDGET),
    ).toEqual([
      { measure: "cssBytes", measured: 501, budget: 500 },
      { measure: "gzipBytes", measured: 801, budget: 800 },
    ]);
  });
});
