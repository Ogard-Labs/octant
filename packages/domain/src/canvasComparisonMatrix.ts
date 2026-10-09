import type {
  CanvasComparisonMatrixBlock,
  CanvasMatrixCell,
  CanvasMatrixGlyph,
} from "@octant/contracts/canvas";
import { formatCanvasNumber } from "./canvasNumberFormat";

/**
 * How a comparison matrix reads, worked out from the block alone.
 *
 * The screen, the static SVG preview, and the Markdown and HTML export all
 * read the same grid, the same numbered notes, and the same weighted scores
 * from here, so an exported decision never states a total the screen does not.
 * Nothing here reads state: ordering the options by score is a reader's view
 * choice, passed in rather than stored.
 *
 * A weighted score is the share of the best reading an option could have had
 * across the criteria that can be scored. Each reading counts as a fraction of
 * its criterion: a score is its place on the score range, and yes, partial,
 * and no are the whole, half, and none of it. A criterion that prefers `lower`
 * turns that fraction round. A criterion counts only when its weight is above
 * zero and at least one option has a score or a glyph in it; text never
 * counts. An option without a reading in a counted criterion scores nothing
 * there, and the number of such gaps is reported beside its total rather than
 * hidden, so a sparse column cannot look better by leaving cells out.
 */

export interface CanvasMatrixScoreRangeReading {
  readonly min: number;
  readonly max: number;
}

export type CanvasMatrixReading =
  | { readonly kind: "score"; readonly score: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "glyph"; readonly glyph: CanvasMatrixGlyph };

export interface CanvasMatrixCellLayout {
  readonly optionId: string;
  /** Absent when the author left the coordinate empty. */
  readonly reading: CanvasMatrixReading | undefined;
  /** The reading's share of its criterion, 0..1, after any preference; absent for text. */
  readonly fraction: number | undefined;
  readonly noteNumber: number | undefined;
}

export interface CanvasMatrixRowLayout {
  readonly criterionId: string;
  readonly label: string;
  readonly detail: string | undefined;
  /** The weight the author gave; absent means it counts once. */
  readonly weight: number | undefined;
  readonly prefer: "higher" | "lower";
  /** Whether this criterion counts toward the weighted score. */
  readonly scored: boolean;
  /** One cell per option, in the option order of this layout. */
  readonly cells: ReadonlyArray<CanvasMatrixCellLayout>;
}

export interface CanvasMatrixTotal {
  /** The weighted share of the best possible reading, 0..1. */
  readonly share: number;
  /** The share read back onto the score range; absent when the matrix holds no scores. */
  readonly onScale: number | undefined;
  /** Counted criteria this option has no score or glyph in. */
  readonly missing: number;
}

export interface CanvasMatrixOptionLayout {
  readonly optionId: string;
  readonly label: string;
  readonly detail: string | undefined;
  /** The option's position as the author wrote it. */
  readonly index: number;
  readonly recommended: boolean;
  /** Absent when no criterion can be scored. */
  readonly total: CanvasMatrixTotal | undefined;
}

export interface CanvasMatrixNoteLayout {
  readonly number: number;
  readonly criterionId: string;
  readonly optionId: string;
  readonly text: string;
}

export interface CanvasComparisonMatrixLayout {
  readonly options: ReadonlyArray<CanvasMatrixOptionLayout>;
  readonly rows: ReadonlyArray<CanvasMatrixRowLayout>;
  /** Notes numbered in reading order: row by row, then option by option as written. */
  readonly notes: ReadonlyArray<CanvasMatrixNoteLayout>;
  readonly scoreRange: CanvasMatrixScoreRangeReading;
  /** The criteria that count toward the weighted score, in the author's order. */
  readonly scoredCriteria: ReadonlyArray<string>;
  /** The option ids with the highest weighted score; several on a tie, none without scores. */
  readonly leaders: ReadonlyArray<string>;
  /** Whether any cell carries a score, which decides how a total reads. */
  readonly hasScores: boolean;
}

export interface CanvasComparisonMatrixLayoutOptions {
  /** `written` keeps the author's option order; `score` ranks by weighted score. */
  readonly order?: "written" | "score";
}

const GLYPH_FRACTION: Readonly<Record<CanvasMatrixGlyph, number>> = {
  yes: 1,
  partial: 0.5,
  no: 0,
};

/** The range scores are read on: the declared one, or zero to the largest score. */
export function comparisonMatrixScoreRange(
  block: CanvasComparisonMatrixBlock,
): CanvasMatrixScoreRangeReading {
  if (block.scoreRange !== undefined) {
    return { min: block.scoreRange.min, max: block.scoreRange.max };
  }
  let min = 0;
  let max = 0;
  for (const cell of block.cells) {
    if (!("score" in cell)) continue;
    if (cell.score < min) min = cell.score;
    if (cell.score > max) max = cell.score;
  }
  return max > min ? { min, max } : { min, max: min + 1 };
}

function readingOf(cell: CanvasMatrixCell): CanvasMatrixReading {
  if ("score" in cell) return { kind: "score", score: cell.score };
  if ("glyph" in cell) return { kind: "glyph", glyph: cell.glyph };
  return { kind: "text", text: cell.text };
}

function fractionOf(
  reading: CanvasMatrixReading,
  range: CanvasMatrixScoreRangeReading,
  prefer: "higher" | "lower",
): number | undefined {
  let fraction: number;
  if (reading.kind === "text") return undefined;
  if (reading.kind === "glyph") {
    fraction = GLYPH_FRACTION[reading.glyph];
  } else {
    // A score outside a declared range is refused by policy; clamping keeps a
    // caller that skipped it from drawing a bar past its track.
    fraction = Math.min(1, Math.max(0, (reading.score - range.min) / (range.max - range.min)));
  }
  return prefer === "lower" ? 1 - fraction : fraction;
}

