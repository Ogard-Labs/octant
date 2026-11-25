import type { MobileInboxRow } from "@octant/client-runtime";

/**
 * How far this phone has read each thread, as the journal position its computer
 * reports, kept by computer and mode: a computer answers for its modes apart,
 * and one that answered first must not say how far another had come. Unread is each client's own, as on the desktop: opening a thread
 * here does not mark it read there.
 */
export type ReadCursors = Readonly<Record<string, ModeCursors>>;

interface ModeCursors {
  /** Where the computer's threads stood when the phone first saw it: all of that is read. */
  readonly baseline: number;
  /** Threads opened past the baseline, the one read longest ago first. */
  readonly read: Readonly<Record<string, number>>;
}

export const NO_READ_CURSORS: ReadCursors = {};

const MAX_TRACKED_THREADS = 500;

const modeKey = (row: MobileInboxRow): string => `${row.hostId}:${row.mode}`;

/** A first look at a computer starts with nothing to review, not its whole past. */
export function seedRead(cursors: ReadCursors, rows: ReadonlyArray<MobileInboxRow>): ReadCursors {
  const baselines = new Map<string, number>();
  for (const row of rows) {
    const key = modeKey(row);
    if (row.lastSequence !== undefined && cursors[key] === undefined)
      baselines.set(key, Math.max(baselines.get(key) ?? 0, row.lastSequence));
  }
  if (baselines.size === 0) return cursors;
  return {
    ...cursors,
    ...Object.fromEntries([...baselines].map(([key, baseline]) => [key, { baseline, read: {} }])),
  };
}

export function isUnread(cursors: ReadCursors, row: MobileInboxRow): boolean {
  const mode = cursors[modeKey(row)];
  if (mode === undefined || row.lastSequence === undefined) return false;
  return row.lastSequence > Math.max(mode.baseline, mode.read[row.threadId] ?? 0);
}

export function markRead(cursors: ReadCursors, row: MobileInboxRow): ReadCursors {
  const mode = cursors[modeKey(row)];
  if (mode === undefined || row.lastSequence === undefined || !isUnread(cursors, row))
    return cursors;
  const { [row.threadId]: _earlier, ...others } = mode.read;
  const read = [...Object.entries(others), [row.threadId, row.lastSequence] as const];
  return {
    ...cursors,
    [modeKey(row)]: { ...mode, read: Object.fromEntries(read.slice(-MAX_TRACKED_THREADS)) },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the phone kept, or nothing at all when it cannot be read whole. */
export function parseReadCursors(kept: string | null): ReadCursors {
  if (kept === null) return NO_READ_CURSORS;
  try {
    const parsed: unknown = JSON.parse(kept);
    if (!isRecord(parsed)) return NO_READ_CURSORS;
    const cursors: Record<string, ModeCursors> = {};
    for (const [key, mode] of Object.entries(parsed)) {
      if (!isRecord(mode) || typeof mode.baseline !== "number" || !isRecord(mode.read))
        return NO_READ_CURSORS;
      const read: Record<string, number> = {};
      for (const [threadId, sequence] of Object.entries(mode.read)) {
        if (typeof sequence !== "number") return NO_READ_CURSORS;
        read[threadId] = sequence;
      }
      cursors[key] = { baseline: mode.baseline, read };
    }
    return cursors;
  } catch {
    return NO_READ_CURSORS;
  }
}
