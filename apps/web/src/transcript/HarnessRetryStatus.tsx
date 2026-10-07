import { decodeUtcTimestamp, type HarnessRetryNotice } from "@octant/contracts";
import { harnessRetryStatusText } from "@octant/domain";
import { useEffect, useState } from "react";

/**
 * What a transcript feeds the working indicator. A retry replaces the one
 * before it; content clears it. The wait is counted from `announcedAt`, so a
 * late reader still shows the time left rather than the original delay.
 */
export type HarnessRetryStreamEvent =
  | {
      readonly kind: "retrying";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason: HarnessRetryNotice["reason"];
      readonly announcedAt: string;
    }
  | { readonly kind: "content" };

export function reduceHarnessRetryStream(
  _current: HarnessRetryNotice | undefined,
  event: HarnessRetryStreamEvent,
): HarnessRetryNotice | undefined {
  if (event.kind === "content") return undefined;
  let announcedAt: HarnessRetryNotice["announcedAt"];
  try {
    announcedAt = decodeUtcTimestamp(event.announcedAt);
  } catch {
    return _current;
  }
  return {
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    delayMs: event.delayMs,
    reason: event.reason,
    announcedAt,
  };
}

export function noticeFromRetryStream(
  events: readonly HarnessRetryStreamEvent[],
): HarnessRetryNotice | undefined {
  return events.reduce<HarnessRetryNotice | undefined>(reduceHarnessRetryStream, undefined);
}

export interface HarnessRetryStatusProps {
  readonly events: readonly HarnessRetryStreamEvent[];
  /** Overrides the clock so a test can count the wait down without sleeping. */
  readonly nowMs?: number;
}

/**
 * The quiet line under a working turn while the endpoint sends the request
 * again. Monochrome on purpose: a retry that usually passes is not an alert.
 */
export function HarnessRetryStatus(props: HarnessRetryStatusProps) {
  const notice = noticeFromRetryStream(props.events);
  const [ticked, setTicked] = useState(() => Date.now());
  useEffect(() => {
    if (notice === undefined || props.nowMs !== undefined) return;
    const timer = setInterval(() => setTicked(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [notice, props.nowMs]);
  if (notice === undefined) return null;
  const nowMs = props.nowMs ?? ticked;
  return (
    <p className="runstatus" data-retry-status="" role="status">
      {harnessRetryStatusText(notice, nowMs)}
    </p>
  );
}
