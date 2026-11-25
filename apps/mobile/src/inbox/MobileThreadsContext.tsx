import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMobileCodeProjects,
  fetchMobileProviderCatalog,
  fetchMobileWorkProjects,
  listAllHostsMobileInbox,
  MobileInboxFailure,
  normalizeMobileProviderDirectory,
  sortMobileInboxRows,
  type MobileInboxHostFailure,
  type MobileInboxRow,
  type MobileProviderDirectoryEntry,
} from "@octant/client-runtime";
import { useMobileSession } from "../session/MobileSessionContext";
import { forgetHosts, isUnread, markRead, parseReadCursors, seedRead } from "./readCursors";
import { keepReadCursors, loadReadCursors } from "./readCursorFile";
import { createThreadDrafts, liveThreadDrafts, type ThreadDrafts } from "./threadDrafts";
import { createRequestGuard } from "./requestGuard";

/**
 * The threads of every paired computer, read once for every place. Home's
 * counts, Threads and Inbox show the same rows, so a number and the list it
 * opens cannot come from two reads that disagree.
 */
export interface MobileThreads {
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly failures: ReadonlyArray<MobileInboxHostFailure>;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  /** The person has this thread open, or (with none) has left it. */
  readonly reading: (row: MobileInboxRow | undefined) => void;
  /** A thread was just settled, which the person may still take back. */
  readonly settled: (row: MobileInboxRow) => void;
  /** The thread Undo would take back. */
  readonly undoable: MobileInboxRow | undefined;
  readonly clearUndo: () => void;
  /** What was being written in a thread, kept while the app runs. */
  readonly drafts: ThreadDrafts;
  readonly hostLabel: (hostId: string) => string;
  readonly projectName: (row: MobileInboxRow) => string | undefined;
  /** Who answers a thread; unknown until its computer's directory is read. */
  readonly provider: (
    row: MobileInboxRow,
  ) => Pick<MobileProviderDirectoryEntry, "displayName" | "driverKind"> | undefined;
  /** Every Project the paired computers name, for the Threads filter. */
  readonly projects: ReadonlyArray<{
    readonly hostId: string;
    readonly projectId: string;
    readonly name: string;
  }>;
}

// In memory alone, through the app's lock: the rows each computer last answered.
let lastRows: ReadonlyArray<MobileInboxRow> = [];

/** What was read now, and the rows of the computers that did not answer. */
function withUnreached(
  read: ReadonlyArray<MobileInboxRow>,
  earlier: ReadonlyArray<MobileInboxRow>,
  answered: ReadonlySet<string>,
): ReadonlyArray<MobileInboxRow> {
  const missing = earlier.filter(
    (row) =>
      !answered.has(row.hostId) &&
      !read.some(
        (entry) =>
          entry.hostId === row.hostId && entry.mode === row.mode && entry.threadId === row.threadId,
      ),
  );
  return missing.length === 0 ? read : sortMobileInboxRows([...read, ...missing]);
}

const Context = createContext<MobileThreads | undefined>(undefined);

export function useMobileThreads(): MobileThreads {
  const value = useContext(Context);
  if (value === undefined) throw new Error("Threads are read inside MobileThreadsProvider.");
  return value;
}

