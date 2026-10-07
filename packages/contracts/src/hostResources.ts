import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Read-only load snapshot for one host.
 *
 * The wire carries cores, a short-window CPU percentage, used and total
 * memory, and — when the data volume can be read — used and free space.
 * It carries no path, no user name, and no process list. A missing `disk`
 * means the volume could not be read; callers hide that bar rather than
 * inventing a figure.
 */
const ByteCount = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));
const Percent = Schema.Int.pipe(Schema.between(0, 100));
const CoreCount = Schema.Int.pipe(Schema.between(0, 4_096));

export const HostResourceMemory = Schema.Struct({
  usedBytes: ByteCount,
  totalBytes: ByteCount,
}).annotations(strict);
export type HostResourceMemory = typeof HostResourceMemory.Type;

export const HostResourceDisk = Schema.Struct({
  usedBytes: ByteCount,
  freeBytes: ByteCount,
}).annotations(strict);
export type HostResourceDisk = typeof HostResourceDisk.Type;

export const HostResourceSnapshot = Schema.Struct({
  cores: CoreCount,
  cpuPercent: Percent,
  memory: HostResourceMemory,
  disk: Schema.optional(HostResourceDisk),
  sampledAt: UtcTimestamp,
}).annotations(strict);
export type HostResourceSnapshot = typeof HostResourceSnapshot.Type;

export const decodeHostResourceSnapshot = Schema.decodeUnknownSync(HostResourceSnapshot);
