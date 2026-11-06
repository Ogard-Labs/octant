import { useCallback, useEffect, useState } from "react";

/** A late Stop receipt never exposes a kill control for a replacement attempt. */
export function useDelayedForceStop(attemptId: string | undefined, supported: boolean) {
  const [requested, setRequested] = useState<string>();
  const [elapsed, setElapsed] = useState(false);
  const stopping = requested === attemptId ? attemptId : undefined;
  useEffect(() => {
    setElapsed(false);
    if (stopping === undefined || !supported) return;
    const timer = setTimeout(() => setElapsed(true), 10_000);
    return () => clearTimeout(timer);
  }, [stopping, supported]);
  const requestStop = useCallback(() => setRequested(attemptId), [attemptId]);
  return { requestStop, offered: stopping !== undefined && supported && elapsed };
}
