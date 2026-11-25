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
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";
import { sealedFile } from "../outbox/sealedFile";
import { createSealedText } from "../outbox/sealedText";
import { useMobileSession } from "../session/MobileSessionContext";
import { keptThreadsText, restoreKeptThreads, type KeptPairing } from "./keptThreads";
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
  /**
   * What a computer last said this phone's session may do there, kept with
   * the list: while it cannot be reached, it tells whether a message may wait.
   */
  readonly lastStanding: (hostId: string) => RemoteSessionStanding | undefined;
  readonly noteStanding: (hostId: string, standing: RemoteSessionStanding) => void;
  /** Every Project the paired computers name, for the Threads filter. */
  readonly projects: ReadonlyArray<{
    readonly hostId: string;
    readonly projectId: string;
    readonly name: string;
  }>;
}

// In memory, through the app's lock: the rows each computer last answered.
let lastRows: ReadonlyArray<MobileInboxRow> = [];
let lastProjects: MobileThreads["projects"] = [];
let lastStandings: ReadonlyMap<string, RemoteSessionStanding> = new Map();
// What was said of one pairing says nothing of the next with the same computer.
const pairingKey = (host: KeptPairing) => `${host.hostId}:${host.hostKeyFingerprint}:${host.keyId}`;
// The pairing each computer's rows and Project names were read under, through
// the lock: when it changes, they are another pairing's and go.
const liveReadUnder = new Map<string, string>();
// And sealed on the phone, so after a restart a message can still be written
// to a thread whose computer cannot be reached.
let keptThreads: ReturnType<typeof createSealedText> | undefined;
const sealedThreads = () =>
  (keptThreads ??= createSealedText({
    crypto: globalThis.crypto,
    file: sealedFile("threads.v1.sealed"),
    keyName: "octant.threads.key.v1",
    storage: createExpoSecureStringStorage(),
  }));
