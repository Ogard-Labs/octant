import "../styles/usage.css";
import type { UsageLatencyStats } from "@octant/contracts";

export interface LatencyStatsSectionProps {
  readonly latencyStats: UsageLatencyStats;
  readonly connectionLatencyMs: number | undefined;
  readonly className: string;
}

export function LatencyStatsSection({
  latencyStats,
  connectionLatencyMs,
  className,
}: LatencyStatsSectionProps) {
  return (
    <section aria-label="Latency" className={`${className} usage-latency`}>
      <h3>Latency</h3>
      {latencyStats.measurements.length === 0 ? (
        <p className="usage-latency__empty">No host latency observations have been recorded.</p>
      ) : (
        <ul className="usage-latency__measurements">
          {latencyStats.measurements.map((measurement) => (
            <li key={measurement.key}>
              <strong>{measurement.label}</strong>
              <span>
                {measurement.observationCount} observation
                {measurement.observationCount === 1 ? "" : "s"} · p50 {measurement.p50Ms} ms · p95{" "}
                {measurement.p95Ms} ms · max {measurement.maxMs} ms
                {measurement.slowThresholdMs === undefined
                  ? ""
                  : ` · ${measurement.slowCount ?? 0} past ${measurement.slowThresholdMs / 1_000}s`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="usage-latency__round-trip">
        Connection round trip (this window):{" "}
        {connectionLatencyMs === undefined
          ? "Unavailable"
          : `${Math.round(connectionLatencyMs)} ms`}
      </p>
    </section>
  );
}
