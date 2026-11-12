import { decodeBrowserContextId } from "@octant/contracts";
import type { BrowserThreadId } from "@octant/contracts/browser-automation";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import { useEffect, useRef, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

/** The slowest a preview of an unchanged page is asked for again. */
const MAX_UNCHANGED_POLL_MS = 5_000;

export interface BrowserThreadSnapshotOptions {
  readonly client: BrowserAutomationClient | undefined;
  readonly enabled: boolean;
  /**
   * Whether a picture is wanted. Without one the host answers from what it
   * already holds and takes no new picture, so a read costs next to nothing.
   */
  readonly picture: boolean;
  /** Keeps a read only while the thread's Browser has a session in play. */
  readonly liveOnly: boolean;
  readonly pollIntervalMs?: number;
  readonly threadId: BrowserThreadId;
  /**
   * A page that lives in a Browser context of its own (one opened for itself,
   * not the thread's current context) is read by that context, as the Browser
   * tool reads it. The thread's current-context read leaves such contexts out,
   * so reading it for one would show another page or none.
   */
  readonly contextId?: string;
}

export interface BrowserThreadRead {
  readonly snapshot: BrowserAutomationSnapshot | undefined;
  /** A context read that found the context gone, refused, or stopped: say so, do not wait. */
  readonly unavailable: boolean;
}

/**
 * Reads what a thread's Browser shows, on the window's own schedule: once a
 * second while a picture is wanted and the session is live, every five seconds
 * otherwise, less and less often while nothing changes, and not at all while
 * the window is hidden. It reads; it never creates or rebinds a Browser
 * context, so a caller can show what the tool itself could show this window.
 */
export function useBrowserThreadSnapshot(
  options: BrowserThreadSnapshotOptions,
): BrowserAutomationSnapshot | undefined {
  return useBrowserThreadRead(options).snapshot;
}

/** The same read, also saying when a page's own context cannot be read any more. */
export function useBrowserThreadRead(options: BrowserThreadSnapshotOptions): BrowserThreadRead {
  const { client, contextId, enabled, liveOnly, picture, threadId } = options;
  const [snapshot, setSnapshot] = useState<BrowserAutomationSnapshot>();
  const [unavailable, setUnavailable] = useState(false);
  const signature = useRef("");
  const polledActivity = picture && snapshot !== undefined && isBrowserActivity(snapshot);
  const pollIntervalMs = options.pollIntervalMs ?? (polledActivity ? 1_000 : 5_000);

  useEffect(() => {
    if (!enabled || client === undefined) {
      signature.current = "";
      setSnapshot(undefined);
      setUnavailable(false);
      return;
    }
    const controller = new AbortController();
    let inFlight = false;
    let unchangedReads = 0;
    let dueAt = 0;
    /** Resolves to whether the read changed what the preview would show. */
    const load = async (): Promise<boolean> => {
      try {
        const next =
          contextId === undefined
            ? await client.inspectThread(
                picture ? { threadId } : { threadId, freshPicture: false },
                controller.signal,
              )
            : await client.inspect(
                { contextId: decodeBrowserContextId(contextId), threadId },
                controller.signal,
              );
        if (controller.signal.aborted) return true;
        // A context that is no longer there, or no longer running, is read as
        // gone: the preview says so instead of holding a picture of nothing.
        if (
          contextId !== undefined &&
          (next.context === undefined ||
            next.failure !== undefined ||
            next.context.state === "stopped" ||
            next.context.state === "expired")
        ) {
          signature.current = "gone";
          setSnapshot(undefined);
          setUnavailable(true);
          return true;
        }
        setUnavailable(false);
        const kept =
          String(next.threadId) === String(threadId) && (!liveOnly || isBrowserActivity(next))
            ? next
            : undefined;
        const readSignature = browserPictureSignature(kept);
        if (readSignature === signature.current) return false;
        signature.current = readSignature;
        setSnapshot(kept);
        return true;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return true;
        signature.current = browserPictureSignature(undefined);
        setSnapshot(undefined);
        // A page's own context that cannot be read is gone for the preview; the
        // thread's current-context read has nothing to say here.
        setUnavailable(contextId !== undefined);
        return true;
      }
    };
    const refresh = async () => {
      // A page that has not changed is asked about less and less often, down
      // to one look every few seconds, so a still page costs next to nothing.
      if (inFlight || Date.now() < dueAt) return;
      inFlight = true;
      try {
        unchangedReads = (await load()) ? 0 : unchangedReads + 1;
      } finally {
        inFlight = false;
      }
      dueAt =
        Date.now() +
        Math.min(
          Math.max(pollIntervalMs, MAX_UNCHANGED_POLL_MS),
          pollIntervalMs * 2 ** Math.min(unchangedReads, 3),
        );
    };
    // Paused while the window is hidden: a preview nobody can see takes no
    // pictures.
    const stop = scheduleVisibleInterval(() => void refresh(), pollIntervalMs, {
      runImmediately: true,
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [client, contextId, enabled, liveOnly, picture, pollIntervalMs, threadId]);

  return {
    snapshot:
      enabled && snapshot !== undefined && String(snapshot.threadId) === String(threadId)
        ? snapshot
        : undefined,
    unavailable: enabled && unavailable,
  };
}

export function isBrowserActivity(snapshot: BrowserAutomationSnapshot): boolean {
  const active = (state: string | undefined) =>
    state === "creating" || state === "active" || state === "stopping" || state === "failed";
  if (snapshot.contexts !== undefined && snapshot.contexts.length > 0) {
    return snapshot.contexts.some((entry) => active(entry.context.state));
  }
  return active(snapshot.context?.state);
}

/**
 * What a preview would draw from a read. Two reads with the same signature
 * are one picture, so the second is not a change and costs no render; the
 * observation's own revision moves on every look and says nothing about the page.
 */
function browserPictureSignature(snapshot: BrowserAutomationSnapshot | undefined): string {
  if (snapshot === undefined) return "none";
  return JSON.stringify([
    snapshot.status,
    snapshot.context?.contextId,
    snapshot.context?.state,
    snapshot.contexts?.length,
    snapshot.observation?.url,
    snapshot.observation?.title,
    snapshot.observation?.stale,
    snapshot.observation?.viewport?.width,
    snapshot.observation?.viewport?.height,
    snapshot.observation?.screenshotDataUrl,
    snapshot.waitingForPerson,
  ]);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
