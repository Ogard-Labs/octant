import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_VIEW_FILTERS,
  decodeProjectViewActivityPeriod,
  decodeProjectViewActivityRange,
  decodeProjectViewFilters,
  decodeProjectViewGrouping,
  decodeProjectViewLifecycle,
  decodeProjectViewLocalDate,
  decodeProjectViewSort,
} from "./projectView";

const validFilters = {
  lifecycle: "active",
  environmentIds: ["local"],
  showEmptyProjects: false,
  grouping: "environment",
  sorting: "created",
  activity: "custom",
  activityRange: { from: "2026-08-01", to: "2026-08-23" },
} as const;

describe("Project View filter contracts", () => {
  it("accepts a complete saved filter document", () => {
    expect(decodeProjectViewFilters(validFilters)).toEqual(validFilters);
  });

  it("accepts the conservative defaults without an activity range", () => {
    expect(decodeProjectViewFilters(DEFAULT_PROJECT_VIEW_FILTERS)).toEqual(
      DEFAULT_PROJECT_VIEW_FILTERS,
    );
  });

  it("accepts only the documented lifecycle, grouping, sort, and activity values", () => {
    expect(decodeProjectViewLifecycle("all")).toBe("all");
    expect(decodeProjectViewGrouping("none")).toBe("none");
    expect(decodeProjectViewSort("alphabetical")).toBe("alphabetical");
    expect(decodeProjectViewActivityPeriod("14-days")).toBe("14-days");
    expect(() => decodeProjectViewLifecycle("hidden")).toThrow();
    expect(() => decodeProjectViewGrouping("provider")).toThrow();
    expect(() => decodeProjectViewSort("manual")).toThrow();
    expect(() => decodeProjectViewActivityPeriod("unread")).toThrow();
  });

  it("accepts local calendar dates and refuses timestamps or malformed days", () => {
    expect(decodeProjectViewLocalDate("2026-02-28")).toBe("2026-02-28");
    expect(decodeProjectViewActivityRange({ from: "2026-08-22" })).toEqual({
      from: "2026-08-22",
    });
    expect(() => decodeProjectViewLocalDate("2026-8-22")).toThrow();
    expect(() => decodeProjectViewLocalDate("2026-08-22T00:00:00.000Z")).toThrow();
    expect(() => decodeProjectViewActivityRange({ from: "tomorrow" })).toThrow();
  });

  it("refuses extra fields, missing required fields, and non-objects", () => {
    expect(() => decodeProjectViewFilters({ ...validFilters, provider: "openai" })).toThrow();
    expect(() =>
      decodeProjectViewFilters({
        lifecycle: "active",
        environmentIds: [],
        grouping: "project",
        sorting: "recency",
        activity: "all",
      }),
    ).toThrow();
    expect(() => decodeProjectViewFilters(null)).toThrow();
    expect(() => decodeProjectViewFilters("active")).toThrow();
  });
});
