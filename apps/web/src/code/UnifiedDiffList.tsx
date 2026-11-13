import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DiffHunk, ParsedDiffFile } from "./unifiedDiff";
import { OctantButton } from "../ui/base/OctantButton";

export interface UnifiedDiffListProps {
  readonly files: ReadonlyArray<ParsedDiffFile>;
  readonly onOpenFile?: (path: string) => void;
  readonly onReadProviderFile?: (path: string) => void;
  readonly onSelectLine?: (input: {
    path: string;
    side: "original" | "modified";
    line: number;
  }) => void;
  readonly requestedFile?: { readonly path: string };
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

const DIFF_VIRTUALIZATION_THRESHOLD = 60;
const DIFF_OVERSCAN = 12;
const FILE_HEADER_ESTIMATE_PX = 37;
const BINARY_NOTICE_ESTIMATE_PX = 34;
const GAP_ROW_ESTIMATE_PX = 26;
const DIFF_LINE_ESTIMATE_PX = 20;

type DiffVirtualRow =
  | {
      readonly kind: "header";
      readonly index: number;
      readonly fileIndex: number;
      readonly estimate: number;
    }
  | {
      readonly kind: "binary";
      readonly index: number;
      readonly fileIndex: number;
      readonly estimate: number;
    }
  | {
      readonly kind: "gap";
      readonly index: number;
      readonly fileIndex: number;
      readonly hunkIndex: number;
      readonly unchanged: number;
      readonly estimate: number;
    }
  | {
      readonly kind: "line";
      readonly index: number;
      readonly fileIndex: number;
      readonly hunkIndex: number;
      readonly lineIndex: number;
      readonly line: DiffHunk["lines"][number];
      readonly estimate: number;
    };

interface DiffFileRange {
  readonly fileIndex: number;
  readonly headerIndex: number;
  readonly firstBodyIndex: number | undefined;
  readonly lastItemIndex: number;
}

interface DiffVirtualModel {
  readonly rows: ReadonlyArray<DiffVirtualRow>;
  readonly ranges: ReadonlyArray<DiffFileRange>;
  readonly headerIndexByPath: ReadonlyMap<string, number>;
}

interface RenderedFileCluster {
  readonly fileIndex: number;
  readonly items: VirtualItem[];
}

/**
 * Every changed file, stacked, each as the unified diff git printed for it:
 * both line numbers, the marker, the line. Reading a change top to bottom
 * needs no selection; the unchanged stretches between hunks are named by
 * length so the reader knows how far apart two hunks sit in the file.
 */
export function UnifiedDiffList(props: UnifiedDiffListProps) {
  const container = useRef<HTMLDivElement>(null);
  const model = useMemo(() => buildDiffVirtualModel(props.files), [props.files]);
  const virtualized = model.rows.length > DIFF_VIRTUALIZATION_THRESHOLD;
  const [scrollMargin, setScrollMargin] = useState(0);

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: virtualized ? model.rows.length : 0,
    estimateSize: (index) => model.rows[index]?.estimate ?? DIFF_LINE_ESTIMATE_PX,
    getScrollElement: () => nearestScrollableAncestor(container.current) ?? container.current,
    overscan: DIFF_OVERSCAN,
    initialRect: { width: 720, height: 480 },
    scrollMargin,
    getItemKey: (index) => diffRowKey(model.rows[index], props.files, index),
    measureElement: measureDiffElement,
    ...(!virtualized ? { enabled: false } : {}),
  });

  useLayoutEffect(() => {
    if (!virtualized) return;
    const list = container.current;
    const scrollElement = nearestScrollableAncestor(list);
    if (list === null || scrollElement === null) {
      setScrollMargin(0);
      return;
    }
    const update = () => {
      const next = scrollMarginFor(list, scrollElement);
      setScrollMargin((current) => (current === next ? current : next));
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(list);
    observer?.observe(scrollElement);
    return () => {
      observer?.disconnect();
    };
  }, [props.files.length, virtualized]);

  useEffect(() => {
    if (props.requestedFile === undefined) return;
    if (virtualized) {
      const headerIndex = model.headerIndexByPath.get(props.requestedFile.path);
      if (headerIndex !== undefined) {
        virtualizer.scrollToIndex(headerIndex, { align: "start" });
      }
      return;
    }
    const target = Array.from(
      container.current?.querySelectorAll<HTMLElement>("[data-diff-path]") ?? [],
    ).find((item) => item.dataset.diffPath === props.requestedFile?.path);
    target?.scrollIntoView?.({ block: "nearest" });
  }, [model.headerIndexByPath, props.requestedFile, virtualized, virtualizer]);

  if (!virtualized) {
    return (
      <div className="unified-diff" ref={container}>
        {props.files.map((file, fileIndex) => {
          const range = model.ranges[fileIndex];
          const bodyRows =
            range?.firstBodyIndex === undefined
              ? []
              : model.rows.slice(range.firstBodyIndex, range.lastItemIndex + 1);
          return renderFileSection({
            file,
            bodyRows: bodyRows.map((row) => ({ row, virtualIndex: undefined })),
            topSpacerHeight: 0,
            bottomSpacerHeight: 0,
            onOpenFile: props.onOpenFile,
            onReadProviderFile: props.onReadProviderFile,
            onSelectLine: props.onSelectLine,
            measureRef: undefined,
          });
        })}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const measurements = virtualizer.measurementsCache;
  const totalSize = virtualizer.getTotalSize();
  const clusters = clusterByFile(virtualItems, model.rows);
  const firstCluster = clusters[0];
  const lastCluster = clusters.at(-1);
  const firstRange = firstCluster === undefined ? undefined : model.ranges[firstCluster.fileIndex];
  const lastRange = lastCluster === undefined ? undefined : model.ranges[lastCluster.fileIndex];

  const outerTopSpacerHeight =
    firstRange === undefined
      ? 0
      : Math.max(0, (measurements[firstRange.headerIndex]?.start ?? 0) - scrollMargin);
  const outerBottomSpacerHeight =
    lastRange === undefined
      ? totalSize
      : Math.max(0, totalSize - ((measurements[lastRange.lastItemIndex]?.end ?? 0) - scrollMargin));

  return (
    <div className="unified-diff unified-diff--virtualized" ref={container}>
      {outerTopSpacerHeight > 0 ? (
        <div aria-hidden="true" style={{ height: outerTopSpacerHeight }} />
      ) : null}
      {clusters.map((cluster) => {
        const file = props.files[cluster.fileIndex];
        const range = model.ranges[cluster.fileIndex];
        if (file === undefined || range === undefined) return null;

        if (file.binary) {
          return renderFileSection({
            file,
            bodyRows: [],
            topSpacerHeight: 0,
            bottomSpacerHeight: 0,
            onOpenFile: props.onOpenFile,
            onReadProviderFile: props.onReadProviderFile,
            onSelectLine: props.onSelectLine,
            measureRef: undefined,
          });
        }

        const bodyVirtualItems = cluster.items.filter(
          (item) => model.rows[item.index]?.kind !== "header",
        );
        const firstBodyVirtual = bodyVirtualItems[0];
        const lastBodyVirtual = bodyVirtualItems.at(-1);
        const fileFirstBodyStart =
          range.firstBodyIndex === undefined
            ? (measurements[range.headerIndex]?.end ?? 0)
            : (measurements[range.firstBodyIndex]?.start ?? 0);
        const fileEnd = measurements[range.lastItemIndex]?.end ?? fileFirstBodyStart;
        const innerTopSpacer =
          firstBodyVirtual === undefined
            ? 0
            : Math.max(0, firstBodyVirtual.start - fileFirstBodyStart);
        const innerBottomSpacer =
          range.firstBodyIndex === undefined
            ? 0
            : lastBodyVirtual === undefined
              ? Math.max(0, fileEnd - fileFirstBodyStart)
              : Math.max(0, fileEnd - lastBodyVirtual.end);

        const bodyRows = bodyVirtualItems.flatMap((item) => {
          const row = model.rows[item.index];
          return row === undefined ? [] : [{ row, virtualIndex: item.index }];
        });

        return renderFileSection({
          file,
          bodyRows,
          topSpacerHeight: innerTopSpacer,
          bottomSpacerHeight: innerBottomSpacer,
          onOpenFile: props.onOpenFile,
          onReadProviderFile: props.onReadProviderFile,
          onSelectLine: props.onSelectLine,
          measureRef: virtualizer.measureElement,
        });
      })}
      {outerBottomSpacerHeight > 0 ? (
        <div aria-hidden="true" style={{ height: outerBottomSpacerHeight }} />
      ) : null}
    </div>
  );
}

function buildDiffVirtualModel(files: ReadonlyArray<ParsedDiffFile>): DiffVirtualModel {
  const rows: DiffVirtualRow[] = [];
  const ranges: DiffFileRange[] = [];
  const headerIndexByPath = new Map<string, number>();

  files.forEach((file, fileIndex) => {
    const headerIndex = rows.length;
    headerIndexByPath.set(file.path, headerIndex);
    rows.push({
      kind: "header",
      index: headerIndex,
      fileIndex,
      estimate: FILE_HEADER_ESTIMATE_PX,
    });

    if (file.binary) {
      const binaryIndex = rows.length;
      rows.push({
        kind: "binary",
        index: binaryIndex,
        fileIndex,
        estimate: BINARY_NOTICE_ESTIMATE_PX,
      });
      ranges.push({
        fileIndex,
        headerIndex,
        firstBodyIndex: binaryIndex,
        lastItemIndex: binaryIndex,
      });
      return;
    }

    let firstBodyIndex: number | undefined;
    let previousEnd = 1;
    file.hunks.forEach((hunk, hunkIndex) => {
      const unchanged = hunk.oldStart - previousEnd;
      if (unchanged > 0) {
        const gapIndex = rows.length;
        if (firstBodyIndex === undefined) firstBodyIndex = gapIndex;
        rows.push({
          kind: "gap",
          index: gapIndex,
          fileIndex,
          hunkIndex,
          unchanged,
          estimate: GAP_ROW_ESTIMATE_PX,
        });
      }
      hunk.lines.forEach((line, lineIndex) => {
        const lineRowIndex = rows.length;
        if (firstBodyIndex === undefined) firstBodyIndex = lineRowIndex;
        rows.push({
          kind: "line",
          index: lineRowIndex,
          fileIndex,
          hunkIndex,
          lineIndex,
          line,
          estimate: DIFF_LINE_ESTIMATE_PX,
        });
      });
      previousEnd = hunk.oldStart + hunk.oldLines;
    });

    ranges.push({
      fileIndex,
      headerIndex,
      firstBodyIndex,
      lastItemIndex: rows.length - 1,
    });
  });

  return { rows, ranges, headerIndexByPath };
}

function clusterByFile(
  virtualItems: ReadonlyArray<VirtualItem>,
  rows: ReadonlyArray<DiffVirtualRow>,
): RenderedFileCluster[] {
  const clusters: RenderedFileCluster[] = [];
  for (const item of virtualItems) {
    const row = rows[item.index];
    if (row === undefined) continue;
    const current = clusters.at(-1);
    if (current !== undefined && current.fileIndex === row.fileIndex) {
      current.items.push(item);
      continue;
    }
    clusters.push({ fileIndex: row.fileIndex, items: [item] });
  }
  return clusters;
}

function renderFileSection(input: {
  readonly file: ParsedDiffFile;
  readonly bodyRows: ReadonlyArray<{
    readonly row: DiffVirtualRow;
    readonly virtualIndex: number | undefined;
  }>;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
  readonly onOpenFile: UnifiedDiffListProps["onOpenFile"];
  readonly onReadProviderFile: UnifiedDiffListProps["onReadProviderFile"];
  readonly onSelectLine: UnifiedDiffListProps["onSelectLine"];
  readonly measureRef: ((element: Element | null) => void) | undefined;
}): ReactNode {
  const { file } = input;
  return (
    <section
      data-diff-path={file.path}
      aria-label={file.path}
      className="unified-diff__file"
      key={file.id}
    >
      <header className="unified-diff__file-header">
        <h2 className="unified-diff__path" title={file.path}>
          {file.path}
        </h2>
        {file.previousPath === undefined ? null : (
          <span className="unified-diff__renamed">from {file.previousPath}</span>
        )}
        <span className="unified-diff__change">{CHANGE_LABELS[file.change]}</span>
        {input.onReadProviderFile === undefined ? null : (
          <OctantButton
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => input.onReadProviderFile?.(file.path)}
          >
            Provider checkpoint
          </OctantButton>
        )}
        {file.binary ? null : (
          <span className="unified-diff__counts">
            <span className="unified-diff__additions">+{file.additions.toLocaleString("en")}</span>
            <span className="unified-diff__deletions">−{file.deletions.toLocaleString("en")}</span>
          </span>
        )}
        {input.onOpenFile === undefined || file.change === "deleted" ? null : (
          <OctantButton
            onClick={() => input.onOpenFile?.(file.path)}
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
          <tbody>
            {input.topSpacerHeight > 0 ? (
              <tr aria-hidden="true">
                <td
                  className="unified-diff__spacer"
                  colSpan={4}
                  style={{ height: input.topSpacerHeight }}
                />
              </tr>
            ) : null}
            {input.bodyRows.map(({ row, virtualIndex }) =>
              renderBodyRow({
                row,
                virtualIndex,
                path: file.path,
                onSelectLine: input.onSelectLine,
                measureRef: input.measureRef,
              }),
            )}
            {input.bottomSpacerHeight > 0 ? (
              <tr aria-hidden="true">
                <td
                  className="unified-diff__spacer"
                  colSpan={4}
                  style={{ height: input.bottomSpacerHeight }}
                />
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </section>
  );
}

function renderBodyRow(input: {
  readonly row: DiffVirtualRow;
  readonly virtualIndex: number | undefined;
  readonly path: string;
  readonly onSelectLine: UnifiedDiffListProps["onSelectLine"];
  readonly measureRef: ((element: Element | null) => void) | undefined;
}): ReactNode {
  const { row, virtualIndex, path, onSelectLine, measureRef } = input;
  if (row.kind === "gap") {
    return (
      <tr
        className="unified-diff__gap"
        data-index={virtualIndex}
        key={`gap-${String(row.hunkIndex)}`}
        ref={measureRef}
      >
        <td colSpan={4}>
          {row.unchanged.toLocaleString("en")} unchanged {row.unchanged === 1 ? "line" : "lines"}
        </td>
      </tr>
    );
  }
  if (row.kind !== "line") return null;

  const { line } = row;
  const oldNumber = line.oldNumber;
  const newNumber = line.newNumber;
  return (
    <tr
      className="unified-diff__line"
      data-index={virtualIndex}
      data-kind={line.kind}
      key={`${String(row.hunkIndex)}-${String(row.lineIndex)}`}
      ref={measureRef}
    >
      <td className="unified-diff__number">
        {line.oldNumber === undefined ? (
          ""
        ) : onSelectLine === undefined ? (
          line.oldNumber
        ) : (
          <OctantButton
            type="button"
            variant="bare"
            aria-label={`Comment on ${path} original line ${line.oldNumber}`}
            onClick={() => {
              if (oldNumber !== undefined)
                onSelectLine({ path, side: "original", line: oldNumber });
            }}
          >
            {line.oldNumber}
          </OctantButton>
        )}
      </td>
      <td className="unified-diff__number">
        {line.newNumber === undefined ? (
          ""
        ) : onSelectLine === undefined ? (
          line.newNumber
        ) : (
          <OctantButton
            type="button"
            variant="bare"
            aria-label={`Comment on ${path} modified line ${line.newNumber}`}
            onClick={() => {
              if (newNumber !== undefined)
                onSelectLine({ path, side: "modified", line: newNumber });
            }}
          >
            {line.newNumber}
          </OctantButton>
        )}
      </td>
      <td className="unified-diff__marker">{MARKERS[line.kind]}</td>
      <td className="unified-diff__code">{line.text}</td>
    </tr>
  );
}

function diffRowKey(
  row: DiffVirtualRow | undefined,
  files: ReadonlyArray<ParsedDiffFile>,
  index: number,
): string {
  if (row === undefined) return String(index);
  const fileKey = files[row.fileIndex]?.id ?? String(row.fileIndex);
  if (row.kind === "header") return `${fileKey}:header`;
  if (row.kind === "binary") return `${fileKey}:binary`;
  if (row.kind === "gap") return `${fileKey}:gap:${String(row.hunkIndex)}`;
  return `${fileKey}:${String(row.hunkIndex)}-${String(row.lineIndex)}`;
}

function measureDiffElement(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLElement, Element>,
): number {
  const index = instance.indexFromElement(element);
  const blockSize = entry?.borderBoxSize?.[0]?.blockSize;
  const measured =
    blockSize !== undefined && blockSize > 0
      ? Math.round(blockSize)
      : element instanceof HTMLElement
        ? element.offsetHeight
        : 0;
  return measured > 0 ? measured : instance.options.estimateSize(index);
}

function nearestScrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  let ancestor = element?.parentElement ?? null;
  while (ancestor !== null) {
    const style = getComputedStyle(ancestor);
    if (
      /^(auto|overlay|scroll)$/.test(style.overflowY) ||
      ancestor.classList.contains("code-diff-pane__stack")
    ) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function scrollMarginFor(list: HTMLElement, scrollElement: HTMLElement): number {
  const listRect = list.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  return listRect.top - scrollRect.top + scrollElement.scrollTop;
}
