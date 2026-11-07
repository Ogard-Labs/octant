import {
  MAX_HOST_HEALTH_POINTS,
  type HostHealthLatency,
  type HostHealthResolution,
  type HostHealthSample,
  type UtcTimestamp,
} from "@octant/contracts";

/**
 * Host-health samples as a reader sees them: minute samples as recorded, or
 * rolled up to hours when the span holds more minutes than one read returns.
 *
 * An hour sums what its minutes counted (stalls, slow statements, latency
 * observations) and keeps the worst of what they measured (peak memory, the
 * longest stall, the highest p95 and maximum latency), because a health view
 * exists to show the bad minute, and averaging would hide it. A host restart
 * inside an hour keeps the newest process start.
 */
export function hostHealthPoints(
  samples: ReadonlyArray<HostHealthSample>,
  requested: HostHealthResolution | undefined,
): { readonly resolution: HostHealthResolution; readonly samples: HostHealthSample[] } {
  const sorted = [...samples].sort((left, right) => left.sampledAt.localeCompare(right.sampledAt));
  const resolution = requested ?? (sorted.length > MAX_HOST_HEALTH_POINTS ? "hour" : "minute");
  const points = resolution === "minute" ? sorted : rollUpToHours(sorted);
  return { resolution, samples: points.slice(-MAX_HOST_HEALTH_POINTS) };
}

function rollUpToHours(sorted: ReadonlyArray<HostHealthSample>): HostHealthSample[] {
  const hours = new Map<string, HostHealthSample>();
  for (const sample of sorted) {
    const key = `${sample.sampledAt.slice(0, 13)}:00:00.000Z`;
    const hour = hours.get(key);
    hours.set(
      key,
      hour === undefined ? { ...sample, sampledAt: key as UtcTimestamp } : merge(hour, sample),
    );
  }
  return [...hours.values()];
}

function merge(hour: HostHealthSample, sample: HostHealthSample): HostHealthSample {
  const databaseBytes = sample.databaseBytes ?? hour.databaseBytes;
  return {
    sampledAt: hour.sampledAt,
    windowMs: hour.windowMs + sample.windowMs,
    processStartedAt:
      sample.processStartedAt > hour.processStartedAt
        ? sample.processStartedAt
        : hour.processStartedAt,
    rssBytes: Math.max(hour.rssBytes, sample.rssBytes),
    heapUsedBytes: Math.max(hour.heapUsedBytes, sample.heapUsedBytes),
    ...(databaseBytes === undefined ? {} : { databaseBytes }),
    eventLoopLagCount: hour.eventLoopLagCount + sample.eventLoopLagCount,
    eventLoopLagWorstMs: Math.max(hour.eventLoopLagWorstMs, sample.eventLoopLagWorstMs),
    slowStatementCount: hour.slowStatementCount + sample.slowStatementCount,
    slowStatementWorstMs: Math.max(hour.slowStatementWorstMs, sample.slowStatementWorstMs),
    latency: mergeLatency(hour.latency, sample.latency),
  };
}

function mergeLatency(
  left: ReadonlyArray<HostHealthLatency>,
  right: ReadonlyArray<HostHealthLatency>,
): HostHealthLatency[] {
  const byKey = new Map<string, HostHealthLatency>();
  for (const entry of [...left, ...right]) {
    const existing = byKey.get(entry.key);
    byKey.set(
      entry.key,
      existing === undefined
        ? entry
        : {
            key: entry.key,
            count: existing.count + entry.count,
            p50Ms: Math.max(existing.p50Ms, entry.p50Ms),
            p95Ms: Math.max(existing.p95Ms, entry.p95Ms),
            maxMs: Math.max(existing.maxMs, entry.maxMs),
          },
    );
  }
  return [...byKey.values()];
}
