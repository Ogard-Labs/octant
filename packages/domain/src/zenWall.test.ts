import { MIN_ZEN_ELEMENT_HEIGHT, MIN_ZEN_ELEMENT_WIDTH } from "@octant/contracts/zen";
import { describe, expect, it } from "vitest";
import { planZenWall } from "./zenWall";

const AREA = { width: 1440, height: 820 } as const;
const LAPTOP = { width: 1180, height: 660 } as const;

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("the Zen wall", () => {
  it("gives one card the whole area", () => {
    const [only] = planZenWall(1, AREA);

    expect(only).toBeDefined();
    expect(only?.width).toBeGreaterThan(AREA.width * 0.9);
    expect(only?.height).toBeGreaterThan(AREA.height * 0.9);
  });

  it("never overlaps two cards, at any count a space can hold", () => {
    for (let count = 2; count <= 20; count += 1) {
      const tiles = planZenWall(count, AREA);
      expect(tiles).toHaveLength(count);
      for (let i = 0; i < tiles.length; i += 1) {
        for (let j = i + 1; j < tiles.length; j += 1) {
          const a = tiles[i];
          const b = tiles[j];
          if (a === undefined || b === undefined) throw new Error("missing tile");
          expect(overlaps(a, b), `tiles ${i} and ${j} overlap at count ${count}`).toBe(false);
        }
      }
    }
  });

  it("splits two cards side by side and quarters four", () => {
    const two = planZenWall(2, AREA);
    expect(two[0]?.y).toBe(two[1]?.y);
    expect(two[0]?.x).toBeLessThan(two[1]?.x ?? 0);

    const four = planZenWall(4, AREA);
    expect(new Set(four.map((tile) => tile.x)).size).toBe(2);
    expect(new Set(four.map((tile) => tile.y)).size).toBe(2);
  });

  it("fills the last row rather than leaving a card beside dead space", () => {
    const tiles = planZenWall(5, AREA);
    const rows = new Map<number, Array<(typeof tiles)[number]>>();
    for (const tile of tiles) rows.set(tile.y, [...(rows.get(tile.y) ?? []), tile]);
    expect(rows.size).toBe(2);

    for (const row of rows.values()) {
      const right = Math.max(...row.map((tile) => tile.x + tile.width));
      const left = Math.min(...row.map((tile) => tile.x));
      // Every row spans the same span, so a short row's cards are wider
      // instead of one card sitting alone against an empty half.
      expect(right - left).toBeGreaterThan(AREA.width * 0.9);
    }
  });

  it("drops to fewer columns rather than shrinking a card past reading width", () => {
    const wide = planZenWall(6, AREA);
    const narrow = planZenWall(6, LAPTOP);

    expect(new Set(wide.map((tile) => tile.x)).size).toBe(3);
    expect(new Set(narrow.map((tile) => tile.x)).size).toBe(2);
    for (const tile of narrow) expect(tile.width).toBeGreaterThanOrEqual(MIN_ZEN_ELEMENT_WIDTH);
  });

  it("keeps every tile inside the contract's size range", () => {
    for (const area of [AREA, LAPTOP, { width: 420, height: 300 }]) {
      for (let count = 1; count <= 12; count += 1) {
        for (const tile of planZenWall(count, area)) {
          expect(tile.width).toBeGreaterThanOrEqual(MIN_ZEN_ELEMENT_WIDTH);
          expect(tile.height).toBeGreaterThanOrEqual(MIN_ZEN_ELEMENT_HEIGHT);
          expect(tile.x).toBeGreaterThanOrEqual(0);
          expect(tile.y).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("reflows the survivors when a card is removed", () => {
    const three = planZenWall(3, AREA);
    const two = planZenWall(2, AREA);

    // Removing the third card is not "the first two keep their tiles and a
    // hole opens"; the wall is recomputed from the count, so the survivors
    // take the row the third one had.
    expect(three).toHaveLength(3);
    expect(new Set(three.map((tile) => tile.y)).size).toBe(2);
    expect(two).toHaveLength(2);
    expect(new Set(two.map((tile) => tile.y)).size).toBe(1);
    expect(two[0]?.height).toBeGreaterThan(three[0]?.height ?? 0);
  });

  it("leaves the surface's floating chrome its own room", () => {
    const plain = planZenWall(2, AREA);
    const inset = planZenWall(2, AREA, { insetTop: 56, insetBottom: 88 });

    // Without this the first row sits under the spaces pill and the last row
    // under the Navigator bar.
    expect(inset[0]?.y).toBeGreaterThan(plain[0]?.y ?? 0);
    expect(inset[0]?.height).toBeLessThan(plain[0]?.height ?? 0);
    for (const tile of inset) expect(tile.y + tile.height).toBeLessThanOrEqual(AREA.height - 88);
  });

  it("returns nothing for an empty space or an area with no room", () => {
    expect(planZenWall(0, AREA)).toHaveLength(0);
    expect(planZenWall(3, { width: 0, height: 0 })).toHaveLength(3);
  });
});
