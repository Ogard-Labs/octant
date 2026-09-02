import {
  createAgentRunClient,
  type AgentRunClient,
  type AgentRunClientCommandResult,
  type AgentRunParentSummaryClientEntry,
} from "@octant/client-runtime";
import type { AgentRunParentThreadId } from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import { samePollingData } from "../polling/samePollingData";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";
import {
  buildChildRunStatusSummary,
  type ChildRunStatusSummary,
} from "./buildChildRunStatusSummary";

export interface ChildRunStatusOptions {
  /** Injected client; otherwise built from the loopback server URL. */
  readonly client?: AgentRunClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly parentThreadId?: AgentRunParentThreadId;
  readonly refreshMs?: number;
  /** Pause new reads while retaining already-known safety controls. */
  readonly enabled?: boolean;
}

/**
 * Whether this parent thread's children are known yet.
 *
 * `loading` is not `ready` with nothing in it: until the host has answered for
 * *this* parent, the hook has no grounds to say the thread has no children, and
 * a surface must not claim emptiness on its behalf.
 */
export type ChildRunStatusReadState = "idle" | "loading" | "ready";

export interface ChildRunStatusController {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly summary: ChildRunStatusSummary;
  /** Whether the host has answered for the currently bound parent thread. */
  readonly status: ChildRunStatusReadState;
  /** True while the last refresh failed and the shown data is stale. */
  readonly reconnecting: boolean;
  readonly busy: boolean;
  readonly errorMessage: string | undefined;
  /** Cancels every live child of this parent thread. Confirm before calling. */
  readonly stopAll: () => Promise<boolean>;
  readonly cancelRun: (runId: string) => Promise<boolean>;
  readonly acknowledge: (input: {
    readonly runId: string;
    readonly version: number;
  }) => Promise<void>;
  readonly refresh: () => void;
}

const EMPTY_SUMMARY = buildChildRunStatusSummary([]);
const NO_ENTRIES: ReadonlyArray<AgentHierarchyInputEntry> = [];

/**
 * One parent thread's read, tagged with the thread it belongs to.
 *
 * The tag is the whole point: a read is only ever shown, counted, or stopped
 * under the parent it was fetched for, so a thread change can never leave the
 * previous thread's runs behind the new thread's controls. `entries` is
 * `undefined` until the host has answered for that parent.
 */
interface ParentThreadRead {
  readonly parentThreadId: AgentRunParentThreadId;
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry> | undefined;
  readonly reconnecting: boolean;
}

/** A failed mutation, tagged with the parent thread the user attempted it on. */
interface ParentThreadFailure {
  readonly parentThreadId: AgentRunParentThreadId | undefined;
  readonly message: string;
}

/**
 * Live child-run status for one parent thread.
 *
 * The host owns the hierarchy: this hook polls `parentSummary` and cancels
 * through the existing AgentRun cancel path. It never walks a subtree of its
 * own and never decides which runs a cancel reaches — `scope: "subtree"` means
 * exactly whatever the server's cancel already includes.
 */
