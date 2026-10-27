import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

export interface ThreadHarnessSessionRead {
  /**
   * The session as last read for this thread: `undefined` until the host has
   * answered, `null` for a thread whose lead is not the Octant harness.
   */
  readonly view: NativeHarnessSessionView | null | undefined;
  /** Reads the session again now; a read already out answers for this one. */
  readonly reload: () => Promise<NativeHarnessSessionView | null | undefined>;
}

/**
 * One reader of a thread's harness session for everything beside its
 * composer. Each card used to read the session on its own, so an open Work
 * thread asked the host the same question three times on open and kept a
 * refresh timer per card while it waited on the person.
 */
export function useThreadHarnessSession(input: {
  readonly client: Pick<NativeHarnessClient, "session">;
  readonly threadId: string;
  /** A change reads the session again at once, such as a turn starting or parking. */
  readonly readAgainOn: string;
  /** How long to wait before reading again, given what was last read; `undefined` stops. */
  readonly refreshEvery: (view: NativeHarnessSessionView | null | undefined) => number | undefined;
}): ThreadHarnessSessionRead {
  const { client, threadId, readAgainOn } = input;
  const [read, setRead] = useState<{
    readonly threadId: string;
    readonly view: NativeHarnessSessionView | null;
  }>();
  const generation = useRef(0);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    const mine = ++generation.current;
    try {
      const view = await client.session(threadId);
      // A response for a thread the pane has left must not paint over the one
      // it shows now.
      if (generation.current === mine) setRead({ threadId, view });
      return view;
    } catch {
      // Keep what was last read while the host reconnects.
      return undefined;
    } finally {
      inFlight.current = false;
    }
  }, [client, threadId]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const view = read?.threadId === threadId ? read.view : undefined;
  useEffect(() => {
    void reload();
  }, [reload, readAgainOn]);
  const every = input.refreshEvery(view);
  useEffect(() => {
    if (every === undefined) return;
    return scheduleVisibleInterval(() => void reload(), every);
  }, [reload, every]);

  return { view, reload };
}
