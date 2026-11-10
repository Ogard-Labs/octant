import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { readTranscriptText } from "./transcriptFind";

const INDEX_BATCH_SIZE = 32;

interface TextIndex<T> {
  readonly items: ReadonlyArray<T>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

/** Preserve rendered-text semantics without mounting an entire conversation. */
export function useTranscriptFindIndex<T>(
  items: ReadonlyArray<T>,
  enabled: boolean,
  query: string,
  root: RefObject<HTMLDivElement | null>,
) {
  const [index, setIndex] = useState<TextIndex<T> | undefined>();
  useEffect(() => {
    setIndex(enabled ? { items, rows: [] } : undefined);
  }, [items, enabled]);
  const rows = index?.items === items ? index.rows : undefined;
  const start = rows?.length ?? 0;
  const end = enabled ? Math.min(start + INDEX_BATCH_SIZE, items.length) : 0;
  const pending = enabled && start < items.length;

  useLayoutEffect(() => {
    if (!pending || rows === undefined || root.current === null) return;
    const batch: Array<ReadonlyArray<string>> = [];
    for (let i = start; i < end; i++) {
      const row = root.current.querySelector(`[data-transcript-row][data-index="${i}"]`);
      if (row === null) return;
      batch.push(readTranscriptText(row));
    }
    // A task boundary lets input/paint interrupt indexing. Closing Find,
    // replacing the thread, or receiving new rows cancels the stale batch.
    const timer = setTimeout(() => setIndex({ items, rows: [...rows, ...batch] }), 0);
    return () => clearTimeout(timer);
  }, [end, items, pending, root, rows, start]);

  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    const found: Array<{ readonly row: number; readonly first: number; readonly count: number }> =
      [];
    let total = 0;
    if (needle !== "" && rows !== undefined) {
      rows.forEach((runs, row) => {
        let count = 0;
        for (const run of runs) {
          for (
            let at = run.indexOf(needle);
            at !== -1;
            at = run.indexOf(needle, at + needle.length)
          )
            count++;
        }
        if (count > 0) found.push({ row, first: total, count });
        total += count;
      });
    }
    return { rows: found, total };
  }, [query, rows]);
  return { start, end, pending, matches };
}
