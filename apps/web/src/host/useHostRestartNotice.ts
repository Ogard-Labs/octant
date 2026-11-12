import { useCallback, useEffect, useMemo, useState } from "react";
import type { HostRestartRecovery } from "@octant/contracts/host-control";
import {
  hostRestartNotice,
  type HostRestartNotice,
  type RestartNoticeThread,
} from "./hostRestartNotice";
import { HOST_MEMORY_NOTICE_POLL_MS } from "./useHostMemoryNotice";

/** What the hook needs of the host control client: the status read. */
export interface HostRestartStatusSource {
  status(): Promise<{ readonly restartRecovery?: HostRestartRecovery | undefined }>;
}

const DISMISSED_KEY = "octant.hostRestartNotice.dismissed";
const DISMISSED_LIMIT = 20;

function readDismissed(): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: ReadonlyArray<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-DISMISSED_LIMIT)));
  } catch {
    // Without storage the notice returns on the next load, which is harmless.
  }
}

/**
 * The notice that follows a restart: which Code threads the host continued
 * by itself and which wait for the person. The host finishes its recovery
 * after it starts serving, so the status is read again on the memory
 * notice's cadence until the summary appears.
 */
export function useHostRestartNotice(
  client: HostRestartStatusSource | undefined,
  threads: ReadonlyArray<RestartNoticeThread>,
): readonly [HostRestartNotice | undefined, () => void] {
  const [recovery, setRecovery] = useState<HostRestartRecovery>();
  const [dismissed, setDismissed] = useState<ReadonlyArray<string>>(readDismissed);

  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    const read = () => {
      client.status().then(
        (status) => {
          if (!cancelled) setRecovery(status.restartRecovery);
        },
        () => undefined,
      );
    };
    read();
    const timer = setInterval(read, HOST_MEMORY_NOTICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);

  const notice = useMemo(() => hostRestartNotice(recovery, threads), [recovery, threads]);
  const current = notice !== undefined && !dismissed.includes(notice.id) ? notice : undefined;
  const dismiss = useCallback(() => {
    if (current === undefined) return;
    const next = [...dismissed, current.id];
    setDismissed(next);
    writeDismissed(next);
  }, [current, dismissed]);

  return [current, dismiss];
}
