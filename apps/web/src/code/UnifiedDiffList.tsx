import type { DiffHunk, ParsedDiffFile } from "./unifiedDiff";
import { OctantButton } from "../ui/base/OctantButton";

export interface UnifiedDiffListProps {
  readonly files: ReadonlyArray<ParsedDiffFile>;
  readonly onOpenFile?: (path: string) => void;
}

const CHANGE_LABELS: Readonly<Record<ParsedDiffFile["change"], string>> = {
  created: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
};

const MARKERS: Readonly<Record<DiffHunk["lines"][number]["kind"], string>> = {
  added: "+",
  removed: "−",
  context: " ",
};

/**
 * Every changed file, stacked, each as the unified diff git printed for it:
 * both line numbers, the marker, the line. Reading a change top to bottom
 * needs no selection; the unchanged stretches between hunks are named by
 * length so the reader knows how far apart two hunks sit in the file.
 */
export function UnifiedDiffList(props: UnifiedDiffListProps) {
  return (
    <div className="unified-diff">
      {props.files.map((file) => (
        <section aria-label={file.path} className="unified-diff__file" key={file.id}>
          <header className="unified-diff__file-header">
            <h2 className="unified-diff__path" title={file.path}>
              {file.path}
            </h2>
            {file.previousPath === undefined ? null : (
              <span className="unified-diff__renamed">from {file.previousPath}</span>
            )}
            <span className="unified-diff__change">{CHANGE_LABELS[file.change]}</span>
            {file.binary ? null : (
              <span className="unified-diff__counts">
                <span className="unified-diff__additions">+{file.additions.toLocaleString()}</span>
                <span className="unified-diff__deletions">−{file.deletions.toLocaleString()}</span>
              </span>
            )}
            {props.onOpenFile === undefined || file.change === "deleted" ? null : (
              <OctantButton
                onClick={() => props.onOpenFile?.(file.path)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Open
              </OctantButton>
            )}
          </header>
          {file.binary ? (
            <p className="unified-diff__binary">
              This file changed without a textual diff, so there is nothing to compare.
            </p>
          ) : (
            <table aria-label={`Diff for ${file.path}`} className="unified-diff__table">
              <tbody>{hunkRows(file.hunks)}</tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

function hunkRows(hunks: ReadonlyArray<DiffHunk>) {
  const rows: React.ReactNode[] = [];
  let previousEnd = 1;
  hunks.forEach((hunk, index) => {
    const unchanged = hunk.oldStart - previousEnd;
    if (unchanged > 0) {
      rows.push(
        <tr className="unified-diff__gap" key={`gap-${String(index)}`}>
          <td colSpan={4}>
            {unchanged.toLocaleString()} unchanged {unchanged === 1 ? "line" : "lines"}
          </td>
        </tr>,
      );
    }
    hunk.lines.forEach((line, lineIndex) => {
      rows.push(
        <tr
          className="unified-diff__line"
          data-kind={line.kind}
          key={`${String(index)}-${String(lineIndex)}`}
        >
          <td className="unified-diff__number">{line.oldNumber ?? ""}</td>
          <td className="unified-diff__number">{line.newNumber ?? ""}</td>
          <td className="unified-diff__marker">{MARKERS[line.kind]}</td>
          <td className="unified-diff__code">{line.text}</td>
        </tr>,
      );
    });
    previousEnd = hunk.oldStart + hunk.oldLines;
  });
  return rows;
}
