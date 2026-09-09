import { useEffect, useRef, useState } from "react";
import type { LocalUsageHistoryResponse } from "@octant/contracts";
import {
  compactTokens,
  historyProviderName,
  dollars,
  formatDay,
  type HistoryMetric,
  type HistoryCostBasis,
} from "./usageHistoryPresentation";

/** The day table carries the same readings for people who cannot use the chart. */
export function ProviderUsageHistoryChart(props: {
  readonly data: LocalUsageHistoryResponse | undefined;
  readonly metric: HistoryMetric;
  readonly basis: HistoryCostBasis;
  readonly loading: boolean;
}) {
  const chart = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    const element = chart.current;
    if (element === null) return;
    const measure = () => {
      const next = element.getBoundingClientRect().width;
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const plotStart = 64;
  const plotEnd = Math.max(plotStart + 1, width - 12);
  const days = [...new Set(props.data?.days.map((row) => row.day) ?? [])].sort();
  const series = (props.data?.providers ?? []).map((provider, index) => ({
    key: provider.key,
    label: provider.label,
    index,
    points: (props.data?.days ?? [])
      .filter((row) => row.providerKey === provider.key)
      .map((row) => ({
        day: row.day,
        value: props.metric === "tokens" ? row.totals.totalTokens : row.cost[props.basis],
      }))
      .filter((point): point is { day: string; value: number } => point.value !== undefined)
      .sort((a, b) => a.day.localeCompare(b.day)),
  }));
  const values = series.flatMap((row) => row.points.map((point) => point.value));
  const maximum = Math.max(1, ...values);
  const x = (day: string) =>
    plotStart +
    (days.length < 2 ? 0.5 : days.indexOf(day) / (days.length - 1)) * (plotEnd - plotStart);
  const y = (value: number) => 204 - (value / maximum) * 168;
  const label = (value: number) =>
    props.metric === "tokens" ? compactTokens(value) : dollars(value);
  return (
    <figure ref={chart} className="provider-history__chart">
      <figcaption>{props.metric === "tokens" ? "Daily processed tokens" : "Daily cost"}</figcaption>
      {values.length === 0 ? (
        <div className="provider-history__chart-empty">
          {props.data === undefined
            ? props.loading
              ? "Loading activity…"
              : "History unavailable"
            : props.metric === "cost"
              ? "No priced activity in this period"
              : "No recorded activity in this period"}
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${width} 240`}
          role="img"
          aria-label={`${props.metric === "tokens" ? "Token usage" : "Cost"} by provider and day. Open chart data for exact provider readings.`}
        >
          {[0, 0.5, 1].map((ratio) => (
            <g key={ratio}>
              <line
                className="provider-history__grid-line"
                x1={plotStart}
                x2={plotEnd}
                y1={y(maximum * ratio)}
                y2={y(maximum * ratio)}
              />
              <text x={plotStart - 10} y={y(maximum * ratio) + 4} textAnchor="end">
                {label(maximum * ratio)}
              </text>
            </g>
          ))}
          {series.map((row) => (
            <g key={row.key} className="provider-history__series" data-series={row.index % 6}>
              <path
                d={row.points
                  .map(
                    (point, index) => `${index === 0 ? "M" : "L"}${x(point.day)},${y(point.value)}`,
                  )
                  .join(" ")}
                fill="none"
                strokeWidth={2}
              />
              {row.points.length === 1
                ? row.points.map((point) => (
                    <circle key={point.day} cx={x(point.day)} cy={y(point.value)} r={3} />
                  ))
                : null}
            </g>
          ))}
          {days.length === 0 ? null : (
            <text x={plotStart} y={232}>
              {formatDay(days[0] ?? "1970-01-01")}
            </text>
          )}
          {days.length < 2 ? null : (
            <text x={plotEnd} y={232} textAnchor="end">
              {formatDay(days[days.length - 1] ?? "1970-01-01")}
            </text>
          )}
        </svg>
      )}
      {props.data === undefined || props.data.days.length === 0 ? null : (
        <details className="provider-history__chart-data">
          <summary>View chart data</summary>
          <div
            className="provider-history__chart-table"
            tabIndex={0}
            role="region"
            aria-label="Chart readings"
          >
            <table aria-label="Daily provider usage">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {props.data.days.map((row) => {
                  const cost = row.cost[props.basis];
                  return (
                    <tr key={`${row.day}/${row.providerKey}`}>
                      <th scope="row">{formatDay(row.day)}</th>
                      <td>
                        {historyProviderName(
                          row.providerKey,
                          props.data?.providers.find((provider) => provider.key === row.providerKey)
                            ?.label ?? row.providerKey,
                        )}
                      </td>
                      <td>{row.totals.totalTokens.toLocaleString()}</td>
                      <td>{cost === undefined ? "Unavailable" : dollars(cost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
