import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

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
const ByteCount = NonNegativeInt;
const Percent = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const CoreCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_096 }));

export const HostResourceMemory = Schema.Struct({
  usedBytes: ByteCount,
  totalBytes: ByteCount,
});
export type HostResourceMemory = typeof HostResourceMemory.Type;

export const HostResourceDisk = Schema.Struct({
  usedBytes: ByteCount,
  freeBytes: ByteCount,
});
export type HostResourceDisk = typeof HostResourceDisk.Type;

/** Bytes per second averaged between this snapshot's sample and the one before it. */
export const HostResourceRate = Schema.Struct({
  inBytesPerSecond: ByteCount,
  outBytesPerSecond: ByteCount,
});
export type HostResourceRate = typeof HostResourceRate.Type;

export const HostResourceGpu = Schema.Struct({ percent: Percent });
export type HostResourceGpu = typeof HostResourceGpu.Type;

export const HostResourceEnergy = Schema.Struct({
  batteryPercent: Percent,
  charging: Schema.Boolean,
});
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
});
export type HostResourceSnapshot = typeof HostResourceSnapshot.Type;

export const decodeHostResourceSnapshot = Schema.decodeUnknownSync(
  HostResourceSnapshot,
  STRICT_DECODE_OPTIONS,
);
