import { createElement, useId, type ReactNode } from "react";
import type { CanvasDashboardPlacedCell } from "@octant/domain/canvas-dashboard-layout";

/**
 * A KPI dashboard: a labelled region holding a grid of the blocks it places.
 *
 * The cells are the document's own blocks, drawn by the caller exactly as
 * they draw alone (a chart keeps its disclosed data table, a table its
 * controls, every block its comment marker), so this owns only the grid.
 * The grid flows in cell order and never places a cell out of it, so focus
 * moves through the cells in the order they read; at dock and phone widths
 * the stylesheet collapses it to one column in that same order.
 */
export function DashboardBlock<B>(props: {
  readonly title: string;
  /**
   * The title's heading level in its surface's outline: the document puts it
   * under the Canvas title, a shared snapshot under its own deeper heading.
   */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6;
  readonly columns: number;
  readonly cells: ReadonlyArray<CanvasDashboardPlacedCell<B>>;
  readonly renderCell: (block: B) => ReactNode;
  readonly cellKey: (block: B) => string;
  readonly cellKind: (block: B) => string;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="canvas-dashboard">
      {createElement(
        `h${String(props.headingLevel ?? 2)}`,
        { className: "canvas-dashboard__title", id: titleId },
        props.title,
      )}
      <div className="canvas-dashboard__grid" data-columns={String(props.columns)}>
        {props.cells.map((cell) => (
          <div
            className="canvas-dashboard__cell"
            data-block-kind={props.cellKind(cell.block)}
            data-span={String(cell.span)}
            key={props.cellKey(cell.block)}
          >
            {props.renderCell(cell.block)}
          </div>
        ))}
      </div>
    </section>
  );
}
