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
  readonly subject: ContextSubjectRef | undefined;
}

export function useContextController(options: UseContextControllerOptions): ContextController {
  const { client } = options;
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
      try {
        const next = await client.inspect(
          {
            subject,
            ...(afterSequence === undefined ? {} : { afterSequence }),
          },
          controller.signal,
        );
        if (!controller.signal.aborted) accept(next);
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
