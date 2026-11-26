/**
 * From this window width a list place shows its list and the open thread side
 * by side: an iPad, iPhone Duo's inner screen, an Android foldable opened or
 * a tablet. A phone held either way and iPhone Duo's cover screen keep one
 * column.
 */
export const COLUMNS_MIN_WIDTH = 640;

export function showsColumns(width: number): boolean {
  return width >= COLUMNS_MIN_WIDTH;
}

/** The list column's width: wide enough for a row, never more than it needs. */
export function listColumnWidth(width: number): number {
  return Math.round(Math.min(380, Math.max(300, width * 0.38)));
}

/**
 * What keeps the person's place when the window crosses the column width, as
 * when a foldable is folded or opened or an iPad window is resized: the thread
 * open in the second column moves onto the stack, and a thread pushed onto the
 * stack moves back into the column. Anything else on the stack stays.
 */
export type ColumnsChange<Row> =
  | { readonly kind: "push-thread"; readonly row: Row }
  | { readonly kind: "take-thread"; readonly row: Row }
  | { readonly kind: "none" };

export function columnsChange<Row>(input: {
  readonly columns: boolean;
  readonly openInColumn: Row | undefined;
  /** The stack above the place's list, oldest first. */
  readonly pushed: ReadonlyArray<{ readonly name: string; readonly row?: Row }>;
}): ColumnsChange<Row> {
  if (!input.columns) {
    return input.openInColumn === undefined
      ? { kind: "none" }
      : { kind: "push-thread", row: input.openInColumn };
  }
  const [only] = input.pushed;
  // Only a thread straight above the list moves; a deeper stack was the
  // person's own path and is left as it is.
  if (input.pushed.length === 1 && only?.name === "thread" && only.row !== undefined) {
    return { kind: "take-thread", row: only.row };
  }
  return { kind: "none" };
}

/**
 * The open thread's identity in its column. A thread screen looks for a search
 * hit once, when it mounts, as a pushed one does for every hit, so a second hit
 * in the same thread mounts it afresh.
 */
export function openThreadKey(thread: string, focusTurnId: string | undefined): string {
  return focusTurnId === undefined ? thread : `${thread}:${focusTurnId}`;
}
