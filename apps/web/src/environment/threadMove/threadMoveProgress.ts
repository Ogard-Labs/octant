import type { ThreadMoveThreadStatus } from "@octant/contracts";

export function percent(sending: NonNullable<ThreadMoveThreadStatus["sending"]>): number {
  if (sending.state === "arrived" || sending.state === "committed") return 100;
  if (sending.bytesTotal === 0) return 0;
  return Math.min(99, Math.floor((sending.bytesSent / sending.bytesTotal) * 100));
}
