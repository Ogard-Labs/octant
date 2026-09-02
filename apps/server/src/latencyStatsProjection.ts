import type { UsageLatencyStats } from "@octant/contracts";

const SAMPLE_LIMIT = 256;
const TOOLCHAIN_PREFIXES: ReadonlyArray<string> = [
  "/api/github/clone",
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

type MeasurementKey =
  | "rpc"
  | "rpc-navigation"
  | "rpc-thread-read"
  | "rpc-evidence"
  | "rpc-environment"
  | "rpc-toolchain"
  | "provider-runtime-acquire"
  | "projection-catch-up";

interface Measurement {
  readonly key: MeasurementKey;
  readonly label: string;
  readonly slowThresholdMs: number | undefined;
}

const MEASUREMENTS: ReadonlyArray<Measurement> = [
  { key: "rpc", label: "Request handling", slowThresholdMs: 15_000 },
  { key: "rpc-navigation", label: "Navigation snapshot", slowThresholdMs: 1_000 },
  { key: "rpc-thread-read", label: "Thread snapshot", slowThresholdMs: 1_000 },
  { key: "rpc-evidence", label: "Conversation evidence", slowThresholdMs: 1_000 },
  { key: "rpc-environment", label: "Environment observation", slowThresholdMs: 2_500 },
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
  // Chat send, edit, retry, and resume await the provider attempt before the
  // HTTP response. Measuring that duration as host RPC mixes model time into
  // Request handling and fires the 15s slow-request warning on ordinary turns.
  if (pathname === "/api/chat/commands") return undefined;
  if (
    pathname === "/api/chat/navigation" ||
    pathname === "/api/work/navigation" ||
    pathname === "/api/code/navigation"
  ) {
    return "rpc-navigation";
  }
  if (
    pathname.startsWith("/api/work/turns/transcript/") ||
    /^\/api\/chat\/threads\/[^/]+$/.test(pathname) ||
    /^\/api\/code\/threads\/[^/]+(?:\/conversation)?$/.test(pathname)
  ) {
    return "rpc-thread-read";
  }
  if (pathname === "/api/code/evidence/batch") return "rpc-evidence";
  if (/^\/api\/projects\/[^/]+\/environment$/.test(pathname)) return "rpc-environment";
  return TOOLCHAIN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
    ? "rpc-toolchain"
    : "rpc";
}

export function withServerTiming(
  response: Response,
  measurement: ObservedLatency,
  durationMs: number,
): Response {
  const duration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  const headers = new Headers(response.headers);
  headers.set("server-timing", `octant;dur=${String(duration)};desc="${measurement}"`);
  headers.set("x-octant-latency-class", measurement);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