function coordinate(criterionId: string, optionId: string): string {
  return `${criterionId}\u0000${optionId}`;
}

export function layoutCanvasComparisonMatrix(
  block: CanvasComparisonMatrixBlock,
  options: CanvasComparisonMatrixLayoutOptions = {},
): CanvasComparisonMatrixLayout {
  const range = comparisonMatrixScoreRange(block);
  const cells = new Map<string, CanvasMatrixCell>();
  for (const cell of block.cells) {
    const key = coordinate(String(cell.criterionId), String(cell.optionId));
    // Policy refuses a repeated coordinate; the first one wins for a caller
    // that skipped it, matching the order a reader meets them in.
    if (!cells.has(key)) cells.set(key, cell);
  }

  const notes: CanvasMatrixNoteLayout[] = [];
  const noteNumbers = new Map<string, number>();
  for (const criterion of block.criteria) {
    for (const option of block.options) {
      const criterionId = String(criterion.criterionId);
      const optionId = String(option.optionId);
      const note = cells.get(coordinate(criterionId, optionId))?.note;
      if (note === undefined || note.trim().length === 0) continue;
      const number = notes.length + 1;
      notes.push({ number, criterionId, optionId, text: note });
      noteNumbers.set(coordinate(criterionId, optionId), number);
    }
  }

  let hasScores = false;
  const rowsAsWritten = block.criteria.map((criterion) => {
    const criterionId = String(criterion.criterionId);
    const prefer = criterion.prefer ?? "higher";
    const rowCells = block.options.map((option): CanvasMatrixCellLayout => {
      const optionId = String(option.optionId);
      const cell = cells.get(coordinate(criterionId, optionId));
      const reading = cell === undefined ? undefined : readingOf(cell);
      if (reading?.kind === "score") hasScores = true;
      return {
        optionId,
        reading,
        fraction: reading === undefined ? undefined : fractionOf(reading, range, prefer),
        noteNumber: noteNumbers.get(coordinate(criterionId, optionId)),
      };
    });
    const weight = criterion.weight ?? 1;
    return {
      criterionId,
      label: criterion.label,
      detail: criterion.detail,
      weight: criterion.weight,
      prefer,
      scored: weight > 0 && rowCells.some((cell) => cell.fraction !== undefined),
      cells: rowCells,
      effectiveWeight: weight,
    };
  });

  const scoredRows = rowsAsWritten.filter((row) => row.scored);
  const weightTotal = scoredRows.reduce((sum, row) => sum + row.effectiveWeight, 0);
  const recommended =
    block.recommendedOptionId === undefined ? undefined : String(block.recommendedOptionId);

  const optionsAsWritten = block.options.map((option, index): CanvasMatrixOptionLayout => {
    let total: CanvasMatrixTotal | undefined;
    if (weightTotal > 0) {
      let earned = 0;
      let missing = 0;
      for (const row of scoredRows) {
        const fraction = row.cells[index]?.fraction;
        if (fraction === undefined) {
          missing += 1;
          continue;
        }
        earned += row.effectiveWeight * fraction;
      }
      const share = earned / weightTotal;
      total = {
        share,
        onScale: hasScores ? range.min + share * (range.max - range.min) : undefined,
        missing,
      };
    }
    return {
      optionId: String(option.optionId),
      label: option.label,
      detail: option.detail,
      index,
      recommended: recommended === String(option.optionId),
      total,
    };
  });

  const best = Math.max(...optionsAsWritten.map((option) => option.total?.share ?? -1));
  const leaders =
    best < 0
      ? []
      : optionsAsWritten
          .filter((option) => option.total !== undefined && option.total.share === best)
          .map((option) => option.optionId);

  const ordered =
    options.order === "score"
      ? [...optionsAsWritten].sort(
          (left, right) =>
            (right.total?.share ?? -1) - (left.total?.share ?? -1) || left.index - right.index,
        )
      : optionsAsWritten;

  return {
    options: ordered,
    rows: rowsAsWritten.map(({ effectiveWeight: _weight, cells: rowCells, ...row }) => ({
      ...row,
      cells: ordered.map((option) => rowCells[option.index]).filter(isCell),
    })),
    notes,
    scoreRange: range,
    scoredCriteria: scoredRows.map((row) => row.criterionId),
    leaders,
    hasScores,
  };
}

/**
 * How a weighted score reads, on the screen and in every export alike: back on
 * the score range to one decimal when the matrix holds scores ("4.2 of 5"),
 * or as a share of the best possible when it holds only glyphs ("75%").
 */
export function formatComparisonMatrixTotal(
  total: CanvasMatrixTotal,
  range: CanvasMatrixScoreRangeReading,
  locale?: string,
): string {
  if (total.onScale === undefined) return formatCanvasNumber(total.share, "percent", locale);
  const rounded = Math.round(total.onScale * 10) / 10;
  return `${formatCanvasNumber(rounded, "number", locale)} of ${formatCanvasNumber(range.max, "number", locale)}`;
}

/** The words a glyph stands for, for assistive technology and every export. */
export const COMPARISON_MATRIX_GLYPH_LABEL: Readonly<Record<CanvasMatrixGlyph, string>> = {
  yes: "Yes",
  partial: "Partial",
  no: "No",
};

function isCell(cell: CanvasMatrixCellLayout | undefined): cell is CanvasMatrixCellLayout {
  return cell !== undefined;
}
