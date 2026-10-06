import { Activity } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  arrangeHomeCards,
  isDefaultHomeCardCustomization,
  moveHomeCard,
  setHomeCardVisible,
  type HomeCardDefinition,
} from "./homeCards";

function card(id: string, overrides: Partial<HomeCardDefinition> = {}): HomeCardDefinition {
  return {
    id,
    title: id,
    icon: Activity,
    defaultOn: true,
    available: true,
    emptyLabel: "Nothing.",
    useContent: () => ({ status: "ready", count: 0, body: null }),
    ...overrides,
  };
}

const registry = [card("one"), card("two"), card("three", { defaultOn: false })];
const NONE = { order: [], visibility: [] } as const;

describe("the order and visibility of start-screen cards", () => {
  it("follows the registry and each card's own default when nothing was chosen", () => {
    expect(arrangeHomeCards(registry, NONE).map((p) => [p.definition.id, p.visible])).toEqual([
      ["one", true],
      ["two", true],
      ["three", false],
    ]);
  });

  it("leaves out a card whose capability is missing so it is neither shown nor offered", () => {
    const arranged = arrangeHomeCards([card("one"), card("two", { available: false })], NONE);
    expect(arranged.map((p) => p.definition.id)).toEqual(["one"]);
  });

  it("puts named cards first, ignores ids it does not know, and keeps the rest in registry order", () => {
    const arranged = arrangeHomeCards(registry, {
      order: ["three", "gone", "one"],
      visibility: [],
    });
    expect(arranged.map((p) => p.definition.id)).toEqual(["three", "one", "two"]);
  });

  it("stores a visibility choice only when it differs from the card's default", () => {
    const off = setHomeCardVisible(registry, NONE, "one", false);
    expect(off.visibility).toEqual([{ id: "one", visible: false }]);
    expect(setHomeCardVisible(registry, off, "one", true).visibility).toEqual([]);
    const on = setHomeCardVisible(registry, NONE, "three", true);
    expect(on.visibility).toEqual([{ id: "three", visible: true }]);
    expect(setHomeCardVisible(registry, on, "three", false).visibility).toEqual([]);
  });

  it("lets a card shipped later arrive with its own default beside an old choice", () => {
    const old = setHomeCardVisible(registry, NONE, "one", false);
    const later = [...registry, card("four")];
    const arranged = arrangeHomeCards(later, old);
    expect(arranged.find((p) => p.definition.id === "four")?.visible).toBe(true);
    expect(arranged.find((p) => p.definition.id === "one")?.visible).toBe(false);
  });

  it("moves a card to a position and keeps the stored place of a card it cannot offer", () => {
    const withMissing = [...registry, card("away", { available: false })];
    const start = { order: ["away", "one", "two", "three"], visibility: [] };
    const moved = moveHomeCard(withMissing, start, "three", 0);
    expect(arrangeHomeCards(withMissing, moved).map((p) => p.definition.id)).toEqual([
      "three",
      "one",
      "two",
    ]);
    expect(moved.order).toContain("away");
  });

  it("clamps a move to the ends and returns the same value when nothing moved", () => {
    expect(moveHomeCard(registry, NONE, "one", -4)).toBe(NONE);
    const last = moveHomeCard(registry, NONE, "one", 99);
    expect(last.order).toEqual(["two", "three", "one"]);
    expect(moveHomeCard(registry, NONE, "missing", 0)).toBe(NONE);
  });

  it("calls an untouched choice the default", () => {
    expect(isDefaultHomeCardCustomization(NONE)).toBe(true);
    expect(isDefaultHomeCardCustomization({ order: ["one"], visibility: [] })).toBe(false);
  });
});
