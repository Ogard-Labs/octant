import { useMemo, useRef, useState } from "react";
import type { PreviewChunk, PreviewManifest, WorkbookCellValue } from "@octant/contracts/previews";
import { OctantButton } from "../ui/base/OctantButton";
import { PreviewFidelityNotice } from "./PreviewFidelityNotice";
import { buildWorkbookViewModel } from "./previewChunkModel";

function formatCell(cell: WorkbookCellValue): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  return cell;
}

/**
 * Read-only XLSX preview viewer. Renders worksheet tabs and the active
 * worksheet's cell grid as a sticky-header table. Stored cell values and
 * cached formula results are shown; formula execution, macros, charts,
 * and embedded objects are disabled and surfaced via the fidelity notice.
 */
export function WorkbookViewer(props: {
  readonly manifest: PreviewManifest;
  readonly chunks: ReadonlyArray<PreviewChunk>;
}) {
  const model = useMemo(() => buildWorkbookViewModel(props.chunks), [props.chunks]);
  const [active, setActive] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  if (model.worksheets.length === 0) {
    return (
      <section className="preview-viewer" aria-label="Workbook preview">
        <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
        <div className="preview-empty" role="status">
          No worksheets decoded.
        </div>
      </section>
    );
  }

  const safeActive = Math.min(active, model.worksheets.length - 1);
  const sheet = model.worksheets[safeActive];
  const rows = sheet?.rows ?? [];
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = rows[0] ?? [];
  const tabId = (index: number) => `preview-workbook-tab-${index}`;
  const panelId = (index: number) => `preview-workbook-panel-${index}`;

  return (
    <section className="preview-viewer" aria-label="Workbook preview">
      <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
      <div className="preview-viewer__chrome">
        <h2 className="preview-viewer__title" title={props.manifest.target.displayName}>
          {props.manifest.target.displayName}
        </h2>
        <div className="preview-viewer__meta">
          <span>{model.worksheets.length} sheets</span>
          <span>{rows.length} rows</span>
        </div>
      </div>
      <div
        className="preview-workbook__tabs"
        role="tablist"
        aria-label="Worksheets"
        aria-orientation="horizontal"
      >
        {model.worksheets.map((entry, index) => (
          <OctantButton
            aria-controls={panelId(index)}
            aria-selected={index === safeActive}
            className="sheet-tab"
            id={tabId(index)}
            key={index}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              let next: number | undefined;
              if (event.key === "ArrowRight") next = (index + 1) % model.worksheets.length;
              if (event.key === "ArrowLeft") {
                next = (index - 1 + model.worksheets.length) % model.worksheets.length;
              }
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = model.worksheets.length - 1;
              if (next === undefined) return;
              event.preventDefault();
              setActive(next);
              tabRefs.current[next]?.focus();
            }}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            tabIndex={index === safeActive ? 0 : -1}
            type="button"
            variant="ghost"
          >
            {entry.name}
          </OctantButton>
        ))}
      </div>
      <div
        className="preview-viewer__body preview-viewer__body--flush"
        role="tabpanel"
        id={panelId(safeActive)}
        aria-labelledby={tabId(safeActive)}
        tabIndex={0}
      >
        <table className="preview-table datatable" aria-label={`${sheet?.name ?? "Worksheet"}`}>
          <caption>
            Worksheet {sheet?.name ?? ""}: {rows.length} rows, {columnCount} columns.
          </caption>
          <thead>
            <tr>
              {Array.from({ length: columnCount }, (_, c) => (
                <th key={c} scope="col" tabIndex={0}>
                  {formatCell(header[c] ?? "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((row, r) => (
              <tr key={r}>
                {Array.from({ length: columnCount }, (_, c) => (
                  <td key={c} tabIndex={0}>
                    {formatCell(row[c] ?? "")}
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
