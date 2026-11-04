import type { openNightlyClientWindow } from "./nightlyClientWindow";

/** Covers a 15s host readiness wait and the existing bounded native exchanges. */
export const NIGHTLY_RECONNECT_MS = 30_000;
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
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              attempt.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, delay);
            timer.unref();
            attempt.signal.addEventListener("abort", finish, { once: true });
          });
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
      pending ??= open(lifetime.signal);
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
