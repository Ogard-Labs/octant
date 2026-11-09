import type { ThreadMovePartKind, ThreadMoveRate, ThreadMoveSize } from "@octant/contracts";

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

/** The parts a thread owns beside its conversation and checkout, which What moves shows as one row. */
export const BULK_PART_KINDS: ReadonlyArray<ThreadMovePartKind> = [
  "attachment",
  "original-input",
  "generated-image",
  "browser-capture",
  "canvas",
];

/**
 * The size of one What moves row, from the kinds of part it shows: `none`
 * when the thread carries no such part, `unknown` when one of its kinds could
 * not be measured. Undefined while the thread as a whole could not be.
 */
export function rowSize(
  size: ThreadMoveSize,
  kinds: ReadonlyArray<ThreadMovePartKind>,
):
  | { readonly status: "measured"; readonly bytes: number }
  | { readonly status: "unknown" | "none" }
  | undefined {
  if (size.status === "unknown") return undefined;
  if (size.status === "partly-measured" && size.unknownParts.some((kind) => kinds.includes(kind))) {
    return { status: "unknown" };
  }
  const parts = size.parts.filter((part) => kinds.includes(part.kind));
  if (parts.length === 0) return { status: "none" };
  return { status: "measured", bytes: parts.reduce((total, part) => total + part.bytes, 0) };
}

/** One thread's size among other figures; a partly measured one says what it knows at least. */
export function threadSize(size: ThreadMoveSize): string {
  if (size.status === "unknown") return "Size unknown";
  return size.status === "measured"
    ? formatBytes(size.bytes)
    : `At least ${formatBytes(size.bytes)}`;
}

/**
 * What a set of threads would send and how long it takes: "1.4 GB, about 2
 * min". A partly measured thread adds what was measured and counts as one
 * size unknown.
 */
export function sizeAndEstimate(
  sizes: ReadonlyArray<ThreadMoveSize>,
  rate: ThreadMoveRate,
): string {
  const bytes = sizes.reduce(
    (total, size) => total + (size.status === "unknown" ? 0 : size.bytes),
    0,
  );
  if (sizes.every((size) => size.status === "unknown")) {
    return sizes.length === 1 ? "Size unknown" : "Sizes unknown";
  }
  const unknown = sizes.filter((size) => size.status !== "measured").length;
  const known = `${formatBytes(bytes)}, ${formatEstimate(bytes, rate)}`;
  if (unknown === 0) return known;
  return `${known}, ${unknown === 1 ? "1 size" : `${String(unknown)} sizes`} unknown`;
}
