import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeMentionableThreadId,
  decodeThreadMessageQueueCommand,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueuePayload,
  type ThreadMessageQueueResult,
  type ThreadMessageQueueScope,
  type ThreadMessageQueueSnapshot,
} from "@octant/contracts";
import {
  createThreadMessageQueueClient,
  type ThreadMessageQueueClient,
} from "./threadMessageQueueClient";

import {
  queueDraftDigest,
  readQueueReceipts,
  saveQueueReceipt,
  removeQueueReceipt,
  type QueueReceipt,
} from "./threadMessageQueueReceipts";

interface QueueDraft {
  readonly text: string;
  readonly revision: number;
}
interface LiveQueueDraft extends QueueDraft {
  readonly clear: () => void;
}

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
  readonly receipt: QueueReceipt;
  readonly accepted?: () => void;
  readonly onRefused?: () => void | Promise<void>;
  readonly draft?: QueueDraft;
  readonly recoveredRevision?: number;
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
    onRefused?: () => void | Promise<void>,
    draft?: QueueDraft,
  ) => Promise<QueueAcknowledgment>;
  readonly change: (change: QueueChange) => Promise<QueueAcknowledgment>;
  readonly refresh: () => Promise<void>;
  readonly retry: () => Promise<void>;
}

export function useThreadMessageQueue(options: {
  readonly hostId?: string | undefined;
  readonly draft?: LiveQueueDraft;
  readonly onRecoveredRefused?: (command: ThreadMessageQueueCommand) => void | Promise<void>;
  readonly mode: ThreadMessageQueueScope["mode"];
  readonly threadId: string | undefined;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly client?: ThreadMessageQueueClient | undefined;
}): ThreadMessageQueue {
  const { mode, threadId, serverUrl, windowCapability } = options;
  const host = options.hostId ?? "local";
  const live = useRef(options);
  live.current = options;
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
    [host, mode, threadId],
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
  const recover = useCallback(() => {
    if (scope === undefined || working.current) return;
    const stored = readQueueReceipts(host, scope);
    if (stored.status === "unavailable") {
      setUncertain(true);
      setMessage("Queue recovery storage is unavailable. No new message can be submitted safely.");
      return;
    }
    const first = stored.receipts[0];
    if (first === undefined) {
      pending.current = undefined;
      setUncertain(false);
      return;
    }
    if (pending.current?.receipt.command.requestId !== first.command.requestId) {
      const onRefused = live.current.onRecoveredRefused;
      let settled = false;
      pending.current = {
        receipt: first,
        ...(live.current.draft === undefined
          ? {}
          : { recoveredRevision: live.current.draft.revision }),
        onRefused: async () => {
          if (settled) return;
          settled = true;
          await onRefused?.(first.command);
        },
      };
    }
    setUncertain(true);
    setMessage(
      "An earlier queue change needs confirmation. Check queue before adding another message; your draft is kept.",
    );
  }, [host, scope]);
  const refresh = useCallback(async () => {
    if (client === undefined || scope === undefined) return;
    recover();
    try {
      const next = await client.read(scope);
      if (active.current !== scope) return;
      apply(next);
      setAvailable(true);
    } catch {
      if (active.current === scope) setAvailable(false);
    }
  }, [apply, client, recover, scope]);
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
    window.addEventListener("storage", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("storage", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
      if (active.current === scope) active.current = undefined;
    };
  }, [refresh, scope]);

  const execute = useCallback(
    async (request: PendingCommand, fresh = false): Promise<QueueAcknowledgment> => {
      if (client === undefined || working.current || scope === undefined) {
        if (fresh) await request.onRefused?.();
        return "refused";
      }
      working.current = true;
      setBusy(true);
      let receipt = request.receipt;
      const keepUncertain = (notice: string) => {
        if (active.current !== scope) return;
        pending.current = { ...request, receipt };
        setUncertain(true);
        setMessage(notice);
      };
      try {
        const stored = readQueueReceipts(host, scope);
        if (stored.status === "unavailable" || (fresh && stored.receipts.length > 0)) {
          keepUncertain(
            "Queue recovery storage needs attention. Check queue before submitting another message.",
          );
          if (fresh) {
            pending.current = undefined;
            await request.onRefused?.();
          }
          return fresh ? "refused" : "unknown";
        }
        if (fresh) {
          if (request.draft !== undefined) {
            try {
              receipt = {
                ...receipt,
                draftDigest: await queueDraftDigest(request.draft.text),
                ...(live.current.draft?.revision !== request.draft.revision
                  ? { draftChanged: true }
                  : {}),
              };
            } catch {
              await request.onRefused?.();
              setMessage("This queue receipt could not be saved. Your draft is kept.");
              return "refused";
            }
          }
          if (!saveQueueReceipt(receipt)) {
            await request.onRefused?.();
            setMessage(
              "This queue receipt could not be saved. Nothing was submitted; your draft is kept.",
            );
            return "refused";
          }
        } else {
          const existing = stored.receipts.find(
            (entry) => entry.command.requestId === receipt.command.requestId,
          );
          if (existing === undefined) {
            await request.onRefused?.();
            if (active.current === scope) {
              pending.current = undefined;
              setUncertain(false);
            }
            return "refused";
          }
          receipt = existing;
        }
        let result: ThreadMessageQueueResult | undefined;
        if (!receipt.accepted && !receipt.refused) {
          try {
            result = await client.execute(receipt.command);
          } catch {
            keepUncertain(
              "The host has not confirmed this change. Check again before adding another message; your draft is kept.",
            );
            return "unknown";
          }
          if (
            !fresh &&
            result.status === "refused" &&
            !["invalid-payload", "queue-full", "not-editable", "invalid-order"].includes(
              result.reason,
            )
          ) {
            keepUncertain(
              "The host cannot confirm the earlier submission with current access. Its receipt is kept; restore access and check again.",
            );
            return "unknown";
          }
        }
        const accepted =
          receipt.accepted === true ||
          result?.status === "applied" ||
          result?.status === "duplicate";
        // Re-read edits made during the request before writing its settlement.
        const latest = readQueueReceipts(host, scope);
        if (latest.status === "unavailable") {
          keepUncertain(
            "The host answered, but recovery storage is unavailable. Check queue before submitting again.",
          );
          return "unknown";
        }
        const retained = latest.receipts.find(
          (entry) => entry.command.requestId === receipt.command.requestId,
        );
        if (retained !== undefined) receipt = retained;
        receipt = { ...receipt, ...(accepted ? { accepted: true } : { refused: true }) };
        if (retained !== undefined && !saveQueueReceipt(receipt)) {
          keepUncertain(
            "The host answered, but its receipt could not be settled safely. Check queue again.",
          );
          return "unknown";
        }
        if (accepted) {
          request.accepted?.();
          if (active.current !== scope) return "accepted";
          if (
            request.accepted === undefined &&
            receipt.draftDigest !== undefined &&
            !receipt.draftChanged
          ) {
            const draft = live.current.draft;
            if (
              draft !== undefined &&
              draft.revision === request.recoveredRevision &&
              (await queueDraftDigest(draft.text)) === receipt.draftDigest &&
              active.current === scope &&
              live.current.draft?.revision === draft.revision &&
              live.current.draft.text === draft.text
            )
              draft.clear();
          }
        } else await request.onRefused?.();
        if (!removeQueueReceipt(receipt)) {
          keepUncertain(
            "This queue receipt could not be removed. Check queue before submitting another message.",
          );
          return "unknown";
        }
        if (active.current !== scope) return accepted ? "accepted" : "refused";
        pending.current = undefined;
        setUncertain(false);
        if (result !== undefined && result.status !== "refused") apply(result.snapshot);
        setMessage(
          result?.status === "refused"
            ? `The host refused this queue change: ${result.reason.replaceAll("-", " ")}.`
            : result?.status === "conflict"
              ? "The queue changed in another window. Review it and try again; your draft is kept."
              : undefined,
        );
        return accepted ? "accepted" : "refused";
      } finally {
        if (active.current === scope) {
          working.current = false;
          setBusy(false);
        }
      }
    },
    [apply, client, host, scope],
  );

  const enqueue = useCallback(
    async (
      payload: ThreadMessageQueuePayload,
      accepted?: () => void,
      onRefused?: () => void | Promise<void>,
      draft?: QueueDraft,
    ): Promise<QueueAcknowledgment> => {
      if (
        !available ||
        scope === undefined ||
        current.current === undefined ||
        pending.current !== undefined ||
        working.current
      ) {
        await onRefused?.();
        return "refused";
      }
      const command = decodeThreadMessageQueueCommand({
        kind: "enqueue",
        scope,
        expectedVersion: current.current.version,
        requestId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        payload,
      });
      let settled = false;
      return execute(
        {
          receipt: { host, command },
          ...(draft === undefined ? {} : { draft }),
          accepted: () => {
            if (settled) return;
            settled = true;
            accepted?.();
          },
          onRefused: async () => {
            if (settled) return;
            settled = true;
            await onRefused?.();
          },
        },
        true,
      );
    },
    [available, execute, host, scope],
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
      return execute(
        {
          receipt: {
            host,
            command: decodeThreadMessageQueueCommand({
              ...change,
              scope,
              expectedVersion:
                "expectedVersion" in change ? change.expectedVersion : current.current.version,
              requestId: crypto.randomUUID(),
            }),
          },
        },
        true,
      );
    },
    [available, execute, host, scope],
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