export function MobileThreadsProvider(props: { readonly children: ReactNode }) {
  const { transports, hosts, hostsLoaded, hostsError, health, environment } = useMobileSession();
  // Sample threads are read and forgotten with the demo.
  const keeps = environment.kind === "live";
  const [held, setRows] = useState<ReadonlyArray<MobileInboxRow>>(() => (keeps ? lastRows : []));
  useEffect(() => {
    if (keeps) lastRows = held;
  }, [held, keeps]);
  const [failures, setFailures] = useState<ReadonlyArray<MobileInboxHostFailure>>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const requestGuard = useRef(createRequestGuard()).current;

  const [cursors, setCursors] = useState(() => parseReadCursors(keeps ? loadReadCursors() : null));
  useEffect(() => {
    if (keeps) keepReadCursors(JSON.stringify(cursors));
  }, [cursors, keeps]);
  useEffect(() => {
    if (keeps && hostsLoaded && hostsError === undefined)
      setCursors((current) => forgetHosts(current, new Set(hosts.map((host) => host.hostId))));
    if (!hostsLoaded || hostsError !== undefined) return;
    // One that rejected this phone shows it nothing more than one taken off it.
    const paired = new Set(
      hosts
        .map((host) => host.hostId)
        .filter(
          (hostId) => health.find((entry) => entry.hostId === hostId)?.kind !== "unauthorized",
        ),
    );
    setRows((current) =>
      current.every((row) => paired.has(row.hostId))
        ? current
        : current.filter((row) => paired.has(row.hostId)),
    );
    const written = hosts.map((host) => `${host.hostKeyFingerprint}:${host.hostId}:`);
    if (keeps)
      liveThreadDrafts.keepOnly((thread) => written.some((prefix) => thread.startsWith(prefix)));
  }, [health, hosts, hostsError, hostsLoaded, keeps]);
  // The thread on screen. What it did while it was read is read as well, which
  // the first list after it is left still has to know.
  const open = useRef<MobileInboxRow | undefined>(undefined);
  const left = useRef<MobileInboxRow | undefined>(undefined);
  const reading = useCallback((row: MobileInboxRow | undefined) => {
    if (row === undefined) left.current = open.current;
    open.current = row;
    if (row !== undefined) setCursors((current) => markRead(current, row));
  }, []);
  const readThrough = useCallback((result: ReadonlyArray<MobileInboxRow>) => {
    const seen = [open.current, left.current].filter((row) => row !== undefined);
    left.current = undefined;
    setCursors((current) =>
      result
        .filter((row) =>
          seen.some(
            (entry) =>
              entry.hostId === row.hostId &&
              entry.mode === row.mode &&
              entry.threadId === row.threadId,
          ),
        )
        .reduce(markRead, seedRead(current, result)),
    );
  }, []);

  const refresh = useCallback(async () => {
    // A slower, older fetch must not overwrite what a newer one already showed.
    const request = requestGuard.begin();
    if (transports.length === 0) {
      // Computers that cannot be reached still have their threads: the rows last
      // read stay, so a message can be written to one.
      setFailures([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const result = await listAllHostsMobileInbox(transports);
      if (!requestGuard.isCurrent(request)) return;
      const answered = new Set(
        transports
          .map((transport) => transport.hostId)
          .filter(
            (hostId) =>
              !result.failures.some(
                (failure) => failure.hostId === hostId && failure.category !== "rejected",
              ),
          ),
      );
      setRows((current) => withUnreached(result.rows, current, answered));
      setFailures(result.failures);
      readThrough(result.rows);
    } catch (cause) {
      if (!requestGuard.isCurrent(request)) return;
      setFailures([]);
      setError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not load threads from your computers.",
      );
    } finally {
      if (requestGuard.isCurrent(request)) setLoading(false);
    }
  }, [readThrough, requestGuard, transports]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Project names from every paired computer, not only the one new threads go
  // to: a thread on a second computer otherwise grouped under a bare "Project".
  const [projects, setProjects] = useState<MobileThreads["projects"]>([]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      transports.map(async (transport) => {
        const [work, code] = await Promise.all([
          fetchMobileWorkProjects(transport).catch(() => []),
          fetchMobileCodeProjects(transport).catch(() => []),
        ]);
        const named = new Map(
          [...work, ...code].map((project) => [String(project.projectId), project.name]),
        );
        return [...named].map(([projectId, name]) => ({
          hostId: transport.hostId,
          projectId,
          name,
        }));
      }),
    ).then((entries) => {
      if (!cancelled) setProjects(entries.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [transports]);

  // Only what a row's mark needs; a computer whose directory cannot be read
  // leaves its rows unmarked, and its threads are listed all the same.
  const [providers, setProviders] = useState<
    ReadonlyMap<string, Pick<MobileProviderDirectoryEntry, "displayName" | "driverKind">>
  >(new Map());
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      transports.map(async (transport) => {
        const catalog = await fetchMobileProviderCatalog(transport).catch(() => undefined);
        return catalog === undefined
          ? []
          : normalizeMobileProviderDirectory(catalog).map(
              ({ providerInstanceId, displayName, driverKind }) =>
                [`${transport.hostId}:${providerInstanceId}`, { displayName, driverKind }] as const,
            );
      }),
    ).then((entries) => {
      if (!cancelled) setProviders(new Map(entries.flat()));
    });
    return () => {
      cancelled = true;
    };
  }, [transports]);

  const rows = useMemo(
    () => held.map((row) => (isUnread(cursors, row) ? { ...row, unread: true } : row)),
    [cursors, held],
  );
  const [drafts] = useState(() => (keeps ? liveThreadDrafts : createThreadDrafts()));
  const [undoable, settled] = useState<MobileInboxRow | undefined>();
  const clearUndo = useCallback(() => settled(undefined), []);
  const value = useMemo<MobileThreads>(() => {
    const labels = new Map(hosts.map((host) => [host.hostId, host.label]));
    const names = new Map(
      projects.map((project) => [`${project.hostId}:${project.projectId}`, project.name]),
    );
    return {
      rows,
      failures,
      error,
      loading,
      refresh,
      reading,
      drafts,
      settled,
      undoable,
      clearUndo,
      projects,
      hostLabel: (hostId) => labels.get(hostId) ?? hostId.slice(0, 8),
      provider: (row) =>
        row.providerInstanceId === undefined
          ? undefined
          : providers.get(`${row.hostId}:${row.providerInstanceId}`),
      projectName: (row) =>
        row.projectId === undefined ? undefined : names.get(`${row.hostId}:${row.projectId}`),
    };
  }, [
    clearUndo,
    drafts,
    error,
    failures,
    hosts,
    loading,
    projects,
    providers,
    reading,
    refresh,
    rows,
    undoable,
  ]);

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
