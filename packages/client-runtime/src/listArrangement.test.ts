import { describe, expect, it } from "vitest";
import {
  arrangeItems,
  DEFAULT_LIST_ARRANGEMENT,
  type ArrangeableItem,
  type ListArrangement,
} from "./listArrangement";

const items: ReadonlyArray<ArrangeableItem> = [
  {
    id: "a",
    hostId: "local",
    name: "Nightly build",
    status: "active",
    groupName: "Storefront",
    updatedAt: "2026-08-18T09:00:00.000Z",
  },
  {
    id: "b",
    hostId: "devbox",
    name: "Address review comments",
    status: "needs-attention",
    groupName: "Storefront",
    updatedAt: "2026-08-18T11:00:00.000Z",
  },
  {
    id: "c",
    hostId: "devbox",
    name: "Migrate the schema",
    status: "finished",
    updatedAt: "2026-08-17T08:00:00.000Z",
  },
];

const environmentLabel = (hostId: string) => (hostId === "local" ? "Local" : "Devbox");

function arrange(overrides: Partial<ListArrangement> = {}) {
  return arrangeItems(items, { ...DEFAULT_LIST_ARRANGEMENT, ...overrides }, { environmentLabel });
}

describe("arranging a list gathered from several environments", () => {
  it("shows everything, newest first, until someone narrows it", () => {
    expect(arrange()).toEqual([{ heading: "", items: [items[1], items[0], items[2]] }]);
  });

  it("keeps only the status asked for", () => {
    const groups = arrange({ status: "needs-attention" });

    expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual(["b"]);
  });

  it("groups by environment under the name the person uses for it", () => {
    const groups = arrange({ grouping: "environment" });

    expect(groups.map((group) => group.heading)).toEqual(["Devbox", "Local"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("says so rather than inventing a Project for an item that has none", () => {
    const groups = arrange({ grouping: "project" });

    expect(groups.map((group) => group.heading)).toEqual(["No Project", "Storefront"]);
  });

  it("never leaves a heading with nothing under it", () => {
    const groups = arrange({ grouping: "environment", status: "active" });

    expect(groups.map((group) => group.heading)).toEqual(["Local"]);
    expect(groups.every((group) => group.items.length > 0)).toBe(true);
  });

  it("orders by name when asked, and breaks a tie the same way every render", () => {
    const byName = arrange({ sort: "name" });

    expect(byName[0]?.items.map((item) => item.name)).toEqual([
      "Address review comments",
      "Migrate the schema",
      "Nightly build",
    ]);

    const sameInstant = [
      { ...(items[0] as ArrangeableItem), id: "z", updatedAt: "2026-08-18T09:00:00.000Z" },
      { ...(items[0] as ArrangeableItem), id: "y", updatedAt: "2026-08-18T09:00:00.000Z" },
    ];
    const twice = [
      arrangeItems(sameInstant, DEFAULT_LIST_ARRANGEMENT, { environmentLabel }),
      arrangeItems([...sameInstant].reverse(), DEFAULT_LIST_ARRANGEMENT, { environmentLabel }),
    ];

    expect(twice[0]?.[0]?.items.map((item) => item.id)).toEqual(
      twice[1]?.[0]?.items.map((item) => item.id),
    );
  });

  it("shows nothing rather than an empty group when everything is filtered out", () => {
    expect(arrangeItems([], DEFAULT_LIST_ARRANGEMENT, { environmentLabel })).toEqual([]);
  });
});
