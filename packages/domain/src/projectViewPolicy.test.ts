import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_VIEW_FILTERS,
  filterProjectViewThreads,
  filterProjectsForView,
  groupProjectsForView,
  normalizeProjectViewFilters,
  projectViewActivityRange,
  projectViewActivityRangeError,
  sortProjectsForView,
} from "./projectViewPolicy";

const alpha = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "octant",
  lifecycle: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const beta = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "auroradocs",
  lifecycle: "archived" as const,
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

describe("normalizeProjectViewFilters", () => {
  it("returns conservative defaults for missing or malformed documents", () => {
    expect(normalizeProjectViewFilters(undefined)).toEqual(DEFAULT_PROJECT_VIEW_FILTERS);
    expect(normalizeProjectViewFilters("{not-json")).toEqual(DEFAULT_PROJECT_VIEW_FILTERS);
    expect(
      normalizeProjectViewFilters({
        lifecycle: "hidden",
        grouping: "provider",
        sorting: "unread",
        activity: "yesterday",
        showEmptyProjects: "yes",
        environmentIds: [null, "", "  "],
      }),
    ).toEqual(DEFAULT_PROJECT_VIEW_FILTERS);
  });

  it("keeps known fields and drops unknown activity dates without inventing a window", () => {
    expect(
      normalizeProjectViewFilters({
        lifecycle: "all",
        environmentIds: ["local", "devbox", "local"],
        showEmptyProjects: false,
        grouping: "environment",
        sorting: "created",
        activity: "custom",
        activityRange: { from: "2026-02-31", to: "2026-03-03" },
        provider: "openai",
      }),
    ).toEqual({
      lifecycle: "all",
      environmentIds: ["local", "devbox"],
      showEmptyProjects: false,
      grouping: "environment",
      sorting: "created",
      activity: "custom",
      activityRange: { to: "2026-03-03" },
    });
  });
});

describe("filterProjectsForView", () => {
  it("filters by lifecycle and only the host environments the window actually supplied", () => {
    const filters = {
      ...DEFAULT_PROJECT_VIEW_FILTERS,
      lifecycle: "archived" as const,
      environmentIds: ["devbox"],
    };
    expect(
      filterProjectsForView(
        [
          alpha,
          beta,
          { id: "33333333-3333-4333-8333-333333333333", lifecycle: "archived" as const },
        ],
        filters,
        new Map([[beta.id, { id: "devbox", name: "Devbox" }]]),
      ),
    ).toEqual([beta]);
  });

  it("treats a Project without an environment projection as Local", () => {
    expect(
      filterProjectsForView([alpha], {
        ...DEFAULT_PROJECT_VIEW_FILTERS,
        environmentIds: ["local"],
      }),
    ).toEqual([alpha]);
    expect(
      filterProjectsForView([alpha], {
        ...DEFAULT_PROJECT_VIEW_FILTERS,
        environmentIds: ["devbox"],
      }),
    ).toEqual([]);
  });
});

describe("filterProjectViewThreads", () => {
  it("uses inclusive server updatedAt windows for activity filters", () => {
    const now = new Date("2026-08-23T15:00:00.000Z");
    const filters = { ...DEFAULT_PROJECT_VIEW_FILTERS, activity: "3-days" as const };
    expect(
      filterProjectViewThreads(
        [
          { projectId: alpha.id, updatedAt: "2026-08-23T00:00:00.000Z" },
          { projectId: alpha.id, updatedAt: "2026-08-21T00:00:00.000Z" },
          { projectId: alpha.id, updatedAt: "2026-08-20T21:59:59.000Z" },
          { projectId: alpha.id },
        ],
        filters,
        now,
      ),
    ).toEqual([
      { projectId: alpha.id, updatedAt: "2026-08-23T00:00:00.000Z" },
      { projectId: alpha.id, updatedAt: "2026-08-21T00:00:00.000Z" },
    ]);
  });

  it("treats both custom local calendar days as inclusive before comparing UTC instants", () => {
    const now = new Date("2026-08-23T15:00:00.000Z");
    const filters = {
      ...DEFAULT_PROJECT_VIEW_FILTERS,
      activity: "custom" as const,
      activityRange: { from: "2026-08-22", to: "2026-08-23" },
    };
    const range = projectViewActivityRange(filters, now);
    expect(range?.from).toEqual(new Date(2026, 7, 22));
    expect(range?.to.getFullYear()).toBe(2026);
    expect(range?.to.getMonth()).toBe(7);
    expect(range?.to.getDate()).toBe(23);
    expect(
      filterProjectViewThreads(
        [
          { updatedAt: new Date(2026, 7, 21, 23, 59, 59, 999).toISOString() },
          { updatedAt: new Date(2026, 7, 22).toISOString() },
          { updatedAt: new Date(2026, 7, 23, 23, 59, 59, 999).toISOString() },
        ],
        filters,
        now,
      ),
    ).toHaveLength(2);
  });

  it("refuses rollover dates and reversed custom ranges without hiding threads", () => {
    const rollover = {
      ...DEFAULT_PROJECT_VIEW_FILTERS,
      activity: "custom" as const,
      activityRange: { from: "2026-02-31", to: "2026-03-03" },
    };
    const reversed = {
      ...DEFAULT_PROJECT_VIEW_FILTERS,
      activity: "custom" as const,
      activityRange: { from: "2026-08-23", to: "2026-08-22" },
    };
    expect(projectViewActivityRangeError(rollover)).toBe("Choose a valid start date.");
    expect(projectViewActivityRange(rollover)).toBeUndefined();
    expect(projectViewActivityRangeError(reversed)).toBe(
      "Start date must be on or before end date.",
    );
    expect(projectViewActivityRange(reversed)).toBeUndefined();
    expect(filterProjectViewThreads([{ updatedAt: "2026-08-22T10:00:00.000Z" }], reversed)).toEqual(
      [{ updatedAt: "2026-08-22T10:00:00.000Z" }],
    );
  });
});

describe("sortProjectsForView and groupProjectsForView", () => {
  it("sorts by thread recency, name, or Project created time", () => {
    const threads = [
      { projectId: alpha.id, updatedAt: "2026-08-10T00:00:00.000Z" },
      { projectId: beta.id, updatedAt: "2026-08-23T00:00:00.000Z" },
    ];
    expect(
      sortProjectsForView([alpha, beta], "recency", threads).map((project) => project.id),
    ).toEqual([beta.id, alpha.id]);
    expect(
      sortProjectsForView([beta, alpha], "alphabetical", threads).map((project) => project.name),
    ).toEqual(["auroradocs", "octant"]);
    expect(
      sortProjectsForView([beta, alpha], "created", threads).map((project) => project.id),
    ).toEqual([beta.id, alpha.id]);
  });

  it("groups by environment or status and never invents a remote host", () => {
    expect(
      groupProjectsForView(
        [alpha, beta],
        "environment",
        new Map([[beta.id, { id: "devbox", name: "Devbox" }]]),
      ),
    ).toEqual([
      { label: "Local", projects: [alpha] },
      { label: "Devbox", projects: [beta] },
    ]);
    expect(groupProjectsForView([alpha, beta], "status")).toEqual([
      { label: "Active", projects: [alpha] },
      { label: "Archived", projects: [beta] },
    ]);
    expect(groupProjectsForView([alpha], "project")).toEqual([]);
  });
});
