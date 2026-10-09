import { useMemo, useState } from "react";
import type { CanvasComparisonMatrixBlock, CanvasMatrixGlyph } from "@octant/contracts/canvas";
import {
  COMPARISON_MATRIX_GLYPH_LABEL,
  formatComparisonMatrixTotal,
  layoutCanvasComparisonMatrix,
  type CanvasComparisonMatrixLayout,
  type CanvasMatrixCellLayout,
  type CanvasMatrixOptionLayout,
} from "@octant/domain/canvas-comparison-matrix";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import { OctantButton } from "../../ui/base/OctantButton";

type MatrixOrder = "written" | "score";

/**
 * A comparison or decision matrix: options across the top, criteria down the
 * side, and a weighted score under each option.
 *
 * The matrix is a native table, so the grid a person sees is the grid a screen
 * reader walks, with every option and criterion a header. It scrolls inside its
 * own focusable region with the criteria pinned, which keeps a wide decision
 * legible on a phone. Ordering the options by score is view state: it is never
 * journaled and never revises the Canvas. The weighted score comes from the
 * shared domain layout, so the screen and every export state the same totals;
 * the recommendation is the author's and is drawn apart from the arithmetic.
 */
export function ComparisonMatrixBlock({ block }: { readonly block: CanvasComparisonMatrixBlock }) {
  const [order, setOrder] = useState<MatrixOrder>("written");
  const layout = useMemo(() => layoutCanvasComparisonMatrix(block, { order }), [block, order]);
  const hasTotals = layout.scoredCriteria.length > 0;
  const label = matrixLabel(block);
  const labelOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const option of block.options) names.set(String(option.optionId), option.label);
    for (const criterion of block.criteria)
      names.set(String(criterion.criterionId), criterion.label);
    return (id: string) => names.get(id) ?? id;
  }, [block]);
  const recommended = layout.options.find((option) => option.recommended);

  return (
    <figure className="canvas-block__matrix">
      {hasTotals && block.options.length > 1 ? (
        <div className="canvas-block__matrix-header">
          <OctantButton
            aria-pressed={order === "score"}
            onClick={() => setOrder((current) => (current === "score" ? "written" : "score"))}
            type="button"
            variant="bare"
          >
            Order by score
          </OctantButton>
        </div>
      ) : null}
      <div
        aria-label={`${label}, scrollable`}
        className="canvas-block__matrix-scroll"
        role="region"
        tabIndex={0}
      >
        <table aria-label={label} className="canvas-block__matrix-table">
          <thead>
            <tr>
              <th className="canvas-block__matrix-corner" scope="col">
                <span className="canvas-block__matrix-criterion-label">Criterion</span>
              </th>
              {layout.options.map((option) => (
                <th
                  className={optionClass("canvas-block__matrix-option", option)}
                  key={option.optionId}
                  scope="col"
                >
                  <span className="canvas-block__matrix-option-label">{option.label}</span>
                  {option.detail === undefined ? null : (
                    <span className="canvas-block__matrix-detail">{option.detail}</span>
                  )}
                  {option.recommended ? (
                    <span className="canvas-block__matrix-badge">Recommended</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {layout.rows.map((row) => (
              <tr key={row.criterionId}>
                <th className="canvas-block__matrix-criterion" scope="row">
                  <span className="canvas-block__matrix-criterion-label">{row.label}</span>
                  {row.detail === undefined ? null : (
                    <span className="canvas-block__matrix-detail">{row.detail}</span>
                  )}
                  {row.weight === undefined && row.prefer === "higher" ? null : (
                    <span className="canvas-block__matrix-criterion-meta">
                      {row.weight === undefined ? null : (
                        <span>{`Weight ${formatCanvasNumber(row.weight)}`}</span>
                      )}
                      {row.prefer === "lower" ? <span>Lower is better</span> : null}
                    </span>
                  )}
                </th>
                {row.cells.map((cell, index) => (
                  <td
                    className={optionClass("canvas-block__matrix-cell", layout.options[index])}
                    data-scored={row.scored ? "true" : undefined}
                    key={cell.optionId}
                  >
                    <MatrixReading cell={cell} scored={row.scored} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {hasTotals ? (
            <tfoot>
              <tr>
                <th className="canvas-block__matrix-criterion" scope="row">
                  <span className="canvas-block__matrix-criterion-label">Weighted score</span>
                </th>
                {layout.options.map((option) => (
                  <td
                    className={optionClass("canvas-block__matrix-total", option)}
                    key={option.optionId}
                  >
                    <MatrixTotal layout={layout} option={option} />
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {recommended === undefined ? null : (
        <p className="canvas-block__matrix-recommendation">
          <span className="canvas-block__matrix-recommendation-label">
            {`Recommended: ${recommended.label}.`}
          </span>
          {block.recommendation === undefined || block.recommendation.trim() === "" ? null : (
            <span> {block.recommendation}</span>
          )}
        </p>
      )}
      {layout.notes.length === 0 ? null : (
        <ol aria-label="Notes" className="canvas-block__matrix-notes">
          {layout.notes.map((note) => (
            <li key={note.number}>
              <span className="canvas-block__matrix-note-number">{note.number}</span>
              <span className="canvas-block__matrix-note-where">
                {`${labelOf(note.criterionId)} · ${labelOf(note.optionId)}: `}
              </span>
              {note.text}
            </li>
          ))}
        </ol>
      )}
      <MatrixData block={block} layout={layout} />
    </figure>
  );
}

function optionClass(base: string, option: CanvasMatrixOptionLayout | undefined): string {
  return option?.recommended === true ? `${base} is-recommended` : base;
}

function MatrixReading({
  cell,
  scored,
}: {
  readonly cell: CanvasMatrixCellLayout;
  readonly scored: boolean;
}) {
  const reading = cell.reading;
  const note =
    cell.noteNumber === undefined ? null : (
      <sup className="canvas-block__matrix-note-ref">
        <span aria-hidden="true">{cell.noteNumber}</span>
        <span className="sr-only">{`Note ${String(cell.noteNumber)}`}</span>
      </sup>
    );
  if (reading === undefined) {
    return (
      <span className="canvas-block__matrix-empty">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not assessed</span>
        {note}
      </span>
    );
  }
  if (reading.kind === "glyph") {
    return (
      <span className="canvas-block__matrix-glyph" data-glyph={reading.glyph}>
        <GlyphMark glyph={reading.glyph} />
        <span>{COMPARISON_MATRIX_GLYPH_LABEL[reading.glyph]}</span>
        {note}
      </span>
    );
  }
  if (reading.kind === "text") {
    return (
      <span className="canvas-block__matrix-text">
        {reading.text}
        {note}
      </span>
    );
  }
  return (
    <span className="canvas-block__matrix-score">
      <span className="canvas-block__matrix-score-value">
        {formatCanvasNumber(reading.score)}
        {note}
      </span>
      {scored && cell.fraction !== undefined ? <Meter fraction={cell.fraction} /> : null}
    </span>
  );
}

/** A reading's share of its criterion, after any lower-is-better turn. */
function Meter({ fraction }: { readonly fraction: number }) {
  return (
    <span aria-hidden="true" className="canvas-block__matrix-meter">
      <span
        className="canvas-block__matrix-meter-fill"
        style={{ width: `${String(Math.round(fraction * 100))}%` }}
      />
    </span>
  );
}

function MatrixTotal({
  layout,
  option,
}: {
  readonly layout: CanvasComparisonMatrixLayout;
  readonly option: CanvasMatrixOptionLayout;
}) {
  const total = option.total;
  if (total === undefined) return null;
  // Every option marked highest says nothing, so a full tie marks none.
  const leads =
    layout.leaders.includes(option.optionId) && layout.leaders.length < layout.options.length;
  return (
    <span className="canvas-block__matrix-score" data-leader={leads ? "true" : undefined}>
      <span className="canvas-block__matrix-total-value">
        {formatComparisonMatrixTotal(total, layout.scoreRange)}
      </span>
      <Meter fraction={total.share} />
      {leads ? <span className="canvas-block__matrix-total-note">Highest</span> : null}
      {total.missing === 0 ? null : (
        <span className="canvas-block__matrix-total-note">{`${String(total.missing)} not scored`}</span>
      )}
    </span>
  );
}

/**
 * The glyph shapes differ as well as their words, so a yes, a partial, and a
 * no stay apart in forced colours and in a monochrome theme.
 */
function GlyphMark({ glyph }: { readonly glyph: CanvasMatrixGlyph }) {
  return (
    <svg
      aria-hidden="true"
      className="canvas-block__matrix-glyph-mark"
      focusable="false"
      height="14"
      viewBox="0 0 14 14"
      width="14"
    >
      {glyph === "yes" ? (
        <>
          <circle cx="7" cy="7" fill="currentColor" r="6.5" />
          <path
            d="M4 7.2 6.1 9.2 10 5"
            fill="none"
            stroke="var(--canvas-matrix-glyph-ink)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </>
      ) : glyph === "partial" ? (
        <>
          <circle cx="7" cy="7" fill="none" r="5.75" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 1.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" fill="none" r="5.75" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4.6 7h4.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

/**
 * The plain reading, one row per option: every criterion's reading in words
 * and the weighted score. It is the matrix turned on its side, which is also
 * the easiest way to read one option's case on a narrow screen.
 */
function MatrixData({
  block,
  layout,
}: {
  readonly block: CanvasComparisonMatrixBlock;
  readonly layout: CanvasComparisonMatrixLayout;
}) {
  const hasTotals = layout.scoredCriteria.length > 0;
  return (
    <details className="canvas-block__matrix-data">
      <summary>View matrix data</summary>
      <div
        aria-label="Comparison matrix data"
        className="canvas-block__matrix-data-table"
        role="region"
        tabIndex={0}
      >
        <table aria-label="Comparison matrix readings" className="ds-table">
          <thead>
            <tr>
              <th scope="col">Option</th>
              {block.criteria.map((criterion) => (
                <th key={String(criterion.criterionId)} scope="col">
                  {criterion.label}
                </th>
              ))}
              {hasTotals ? <th scope="col">Weighted score</th> : null}
            </tr>
          </thead>
          <tbody>
            {layout.options.map((option, optionIndex) => (
              <tr key={option.optionId}>
                <th scope="row">
                  {option.recommended ? `${option.label} (recommended)` : option.label}
                </th>
                {layout.rows.map((row) => (
                  <td key={row.criterionId}>{plainReading(row.cells[optionIndex])}</td>
                ))}
                {hasTotals ? (
                  <td>
                    {option.total === undefined
                      ? ""
                      : formatComparisonMatrixTotal(option.total, layout.scoreRange)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function plainReading(cell: CanvasMatrixCellLayout | undefined): string {
  const reading = cell?.reading;
  if (reading === undefined) return "Not assessed";
  if (reading.kind === "glyph") return COMPARISON_MATRIX_GLYPH_LABEL[reading.glyph];
  if (reading.kind === "text") return reading.text;
  return formatCanvasNumber(reading.score);
}

function matrixLabel(block: CanvasComparisonMatrixBlock): string {
  const options = block.options.length;
  const criteria = block.criteria.length;
  return `Comparison of ${String(options)} ${options === 1 ? "option" : "options"} across ${String(criteria)} ${criteria === 1 ? "criterion" : "criteria"}`;
}
