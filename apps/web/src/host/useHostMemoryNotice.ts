import type { HostControlStatus } from "@octant/contracts/host-control";
import { useCallback, useEffect, useState } from "react";
import { hostMemoryNotices, type HostMemoryNotice } from "./hostMemoryNotice";

/** What the hook needs of the host control client: the status read. */
export interface HostMemoryStatusSource {
  status(): Promise<Pick<HostControlStatus, "memory">>;
}

/** The host reads memory every few seconds; a minute is enough to hear of it. */
export const HOST_MEMORY_NOTICE_POLL_MS = 60_000;

const DISMISSED_KEY = "octant.hostMemoryNotice.dismissed";
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
 * The quiet memory notice: the first thing the host did about memory, or its
 * last unclean stop, that the person has not dismissed. A notice is told apart
 * by the time of the event, so a new relief shows again after an old one was
 * dismissed. An unreachable host shows nothing here; Settings reports that.
 */
export function useHostMemoryNotice(
  client: HostMemoryStatusSource | undefined,
): readonly [HostMemoryNotice | undefined, () => void] {
  const [notices, setNotices] = useState<ReadonlyArray<HostMemoryNotice>>([]);
  const [dismissed, setDismissed] = useState<ReadonlyArray<string>>(readDismissed);

  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    const read = () => {
      client.status().then(
        (status) => {
          if (!cancelled) setNotices(hostMemoryNotices(status.memory));
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

  const current = notices.find((notice) => !dismissed.includes(notice.id));
  const dismiss = useCallback(() => {
    if (current === undefined) return;
    const next = [...dismissed, current.id];
    setDismissed(next);
    writeDismissed(next);
  }, [current, dismissed]);

  return [current, dismiss];
}
