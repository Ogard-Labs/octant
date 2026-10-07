import type { HarnessRetryNotice } from "@octant/contracts";

/**
 * Whole seconds still to wait, counting down from the announcement. A wait
 * that has already elapsed reads as zero; the status stays until the next
 * content clears it, rather than disappearing on its own.
 */
export function harnessRetryRemainingMs(notice: HarnessRetryNotice, nowMs: number): number {
  const announcedAt = Date.parse(notice.announcedAt);
  if (!Number.isFinite(announcedAt) || !Number.isFinite(nowMs)) return notice.delayMs;
  return Math.max(0, announcedAt + notice.delayMs - nowMs);
}

/**
 * The one sentence every surface uses while a turn is retrying. Monochrome
 * copy: a retry that usually passes is not an alert. The final failure keeps
 * its own wording.
 */
export function harnessRetryStatusText(notice: HarnessRetryNotice, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil(harnessRetryRemainingMs(notice, nowMs) / 1000));
  return `Provider busy, retrying ${notice.attempt}/${notice.maxAttempts} in ${seconds} s`;
}
