import { useEffect, useRef } from "react";
import { documentIsVisible, scheduleVisibleInterval } from "./documentVisibility";

/** Coalesce notices received during a read into one follow-up read. */
export function useVisibleRefresh(
  refresh: (signal: AbortSignal) => Promise<void>,
  revision: number | undefined,
  intervalMs: number,
): void {
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const current = useRef<
    | {
        revision: number | undefined;
        run: () => void;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    let readAgain = false;
    const run = async (): Promise<void> => {
      if (controller.signal.aborted || !documentIsVisible()) return;
      if (inFlight) {
        readAgain = true;
        return;
      }
      inFlight = true;
      try {
        await refresh(controller.signal);
      } catch {
        // Readers keep their last useful answer; a later notice or recovery retries.
      } finally {
        inFlight = false;
        if (readAgain && !controller.signal.aborted) {
          readAgain = false;
          void run();
        }
      }
    };
    const entry = { revision: revisionRef.current, run: () => void run() };
    current.current = entry;
    const stop = scheduleVisibleInterval(entry.run, intervalMs, { runImmediately: true });
    window.addEventListener("online", entry.run);
    return () => {
      controller.abort();
      stop();
      window.removeEventListener("online", entry.run);
      if (current.current === entry) current.current = undefined;
    };
  }, [refresh, intervalMs]);

  useEffect(() => {
    const entry = current.current;
    if (entry === undefined || entry.revision === revision) return;
    entry.revision = revision;
    entry.run();
  }, [revision]);
}
