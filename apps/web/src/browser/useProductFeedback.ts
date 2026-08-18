import {
  createProductFeedbackClient,
  type ProductFeedbackClient,
} from "@octant/client-runtime/product-feedback-client";
import type {
  ProductFeedbackNote,
  ProductFeedbackRefusalReason,
} from "@octant/contracts/product-feedback";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface ProductFeedbackOptions {
  readonly threadId: string | undefined;
  readonly mode: "chat" | "work" | "code";
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build the client elsewhere. */
  readonly client?: ProductFeedbackClient;
}

export interface ProductFeedback {
  /** The notes still waiting to travel with the next message. */
  readonly pending: ReadonlyArray<ProductFeedbackNote>;
  readonly available: boolean;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly capture: (input: {
    readonly contextId: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly comment: string;
  }) => Promise<boolean>;
  readonly discard: (note: ProductFeedbackNote) => Promise<void>;
}

const refusalText: Record<ProductFeedbackRefusalReason, string> = {
  "thread-unavailable": "This thread is no longer available.",
  "surface-unavailable": "The host cannot read this page right now.",
  "element-unavailable": "There is nothing at that spot to point at.",
  "capture-unavailable": "The host could not capture that element.",
  "note-limit-reached": "Send the notes you have before leaving more.",
};

/**
 * The notes a user has pointed at this thread's running product.
 *
 * Nothing here resolves an element. The hook sends where the user tapped and
 * what they wrote; every identity, picture, and refusal in the list came back
 * from the host, which read its own page to produce them.
 */
export function useProductFeedback(options: ProductFeedbackOptions): ProductFeedback {
  const { threadId, mode, serverUrl, windowCapability } = options;
  const injected = options.client;
  const client = useMemo(() => {
    if (injected !== undefined) return injected;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createProductFeedbackClient({ baseUrl: serverUrl, fetch, windowCapability });
    } catch {
      return undefined;
    }
  }, [injected, serverUrl, windowCapability]);

  const [notes, setNotes] = useState<ReadonlyArray<ProductFeedbackNote>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const refresh = useCallback(async () => {
    if (client === undefined || threadId === undefined) return;
    try {
      setNotes(await client.list(threadId));
    } catch {
      setNotes([]);
    }
  }, [client, threadId]);

  useEffect(() => {
    setNotes([]);
    setMessage(undefined);
    void refresh();
  }, [refresh]);

  const capture = useCallback(
    async (input: {
      readonly contextId: string;
      readonly point: { readonly x: number; readonly y: number };
      readonly comment: string;
    }): Promise<boolean> => {
      if (client === undefined || threadId === undefined) return false;
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await client.execute({
          kind: "capture-product-feedback",
          threadId: threadId as never,
          mode,
          contextId: input.contextId as never,
          point: input.point,
          comment: input.comment as never,
        });
        if (result.kind === "feedback-refused") {
          setMessage(refusalText[result.reason]);
          return false;
        }
        await refresh();
        return true;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The note could not be sent.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, mode, refresh, threadId],
  );

  const discard = useCallback(
    async (note: ProductFeedbackNote) => {
      if (client === undefined) return;
      setBusy(true);
      try {
        await client.execute({
          kind: "discard-product-feedback",
          noteId: note.id,
          expectedVersion: note.version,
        });
        await refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The note could not be removed.");
      } finally {
        setBusy(false);
      }
    },
    [client, refresh],
  );

  return {
    pending: useMemo(() => notes.filter((note) => note.lifecycle === "pending"), [notes]),
    available: client !== undefined && threadId !== undefined,
    busy,
    message,
    capture,
    discard,
  };
}
