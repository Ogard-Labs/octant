import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { readTranscriptText } from "./transcriptFind";

const INDEX_BATCH_SIZE = 32;

interface IndexedRow<T> {
  readonly item: T;
  readonly text: ReadonlyArray<string>;
}
interface TextIndex<T> {
  readonly keys: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<IndexedRow<T> | undefined>;
  readonly cursor: number;
}

/** Preserve rendered-text semantics without mounting an entire conversation. */
export function useTranscriptFindIndex<T>(
  items: ReadonlyArray<T>,
  itemKey: (item: T, index: number) => string,
  enabled: boolean,
  query: string,
  root: RefObject<HTMLDivElement | null>,
) {
  const keys = useMemo(() => (enabled ? items.map(itemKey) : []), [enabled, items, itemKey]);
  const [index, setIndex] = useState<TextIndex<T> | undefined>();
  useEffect(() => {
    setIndex((previous) => {
      if (!enabled) return undefined;
      const byKey = new Map(previous?.keys.map((key, i) => [key, previous.rows[i]]));
      return { keys, rows: keys.map((key) => byKey.get(key)), cursor: previous?.cursor ?? 0 };
    });
  }, [keys, enabled]);
  const rows = useMemo(() => {
    if (!enabled || index === undefined) return undefined;
    if (index.keys === keys) return index.rows;
    const byKey = new Map(index.keys.map((key, i) => [key, index.rows[i]]));
    return keys.map((key) => byKey.get(key));
  }, [enabled, index, keys]);
  const cursor = index?.cursor ?? 0;
  const batch = useMemo(() => {
    const result: number[] = [];
    if (!enabled) return result;
    // Rotate through stale rows instead of restarting at zero on each token.
    // Even callers that recreate every row while streaming cannot starve the
    // end of a long history. Changed text refreshes while known matches stay usable.
    for (let n = 0; n < items.length && result.length < INDEX_BATCH_SIZE; n++) {
      const i = (cursor + n) % items.length;
      if (rows?.[i]?.item !== items[i]) result.push(i);
    }
    return result;
  }, [cursor, enabled, items, rows]);
  const pending = enabled && (rows === undefined || rows.some((row) => row === undefined));

  useLayoutEffect(() => {
    if (batch.length === 0 || rows === undefined || root.current === null) return;
    const next = [...rows];
    for (const i of batch) {
      const row = root.current.querySelector(`[data-transcript-row][data-index="${i}"]`);
      const item = items[i];
      if (row === null || item === undefined) return;
      next[i] = { item, text: readTranscriptText(row) };
    }
    const last = batch[batch.length - 1];
    // A task boundary lets input/paint interrupt indexing. Closing Find or
    // changing the row set cancels this stale batch before it can publish.
    const timer = setTimeout(
      () =>
        setIndex((current) => {
          if (current === undefined || current.keys !== keys) return current;
          const merged = [...current.rows];
          for (const i of batch) {
            // A disclosure can change after this batch reads it but before the task
            // publishes. Keep the newer visibility observation in that case.
            if (current.rows[i] === rows[i]) merged[i] = next[i];
          }
          return { keys, rows: merged, cursor: (last ?? 0) + 1 };
        }),
      0,
    );
    return () => clearTimeout(timer);
  }, [batch, items, keys, root, rows]);

  const refreshRow = useCallback(
    (rowIndex: number, element: Element) => {
      const item = items[rowIndex];
      const key = keys[rowIndex];
      if (!enabled || item === undefined || key === undefined) return;
      const text = readTranscriptText(element);
      setIndex((current) => {
        if (current === undefined) return current;
        const i = current.keys.indexOf(key);
        if (i < 0) return current;
        const previous = current.rows[i];
        if (
          previous?.item === item &&
          previous.text.length === text.length &&
          previous.text.every((run, offset) => run === text[offset])
        )
          return current;
        const next = [...current.rows];
        next[i] = { item, text };
        return { ...current, rows: next };
      });
    },
    [enabled, items, keys],
  );

  const counts = useRef(
    new WeakMap<ReadonlyArray<string>, { readonly query: string; readonly count: number }>(),
  );
  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    const found: Array<{ readonly row: number; readonly first: number; readonly count: number }> =
      [];
    let total = 0;
    if (needle !== "" && !pending && rows !== undefined) {
      rows.forEach((entry, row) => {
        if (entry === undefined) return;
        const cached = counts.current.get(entry.text);
        let count = cached?.query === needle ? cached.count : 0;
        if (cached?.query !== needle) {
          for (const run of entry.text) {
            for (
              let at = run.indexOf(needle);
              at !== -1;
              at = run.indexOf(needle, at + needle.length)
            )
              count++;
          }
          counts.current.set(entry.text, { query: needle, count });
        }
        if (count > 0) found.push({ row, first: total, count });
        total += count;
      });
    }
    return { rows: found, total };
  }, [pending, query, rows]);
  return { batch, pending, matches, refreshRow };
}
