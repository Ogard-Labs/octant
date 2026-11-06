import { decodeCodeFileChangeNotice, type CodeFileChangeNotice } from "@octant/contracts";
import type { CodeFileWatchQuery } from "./codeFileListingClient";

interface Reader {
  readonly query: CodeFileWatchQuery;
  pending?: CodeFileChangeNotice;
  error?: unknown;
  closed: boolean;
  wake?: () => void;
}
interface Connection {
  readonly readers: Set<Reader>;
  active?: AbortController;
  revision: number;
  scheduled: boolean;
}
type Open = (
  query: CodeFileWatchQuery,
  folders: ReadonlyArray<string>,
  signal: AbortSignal,
  ready: () => void,
) => AsyncIterable<CodeFileChangeNotice>;
const connections = new WeakMap<typeof globalThis.fetch, Map<string, Connection>>();
const wake = (reader: Reader) => {
  const notify = reader.wake;
  delete reader.wake;
  notify?.();
};

/** Visible folders and duplicate panes share one bounded stream per checkout/window. */
export async function* followCodeFileChanges(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly key: string;
  readonly query: CodeFileWatchQuery;
  readonly signal: AbortSignal;
  readonly open: Open;
}): AsyncGenerator<CodeFileChangeNotice> {
  if (input.signal.aborted) return;
  let registry = connections.get(input.fetch);
  if (registry === undefined) {
    registry = new Map();
    connections.set(input.fetch, registry);
  }
  let connection = registry.get(input.key);
  if (connection === undefined) {
    connection = { readers: new Set(), revision: 0, scheduled: false };
    registry.set(input.key, connection);
  }
  const owned = connection;
  const reader: Reader = { query: input.query, closed: false };
  const invalidate = () => {
    for (const target of owned.readers) {
      target.pending = decodeCodeFileChangeNotice({
        kind: "code-file-change",
        threadId: target.query.threadId,
        checkoutId: target.query.checkoutId,
        ...(target.query.folder === undefined ? {} : { folder: target.query.folder }),
        paths: [],
        truncated: true,
        observedAt: new Date().toISOString(),
      });
      wake(target);
    }
  };
  const schedule = () => {
    if (owned.scheduled) return;
    owned.scheduled = true;
    void Promise.resolve().then(async () => {
      owned.scheduled = false;
      owned.active?.abort();
      const revision = ++owned.revision;
      if (owned.readers.size === 0) return;
      const active = new AbortController();
      owned.active = active;
      const folders = [
        ...new Set([...owned.readers].map((target) => target.query.folder ?? ".")),
      ].sort();
      try {
        for await (const notice of input.open(input.query, folders, active.signal, invalidate)) {
          if (revision !== owned.revision || active.signal.aborted) return;
          for (const target of owned.readers) {
            if ((target.query.folder ?? ".") !== (notice.folder ?? ".")) continue;
            target.pending =
              target.pending === undefined ? notice : { ...notice, paths: [], truncated: true };
            wake(target);
          }
        }
      } catch (error) {
        if (revision !== owned.revision || active.signal.aborted) return;
        for (const target of owned.readers) target.error = error;
      } finally {
        if (revision === owned.revision && !active.signal.aborted) {
          if (registry.get(input.key) === owned) registry.delete(input.key);
          for (const target of owned.readers) {
            target.closed = true;
            wake(target);
          }
        }
      }
    });
  };
  const previousFolders = new Set([...owned.readers].map((target) => target.query.folder ?? "."));
  owned.readers.add(reader);
  if (!previousFolders.has(input.query.folder ?? ".")) schedule();
  const abort = () => {
    reader.closed = true;
    wake(reader);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    while (!reader.closed || reader.pending !== undefined) {
      if (input.signal.aborted) return;
      if (reader.error !== undefined) throw reader.error;
      const notice = reader.pending;
      if (notice !== undefined) {
        delete reader.pending;
        yield notice;
      } else
        await new Promise<void>((resolve) => {
          reader.wake = resolve;
        });
    }
    if (reader.error !== undefined) throw reader.error;
  } finally {
    input.signal.removeEventListener("abort", abort);
    owned.readers.delete(reader);
    if (owned.readers.size === 0) {
      owned.revision++;
      owned.active?.abort();
      if (registry.get(input.key) === owned) registry.delete(input.key);
    } else if (
      [...owned.readers].some((target) => !target.closed) &&
      ![...owned.readers].some((target) => target.query.folder === reader.query.folder)
    )
      schedule();
  }
}
