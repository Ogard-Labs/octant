import {
  createCodeFileListingClient,
  isRefusedCodeFileWatch,
  type CodeFileListingClient,
} from "@octant/client-runtime";
import type { CodeCheckoutId, CodeFileChangeNotice, CodeThreadId } from "@octant/contracts";
import { useEffect, useMemo, useRef } from "react";

/** How long a dropped watch waits before asking the host for another one. */
const WATCH_RETRY_MS = 2_000;

export interface CodeFileChangeWatchOptions {
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly client?: Pick<CodeFileListingClient, "watch">;
  readonly enabled: boolean;
  readonly threadId?: CodeThreadId | undefined;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly onChanged: (notice: CodeFileChangeNotice) => void;
}

/**
 * Follow the host's notices that files under a Code thread's checkout changed.
 *
 * The notice says which paths moved and nothing more; every surface decides on
 * its own what to refetch, and each refetch is authorized again. A stream the
 * host ends is reopened rather than treated as "nothing changes here any more"
 * — a watcher can be dropped by the filesystem, and silently stopping would
 * leave the surface stale with no sign that it had.
 *
 * A watch the host refuses or cannot open is the one end that is not
 * reopened: the answer to asking again is the same refusal, so retrying would
 * be an endless request loop rather than a recovery.
 */
export function useCodeFileChangeWatch(options: CodeFileChangeWatchOptions): void {
  const { enabled, threadId, checkoutId, serverUrl, windowCapability } = options;
  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (!enabled || serverUrl === undefined || windowCapability === undefined) return undefined;
    return createCodeFileListingClient({
      baseUrl: serverUrl,
      fetch: globalThis.fetch,
      windowCapability,
    });
  }, [options.client, enabled, serverUrl, windowCapability]);

  // Read through a ref so a caller passing an inline handler does not tear the
  // watch down and reopen it on every render.
  const onChanged = useRef(options.onChanged);
  onChanged.current = options.onChanged;

  useEffect(() => {
    if (!enabled || client === undefined || threadId === undefined || checkoutId === undefined) {
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;

    const follow = async (): Promise<void> => {
      while (!signal.aborted) {
        try {
          for await (const notice of client.watch({ threadId, checkoutId }, signal)) {
            if (signal.aborted) return;
            onChanged.current(notice);
          }
        } catch (error) {
          if (isRefusedCodeFileWatch(error)) return;
          // Any other failure is an ordinary broken stream, and is reopened.
        }
        if (signal.aborted) return;
        await pause(WATCH_RETRY_MS, signal);
      }
    };
    void follow();

    return () => {
      controller.abort();
    };
  }, [checkoutId, client, enabled, threadId]);
}

/** Wait, or stop waiting the moment the caller goes away. */
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Whether one notice concerns a given path. A truncated notice concerns every
 * path by definition: the host observed more change than it could name, so a
 * surface that assumed it was unaffected would be assuming what nobody knows.
 * A named directory concerns every file under it, because a checkout, rename,
 * or delete often arrives as the directory rather than each child.
 */
export function noticeTouches(notice: CodeFileChangeNotice, path: string): boolean {
  return (
    notice.truncated ||
    notice.paths.some((candidate) => {
      const named = String(candidate);
      return named === path || path.startsWith(`${named}/`);
    })
  );
}
