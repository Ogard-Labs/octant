import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasComparisonMatrixBlock,
} from "@octant/contracts/canvas";
import {
  comparisonMatrixScoreRange,
  formatComparisonMatrixTotal,
  layoutCanvasComparisonMatrix,
} from "./canvasComparisonMatrix";
import { comparisonMatrixExampleBlocks } from "./canvasComparisonMatrixExamples";

function matrix(overrides: Record<string, unknown> = {}): CanvasComparisonMatrixBlock {
  const block = decodeCanvasBlock({
    blockId: "state-store",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "comparison-matrix",
    options: [
      { optionId: "a", label: "A" },
      { optionId: "b", label: "B" },
    ],
    criteria: [
      { criterionId: "speed", label: "Speed", weight: 3 },
      { criterionId: "cost", label: "Cost", weight: 1, prefer: "lower" },
    ],
    cells: [
      { criterionId: "speed", optionId: "a", score: 5 },
      { criterionId: "speed", optionId: "b", score: 1 },
      { criterionId: "cost", optionId: "a", score: 5 },
      { criterionId: "cost", optionId: "b", score: 1 },
    ],
    scoreRange: { min: 1, max: 5 },
    ...overrides,
  });
  if (block.kind !== "comparison-matrix") throw new Error("expected a comparison matrix");
  return block;
}

function totalOf(block: CanvasComparisonMatrixBlock, optionId: string) {
  const option = layoutCanvasComparisonMatrix(block).options.find(
    (entry) => entry.optionId === optionId,
  );
  if (option === undefined) throw new Error(`no option ${optionId}`);
  return option.total;
}