export function useChildRunStatus(options: ChildRunStatusOptions): ChildRunStatusController {
  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (options.serverUrl === undefined || options.windowCapability === undefined) return undefined;
    try {
      return createAgentRunClient({
        baseUrl: options.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: options.windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [options.client, options.serverUrl, options.windowCapability]);

  const [read, setRead] = useState<ParentThreadRead | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ParentThreadFailure | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const parentThreadId = options.parentThreadId;
  // Anything read for another parent thread is the previous thread's data. It
  // is discarded here, during render, so the change takes effect on the very
  // frame the new thread appears — before an effect runs, before the new
  // thread's read resolves, and whether or not that read ever succeeds.
  const current =
    client !== undefined && parentThreadId !== undefined && read?.parentThreadId === parentThreadId
      ? read
      : undefined;
  const entries = current?.entries ?? NO_ENTRIES;
  const refreshMs = options.refreshMs ?? (entries.length > 0 ? 1_000 : 5_000);
  const status: ChildRunStatusReadState =
    client === undefined || parentThreadId === undefined
      ? "idle"
      : current?.entries === undefined
        ? "loading"
        : "ready";
  const reconnecting = current?.reconnecting ?? false;
  // "They are still running" names *this* thread's children, so the message is
  // scoped to the thread whose stop failed and never follows the user away.
  const errorMessage =
    failure !== undefined && failure.parentThreadId === parentThreadId
      ? failure.message
      : undefined;

  useEffect(() => {
    if (client === undefined || parentThreadId === undefined || options.enabled === false) return;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const summary = await client.parentSummary(parentThreadId);
        if (cancelled || !mounted.current) return;
        const entries = summary.entries.map(toHierarchyEntry);
        setRead((previous) => {
          if (
            previous?.parentThreadId === parentThreadId &&
            previous.reconnecting === false &&
            previous.entries !== undefined &&
            samePollingData(previous.entries, entries)
          ) {
            return previous;
          }
          return {
            parentThreadId,
            entries,
            reconnecting: false,
          };
        });
      } catch {
        // Keep this parent's last server-authored hierarchy visible and say so,
        // rather than blanking the chrome and implying the children
        // disappeared. A parent with no answer yet stays empty: saying nothing
        // is honest, showing another thread's runs is not.
        if (cancelled || !mounted.current) return;
        setRead((previous) =>
          previous?.parentThreadId === parentThreadId
            ? { ...previous, reconnecting: true }
            : { parentThreadId, entries: undefined, reconnecting: true },
        );
      } finally {
        inFlight = false;
      }
    };
    const stop = scheduleVisibleInterval(() => void load(), Math.max(10, refreshMs), {
      runImmediately: true,
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [client, options.enabled, parentThreadId, refreshMs, refreshToken]);

  const summary = useMemo(
    () => (entries.length === 0 ? EMPTY_SUMMARY : buildChildRunStatusSummary(entries)),
    [entries],
  );

  const refresh = useCallback(() => setRefreshToken((current) => current + 1), []);

  const cancelRuns = useCallback(
    async (runIds: ReadonlyArray<string>): Promise<boolean> => {
      if (client === undefined || runIds.length === 0) return false;
      setBusy(true);
      setFailure(undefined);
      try {
        const receipts: AgentRunClientCommandResult[] = [];
        for (const runId of runIds) {
          // `subtree` is the existing cancel scope: nested descendants are in
          // scope only because the server's own cancel already includes them.
          const { results } = await client.cancel({ runId: runId as never, scope: "subtree" });
          receipts.push(...results);
        }
        // The host answers with ordinary command receipts. A failed receipt is
        // still a recorded outcome, not a successful stop.
        if (receipts.some((receipt) => receipt.kind === "run-command-failed")) {
          if (mounted.current) {
            setFailure({
              parentThreadId,
              message: "Child runs could not be stopped. They are still running.",
            });
            refresh();
          }
          return false;
        }
        if (mounted.current) refresh();
        return true;
      } catch {
        if (mounted.current) {
          setFailure({
            parentThreadId,
            message: "Child runs could not be stopped. They are still running.",
          });
        }
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [client, parentThreadId, refresh],
  );

  const stopAll = useCallback(
    () => cancelRuns(selectTopLevelStoppableRunIds(entries, summary.stoppableRunIds)),
    [cancelRuns, entries, summary.stoppableRunIds],
  );

  const cancelRun = useCallback((runId: string) => cancelRuns([runId]), [cancelRuns]);

  const acknowledge = useCallback(
    async (input: { readonly runId: string; readonly version: number }) => {
      if (client === undefined) return;
      try {
        await client.acknowledge({ runId: input.runId as never, expectedVersion: input.version });
        if (mounted.current) refresh();
      } catch {
        if (mounted.current) {
          setFailure({ parentThreadId, message: "The result could not be acknowledged." });
        }
      }
    },
    [client, parentThreadId, refresh],
  );

  return {
    entries,
    summary,
    status,
    reconnecting,
    busy,
    errorMessage,
    stopAll,
    cancelRun,
    acknowledge,
    refresh,
  };
}

/**
 * The stoppable runs that still need their own cancellation.
 *
 * A `subtree` cancel already reaches every descendant of the run it names, so
 * submitting a descendant whose ancestor is in the same stop asks the host to
 * cancel a run the first request already cancelled. The host answers a
 * cancellation with no live target as unauthorized, which would report a
 * successful stop as a failure. Only ancestry the server itself reported is
 * used: this walks the summary's own `parentRunId` links and decides nothing
 * about which runs a cancel reaches.
 */
function selectTopLevelStoppableRunIds(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
  stoppableRunIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const stoppable = new Set(stoppableRunIds);
  const parentOf = new Map(entries.map((entry) => [entry.runId, entry.parentRunId]));
  return stoppableRunIds.filter((runId) => {
    const seen = new Set<string>([runId]);
    let ancestor = parentOf.get(runId);
    while (ancestor !== undefined && !seen.has(ancestor)) {
      if (stoppable.has(ancestor)) return false;
      seen.add(ancestor);
      ancestor = parentOf.get(ancestor);
    }
    return true;
  });
}

/**
 * Project a server parent-summary entry onto the hierarchy row shape the
 * existing panel already renders, so the compact chrome and the detail list
 * agree without a second projection.
 */
function toHierarchyEntry(entry: AgentRunParentSummaryClientEntry): AgentHierarchyInputEntry {
  return {
    runId: String(entry.runId),
    ...(entry.parentRunId === undefined ? {} : { parentRunId: String(entry.parentRunId) }),
    role: entry.role,
    task: entry.task,
    lifecycleStatus: entry.lifecycleStatus,
    executionKind: entry.executionKind,
    usageQuality: entry.usageQuality,
    resultAcknowledgement: entry.resultAcknowledgement,
    ...(entry.route === undefined ? {} : { route: entry.route }),
    ...(entry.recoveryReason === undefined ? {} : { recoveryReason: entry.recoveryReason }),
    ...(entry.result === undefined ? {} : { result: entry.result }),
    version: entry.version,
    updatedAt: entry.updatedAt,
  };
}
