import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBarListBlock,
} from "@octant/contracts/canvas";
import { hottestFilesBlock } from "./canvasBarListExamples";
import {
  BAR_LIST_DEFAULT_VISIBLE_ROWS,
  barListValueDomain,
  layoutCanvasBarList,
} from "./canvasBarListLayout";

const snapshot = JSON.parse(
  readFileSync(new URL("./canvasBarListLayout.snapshot.json", import.meta.url), "utf8"),
) as {
  readonly hottestFiles: ReturnType<typeof layoutCanvasBarList>;
};

function barList(
  rows: ReadonlyArray<{ readonly label: string; readonly value: number }>,
): CanvasBarListBlock {
  const block = decodeCanvasBlock({
    blockId: "ranked-list",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "bar-list",
    rows,
  });
  if (block.kind !== "bar-list") throw new Error("Fixture did not decode as a bar list.");
  return block;
}

describe("bar list layout", () => {
  it("ranks the rows largest first, the same way every time", () => {
    const layout = layoutCanvasBarList(hottestFilesBlock, { limit: 4 });

    expect(layout).toEqual(snapshot.hottestFiles);
    expect(layoutCanvasBarList(hottestFilesBlock, { limit: 4 })).toEqual(layout);
    expect(layout.rows.map((row) => row.value)).toEqual([41, 33, 27, 19]);
    expect(layout.hiddenCount).toBe(1);
  });

  it("gives the largest reading a full bar and the rest their share of it", () => {
    const layout = layoutCanvasBarList(hottestFilesBlock);

    expect(layout.max).toBe(41);
    expect(layout.rows[0]?.fraction).toBe(1);
    expect(layout.rows[1]?.fraction).toBeCloseTo(33 / 41, 5);
    expect(layout.total).toBe(41 + 33 + 27 + 19 + 12);
  });

  it("reverses the ranking when asked", () => {
    const ascending = layoutCanvasBarList(hottestFilesBlock, { direction: "asc" });

    expect(ascending.rows.map((row) => row.value)).toEqual([12, 19, 27, 33, 41]);
  });

  it("keeps a tie in the order the author declared, not by label", () => {
    const layout = layoutCanvasBarList(
      barList([
        { label: "b", value: 5 },
        { label: "a", value: 5 },
      ]),
    );

    expect(layout.rows.map((row) => row.label)).toEqual(["b", "a"]);
    expect(layout.rows.map((row) => row.index)).toEqual([0, 1]);
  });

  it("shows the top rows by default and counts the rest as hidden", () => {
    const many = barList(
      Array.from({ length: 10 }, (_value, index) => ({
        label: `row-${String(index)}`,
        value: 10 - index,
      })),
    );
    const layout = layoutCanvasBarList(many, { limit: BAR_LIST_DEFAULT_VISIBLE_ROWS });

    expect(layout.rows).toHaveLength(BAR_LIST_DEFAULT_VISIBLE_ROWS);
    expect(layout.hiddenCount).toBe(10 - BAR_LIST_DEFAULT_VISIBLE_ROWS);
    expect(layoutCanvasBarList(many, { limit: 10 }).hiddenCount).toBe(0);
  });

  it("reads the value domain from zero so a bar starts where a bar starts", () => {
    const domain = barListValueDomain(hottestFilesBlock);

    expect(domain).toEqual({ min: 0, max: 41 });
  });

  it("gives a list of zeros a domain that does not collapse to a point", () => {
    const zeroed = barList([{ label: "flat", value: 0 }]);

    expect(barListValueDomain(zeroed)).toEqual({ min: 0, max: 1 });
    expect(layoutCanvasBarList(zeroed).rows[0]?.fraction).toBe(0);
  });
});
