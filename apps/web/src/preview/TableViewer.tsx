import { useMemo } from "react";
import type { PreviewChunk, PreviewManifest } from "@octant/contracts/previews";
import { PreviewFidelityNotice } from "./PreviewFidelityNotice";
import { buildTableViewModel } from "./previewChunkModel";

const DELIMITER_LABEL: Record<string, string> = {
  ",": "CSV",
  "\t": "TSV",
  ";": "Semicolon-delimited",
  "|": "Pipe-delimited",
};

/**
 * Read-only CSV/TSV preview viewer. Renders the row grid as a sticky-
 * header table with detected-delimiter metadata and a visible fidelity
 * notice when the render budget truncated the grid. Cells are focusable
 * for accessibility and selection.
 */
export function TableViewer(props: {
  readonly manifest: PreviewManifest;
  readonly chunks: ReadonlyArray<PreviewChunk>;
}) {
  const model = useMemo(() => buildTableViewModel(props.chunks), [props.chunks]);
  const rowCount = model.rows.length;
  const columnCount = model.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = model.rows[0] ?? [];
  const body = model.rows.slice(1);
  const delimiterLabel = DELIMITER_LABEL[model.delimiter] ?? "Delimited";

  if (rowCount === 0) {
    return (
      <section className="preview-viewer" aria-label="Table preview">
        <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
        <div className="preview-empty" role="status">
          No rows parsed.
        </div>
      </section>
    );
  }

  return (
    <section className="preview-viewer" aria-label="Table preview">
      <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
      <div className="preview-viewer__chrome">
        <h2 className="preview-viewer__title" title={props.manifest.target.displayName}>
          {props.manifest.target.displayName}
        </h2>
        <div className="preview-viewer__meta">
          <span>{delimiterLabel}</span>
          <span>{rowCount} rows</span>
          <span>{columnCount} columns</span>
        </div>
      </div>
      <div className="preview-viewer__body preview-viewer__body--flush">
        <table className="preview-table" aria-label={props.manifest.target.displayName}>
          <caption>
            {delimiterLabel} preview of {props.manifest.target.displayName}: {rowCount} rows,{" "}
            {columnCount} columns.
          </caption>
          <thead>
            <tr>
              {Array.from({ length: columnCount }, (_, c) => (
                <th key={c} scope="col" tabIndex={0}>
                  {header[c] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {Array.from({ length: columnCount }, (_, c) => (
                  <td key={c} tabIndex={0}>
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
