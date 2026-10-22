import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { createPollGuard } from "./pollGuard";

export interface PolledResource<T> {
  /** The newest successful answer; kept while later reads fail. */
  readonly value: T | undefined;
  /** Set while the latest read failed, cleared by the next success. */
  readonly error: unknown;
  /** Reads now, even when a timer read is in flight. */
  readonly reload: () => Promise<void>;
}

/**
 * Reads `load` on mount and then every `intervalMs` while the app is in front.
 * A phone in a pocket does not need a refresh, so the timer idles when the app
 * is not active and reads once when it returns. A failed read keeps the last
 * value so a flaky connection does not blank what the person is deciding on.
 */
export function usePolledResource<T>(
  load: () => Promise<T>,
  options: { readonly intervalMs: number; readonly enabled?: boolean },
): PolledResource<T> {
  const { intervalMs, enabled = true } = options;
  const [state, setState] = useState<{ readonly value: T | undefined; readonly error: unknown }>({
    value: undefined,
    error: undefined,
  });
  // The guard and the runner live inside the effect so a remount (or a new
  // `load`) starts clean instead of inheriting a disposed guard.
  const runner = useRef<((force: boolean) => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    // A new load (another thread or host) must not show the old one's value.
    setState({ value: undefined, error: undefined });
    if (!enabled) return;
    const guard = createPollGuard();
    const run = async (force: boolean) => {
      const ticket = guard.start({ force });
      if (ticket === undefined) return;
      try {
        const value = await load();
        if (guard.finish(ticket)) setState({ value, error: undefined });
      } catch (error) {
        if (guard.finish(ticket)) setState((previous) => ({ value: previous.value, error }));
      }
    };
    runner.current = run;
    void run(false);
    return () => {
      guard.dispose();
      runner.current = undefined;
    };
  }, [load, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void runner.current?.(false);
    }, intervalMs);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void runner.current?.(false);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [enabled, intervalMs]);

  const reload = useCallback(async () => {
    await runner.current?.(true);
  }, []);
  return { value: state.value, error: state.error, reload };
}
