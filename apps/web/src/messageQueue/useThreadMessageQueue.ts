import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeMentionableThreadId,
  decodeThreadMessageQueueCommand,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueuePayload,
  type ThreadMessageQueueScope,
  type ThreadMessageQueueSnapshot,
} from "@octant/contracts";
import {
  createThreadMessageQueueClient,
  type ThreadMessageQueueClient,
} from "./threadMessageQueueClient";

type QueueChange =
  | {
      readonly kind: "edit";
      readonly messageId: string;
      readonly prompt: string;
      readonly expectedVersion?: ThreadMessageQueueSnapshot["version"];
    }
  | { readonly kind: "remove"; readonly messageId: string }
  | { readonly kind: "reorder"; readonly messageIds: ReadonlyArray<string> }
  | { readonly kind: "pause" | "resume" };
export type QueueAcknowledgment = "accepted" | "refused" | "unknown";
interface PendingCommand {
  readonly command: ThreadMessageQueueCommand;
  readonly accepted?: () => void;
}
export interface ThreadMessageQueue {
  readonly snapshot: ThreadMessageQueueSnapshot | undefined;
  readonly available: boolean;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly message: string | undefined;
  readonly enqueue: (
    payload: ThreadMessageQueuePayload,
    accepted?: () => void,
  ) => Promise<QueueAcknowledgment>;
  readonly change: (change: QueueChange) => Promise<QueueAcknowledgment>;
  readonly refresh: () => Promise<void>;
  readonly retry: () => Promise<void>;
}

export function useThreadMessageQueue(options: {
  readonly mode: ThreadMessageQueueScope["mode"];
  readonly threadId: string | undefined;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly client?: ThreadMessageQueueClient | undefined;
}): ThreadMessageQueue {
  const { mode, threadId, serverUrl, windowCapability } = options;
  const client = useMemo(
    () =>
      options.client ??
      (serverUrl === undefined || windowCapability === undefined
        ? undefined
        : createThreadMessageQueueClient({ serverUrl, windowCapability })),
    [options.client, serverUrl, windowCapability],
  );
  const scope = useMemo(
    (): ThreadMessageQueueScope | undefined =>
      threadId === undefined
        ? undefined
        : {
            mode,
            threadId: decodeMentionableThreadId(threadId),
          },
    [mode, threadId],
  );
  const [snapshot, setSnapshot] = useState<ThreadMessageQueueSnapshot>();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string>();
  const current = useRef<ThreadMessageQueueSnapshot | undefined>(undefined);
  const active = useRef(scope);
  active.current = scope;
  const working = useRef(false);
  const pending = useRef<PendingCommand | undefined>(undefined);
  const apply = useCallback(
    (next: ThreadMessageQueueSnapshot) => {
      if (
        active.current !== scope ||
        next.scope.mode !== scope?.mode ||
        String(next.scope.threadId) !== String(scope.threadId)
      )
        return;
      if (current.current !== undefined && next.version < current.current.version) return;
      current.current = next;
      setSnapshot(next);
    },
    [scope],
  );
  const refresh = useCallback(async () => {
    if (client === undefined || scope === undefined) return;
    try {
      const next = await client.read(scope);
      if (active.current !== scope) return;
      apply(next);
      setAvailable(true);
    } catch {
      if (active.current === scope) setAvailable(false);
    }
  }, [apply, client, scope]);
  useEffect(() => {
    active.current = scope;
    current.current = undefined;
    pending.current = undefined;
    working.current = false;
    setSnapshot(undefined);
    setAvailable(false);
    setBusy(false);
    setUncertain(false);
    setMessage(undefined);
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 3000);
    const reconnect = () => void refresh();
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
      if (active.current === scope) active.current = undefined;
    };
  }, [refresh, scope]);

  const execute = useCallback(
    async (request: PendingCommand): Promise<QueueAcknowledgment> => {
      if (client === undefined || working.current) return "refused";
      working.current = true;
      setBusy(true);
      try {
        const result = await client.execute(request.command);
        // Attachment ownership transfers even if the originating surface closed.
        if (result.status === "applied" || result.status === "duplicate") request.accepted?.();
        if (active.current !== scope)
          return result.status === "applied" || result.status === "duplicate"
            ? "accepted"
            : "refused";
        pending.current = undefined;
        setUncertain(false);
        if (result.status === "refused") {
          setMessage(`The host refused this queue change: ${result.reason.replaceAll("-", " ")}.`);
          return "refused";
        }
        apply(result.snapshot);
        if (result.status === "conflict") {
          setMessage(
            "The queue changed in another window. Review it and try again; your draft is kept.",
          );
          return "refused";
        }
        setMessage(undefined);
        return "accepted";
      } catch {
        if (active.current === scope) {
          pending.current = request;
          setUncertain(true);
          setMessage(
            "The host has not confirmed this change. Check again before adding another message; your draft is kept.",
          );
        }
        return "unknown";
      } finally {
        if (active.current === scope) {
          working.current = false;
          setBusy(false);
        }
      }
    },
    [apply, client, scope],
  );

  const enqueue = useCallback(
    async (
      payload: ThreadMessageQueuePayload,
      accepted?: () => void,
    ): Promise<QueueAcknowledgment> => {
      if (
        !available ||
        scope === undefined ||
        current.current === undefined ||
        pending.current !== undefined ||
        working.current
      )
        return "refused";
      const command = decodeThreadMessageQueueCommand({
        kind: "enqueue",
        scope,
        expectedVersion: current.current.version,
        requestId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        payload,
      });
      return execute({ command, ...(accepted === undefined ? {} : { accepted }) });
    },
    [available, execute, scope],
  );
  const change = useCallback(
    async (change: QueueChange): Promise<QueueAcknowledgment> => {
      if (
        !available ||
        scope === undefined ||
        current.current === undefined ||
        pending.current !== undefined ||
        working.current
      )
        return "refused";
      return execute({
        command: decodeThreadMessageQueueCommand({
          ...change,
          scope,
          expectedVersion:
            "expectedVersion" in change ? change.expectedVersion : current.current.version,
          requestId: crypto.randomUUID(),
        }),
      });
    },
    [available, execute, scope],
  );
  return {
    snapshot,
    available,
    busy,
    uncertain,
    message:
      message ??
      (available ? undefined : "The host message queue is unavailable. Your draft stays here."),
    enqueue,
    change,
    refresh,
    retry: async () => {
      const request = pending.current;
      if (request !== undefined) await execute(request);
      else await refresh();
    },
  };
}
