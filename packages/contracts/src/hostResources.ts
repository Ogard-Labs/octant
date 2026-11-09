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
 * inventing a figure. The same holds for `network`, `diskIo`, `gpu` and
 * `energy`: each is present only when the host could read it.
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

/** Bytes per second averaged between this snapshot's sample and the one before it. */
export const HostResourceRate = Schema.Struct({
  inBytesPerSecond: ByteCount,
  outBytesPerSecond: ByteCount,
}).annotations(strict);
export type HostResourceRate = typeof HostResourceRate.Type;

export const HostResourceGpu = Schema.Struct({ percent: Percent }).annotations(strict);
export type HostResourceGpu = typeof HostResourceGpu.Type;

export const HostResourceEnergy = Schema.Struct({
  batteryPercent: Percent,
  charging: Schema.Boolean,
}).annotations(strict);
export type HostResourceEnergy = typeof HostResourceEnergy.Type;

export const HostResourceSnapshot = Schema.Struct({
  cores: CoreCount,
  cpuPercent: Percent,
  memory: HostResourceMemory,
  disk: Schema.optional(HostResourceDisk),
  /** Network throughput across non-loopback interfaces; absent until two samples exist or when unreadable. */
  network: Schema.optional(HostResourceRate),
  /** Block-device throughput (in = read, out = written); absent under the same conditions. */
  diskIo: Schema.optional(HostResourceRate),
  /** Busiest GPU's utilisation; absent when the host has no readable GPU counter. */
  gpu: Schema.optional(HostResourceGpu),
  /** Battery state; absent on a host with no battery, which the tool says plainly. */
  energy: Schema.optional(HostResourceEnergy),
  sampledAt: UtcTimestamp,
}).annotations(strict);
export type HostResourceSnapshot = typeof HostResourceSnapshot.Type;

export const decodeHostResourceSnapshot = Schema.decodeUnknownSync(HostResourceSnapshot);
