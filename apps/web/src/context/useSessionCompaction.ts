import { ContextClientFailure, type ContextClient } from "@octant/client-runtime/context-client";
import {
  decodeContextCompactionId,
  type ContextCompactionRefusalReason,
  type ContextSubjectRef,
} from "@octant/contracts/context";
import type { ContextCompactionState } from "@octant/contracts/context-rpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRetainedRecord } from "../polling/useRetainedRecord";

export interface SessionCompactionController {
  /** The host's latest answer for this thread; absent until it answers. */
  readonly state?: ContextCompactionState;
  /** The person confirmed, and the host has not answered the request yet. */
  readonly starting: boolean;
  /** Why the host refused the person's last request, while it still refuses. */
  readonly refusal?: ContextCompactionRefusalReason;
  /** The request could not reach the host or was not understood. */
  readonly errorMessage?: string;
  /**
   * A compaction this window watched end. Its outcome is announced once;
   * a result that was already there when the thread opened is not.
   */
  readonly settledId?: string;
  /**
   * A compaction was running when the host stopped answering, and enough
   * reads failed that the window no longer holds the thread on its account.
   * The host may still be compacting; it refuses a turn until it ends.
   */
  readonly stateUnknown: boolean;
  readonly compact: () => Promise<void>;
}

export interface UseSessionCompactionOptions {
  readonly client: ContextClient | undefined;
  readonly subject: ContextSubjectRef | undefined;
  /**
   * Changes when the thread's turns move on, which is when the host's answer
   * (a turn running, a session to compact) can change.
   */
  readonly revision?: number;
  /** Called once a compaction this window watched has ended. */
  readonly onSettled?: () => void;
  readonly newCompactionId?: () => string;
  /** How often to ask again while a compaction runs. */
  readonly pollMs?: number;
}

const DEFAULT_POLL_MS = 1_500;
/** Failed reads in a row, while a compaction ran, before the window lets go. */
const MAX_FAILED_READS = 5;
const MAX_RETRY_MS = 30_000;

/**
 * The Compact session control's state, read from the host and never derived
 * here. A running compaction is asked about again until it ends: Work and Code
 * streams do not carry its outcome to this window, and the read is the one
 * answer every thread kind shares.
 */
export function useSessionCompaction(
  options: UseSessionCompactionOptions,
): SessionCompactionController {
  const { client, revision } = options;
  const aggregateType = options.subject?.aggregateType;
  const aggregateId = options.subject?.aggregateId;
  const subject = useMemo<ContextSubjectRef | undefined>(
    () =>
      aggregateType === undefined || aggregateId === undefined
        ? undefined
        : { aggregateType, aggregateId },
    [aggregateId, aggregateType],
  );
  const [state, setState] = useState<ContextCompactionState | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<ContextCompactionRefusalReason | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [settledId, setSettledId] = useState<string | undefined>(undefined);
  // Counts answers, so a running compaction is asked about again after each
  // one even when the host's answer is unchanged.
  const [answers, setAnswers] = useState(0);
  const [retryMs, setRetryMs] = useState<number | undefined>(undefined);
  const [stateUnknown, setStateUnknown] = useState(false);
  const failedReads = useRef(0);
  const stateRef = useRef<ContextCompactionState | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  // Compactions this window saw running or asked for, so the end of one is
  // told apart from a result that was already there.
  const watched = useRef(new Set<string>());
  // The compaction this window last asked for. Its answer can be lost on the
  // way back while the host still journaled it; the host's record then
  // replaces the window's own "did not answer".
  const asked = useRef<string | undefined>(undefined);
  const onSettled = useRef(options.onSettled);
  onSettled.current = options.onSettled;
  const newCompactionId = options.newCompactionId ?? randomId;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const load = useCallback(async () => {
    requestRef.current?.abort();
    if (client === undefined || subject === undefined) return;
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const next = await client.readCompaction(subject, controller.signal);
      if (controller.signal.aborted) return;
      const latest = next.latestCompaction;
      if (latest !== undefined) {
        const id = latestId(latest);
        if (id === asked.current) setErrorMessage(undefined);
        if (latest.status === "running") watched.current.add(id);
        else if (watched.current.delete(id)) {
          setSettledId(id);
          onSettled.current?.();
        }
      }
      if (next.compaction.status === "available") setRefusal(undefined);
      failedReads.current = 0;
      stateRef.current = next;
      setState(next);
      setRetryMs(undefined);
      setStateUnknown(false);
      setAnswers((count) => count + 1);
    } catch {
      // Only this window's own abort means a newer read replaced this one; a
      // read the transport interrupted is a failed read like any other.
      if (controller.signal.aborted) return;
      if (stateRef.current?.latestCompaction?.status !== "running") {
        // A host that cannot say is not offering anything.
        stateRef.current = undefined;
        setState(undefined);
        return;
      }
      // A compaction it last reported running still holds the thread, so that
      // answer stands and is asked about again, more slowly each time. After
      // a bound (a host gone, or this window refused the thread) the window
      // lets go and says it no longer knows, rather than hold send for ever.
      failedReads.current += 1;
      if (failedReads.current >= MAX_FAILED_READS) {
        failedReads.current = 0;
        stateRef.current = undefined;
        setState(undefined);
        setRetryMs(undefined);
        setStateUnknown(true);
        return;
      }
      setRetryMs(Math.min(pollMs * 2 ** failedReads.current, MAX_RETRY_MS));
      setAnswers((count) => count + 1);
    }
  }, [client, pollMs, subject]);

  useEffect(() => {
    watched.current.clear();
    asked.current = undefined;
    failedReads.current = 0;
    stateRef.current = undefined;
    setState(undefined);
    setRetryMs(undefined);
    setStateUnknown(false);
    setStarting(false);
    setRefusal(undefined);
    setErrorMessage(undefined);
    setSettledId(undefined);
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  const observedRevision = useRef(revision);
  useEffect(() => {
    if (revision === undefined || observedRevision.current === revision) return;
    observedRevision.current = revision;
    void load();
  }, [load, revision]);

  const running = state?.latestCompaction?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void load(), retryMs ?? pollMs);
    return () => clearTimeout(timer);
  }, [answers, load, pollMs, retryMs, running]);

  const startingRef = useRef(false);
  const compact = useCallback(async () => {
    if (client === undefined || subject === undefined || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setRefusal(undefined);
    setErrorMessage(undefined);
    const compactionId = decodeContextCompactionId(newCompactionId());
    watched.current.add(String(compactionId));
    asked.current = String(compactionId);
    try {
      await client.execute({ kind: "compact-session", subject, compactionId });
    } catch (error) {
      if (
        error instanceof ContextClientFailure &&
        error.category === "compaction-refused" &&
        error.reason !== undefined
      ) {
        // A refusal is decided before anything is journaled.
        watched.current.delete(String(compactionId));
        setRefusal(error.reason);
      } else {
        setErrorMessage("Couldn't compact: the host did not answer. Try again.");
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
    await load();
  }, [client, load, newCompactionId, subject]);

  // One identity while nothing in it moved; see useRetainedRecord.
  return useRetainedRecord({
    starting,
    stateUnknown,
    compact,
    ...(state === undefined ? {} : { state }),
    ...(refusal === undefined ? {} : { refusal }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(settledId === undefined ? {} : { settledId }),
  });
}

function latestId(record: NonNullable<ContextCompactionState["latestCompaction"]>): string {
  return String(record.status === "completed" ? record.receipt.compactionId : record.compactionId);
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}
