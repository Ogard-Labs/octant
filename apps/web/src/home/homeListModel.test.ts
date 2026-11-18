import { describe, expect, it, vi } from "vitest";
import {
  buildHomeList,
  HOME_LIST_ROW_LIMIT,
  pullRequestListId,
  threadListId,
  type HomeListRow,
  type HomeListSectionId,
} from "./homeListModel";

function row(
  id: string,
  section: HomeListSectionId,
  extra: Partial<HomeListRow> = {},
): HomeListRow {
  return {
    id,
    section,
    glyph: "pull-request",
    tone: "neutral",
    label: "Open",
    title: id,
    meta: [],
    ...extra,
  };
}

describe("the start screen's list", () => {
  it("shows a pull request once, under Needs you, when it is also one of the person's own", () => {
    const id = pullRequestListId("Acme", "App", 12);
    const sections = buildHomeList({
      rows: [row(id, "your-pull-requests"), row(id, "needs-you")],
      seeAll: {},
    });
    expect(sections.map((section) => section.id)).toEqual(["needs-you"]);
    expect(sections[0]?.total).toBe(1);
  });

  it("names a pull request the same whatever case a source spells its repository in", () => {
    expect(pullRequestListId("Acme", "App", 12)).toBe(pullRequestListId("acme", "app", 12));
  });

  it("leaves a thread out of Continue while a request waiting on it is in Needs you", () => {
    const sections = buildHomeList({
      rows: [
        row("thread:7", "continue"),
        row("request:abc", "needs-you", { aliases: [threadListId("7")] }),
        row("thread:8", "continue"),
      ],
      seeAll: {},
    });
    expect(sections.map((section) => [section.id, section.rows.map((r) => r.id)])).toEqual([
      ["needs-you", ["request:abc"]],
      ["continue", ["thread:8"]],
    ]);
  });

  it("does not draw a section that has no rows", () => {
    const sections = buildHomeList({
      rows: [row("a", "continue"), row("b", "needs-you")],
      seeAll: {},
    });
    expect(sections.map((section) => section.id)).toEqual(["needs-you", "continue"]);
    expect(buildHomeList({ rows: [], seeAll: {} })).toEqual([]);
  });

  it("lists at most five rows per section and offers See all only for the rest", () => {
    const onSelect = vi.fn();
    const many = Array.from({ length: 7 }, (_, index) =>
      row(`p${String(index)}`, "your-pull-requests"),
    );
    const [section] = buildHomeList({
      rows: many,
      seeAll: { "your-pull-requests": { label: "See all", onSelect } },
    });
    expect(section?.rows).toHaveLength(HOME_LIST_ROW_LIMIT);
    expect(section?.total).toBe(7);
    expect(section?.seeAll?.label).toBe("See all");

    const [short] = buildHomeList({
      rows: many.slice(0, 5),
      seeAll: { "your-pull-requests": { label: "See all", onSelect } },
    });
    expect(short?.seeAll).toBeUndefined();
  });

  it("lets a row the cap hides still keep its item out of a later section", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => row(`n${String(index)}`, "needs-you")),
      row("n5", "your-pull-requests"),
    ];
    const sections = buildHomeList({ rows, seeAll: {} });
    expect(sections.map((section) => section.id)).toEqual(["needs-you"]);
  });
});
