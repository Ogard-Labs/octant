import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { LocalUsageHistoryResponse } from "@octant/contracts";
import {
  axisValue,
  compactTokens,
  historyProviderColor,
  historyProviderName,
  dollars,
  formatDay,
  type HistoryMetric,
  type HistoryCostBasis,
} from "./usageHistoryPresentation";
import { calendarDays, roundTicks, smoothArea, smoothLine } from "./usageChartGeometry";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";

const PLOT_START = 64;
const PLOT_TOP = 36;
const BASELINE = 204;

/** The day table carries the same readings for people who cannot use the chart. */
export function ProviderUsageHistoryChart(props: {
  readonly data: LocalUsageHistoryResponse | undefined;
  readonly metric: HistoryMetric;
  readonly basis: HistoryCostBasis;
  readonly loading: boolean;
}) {
  const chart = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(700);
  /** The day being read, by pointer or keyboard. */
  const [reading, setReading] = useState<string>();
  /** The day that holds the plot's one tab stop once the keys have moved it. */
  const [stop, setStop] = useState<string>();
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
  const plotEnd = Math.max(PLOT_START + 1, width - 12);
  const rows = props.data?.days ?? [];
  const days = calendarDays(rows.map((row) => row.day));
  const valueOf = (row: (typeof rows)[number]) =>
    props.metric === "tokens" ? row.totals.totalTokens : row.cost[props.basis];
  const series = (props.data?.providers ?? []).map((provider, index) => {
    const own = new Map(
      rows.filter((row) => row.providerKey === provider.key).map((row) => [row.day, row]),
    );
    const measured = [...own.values()].some((row) => valueOf(row) !== undefined);
    return {
      key: provider.key,
      name: historyProviderName(provider.key, provider.label),
      index,
      measured,
      // A day with no record is a quiet day; a record with no price is
      // unknown, and a provider with no priced record at all is never zero.
      values: days.map((day) => {
        const row = own.get(day);
        return !measured ? undefined : row === undefined ? 0 : valueOf(row);
      }),
    };
  });
  const known = series.flatMap((row) => row.values.filter((value) => value !== undefined));
  const ticks = roundTicks(Math.max(0, ...known));
  const top = ticks[ticks.length - 1] ?? 1;
  const x = (index: number) =>
    PLOT_START + (days.length < 2 ? 0.5 : index / (days.length - 1)) * (plotEnd - PLOT_START);
  const y = (value: number) => BASELINE - (value / top) * (BASELINE - PLOT_TOP);
  const label = (value: number) =>
    props.metric === "tokens" ? compactTokens(value) : dollars(value);
  const readings = (index: number) =>
    series
      .map((row) => {
        const value = row.values[index];
        return `${row.name} ${value === undefined ? "Unavailable" : label(value)}`;
      })
      .join(" · ");
  const readIndex = reading === undefined ? -1 : days.indexOf(reading);
  const stopDay = stop !== undefined && days.includes(stop) ? stop : days[days.length - 1];
  const band = days.length < 2 ? plotEnd - PLOT_START : (plotEnd - PLOT_START) / (days.length - 1);
  const moveTo = (event: KeyboardEvent<SVGRectElement>, index: number) => {
    if (event.key === "Escape") {
      if (reading === undefined) return;
      // Inside Settings, Escape also closes the sheet; the first press closes the readout.
      event.stopPropagation();
      setReading(undefined);
      return;
    }
    const next =
      event.key === "ArrowLeft"
        ? index - 1
        : event.key === "ArrowRight"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? days.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    event.currentTarget.parentElement
      ?.querySelectorAll<SVGRectElement>("rect")
      [Math.max(0, Math.min(days.length - 1, next))]?.focus();
  };
  return (
    <figure ref={chart} className="provider-history__chart">
      <figcaption>{props.metric === "tokens" ? "Daily processed tokens" : "Daily cost"}</figcaption>
      {known.length === 0 ? (
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
        <>
          {/* Each day's mark names its own readings, so this line is for sight. */}
          <p className="provider-history__readout" aria-hidden="true">
            {readIndex < 0
              ? "Point at a day, or use the arrow keys, for its readings"
              : `${formatDay(days[readIndex] ?? "")} · ${readings(readIndex)}`}
          </p>
          <svg
            viewBox={`0 0 ${width} 240`}
            role="group"
            aria-label={`${props.metric === "tokens" ? "Token usage" : "Cost"} by provider and day. Arrow keys move between days.`}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  className="provider-history__grid-line"
                  x1={PLOT_START}
                  x2={plotEnd}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text
                  className="provider-history__tick"
                  x={PLOT_START - 10}
                  y={y(tick) + 4}
                  textAnchor="end"
                >
                  {axisValue(tick, props.metric)}
                </text>
              </g>
            ))}
            {series.map((row) => (
              <g
                key={row.key}
                className="provider-history__series"
                data-series={row.index % 6}
                style={seriesStyle(row.key)}
                aria-hidden="true"
              >
                {runs(row.values).map((run) => {
                  const points = run.map(({ index, value }) => ({ x: x(index), y: y(value) }));
                  const only = points.length === 1 ? points[0] : undefined;
                  // One day alone has no area to fill, so it is drawn as a dot.
                  return only !== undefined ? (
                    <circle key={run[0]?.index} cx={only.x} cy={only.y} r={3} />
                  ) : (
                    <g key={run[0]?.index}>
                      <path className="provider-history__area" d={smoothArea(points, BASELINE)} />
                      <path className="provider-history__line" d={smoothLine(points)} />
                    </g>
                  );
                })}
                {readIndex < 0 || row.values[readIndex] === undefined ? null : (
                  <circle cx={x(readIndex)} cy={y(row.values[readIndex] ?? 0)} r={3} />
                )}
              </g>
            ))}
            {readIndex < 0 ? null : (
              <line
                className="provider-history__guide"
                x1={x(readIndex)}
                x2={x(readIndex)}
                y1={PLOT_TOP}
                y2={BASELINE}
              />
            )}
            <g onPointerLeave={() => setReading(undefined)}>
              {days.map((day, index) => (
                <rect
                  key={day}
                  className="provider-history__day"
                  role="img"
                  aria-label={`${formatDay(day)}: ${readings(index)}`}
                  tabIndex={day === stopDay ? 0 : -1}
                  x={Math.max(PLOT_START, x(index) - band / 2)}
                  y={PLOT_TOP}
                  width={Math.max(
                    1,
                    Math.min(plotEnd, x(index) + band / 2) -
                      Math.max(PLOT_START, x(index) - band / 2),
                  )}
                  height={BASELINE - PLOT_TOP}
                  onPointerEnter={() => setReading(day)}
                  onFocus={() => {
                    setStop(day);
                    setReading(day);
                  }}
                  onBlur={() => setReading(undefined)}
                  onKeyDown={(event) => moveTo(event, index)}
                />
              ))}
            </g>
            {days.length === 0 ? null : (
              <text x={PLOT_START} y={232}>
                {formatDay(days[0] ?? "")}
              </text>
            )}
            {days.length < 2 ? null : (
              <text x={plotEnd} y={232} textAnchor="end">
                {formatDay(days[days.length - 1] ?? "")}
              </text>
            )}
          </svg>
        </>
      )}
      {props.data === undefined || props.data.days.length === 0 ? null : (
        <OctantCollapsible className="provider-history__chart-data" summary="View chart data">
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
                      <td>{row.totals.totalTokens.toLocaleString("en")}</td>
                      <td>{cost === undefined ? "Unavailable" : dollars(cost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </OctantCollapsible>
      )}
    </figure>
  );
}

/** Unbroken stretches of known values; an unknown day leaves a gap between them. */
function runs(
  values: ReadonlyArray<number | undefined>,
): ReadonlyArray<ReadonlyArray<{ readonly index: number; readonly value: number }>> {
  const found: Array<Array<{ readonly index: number; readonly value: number }>> = [];
  let open = false;
  values.forEach((value, index) => {
    if (value === undefined) {
      open = false;
      return;
    }
    if (!open) found.push([]);
    open = true;
    found[found.length - 1]?.push({ index, value });
  });
  return found;
}

function seriesStyle(providerKey: string): CSSProperties | undefined {
  const color = historyProviderColor(providerKey);
  return color === undefined ? undefined : ({ "--usage-provider-color": color } as CSSProperties);
}
