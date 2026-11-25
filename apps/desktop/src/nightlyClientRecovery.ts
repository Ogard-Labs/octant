import type { openNightlyClientWindow } from "./nightlyClientWindow";

/** Covers a 15s host readiness wait and the existing bounded native exchanges. */
export const NIGHTLY_RECONNECT_MS = 30_000;
/** Ends inside the 30s a host-only Octant waits for its first Nightly window. */
export const NIGHTLY_FIRST_WINDOW_MS = 15_000;
type Client = Awaited<ReturnType<typeof openNightlyClientWindow>>;

/** Recovery always opens a new native lease; it never reuses a host descriptor. */
export function createNightlyClientRecovery(options: {
  readonly open: (signal: AbortSignal, lost: () => void) => Promise<Client>;
  readonly exhausted: () => void;
}) {
  let stopped = false;
  let recovering = false;
  let current: Client | undefined;
  let pending: Promise<Client> | undefined;
  let recovery: Promise<void> | undefined;
  let cleanupFailed = false;
  const lifetime = new AbortController();
  const close = async (client: Extract<Client, { readonly kind: "opened" }>) => {
    if ((await client.close()).kind === "failed") cleanupFailed = true;
  };
  const open = async (signal: AbortSignal) => {
    const result = await options.open(signal, lost);
    if (result.kind === "refused" && result.cleanupFailed === true) cleanupFailed = true;
    if (signal.aborted || stopped) {
      if (result.kind === "opened") await close(result);
      return { kind: "refused", reason: "native-unavailable" } as const;
    }
    current = result;
    return result;
  };
  const pause = (delay: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      timer.unref();
      signal.addEventListener("abort", finish, { once: true });
    });
  // Each registration makes both apps check the other's signed bundle, about
  // 1 GB each, inside one 2.5s native deadline. A slow or busy Mac can miss it
  // once, so the first window asks again instead of failing the launch.
  const openFirst = async (): Promise<Client> => {
    const deadline = performance.now() + NIGHTLY_FIRST_WINDOW_MS;
    let delay = 250;
    while (true) {
      const result = await open(lifetime.signal);
      if (
        result.kind === "opened" ||
        result.retryable !== true ||
        lifetime.signal.aborted ||
        performance.now() + delay >= deadline
      )
        return result;
      await pause(delay, lifetime.signal);
      if (lifetime.signal.aborted) return result;
      delay = Math.min(delay * 2, 2_000);
    }
  };
  const lost = () => {
    if (stopped || recovering) return;
    // Electron emits window-all-closed synchronously during stale-window destroy.
    recovering = true;
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, NIGHTLY_RECONNECT_MS);
    deadline.unref();
    recovery = Promise.resolve().then(async () => {
      await pending;
      if (current?.kind === "opened") await close(current);
      current = undefined;
      if (stopped) attempt.abort();
      try {
        let delay = 250;
        while (!attempt.signal.aborted) {
          pending = open(attempt.signal);
          const result = await pending;
          if (result.kind === "opened") return;
          if (result.reason === "invalid-receipt" || attempt.signal.aborted) break;
          await pause(delay, attempt.signal);
          delay = Math.min(delay * 2, 2_000);
        }
        if (!stopped) options.exhausted();
      } finally {
        clearTimeout(deadline);
        lifetime.signal.removeEventListener("abort", abort);
        recovering = false;
      }
    });
  };
  return Object.freeze({
    start: (): Promise<Client> => {
      pending ??= openFirst();
      return pending;
    },
    recovering: () => recovering,
    stop: async (): Promise<{ readonly kind: "closed" | "failed" }> => {
      stopped = true;
      lifetime.abort();
      await recovery;
      await pending;
      if (current?.kind === "opened") await close(current);
      return { kind: cleanupFailed ? "failed" : "closed" };
    },
  });
}