// What the sealed list was last read or written as, this run: undefined while
// it has not been read yet.
let lastKept: { readonly text: string | undefined } | undefined;

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
  const [projects, setProjects] = useState<MobileThreads["projects"]>(() =>
    keeps ? lastProjects : [],
  );
  useEffect(() => {
    if (keeps) lastProjects = projects;
  }, [keeps, projects]);
  // By pairing.
  const [standings, setStandings] = useState(() =>
    keeps ? lastStandings : new Map<string, RemoteSessionStanding>(),
  );
  useEffect(() => {
    if (keeps) lastStandings = standings;
  }, [keeps, standings]);
  const [failures, setFailures] = useState<ReadonlyArray<MobileInboxHostFailure>>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const requestGuard = useRef(createRequestGuard()).current;
  // Computers that answered since this opened: what they said outranks what was kept.
  const answeredHosts = useRef(new Set<string>());
  const answeredProjects = useRef(new Set<string>());
  const readUnder = useRef(keeps ? liveReadUnder : new Map<string, string>()).current;

  const [cursors, setCursors] = useState(() => parseReadCursors(keeps ? loadReadCursors() : null));
  useEffect(() => {
    if (keeps) keepReadCursors(JSON.stringify(cursors));
  }, [cursors, keeps]);
  useEffect(() => {
    if (keeps && hostsLoaded && hostsError === undefined)
      setCursors((current) => forgetHosts(current, new Set(hosts.map((host) => host.hostId))));
    if (!hostsLoaded || hostsError !== undefined) return;
    // One that rejected this phone shows it nothing more than one taken off it,
    // and one paired again shows nothing read under the pairing before.
    const stillPaired = hosts.filter(
      (host) => health.find((entry) => entry.hostId === host.hostId)?.kind !== "unauthorized",
    );
    const pairedAgain = new Set(
      stillPaired
        .filter((host) => {
          const before = readUnder.get(host.hostId);
          return before !== undefined && before !== pairingKey(host);
        })
        .map((host) => host.hostId),
    );
    readUnder.clear();
    for (const host of stillPaired) readUnder.set(host.hostId, pairingKey(host));
    const paired = new Set(
      stillPaired.map((host) => host.hostId).filter((hostId) => !pairedAgain.has(hostId)),
    );
    setRows((current) =>
      current.every((row) => paired.has(row.hostId))
        ? current
        : current.filter((row) => paired.has(row.hostId)),
    );
    setProjects((current) =>
      current.every((project) => paired.has(project.hostId))
        ? current
        : current.filter((project) => paired.has(project.hostId)),
    );
    const pairs = new Set(
      hosts.filter((host) => paired.has(host.hostId)).map((host) => pairingKey(host)),
    );
    setStandings((current) =>
      [...current.keys()].every((key) => pairs.has(key))
        ? current
        : new Map([...current].filter(([key]) => pairs.has(key))),
    );
    const written = hosts.map((host) => `${host.hostKeyFingerprint}:${host.hostId}:`);
    if (keeps)
      liveThreadDrafts.keepOnly((thread) => written.some((prefix) => thread.startsWith(prefix)));
  }, [health, hosts, hostsError, hostsLoaded, keeps, readUnder]);
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
      for (const hostId of answered) answeredHosts.current.add(hostId);
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
  // A computer that answered neither read keeps the names it gave before.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      transports.map(async (transport) => {
        const [work, code] = await Promise.all([
          fetchMobileWorkProjects(transport).catch(() => undefined),
          fetchMobileCodeProjects(transport).catch(() => undefined),
        ]);
        if (work === undefined && code === undefined) return undefined;
        const named = new Map(
          [...(work ?? []), ...(code ?? [])].map((project) => [
            String(project.projectId),
            project.name,
          ]),
        );
        return {
          hostId: transport.hostId,
          named: [...named].map(([projectId, name]) => ({
            hostId: transport.hostId,
            projectId,
            name,
          })),
        };
      }),
    ).then((entries) => {
      if (cancelled) return;
      const read = entries.filter((entry) => entry !== undefined);
      for (const entry of read) answeredProjects.current.add(entry.hostId);
      setProjects((current) => [
        ...current.filter((project) => !read.some((entry) => entry.hostId === project.hostId)),
        ...read.flatMap((entry) => entry.named),
      ]);
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

  // The kept list is bound to the computers paired now that have not rejected
  // this phone; undefined while that cannot be told.
  const pairings = useMemo<ReadonlyArray<KeptPairing> | undefined>(
    () =>
      !keeps || !hostsLoaded || hostsError !== undefined
        ? undefined
        : hosts
            .filter(
              (host) =>
                health.find((entry) => entry.hostId === host.hostId)?.kind !== "unauthorized",
            )
            .map(({ hostId, hostKeyFingerprint, keyId }) => ({
              hostId,
              hostKeyFingerprint,
              keyId,
            })),
    [health, hosts, hostsError, hostsLoaded, keeps],
  );
  const pairingsNow = useRef(pairings);
  useEffect(() => {
    pairingsNow.current = pairings;
  }, [pairings]);
  // Read once a run, after a restart: under what the computers said since.
  const [restored, setRestored] = useState(() => lastKept !== undefined);
  const canRestore = pairings !== undefined;
  useEffect(() => {
    if (!canRestore || lastKept !== undefined) return;
    let gone = false;
    const restore = (text: string | null) => {
      const now = pairingsNow.current;
      if (gone || lastKept !== undefined || now === undefined) return;
      lastKept = { text: text ?? undefined };
      const kept = restoreKeptThreads(text, now);
      setRows((current) => withUnreached(current, kept.rows, answeredHosts.current));
      setProjects((current) => [
        ...current,
        ...kept.projects.filter(
          (project) =>
            !answeredProjects.current.has(project.hostId) &&
            !current.some((entry) => entry.hostId === project.hostId),
        ),
      ]);
      setStandings(
        (current) =>
          new Map([
            ...now.flatMap((host) => {
              const standing = kept.standings.get(host.hostId);
              return standing === undefined ? [] : [[pairingKey(host), standing] as const];
            }),
            ...current,
          ]),
      );
      setRestored(true);
    };
    sealedThreads()
      .load()
      .then(restore, () => restore(null));
    return () => {
      gone = true;
    };
  }, [canRestore]);
  useEffect(() => {
    if (!restored || pairings === undefined) return;
    const text = keptThreadsText(
      {
        rows: held,
        projects,
        standings: new Map(
          pairings.flatMap((host) => {
            const standing = standings.get(pairingKey(host));
            return standing === undefined ? [] : [[host.hostId, standing] as const];
          }),
        ),
      },
      pairings,
    );
    if (lastKept?.text === text) return;
    const written = { text };
    lastKept = written;
    // Tried again with the next change: until then, a restart shows the list
    // kept before, which the computers replace once they answer.
    sealedThreads()
      .keep(text)
      .catch(() => {
        // No list is kept as empty text, so the next one differs from this.
        if (lastKept === written) lastKept = { text: "" };
      });
  }, [held, pairings, projects, restored, standings]);

  const rows = useMemo(
    () => held.map((row) => (isUnread(cursors, row) ? { ...row, unread: true } : row)),
    [cursors, held],
  );
  const [drafts] = useState(() => (keeps ? liveThreadDrafts : createThreadDrafts()));
  const [undoable, settled] = useState<MobileInboxRow | undefined>();
  const clearUndo = useCallback(() => settled(undefined), []);
  // Steady, so the thread that notes what was said is not asked again for it.
  const hostsNow = useRef(hosts);
  useEffect(() => {
    hostsNow.current = hosts;
  }, [hosts]);
  const noteStanding = useCallback((hostId: string, standing: RemoteSessionStanding) => {
    const host = hostsNow.current.find((entry) => entry.hostId === hostId);
    if (host === undefined) return;
    const key = pairingKey(host);
    setStandings((current) => {
      const before = current.get(key);
      return before?.actsAsHostPerson === standing.actsAsHostPerson &&
        before.accessLevel === standing.accessLevel
        ? current
        : new Map([...current, [key, standing]]);
    });
  }, []);
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
      lastStanding: (hostId) => {
        const host = hosts.find((entry) => entry.hostId === hostId);
        return host === undefined ? undefined : standings.get(pairingKey(host));
      },
      noteStanding,
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
    noteStanding,
    projects,
    providers,
    reading,
    refresh,
    rows,
    standings,
    undoable,
  ]);

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
