export type ThreadBoardState<TView> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: TView }
  | { readonly status: "refreshing"; readonly view: TView }
  | { readonly status: "error"; readonly message: string; readonly view?: TView };

export function lastUsefulView<TView>(board: ThreadBoardState<TView>): TView | undefined {
  if (board.status === "ready" || board.status === "refreshing") return board.view;
  if (board.status === "error") return board.view;
  return undefined;
}

export type BoardStorage = Pick<Storage, "getItem" | "setItem">;

export function defaultBoardStorage(): BoardStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function readStoredValue<T extends string>(
  storage: BoardStorage | undefined,
  key: string,
  parse: (value: string) => T | undefined,
): T | undefined {
  try {
    const value = storage?.getItem(key);
    return value === null || value === undefined ? undefined : parse(value);
  } catch {
    return undefined;
  }
}

export function writeStoredValue(
  storage: BoardStorage | undefined,
  key: string,
  value: string,
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // A device that cannot persist the preference still works this session.
  }
}

export function readStoredBoolean(
  storage: BoardStorage | undefined,
  key: string,
): boolean | undefined {
  const value = readStoredValue(storage, key, (stored) => {
    if (stored === "true" || stored === "false") return stored;
    return undefined;
  });
  return value === undefined ? undefined : value === "true";
}

export function writeStoredBoolean(
  storage: BoardStorage | undefined,
  key: string,
  value: boolean,
): void {
  writeStoredValue(storage, key, String(value));
}

export function activityLabel(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed).toLocaleString();
}

export function firstOrEmpty(values: ReadonlySet<string>): string {
  for (const value of values) return value;
  return "";
}

export interface CardFact<TIcon = unknown> {
  readonly key: string;
  readonly text: string;
  readonly className?: string;
  readonly icon?: TIcon;
  readonly title?: string;
}

export interface ActiveFilterLabel {
  readonly kind: string;
  readonly label: string;
  readonly verbatim?: true;
}
