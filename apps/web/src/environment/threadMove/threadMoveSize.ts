import type { ThreadMoveRate, ThreadMoveSize } from "@octant/contracts";

/** A size in English figures whatever the locale, as every Octant size reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * How long sending this many bytes takes at the rate, in words. The moves of
 * a batch run one after another, so a batch's time is its total's.
 */
export function formatEstimate(bytes: number, rate: ThreadMoveRate): string {
  const seconds = Math.ceil(bytes / rate.bytesPerSecond);
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${String(hours)} h` : `about ${String(hours)} h ${String(rest)} min`;
}

/** Where the estimate's rate came from, so the person can judge it. */
export function estimateBasis(rate: ThreadMoveRate, memberName: string): string {
  return rate.basis === "measured"
    ? `Estimated from the speed earlier moves to ${memberName} reached.`
    : `Estimated at ${formatBytes(rate.bytesPerSecond)} a second, because no move to ${memberName} has been timed yet.`;
}

/** What a set of threads would send and how long it takes: "1.4 GB, about 2 min". */
export function sizeAndEstimate(
  sizes: ReadonlyArray<ThreadMoveSize>,
  rate: ThreadMoveRate,
): string {
  const bytes = sizes.reduce(
    (total, size) => total + (size.status === "measured" ? size.bytes : 0),
    0,
  );
  const unknown = sizes.filter((size) => size.status === "unknown").length;
  if (unknown === sizes.length) return unknown === 1 ? "Size unknown" : "Sizes unknown";
  const known = `${formatBytes(bytes)}, ${formatEstimate(bytes, rate)}`;
  if (unknown === 0) return known;
  return `${known}, ${unknown === 1 ? "1 size" : `${String(unknown)} sizes`} unknown`;
}
