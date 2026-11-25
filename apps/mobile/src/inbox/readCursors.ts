import type { MobileInboxRow } from "@octant/client-runtime";

/**
 * How far this phone has read each thread, as the journal position its computer
 * reports. Unread is each client's own, as on the desktop: opening a thread
 * here does not mark it read there.
 */
export type ReadCursors = Readonly<Record<string, HostCursors>>;

interface HostCursors {
  /** Where the computer stood when the phone first saw it: all of that is read. */
  readonly baseline: number;
  /** Threads opened past the baseline, the one read longest ago first. */
  readonly read: Readonly<Record<string, number>>;
}

export const NO_READ_CURSORS: ReadCursors = {};

const MAX_TRACKED_THREADS = 500;

const threadKey = (row: MobileInboxRow): string => `${row.mode}:${row.threadId}`;

/** A first look at a computer starts with nothing to review, not its whole past. */
export function seedHosts(cursors: ReadCursors, rows: ReadonlyArray<MobileInboxRow>): ReadCursors {
  const baselines = new Map<string, number>();
  for (const row of rows)
    if (row.lastSequence !== undefined && cursors[row.hostId] === undefined)
      baselines.set(row.hostId, Math.max(baselines.get(row.hostId) ?? 0, row.lastSequence));
  if (baselines.size === 0) return cursors;
  return {
    ...cursors,
    ...Object.fromEntries(
      [...baselines].map(([hostId, baseline]) => [hostId, { baseline, read: {} }]),
    ),
  };
}

export function isUnread(cursors: ReadCursors, row: MobileInboxRow): boolean {
  const host = cursors[row.hostId];
  if (host === undefined || row.lastSequence === undefined) return false;
  return row.lastSequence > Math.max(host.baseline, host.read[threadKey(row)] ?? 0);
}

export function markRead(cursors: ReadCursors, row: MobileInboxRow): ReadCursors {
  const host = cursors[row.hostId];
  if (host === undefined || row.lastSequence === undefined || !isUnread(cursors, row))
    return cursors;
  const { [threadKey(row)]: _earlier, ...others } = host.read;
  const read = [...Object.entries(others), [threadKey(row), row.lastSequence] as const];
  return {
    ...cursors,
    [row.hostId]: { ...host, read: Object.fromEntries(read.slice(-MAX_TRACKED_THREADS)) },
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
    const cursors: Record<string, HostCursors> = {};
    for (const [hostId, host] of Object.entries(parsed)) {
      if (!isRecord(host) || typeof host.baseline !== "number" || !isRecord(host.read))
        return NO_READ_CURSORS;
      const read: Record<string, number> = {};
      for (const [key, sequence] of Object.entries(host.read)) {
        if (typeof sequence !== "number") return NO_READ_CURSORS;
        read[key] = sequence;
      }
      cursors[hostId] = { baseline: host.baseline, read };
    }
    return cursors;
  } catch {
    return NO_READ_CURSORS;
  }
}
