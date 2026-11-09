import { useEffect, useState } from "react";
import type { HostHealthHistory, HostHealthSample } from "@octant/contracts";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import { SurfaceSection } from "../surface/SurfaceHeader";

interface Metric {
  readonly id: string;
  readonly label: string;
  readonly value: (sample: HostHealthSample) => number | undefined;
  readonly words: (value: number) => string;
  readonly note: string;
}

const METRICS: ReadonlyArray<Metric> = [
  {
    id: "memory",
    label: "Memory in use",
    value: (sample) => sample.rssBytes,
    words: megabytes,
    note: "The host process's resident memory, the highest in each point.",
  },
  {
    id: "stalls",
    label: "Event-loop stalls",
    value: (sample) => sample.eventLoopLagCount,
    words: (value) => `${value.toLocaleString("en")}`,
    note: "Times the host was too busy to answer for longer than the stall threshold.",
  },
  {
    id: "stall-worst",
    label: "Longest stall",
    value: (sample) => sample.eventLoopLagWorstMs,
    words: (value) => `${value.toLocaleString("en")} ms`,
    note: "The longest the host went without answering, in each point.",
  },
  {
    id: "slow-sql",
    label: "Slow database statements",
    value: (sample) => sample.slowStatementCount,
    words: (value) => `${value.toLocaleString("en")}`,
    note: "Statements slower than the slow-statement threshold.",
  },
  {
    id: "request-p95",
    label: "Request handling, slow (p95)",
    value: (sample) => sample.latency.find((entry) => entry.key === "rpc")?.p95Ms,
    words: (value) => `${value.toLocaleString("en")} ms`,
    note: "How long the slowest twentieth of the window's requests took.",
  },
  {
    id: "database",
    label: "Database size",
    value: (sample) => sample.databaseBytes,
    words: megabytes,
    note: "The size of the journal database file.",
  },
];

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly history: HostHealthHistory }
  | { readonly status: "failure" };

/**
 * How the host process itself did over the range, beside how turns went: a
 * stall, a memory climb, or a slow database outlives the restart that usually
 * follows it. One small chart per measure, each on its own scale, with the
 * same readings in a disclosed table.
 */
export function HostHealthSection(props: {
  readonly client: Pick<UsageClient, "hostHealth">;
  readonly from: string | undefined;
  /** Changes when the page refreshes, so this section reads again with it. */
  readonly readKey: unknown;
  readonly when: (timestamp: string) => string;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const { client, from, readKey } = props;

  useEffect(() => {
    let current = true;
    client.hostHealth(from === undefined ? {} : { from: from as never }).then(
      (history) => {
        if (current) setState({ status: "ready", history });
      },
      () => {
        if (current) setState({ status: "failure" });
      },
    );
    return () => {
      current = false;
    };
  }, [client, from, readKey]);

  if (state.status === "loading") return null;
  if (state.status === "failure") {
    return (
      <SurfaceSection label="Host health">
        <p className="usage-workspace__note">This host did not answer its health history.</p>
      </SurfaceSection>
    );
  }
  const { history } = state;
  const samples = history.samples;
  // The host counts restarts from minutes, against the process in effect when
  // the range began, so restarts inside one hour and one just after the range
  // start are all here.
  const restarts = history.restarts;
  return (
    <SurfaceSection label="Host health">
      {samples.length === 0 ? (
        <p className="usage-workspace__note">
          No samples yet. The host records one a minute and keeps {history.retentionDays} days.
        </p>
      ) : (
        <>
          <p className="usage-workspace__note">
            One point per {history.resolution}; an hour keeps its worst minute. Kept for{" "}
            {history.retentionDays} days.{" "}
            {restarts.length === 0
              ? "No restart in this range."
              : `Restarted ${restarts.length} time${restarts.length === 1 ? "" : "s"}: ${restarts
                  .map(props.when)
                  .join(", ")}.`}
          </p>
          <div className="host-health__grid">
            {METRICS.map((metric) => (
              <MetricStrip key={metric.id} metric={metric} samples={samples} when={props.when} />
            ))}
          </div>
          <details className="turn-diagnostics__details">
            <summary>Show as a table</summary>
            <div className="usage-table-scroll">
              <table aria-label="Host health" className="usage-table">
                <thead>
                  <tr>
                    <th scope="col">{history.resolution === "hour" ? "Hour" : "Minute"}</th>
                    {METRICS.map((metric) => (
                      <th key={metric.id} scope="col">
                        {metric.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...samples].reverse().map((sample) => (
                    <tr key={sample.sampledAt}>
                      <th scope="row">{props.when(sample.sampledAt)}</th>
                      {METRICS.map((metric) => {
                        const value = metric.value(sample);
                        return (
                          <td key={metric.id}>
                            {value === undefined ? "Unavailable" : metric.words(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </SurfaceSection>
  );
}

function MetricStrip(props: {
  readonly metric: Metric;
  readonly samples: ReadonlyArray<HostHealthSample>;
  readonly when: (timestamp: string) => string;
}) {
  const readings = props.samples.flatMap((sample) => {
    const value = props.metric.value(sample);
    return value === undefined ? [] : [{ at: sample.sampledAt, value }];
  });
  const peak = readings.reduce<{ at: string; value: number } | undefined>(
    (best, reading) => (best === undefined || reading.value > best.value ? reading : best),
    undefined,
  );
  const maximum = Math.max(1, peak?.value ?? 0);
  return (
    <figure className="host-health__metric">
      <figcaption>
        <span className="host-health__label">{props.metric.label}</span>
        <span className="host-health__peak">
          {peak === undefined
            ? "Unavailable"
            : `Peak ${props.metric.words(peak.value)} · ${props.when(peak.at)}`}
        </span>
      </figcaption>
      <ul aria-hidden="true" className="host-health__bars">
        {readings.map((reading) => (
          <li
            className="host-health__bar"
            key={reading.at}
            style={{
              height: `${Math.max(reading.value > 0 ? 4 : 1, (reading.value / maximum) * 100)}%`,
            }}
            title={`${props.when(reading.at)} · ${props.metric.words(reading.value)}`}
          />
        ))}
      </ul>
      <p className="usage-workspace__note">{props.metric.note}</p>
    </figure>
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toLocaleString("en", { maximumFractionDigits: 1 })} MB`;
}