describe("comparison matrix weighted totals", () => {
  it("weights each criterion and turns a lower-is-better reading round", () => {
    // A: speed 5 of 1..5 (1.0) × 3, cost 5 where lower is better (0.0) × 1 → 3 / 4.
    // B: speed 1 (0.0) × 3, cost 1 where lower is better (1.0) × 1 → 1 / 4.
    const block = matrix();
    expect(totalOf(block, "a")).toMatchObject({ share: 0.75, onScale: 4, missing: 0 });
    expect(totalOf(block, "b")).toMatchObject({ share: 0.25, onScale: 2, missing: 0 });
    expect(layoutCanvasComparisonMatrix(block).leaders).toEqual(["a"]);
  });

  it("counts every criterion once when no weight is given", () => {
    const block = matrix({
      criteria: [
        { criterionId: "speed", label: "Speed" },
        { criterionId: "cost", label: "Cost", prefer: "lower" },
      ],
    });
    expect(totalOf(block, "a")?.share).toBe(0.5);
    expect(totalOf(block, "b")?.share).toBe(0.5);
    expect(layoutCanvasComparisonMatrix(block).leaders).toEqual(["a", "b"]);
  });

  it("reads yes, partial, and no as the whole, half, and none of a criterion", () => {
    const block = matrix({
      criteria: [{ criterionId: "offline", label: "Offline", weight: 2 }],
      cells: [
        { criterionId: "offline", optionId: "a", glyph: "yes" },
        { criterionId: "offline", optionId: "b", glyph: "partial" },
      ],
      scoreRange: undefined,
    });
    expect(totalOf(block, "a")).toMatchObject({ share: 1, onScale: undefined });
    expect(totalOf(block, "b")).toMatchObject({ share: 0.5, onScale: undefined });
  });

  it("keeps text, weight-zero rows, and rows nobody scored out of the total", () => {
    const block = matrix({
      criteria: [
        { criterionId: "speed", label: "Speed", weight: 1 },
        { criterionId: "licence", label: "Licence", weight: 5 },
        { criterionId: "taste", label: "Taste", weight: 0 },
      ],
      cells: [
        { criterionId: "speed", optionId: "a", score: 5 },
        { criterionId: "speed", optionId: "b", score: 3 },
        { criterionId: "licence", optionId: "a", text: "MIT" },
        { criterionId: "taste", optionId: "b", score: 5 },
      ],
    });
    const layout = layoutCanvasComparisonMatrix(block);
    expect(layout.scoredCriteria).toEqual(["speed"]);
    expect(totalOf(block, "a")).toMatchObject({ share: 1, missing: 0 });
    expect(totalOf(block, "b")).toMatchObject({ share: 0.5, missing: 0 });
  });

  it("counts a scored criterion an option has no reading for as missing and as nothing", () => {
    const block = matrix({
      cells: [
        { criterionId: "speed", optionId: "a", score: 5 },
        { criterionId: "speed", optionId: "b", score: 5 },
        { criterionId: "cost", optionId: "a", score: 1 },
      ],
    });
    expect(totalOf(block, "a")).toMatchObject({ share: 1, missing: 0 });
    expect(totalOf(block, "b")).toMatchObject({ share: 0.75, missing: 1 });
  });

  it("draws no total when nothing in the matrix can be scored", () => {
    const block = matrix({
      cells: [{ criterionId: "speed", optionId: "a", text: "fast" }],
    });
    const layout = layoutCanvasComparisonMatrix(block);
    expect(layout.scoredCriteria).toEqual([]);
    expect(layout.options.every((option) => option.total === undefined)).toBe(true);
    expect(layout.leaders).toEqual([]);
  });

  it("ranks the options by their score as a view choice, keeping the author's order on a tie", () => {
    const block = matrix({
      options: [
        { optionId: "a", label: "A" },
        { optionId: "b", label: "B" },
        { optionId: "c", label: "C" },
      ],
      cells: [
        { criterionId: "speed", optionId: "a", score: 1 },
        { criterionId: "speed", optionId: "b", score: 5 },
        { criterionId: "speed", optionId: "c", score: 5 },
      ],
    });
    expect(
      layoutCanvasComparisonMatrix(block, { order: "score" }).options.map((o) => o.optionId),
    ).toEqual(["b", "c", "a"]);
    expect(layoutCanvasComparisonMatrix(block).options.map((o) => o.optionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("reads scores from zero to the largest score when no range is declared", () => {
    const block = matrix({ scoreRange: undefined });
    expect(comparisonMatrixScoreRange(block)).toEqual({ min: 0, max: 5 });
    expect(totalOf(block, "a")?.share).toBe(0.75);
  });

  it("finds each cell at its criterion and option and numbers the notes in reading order", () => {
    const block = matrix({
      cells: [
        { criterionId: "cost", optionId: "b", score: 1, note: "second" },
        { criterionId: "speed", optionId: "a", score: 5, note: "first" },
      ],
    });
    const layout = layoutCanvasComparisonMatrix(block);
    expect(layout.notes.map((note) => [note.number, note.text])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    expect(layout.rows[0]?.cells[0]).toMatchObject({ optionId: "a", noteNumber: 1 });
    expect(layout.rows[0]?.cells[1]).toMatchObject({ optionId: "b", reading: undefined });
  });

  it("reads a total on the score range when the matrix holds scores, and as a share otherwise", () => {
    expect(
      formatComparisonMatrixTotal(
        { share: 0.8, onScale: 4.2, missing: 0 },
        { min: 1, max: 5 },
        "en-US",
      ),
    ).toBe("4.2 of 5");
    expect(
      formatComparisonMatrixTotal(
        { share: 0.75, onScale: undefined, missing: 0 },
        { min: 0, max: 1 },
        "en-US",
      ),
    ).toBe("75%");
  });

  it("decodes every describe example and scores it", () => {
    expect(comparisonMatrixExampleBlocks.length).toBeGreaterThan(0);
    for (const example of comparisonMatrixExampleBlocks) {
      expect(layoutCanvasComparisonMatrix(example).leaders.length).toBeGreaterThan(0);
    }
  });
});
