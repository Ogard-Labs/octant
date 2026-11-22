import { describe, expect, it } from "vitest";
import { compareWithBudget, readBudget } from "./benchmark-initial-renderer";

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

  it("refuses a budget file that leaves out a measure, so no limit goes unchecked", () => {
    expect(readBudget({ mainEntryBytes: 1_000, cssBytes: 500 })).toEqual({
      status: "refused",
      message: "scripts/initial-renderer-budget.json has no whole-byte gzipBytes.",
    });
    expect(readBudget(BUDGET)).toEqual({ status: "read", budget: BUDGET });
  });
});
