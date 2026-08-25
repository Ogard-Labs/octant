import { ContextClientFailure, type ContextClient } from "@octant/client-runtime/context-client";
import type { ContextEntryId, ContextSubjectRef } from "@octant/contracts/context";
import type { ContextCommand, ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ContextControllerStatus =
  | "idle"
  | "loading"
  | "ready"
  | "updating"
  | "disconnected"
  /** The host answered, and nothing has planned this subject's context yet. */
  | "not-planned";

export interface ContextController {
  readonly errorMessage?: string;
  readonly rebuild: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly setExcluded: (entryId: ContextEntryId, excluded: boolean) => Promise<void>;
  readonly setPinned: (entryId: ContextEntryId, pinned: boolean) => Promise<void>;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly status: ContextControllerStatus;
}

export interface UseContextControllerOptions {
  readonly client: ContextClient;
  /**
   * A value that changes whenever the subject's own turns have moved on. The
   * snapshot measures a conversation that keeps growing, so a controller that
   * only reloads when the subject changes reports the turn the thread was
   * opened on for the rest of the session.
   */
  readonly revision?: number;
  readonly subject: ContextSubjectRef | undefined;
}

export function useContextController(options: UseContextControllerOptions): ContextController {
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
  const [status, setStatus] = useState<ContextControllerStatus>(
    subject === undefined ? "idle" : "loading",
  );
  const [snapshot, setSnapshot] = useState<ContextInspectorSnapshot | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const snapshotRef = useRef<ContextInspectorSnapshot | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);

  const accept = useCallback((next: ContextInspectorSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    setErrorMessage(undefined);
    setStatus("ready");
  }, []);

  const reload = useCallback(
    async (afterSequence?: ContextInspectorSnapshot["sequence"]) => {
      requestRef.current?.abort();
      if (subject === undefined) {
        snapshotRef.current = undefined;
        setSnapshot(undefined);
        setErrorMessage(undefined);
        setStatus("idle");
        return;
      }
      const controller = new AbortController();
      requestRef.current = controller;
      setStatus(snapshotRef.current === undefined ? "loading" : "updating");
      setErrorMessage(undefined);
      let backoffMs = MIN_CONTEXT_RETRY_MS;
      for (;;) {
        try {
          const next = await client.inspect(
            {
              subject,
              ...(afterSequence === undefined ? {} : { afterSequence }),
            },
            controller.signal,
          );
          if (!controller.signal.aborted) accept(next);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          // A subject nothing has planned yet is an empty answer from a host that
          // replied, so it must not raise an alert or offer a retry that cannot
          // change anything.
          if (error instanceof ContextClientFailure && error.category === "not-planned") {
            setStatus("not-planned");
            setErrorMessage(undefined);
            return;
          }
          setStatus("disconnected");
          setErrorMessage(publicError(error));
          /*
           * A host that did not answer is a host to wait for: this pane asks
           * while the local service may still be starting, and giving up left
           * it reading "Context is unavailable" for the session on a machine
           * that was healthy a second later. Every other category is an answer
           * the host meant, and asking again would only collect it twice.
           */
          if (!worthAskingAgain(error)) return;
          await waitForRetry(controller.signal, backoffMs);
          if (controller.signal.aborted) return;
          backoffMs = Math.min(backoffMs * 2, MAX_CONTEXT_RETRY_MS);
        }
      }
    },
    [accept, client, subject],
  );

  useEffect(() => {
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    if (subject === undefined) {
      requestRef.current?.abort();
      setErrorMessage(undefined);
      setStatus("idle");
      return () => requestRef.current?.abort();
    }
    void reload();
    return () => requestRef.current?.abort();
  }, [reload, subject]);

  const observedRevision = useRef(revision);
  useEffect(() => {
    if (observedRevision.current === revision) return;
    // The subject effect above owns the first load and clears the snapshot on
    // its way in. A newer turn is the same subject measured again, so the last
    // reading stays on screen as `updating` rather than collapsing to a
    // spinner every time the reader sends something.
    //
    // A turn that lands while that first request is still in flight has nothing
    // to measure from yet, and marking it observed here would let the reading
    // taken before it existed stand for the rest of the session. Leaving it
    // unobserved runs this effect again the moment a snapshot arrives, so the
    // newer turn is asked for instead of swallowed.
    if (subject === undefined || snapshot === undefined) return;
    observedRevision.current = revision;
    void reload(snapshot.sequence);
  }, [reload, revision, snapshot, subject]);

  const execute = useCallback(
    async (command: ContextCommand) => {
      if (subject === undefined) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setStatus("updating");
      setErrorMessage(undefined);
      try {
        const result = await client.execute(command, controller.signal);
        if (!controller.signal.aborted) accept(result.snapshot);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ContextClientFailure && error.category === "stale") {
          await reload(snapshotRef.current?.sequence);
          return;
        }
        setStatus("disconnected");
        setErrorMessage(publicError(error));
      }
    },
    [accept, client, reload, subject],
  );

  const updateOverrides = useCallback(
    async (entryId: ContextEntryId, kind: "exclude" | "pin", enabled: boolean) => {
      const current = snapshotRef.current;
      if (current === undefined || subject === undefined) return;
      const overrides = current.next.manifest.overrides;
      const pinned = new Set(overrides.pinnedEntryIds);
      const excluded = new Set(overrides.excludedEntryIds);
      const selected = kind === "pin" ? pinned : excluded;
      if (enabled) selected.add(entryId);
      else selected.delete(entryId);
      await execute({
        kind: "update-context-overrides",
        subject,
        expectedManifestId: current.next.manifest.id,
        overrides: {
          pinnedEntryIds: [...pinned],
          excludedEntryIds: [...excluded],
        },
      });
    },
    [execute, subject],
  );

  return {
    status,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    retry: () => reload(snapshotRef.current?.sequence),
    rebuild: async () => {
      const current = snapshotRef.current;
      if (current === undefined || subject === undefined) return;
      await execute({
        kind: "rebuild-context-plan",
        subject,
        expectedManifestId: current.next.manifest.id,
      });
    },
    setPinned: (entryId, pinned) => updateOverrides(entryId, "pin", pinned),
    setExcluded: (entryId, excluded) => updateOverrides(entryId, "exclude", excluded),
  };
}

const MIN_CONTEXT_RETRY_MS = 100;
const MAX_CONTEXT_RETRY_MS = 10_000;

/**
 * Whether a refusal describes a host that may simply not be up yet. The client
 * reports every unreachable transport as `unavailable`; every other category
 * names something waiting cannot change.
 */
function worthAskingAgain(error: unknown): boolean {
  return error instanceof ContextClientFailure && error.category === "unavailable";
}

async function waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function publicError(error: unknown): string {
  if (error instanceof ContextClientFailure && error.category === "interrupted") {
    return "Context update was interrupted.";
  }
  if (error instanceof ContextClientFailure && error.category === "blocked") {
    return "The requested context update is blocked by the safe budget.";
  }
  if (error instanceof ContextClientFailure && error.category === "unauthorized") {
    return "This window is not authorized to inspect that context.";
  }
  return "Context is unavailable. Retry the local connection.";
}
