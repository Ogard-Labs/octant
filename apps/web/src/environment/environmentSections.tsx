import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * Which sections of the Environment strip a person folded away, kept in this
 * device's local storage and keyed by window and mode. It is a reading
 * preference like the Artifacts view: it journals nothing, decides nothing the
 * host returns, and the strip's other show and hide choices (a group's
 * disclosure) are component state that is never sent to the host either, so
 * the shell's presentation state has no sibling key to extend.
 */
const STORAGE_KEY = "octant.environment.folded.v1";

type FoldedBySlot = Readonly<Record<string, ReadonlyArray<string>>>;

let memoryRaw: string | null = null;
let parsed: { readonly raw: string | null; readonly value: FoldedBySlot } = {
  raw: null,
  value: {},
};
const listeners = new Set<() => void>();

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Set once storage refuses a write or a read: the choice then lives in memory. */
let memoryOnly = false;

function readRaw(): string | null {
  if (memoryOnly) return memoryRaw;
  try {
    const store = storage();
    if (store === undefined) {
      memoryOnly = true;
      return memoryRaw;
    }
    return store.getItem(STORAGE_KEY);
  } catch {
    memoryOnly = true;
    return memoryRaw;
  }
}

function readAll(): FoldedBySlot {
  const raw = readRaw();
  if (raw === parsed.raw) return parsed.value;
  let value: FoldedBySlot = {};
  try {
    const decoded: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      const next: Record<string, ReadonlyArray<string>> = {};
      for (const [slot, ids] of Object.entries(decoded)) {
        if (Array.isArray(ids)) next[slot] = ids.filter((id) => typeof id === "string");
      }
      value = next;
    }
  } catch {
    // A damaged value reads as "nothing folded", never as a thrown render.
  }
  parsed = { raw, value };
  return value;
}

const NOTHING_FOLDED: ReadonlyArray<string> = [];

function writeFolded(slot: string, id: string, folded: boolean): void {
  const all = readAll();
  const current = all[slot] ?? NOTHING_FOLDED;
  const next = folded ? [...new Set([...current, id])] : current.filter((entry) => entry !== id);
  const raw = JSON.stringify({ ...all, [slot]: next });
  memoryRaw = raw;
  try {
    storage()?.setItem(STORAGE_KEY, raw);
  } catch {
    // A window without storage keeps the choice until it closes.
    memoryOnly = true;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface FoldScope {
  readonly windowKey: string;
  readonly mode: string;
}

const FoldScopeContext = createContext<FoldScope>({ windowKey: "window", mode: "thread" });

/**
 * Names the window, or the mode, that the folds below it are remembered for.
 * Either may be given alone: the workspace names the window, and each
 * Environment strip names its mode.
 */
export function EnvironmentFoldScope(props: {
  readonly windowKey?: string;
  readonly mode?: string;
  readonly children: ReactNode;
}) {
  const parent = useContext(FoldScopeContext);
  const windowKey = props.windowKey ?? parent.windowKey;
  const mode = props.mode ?? parent.mode;
  const value = useMemo(() => ({ windowKey, mode }), [windowKey, mode]);
  return <FoldScopeContext.Provider value={value}>{props.children}</FoldScopeContext.Provider>;
}

/** Whether a section is folded in this window and mode, and the way to flip it. */
export function useEnvironmentSectionFold(sectionId: string): readonly [boolean, () => void] {
  const scope = useContext(FoldScopeContext);
  const slot = `${scope.windowKey}:${scope.mode}`;
  const folded = useSyncExternalStore(
    subscribe,
    () => readAll()[slot] ?? NOTHING_FOLDED,
    () => NOTHING_FOLDED,
  ).includes(sectionId);
  const toggle = useCallback(
    () => writeFolded(slot, sectionId, !(readAll()[slot] ?? NOTHING_FOLDED).includes(sectionId)),
    [slot, sectionId],
  );
  return [folded, toggle];
}

/**
 * What a row inside a section knows that the section's folded summary needs.
 * Rows stay mounted while their section is folded, so the summary keeps
 * following them: a subagent that starts under a folded Running section
 * changes its summary and never unfolds it.
 */
export type SectionReport =
  | { readonly kind: "running"; readonly count: number | undefined }
  | { readonly kind: "summary"; readonly text: string | undefined };

type Report = (key: string, report: SectionReport | undefined) => void;

export const EnvironmentSectionReportContext = createContext<Report | undefined>(undefined);

/**
 * Whether the section a row stands in is folded. Folded rows stay mounted so
 * the section's summary keeps following them, which also left a row's own
 * once-a-second clock running with nothing on screen to tick.
 */
export const EnvironmentSectionFoldedContext = createContext(false);

export function useEnvironmentSectionFolded(): boolean {
  return useContext(EnvironmentSectionFoldedContext);
}

function useReport(report: SectionReport): void {
  const key = useId();
  const send = useContext(EnvironmentSectionReportContext);
  const count = report.kind === "running" ? report.count : undefined;
  const text = report.kind === "summary" ? report.text : undefined;
  const kind = report.kind;
  useEffect(() => {
    send?.(key, kind === "running" ? { kind, count } : { kind, text });
  }, [send, key, kind, count, text]);
  useEffect(() => () => send?.(key, undefined), [send, key]);
}

/**
 * How many things in this row are running. Absent while the row has not yet
 * been read, so the section never says "Nothing running" before everything
 * that could be running has answered.
 */
export function useReportRunning(count: number | undefined): void {
  useReport({ kind: "running", count });
}

/** The one short fact this row gives the section's folded line. */
export function useReportSummary(text: string | undefined): void {
  useReport({ kind: "summary", text });
}

/** Renders nothing; lets a parent that owns the data report it for the section. */
export function EnvironmentRunningReport(props: { readonly count: number | undefined }) {
  useReportRunning(props.count);
  return null;
}

export function summaryOfReports(reports: ReadonlyMap<string, SectionReport>): string | undefined {
  let running = 0;
  let sawRunning = false;
  let pending = false;
  let text: string | undefined;
  for (const report of reports.values()) {
    if (report.kind === "running") {
      sawRunning = true;
      if (report.count === undefined) pending = true;
      else running += report.count;
    } else if (text === undefined) {
      text = report.text;
    }
  }
  if (sawRunning) {
    if (running > 0) return `${String(running)} running`;
    return pending ? undefined : "Nothing running";
  }
  return text;
}
