import type { UsageLatencyStats } from "@octant/contracts";

const SAMPLE_LIMIT = 256;
const TOOLCHAIN_PREFIXES: ReadonlyArray<string> = [
  "/api/github/clone/",
  "/api/scaffolds",
  "/api/extensions/import-local",
  "/api/apple/toolchain",
  "/api/apple/artifacts",
  "/api/providers/discovery/scan",
  "/api/code/local-servers/commands",
  "/api/ship/commands",
  "/api/chat/attachments",
  "/api/code/attachments",
  "/api/work/attachments",
  "/api/threads/export",
  "/api/usage/export",
  "/api/diagnostics/export",
];

type MeasurementKey = "rpc" | "rpc-toolchain" | "provider-runtime-acquire" | "projection-catch-up";

interface Measurement {
  readonly key: MeasurementKey;
  readonly label: string;
  readonly slowThresholdMs: number | undefined;
}

const MEASUREMENTS: ReadonlyArray<Measurement> = [
  { key: "rpc", label: "Request handling", slowThresholdMs: 15_000 },
  { key: "rpc-toolchain", label: "Toolchain request handling", slowThresholdMs: 120_000 },
  { key: "provider-runtime-acquire", label: "Provider runtime start", slowThresholdMs: undefined },
  { key: "projection-catch-up", label: "Projection catch-up", slowThresholdMs: undefined },
];

export type ObservedLatency = MeasurementKey;

interface LatencyReading {
  observationCount: number;
  maxMs: number;
  slowCount: number;
  samples: Array<number>;
  nextSampleIndex: number;
}

function nearestRank(samples: ReadonlyArray<number>, percentile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? 0;
}

export class LatencyStatsProjection {
  readonly #readings = new Map<ObservedLatency, LatencyReading>();

  slowThresholdMs(measurement: ObservedLatency): number | undefined {
    return MEASUREMENTS.find((entry) => entry.key === measurement)?.slowThresholdMs;
  }

  record(measurement: ObservedLatency, durationMs: number): void {
    const duration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
    const reading = this.#reading(measurement);
    reading.observationCount += 1;
    reading.maxMs = Math.max(reading.maxMs, duration);
    const threshold = MEASUREMENTS.find((entry) => entry.key === measurement)?.slowThresholdMs;
    if (threshold !== undefined && duration >= threshold) reading.slowCount += 1;
    if (reading.samples.length < SAMPLE_LIMIT) {
      reading.samples.push(duration);
    } else {
      reading.samples[reading.nextSampleIndex] = duration;
      reading.nextSampleIndex = (reading.nextSampleIndex + 1) % SAMPLE_LIMIT;
    }
  }

  /**
   * Percentiles cover the most recent samples; count, max, and slow are lifetime
   * figures for this host process.
   */
  read(): UsageLatencyStats {
    return {
      measurements: MEASUREMENTS.flatMap((entry) => {
        const reading = this.#readings.get(entry.key);
        if (reading === undefined || reading.observationCount === 0) return [];
        return [
          {
            key: entry.key,
            label: entry.label,
            observationCount: reading.observationCount,
            p50Ms: nearestRank(reading.samples, 0.5),
            p95Ms: nearestRank(reading.samples, 0.95),
            maxMs: reading.maxMs,
            ...(entry.slowThresholdMs === undefined
              ? {}
              : { slowThresholdMs: entry.slowThresholdMs, slowCount: reading.slowCount }),
          },
        ];
      }),
    };
  }

  #reading(measurement: ObservedLatency): LatencyReading {
    const existing = this.#readings.get(measurement);
    if (existing !== undefined) return existing;
    const created: LatencyReading = {
      observationCount: 0,
      maxMs: 0,
      slowCount: 0,
      samples: [],
      nextSampleIndex: 0,
    };
    this.#readings.set(measurement, created);
    return created;
  }
}

export function observedRpcLatency(pathname: string): ObservedLatency | undefined {
  if (!pathname.startsWith("/api/")) return undefined;
  return TOOLCHAIN_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? "rpc-toolchain" : "rpc";
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

export function slowRequestRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      UUID_SEGMENT.test(segment) || OPAQUE_SEGMENT.test(segment) ? ":id" : segment,
    )
    .join("/");
}
