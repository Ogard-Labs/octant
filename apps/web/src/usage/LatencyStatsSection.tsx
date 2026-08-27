import type { UsageLatencyStats } from "@octant/contracts";

export interface LatencyStatsSectionProps {
  readonly latencyStats: UsageLatencyStats;
  readonly connectionLatencyMs: number | undefined;
  readonly className: string;
  readonly compact?: boolean;
}

const EMPTY_LATENCY_STATS: UsageLatencyStats = { measurements: [] };

export function LatencyStatsSection({
  latencyStats,
  connectionLatencyMs,
  className,
  compact = false,
}: LatencyStatsSectionProps) {
  const reading = latencyStats ?? EMPTY_LATENCY_STATS;
  return (
    <section aria-label="Latency" className={`${className} usage-latency`}>
      <h3>Latency</h3>
      {reading.measurements.length === 0 ? (
        <p className="usage-latency__empty">No host latency observations have been recorded.</p>
      ) : compact ? (
        <table className="usage-dashboard__table" aria-label="Latency measurements">
          <thead>
            <tr>
              <th scope="col">Measurement</th>
              <th scope="col">Observations</th>
              <th scope="col">p50</th>
              <th scope="col">p95</th>
              <th scope="col">Max</th>
              <th scope="col">Slow</th>
            </tr>
          </thead>
          <tbody>
            {reading.measurements.map((measurement) => (
              <tr key={measurement.key}>
                <th scope="row">{measurement.label}</th>
                <td>{measurement.observationCount}</td>
                <td>{measurement.p50Ms} ms</td>
                <td>{measurement.p95Ms} ms</td>
                <td>{measurement.maxMs} ms</td>
                <td>
                  {measurement.slowThresholdMs === undefined
                    ? "—"
                    : `${measurement.slowCount ?? 0} past ${measurement.slowThresholdMs / 1_000}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="usage-latency__measurements">
          {reading.measurements.map((measurement) => (
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
