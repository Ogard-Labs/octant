import {
  editMobileQueuedMessage,
  MobileInboxFailure,
  queueMobileFollowUp,
  readMobileThreadMessageQueue,
  removeMobileQueuedMessage,
  type MobileQueueScope,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { ThreadMessageQueueSnapshot } from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

const QUEUE_REFRESH_MS = 2000;

/**
 * A Work or Code thread's host queue on the phone: read while a turn runs or
 * something waits, and changed only through the host's own queue routes,
 * which check this device on every command. Read only while `active`.
 */
export function useMobileMessageQueue(input: {
  readonly transport: MobileRemoteTransport | undefined;
  readonly scope: MobileQueueScope | undefined;
  readonly active: boolean;
  readonly allowChanges: boolean;
}) {
  const { transport, scope, active, allowChanges } = input;
  const [snapshot, setSnapshot] = useState<ThreadMessageQueueSnapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [changing, setChanging] = useState(false);
  const scopeKey = scope === undefined ? undefined : `${scope.mode}:${scope.threadId}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  useEffect(() => {
    setSnapshot(undefined);
    setError(undefined);
  }, [scopeKey]);

  const read = useCallback(async () => {
    if (transport === undefined || scope === undefined) return;
    const asked = `${scope.mode}:${scope.threadId}`;
    try {
      const next = await readMobileThreadMessageQueue(transport, scope);
      if (scopeKeyRef.current === asked) setSnapshot(next);
    } catch {
      // A queue the host will not show leaves the last one read in place; the
      // next change says why if it fails too.
    }
  }, [transport, scope]);

  const waiting = (snapshot?.items.length ?? 0) > 0;
  useEffect(() => {
    if (!active && !waiting) return;
    void read();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void read();
    }, QUEUE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, waiting, read]);

  const change = useCallback(
    async (
      run: (
        transport: MobileRemoteTransport,
        scope: MobileQueueScope,
        expectedVersion: number,
      ) => Promise<ThreadMessageQueueSnapshot>,
    ): Promise<boolean> => {
      if (transport === undefined || scope === undefined || !allowChanges) return false;
      const asked = `${scope.mode}:${scope.threadId}`;
      setChanging(true);
      setError(undefined);
      try {
        const current = snapshot ?? (await readMobileThreadMessageQueue(transport, scope));
        const next = await run(transport, scope, current.version);
        if (scopeKeyRef.current === asked) setSnapshot(next);
        return true;
      } catch (cause) {
        if (scopeKeyRef.current === asked) {
          setError(
            cause instanceof MobileInboxFailure ? cause.message : "The queue could not change.",
          );
          void read();
        }
        return false;
      } finally {
        setChanging(false);
      }
    },
    [allowChanges, read, scope, snapshot, transport],
  );

  return {
    items: snapshot?.items ?? [],
    error,
    changing,
    enqueue: (prompt: string, typedByPerson: boolean) =>
      change((transport, scope, expectedVersion) =>
        queueMobileFollowUp({
          transport,
          scope,
          expectedVersion,
          prompt,
          ...(typedByPerson ? { typedByPerson: true as const } : {}),
        }),
      ),
    edit: (messageId: string, prompt: string) =>
      change((transport, scope, expectedVersion) =>
        editMobileQueuedMessage({ transport, scope, expectedVersion, messageId, prompt }),
      ),
    remove: (messageId: string) =>
      change((transport, scope, expectedVersion) =>
        removeMobileQueuedMessage({ transport, scope, expectedVersion, messageId }),
      ),
  };
}
