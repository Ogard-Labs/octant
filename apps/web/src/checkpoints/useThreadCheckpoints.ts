import type {
  ThreadCheckpoint,
  ThreadCheckpointAnchorRequest,
  ThreadCheckpointRefusalReason,
  ThreadCheckpointRestore,
} from "@octant/contracts/thread-checkpoints";
import {
  createThreadCheckpointClient,
  type ThreadCheckpointClient,
} from "@octant/client-runtime/thread-checkpoint-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ThreadCheckpointsOptions {
  readonly enabled?: boolean;
  readonly threadId: string;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build the client elsewhere. */
  readonly client?: ThreadCheckpointClient;
}

export interface ThreadCheckpoints {
  /** The checkpoints still on offer, keyed by the turn each one marks. */
  readonly byAnchor: ReadonlyMap<string, ThreadCheckpoint>;
  readonly available: boolean;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly mark: (anchor: ThreadCheckpointAnchorRequest, label: string) => Promise<void>;
  readonly forget: (checkpoint: ThreadCheckpoint) => Promise<void>;
  readonly restore: (
    checkpoint: ThreadCheckpoint,
    title: string,
  ) => Promise<ThreadCheckpointRestore | undefined>;
}

const refusalText: Record<ThreadCheckpointRefusalReason, string> = {
  "thread-unavailable": "This thread is no longer available.",
  "anchor-unavailable": "This message is no longer part of the conversation.",
  "revision-unavailable": "The host did not record a revision for this message.",
  "checkpoint-forgotten": "This checkpoint has been put away.",
  "project-unavailable": "This thread's Project is unavailable.",
  "restore-unavailable": "This host cannot take up threads in that mode.",
  "restore-refused": "The host turned the new thread down.",
};

/**
 * The checkpoints one thread carries, and the gestures that change them.
 *
 * Nothing here decides what may be marked or restored; every answer, including
 * every refusal, comes back from the host. The hook keeps the host's list and
 * the host's words for why something was turned down, so the transcript never
 * offers a gesture the server would refuse and never invents a reason.
 */
export function useThreadCheckpoints(options: ThreadCheckpointsOptions): ThreadCheckpoints {
  const { threadId, serverUrl, windowCapability } = options;
  const enabled = options.enabled !== false;
  const injected = options.client;
  const client = useMemo(() => {
    if (injected !== undefined) return injected;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createThreadCheckpointClient({ baseUrl: serverUrl, fetch, windowCapability });
    } catch {
      return undefined;
    }
  }, [injected, serverUrl, windowCapability]);

  const [checkpoints, setCheckpoints] = useState<ReadonlyArray<ThreadCheckpoint>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const activeThreadId = useRef(threadId);
  activeThreadId.current = threadId;

  const refresh = useCallback(async () => {
    if (!enabled || client === undefined || threadId.length === 0) return;
    try {
      const listed = await client.list(threadId);
      if (activeThreadId.current === threadId) setCheckpoints(listed);
    } catch {
      if (activeThreadId.current === threadId) setCheckpoints([]);
    }
  }, [client, enabled, threadId]);

  useEffect(() => {
    setCheckpoints([]);
    setMessage(undefined);
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (
      command: Parameters<ThreadCheckpointClient["execute"]>[0],
    ): Promise<ThreadCheckpointRestore | undefined> => {
      if (client === undefined) return undefined;
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await client.execute(command);
        if (result.kind === "checkpoint-refused") {
          setMessage(refusalText[result.reason]);
          return undefined;
        }
        await refresh();
        return result.kind === "checkpoint-restored" ? result.restore : undefined;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The checkpoint request failed.");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [client, refresh],
  );

  const byAnchor = useMemo(() => {
    const map = new Map<string, ThreadCheckpoint>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.lifecycle !== "marked") continue;
      const anchor = checkpoint.anchor;
      map.set(String(anchor.mode === "chat" ? anchor.turnId : anchor.operationId), checkpoint);
    }
    return map;
  }, [checkpoints]);

  return {
    byAnchor,
    available: enabled && client !== undefined,
    busy,
    message,
    mark: useCallback(
      async (anchor, label) => {
        await run({ kind: "mark-thread-checkpoint", anchor, label });
      },
      [run],
    ),
    forget: useCallback(
      async (checkpoint) => {
        await run({
          kind: "forget-thread-checkpoint",
          checkpointId: checkpoint.id,
          expectedVersion: checkpoint.version,
        });
      },
      [run],
    ),
    restore: useCallback(
      async (checkpoint, title) =>
        run({
          kind: "restore-from-thread-checkpoint",
          checkpointId: checkpoint.id,
          expectedVersion: checkpoint.version,
          title,
        }),
      [run],
    ),
  };
}
