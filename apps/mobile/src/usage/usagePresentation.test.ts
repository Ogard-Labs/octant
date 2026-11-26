import { describe, expect, it } from "vitest";
import { usageResetLabel, usageShareLabel } from "./usagePresentation";

describe("usage presentation", () => {
  it("names a reset later today by its time alone", () => {
    const now = new Date(2026, 10, 26, 10, 0);
    const label = usageResetLabel(new Date(2026, 10, 26, 14, 30).toISOString(), now, "en-GB");
    expect(label).toBe("Resets at 14:30");
  });

  it("adds the weekday to a reset on another day", () => {
    const now = new Date(2026, 10, 26, 10, 0);
    const label = usageResetLabel(new Date(2026, 10, 29, 9, 5).toISOString(), now, "en-GB");
    expect(label).toMatch(/^Resets Sun 0?9:05$/);
  });

  it("says a spent window has reached its limit, and any other how much is used", () => {
    expect(usageShareLabel({ usedPercent: 100, level: "spent" })).toBe("Limit reached");
    expect(usageShareLabel({ usedPercent: 82, level: "near" })).toBe("82% used");
  });

  it("names the date for a reset a week or more away, so it is not read as one this week", () => {
    const now = new Date(2026, 10, 26, 10, 0);
    const label = usageResetLabel(new Date(2026, 11, 3, 9, 0).toISOString(), now, "en-GB");
    expect(label).toContain("3 Dec");
  });

  it("says nothing for a reset time it cannot read", () => {
    expect(usageResetLabel("not a time", new Date(), "en-GB")).toBeUndefined();
  });
});
