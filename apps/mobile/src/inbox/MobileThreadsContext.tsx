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
  fetchMobileWorkProjects,
  listAllHostsMobileInbox,
  MobileInboxFailure,
  type MobileInboxHostFailure,
  type MobileInboxRow,
} from "@octant/client-runtime";
import { useMobileSession } from "../session/MobileSessionContext";
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
  readonly hostLabel: (hostId: string) => string;
  readonly projectName: (row: MobileInboxRow) => string | undefined;
  /** Every Project the paired computers name, for the Threads filter. */
  readonly projects: ReadonlyArray<{
    readonly hostId: string;
    readonly projectId: string;
    readonly name: string;
  }>;
}

const Context = createContext<MobileThreads | undefined>(undefined);

export function useMobileThreads(): MobileThreads {
  const value = useContext(Context);
  if (value === undefined) throw new Error("Threads are read inside MobileThreadsProvider.");
  return value;
}

export function MobileThreadsProvider(props: { readonly children: ReactNode }) {
  const { transports, hosts } = useMobileSession();
  const [rows, setRows] = useState<ReadonlyArray<MobileInboxRow>>([]);
  const [failures, setFailures] = useState<ReadonlyArray<MobileInboxHostFailure>>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const requestGuard = useRef(createRequestGuard()).current;

  const refresh = useCallback(async () => {
    // A slower, older fetch must not overwrite what a newer one already showed.
    const request = requestGuard.begin();
    if (transports.length === 0) {
      setRows([]);
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
      setRows(result.rows);
      setFailures(result.failures);
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
  }, [requestGuard, transports]);

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
      projects,
      hostLabel: (hostId) => labels.get(hostId) ?? hostId.slice(0, 8),
      projectName: (row) =>
        row.projectId === undefined ? undefined : names.get(`${row.hostId}:${row.projectId}`),
    };
  }, [error, failures, hosts, loading, projects, refresh, rows]);

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
