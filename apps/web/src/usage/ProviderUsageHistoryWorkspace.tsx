import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  decodeLocalUsageHistoryRequest,
  type LocalUsageHistoryResponse,
  type LocalUsageHistoryGroup,
} from "@octant/contracts";
import type { LocalUsageHistoryClient } from "@octant/client-runtime/provider-usage-history-client";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { ProviderUsageHistoryChart } from "./ProviderUsageHistoryChart";
import "./providerUsageHistory.css";

type Range = "24h" | "7d" | "30d" | "90d";
import {
  compactTokens,
  historyProviderName,
  dollars,
  formatDay,
  type HistoryMetric,
  type HistoryCostBasis,
} from "./usageHistoryPresentation";
const ranges: ReadonlyArray<{ readonly value: Range; readonly label: string }> = [
  { value: "24h", label: "Past 24h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function ProviderUsageHistoryWorkspace(props: {
  readonly client: LocalUsageHistoryClient;
  readonly onBack?: () => void;
  readonly sourceControl?: ReactNode;
  readonly limits?: ReactNode;
  /**
   * Rendered inside a page that already has a title, so this view contributes
   * its controls and its readings but not a second "Usage" heading.
   */
  readonly embedded?: boolean;
}) {
  const [range, setRange] = useState<Range>("30d");
  // Cost first: it is the question a person opens this page with, and it is
  // the one the Octant ledger structurally cannot answer, which is why that
  // view led for so long. Tokens stay one control away.
  const [metric, setMetric] = useState<HistoryMetric>("cost");
  const [basis, setBasis] = useState<HistoryCostBasis>("apiEstimateUsd");
  const [breakdown, setBreakdown] = useState<"model" | "day">("model");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    readonly client: LocalUsageHistoryClient;
    readonly range: Range;
    readonly data?: LocalUsageHistoryResponse;
    readonly busy: boolean;
    readonly failed: boolean;
    readonly paused?: boolean;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    const to = Date.now();
    const duration = range === "24h" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const request = decodeLocalUsageHistoryRequest({
      from: new Date(to - duration * 86400000).toISOString(),
      to: new Date(to).toISOString(),
      timeZone,
    });
    setResult((previous) => ({
      client: props.client,
      range,
      busy: true,
      failed: false,
      ...(previous?.client === props.client &&
      previous.range === range &&
      previous.data !== undefined
        ? { data: previous.data }
        : {}),
    }));
    const read = async () => {
      try {
        for (let batch = 0; batch < 512 && !abort.signal.aborted; batch += 1) {
          const data = await props.client.load(request, abort.signal);
          if (abort.signal.aborted) return;
          const more = data.coverage.some((source) => source.hasMore === true);
          const paused = more && batch === 511;
          setResult({
            client: props.client,
            range,
            data,
            busy: more && !paused,
            failed: false,
            paused,
          });
          if (!more || paused) return;
          await pauseImport(abort.signal);
        }
      } catch {
        if (!abort.signal.aborted)
          setResult((previous) => ({
            ...previous,
            client: props.client,
            range,
            busy: false,
            failed: true,
          }));
      }
    };
    void read();
    return () => abort.abort();
  }, [props.client, range, revision]);
  const current = result?.client === props.client && result.range === range ? result : undefined;
  const data = current?.data;
  const busy = current === undefined || current.busy;
  const costBasis =
    data?.cost[basis] === undefined &&
    data?.cost[basis === "apiEstimateUsd" ? "providerRecordedUsd" : "apiEstimateUsd"] !== undefined
      ? basis === "apiEstimateUsd"
        ? "providerRecordedUsd"
        : "apiEstimateUsd"
      : basis;
  const hasHistorySource =
    data !== undefined &&
    (data.totals.requestCount > 0 ||
      data.coverage.some((source) => source.status === "ready" || source.status === "partial"));
  const primary =
    data === undefined || !hasHistorySource
      ? undefined
      : metric === "tokens"
        ? data.totals.totalTokens
        : data.cost[costBasis];
  const selectedPricedCount =
    data?.cost[
      costBasis === "apiEstimateUsd" ? "apiEstimateRecordCount" : "providerRecordedRecordCount"
    ];
  const modelRows = useMemo(
    () =>
      data === undefined
        ? []
        : [...data.models].sort(
            (a, b) =>
              (metricValue(b, metric, costBasis) ?? -1) -
                (metricValue(a, metric, costBasis) ?? -1) || a.key.localeCompare(b.key),
          ),
    [data, metric, costBasis],
  );
  return (
    <section className="provider-history" aria-label="Local provider usage history">
      <header className="provider-history__header">
        <div className="provider-history__heading">
          {props.embedded === true ? null : props.onBack === undefined ? null : (
            <OctantButton
              onClick={props.onBack}
              variant="ghost"
              size="icon"
              aria-label="Back to app"
            >
              <ArrowLeft size={16} />
            </OctantButton>
          )}
          {props.embedded === true ? null : <h2>Usage</h2>}
          {props.sourceControl}
        </div>
        <div className="provider-history__controls">
          <OctantToggleGroup<HistoryMetric>
            aria-label="Usage measure"
            value={[metric]}
            onValueChange={(values) => {
              const next = values[0];
              if (next !== undefined) setMetric(next);
            }}
          >
            <OctantToggleGroupItem value="cost">Cost</OctantToggleGroupItem>
            <OctantToggleGroupItem value="tokens">Tokens</OctantToggleGroupItem>
          </OctantToggleGroup>
          <OctantToggleGroup<Range>
            aria-label="Usage period"
            value={[range]}
            onValueChange={(values) => {
              const next = values[0];
              if (next !== undefined) setRange(next);
            }}
          >
            {ranges.map((item) => (
              <OctantToggleGroupItem key={item.value} value={item.value}>
                {item.label}
              </OctantToggleGroupItem>
            ))}
          </OctantToggleGroup>
          <OctantButton
            aria-label="Refresh provider history"
            disabled={busy}
            variant="ghost"
            size="icon"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </OctantButton>
        </div>
      </header>
      <div className="provider-history__content">
        <p className="provider-history__status" role="status">
          {current?.failed
            ? data === undefined
              ? "History could not be read. Refresh to try again."
              : data.coverage.some((source) => source.status !== "ready" || source.hasMore === true)
                ? "Import failed. Partial readings are shown; see source coverage."
                : "Refresh failed. Last successful readings are shown."
            : current?.paused
              ? "Import paused. Refresh to continue reading history."
              : busy
                ? "Reading local provider history…"
                : data?.coverage.length === 0
                  ? "No supported local history source is enabled. Check Providers & Models."
                  : data?.coverage.some((source) => source.status !== "ready")
                    ? "Some sources are incomplete or unavailable. See source coverage."
                    : "Local provider history · this computer"}
        </p>
        <section
          className="provider-history__overview"
          aria-label="Usage overview"
          aria-busy={busy}
        >
          <div className="provider-history__summary">
            <h3>
              {data === undefined
                ? current?.failed
                  ? "Unavailable"
                  : "—"
                : primary === undefined
                  ? "Unavailable"
                  : metric === "tokens"
                    ? compactTokens(primary)
                    : dollars(primary)}
            </h3>
            <p>
              {data === undefined
                ? current?.failed
                  ? "Refresh to try again"
                  : "Collecting usage"
                : `${data.totals.sessionCount.toLocaleString()} sessions`}
              {metric === "cost"
                ? ` · ${costBasis === "apiEstimateUsd" ? "API-equivalent estimate" : "Provider-recorded cost"}`
                : " · processed tokens"}
            </p>
            <ul className="provider-history__providers">
              {data?.providers.map((provider, index) => (
                <li key={provider.key}>
                  <span className="provider-history__provider-label">
                    <span
                      className="provider-history__swatch"
                      data-series={index % 6}
                      aria-hidden="true"
                    />
                    {historyProviderName(provider.key, provider.label)}
                    <small>{provider.totals.sessionCount.toLocaleString()} sessions</small>
                  </span>
                  <span>{displayValue(metricValue(provider, metric, costBasis), metric)}</span>
                </li>
              ))}
            </ul>
            {metric === "cost" && data !== undefined ? (
              <div className="provider-history__cost-note">
                {data.cost.apiEstimateUsd !== undefined &&
                data.cost.providerRecordedUsd !== undefined ? (
                  <OctantToggleGroup<HistoryCostBasis>
                    aria-label="Cost source"
                    value={[costBasis]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next !== undefined) setBasis(next);
                    }}
                  >
                    <OctantToggleGroupItem value="apiEstimateUsd">
                      API estimate
                    </OctantToggleGroupItem>
                    <OctantToggleGroupItem value="providerRecordedUsd">
                      Recorded cost
                    </OctantToggleGroupItem>
                  </OctantToggleGroup>
                ) : null}
                <p>
                  {data.cost.unpricedRecordCount > 0
                    ? `${data.cost.unpricedRecordCount.toLocaleString()} ${data.cost.unpricedRecordCount === 1 ? "request without pricing" : "requests without pricing"}. `
                    : ""}
                  {selectedPricedCount === undefined
                    ? ""
                    : `${selectedPricedCount.toLocaleString()} of ${data.totals.requestCount.toLocaleString()} requests priced in this view. `}
                  Costs are in USD and reflect the selected source, not a subscription invoice.
                </p>
              </div>
            ) : null}
          </div>
          <ProviderUsageHistoryChart data={data} metric={metric} basis={costBasis} loading={busy} />
        </section>
        <section aria-label="Token totals" className="provider-history__totals">
          <Metric
            label="Processed tokens"
            value={hasHistorySource ? data?.totals.totalTokens : undefined}
            loading={busy && data === undefined}
          />
          <Metric
            label="Cached input"
            value={hasHistorySource ? data?.totals.cacheReadInputTokens : undefined}
            coverage={data?.totals.componentCoverage.cacheRead}
            loading={busy && data === undefined}
          />
          <Metric
            label="Uncached input"
            value={hasHistorySource ? data?.totals.uncachedInputTokens : undefined}
            coverage={data?.totals.componentCoverage.uncachedInput}
            loading={busy && data === undefined}
          />
          <Metric
            label="Cache savings · estimate"
            value={data?.cost.cacheSavingsUsd}
            format="money"
            coverage={
              data === undefined
                ? undefined
                : {
                    measured: data.cost.cacheSavingsRecordCount ?? 0,
                    total: data.totals.requestCount,
                  }
            }
            loading={busy && data === undefined}
          />
          <Metric
            label="Output"
            value={hasHistorySource ? data?.totals.outputTokens : undefined}
            loading={busy && data === undefined}
          />
        </section>
        {props.limits}
        <section aria-label="Usage breakdown" className="provider-history__breakdown">
          <div className="provider-history__section-heading">
            <h3>Breakdown</h3>
            <OctantToggleGroup<"model" | "day">
              aria-label="Breakdown by"
              value={[breakdown]}
              onValueChange={(values) => {
                const next = values[0];
                if (next !== undefined) setBreakdown(next);
              }}
            >
              <OctantToggleGroupItem value="model">Model</OctantToggleGroupItem>
              <OctantToggleGroupItem value="day">Day</OctantToggleGroupItem>
            </OctantToggleGroup>
          </div>
          <div
            className="provider-history__table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Usage breakdown rows"
          >
            <table aria-label={`Usage by ${breakdown}`}>
              <thead>
                <tr>
                  <th scope="col">{breakdown === "model" ? "Model" : "Day"}</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Share</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {breakdown === "model"
                  ? modelRows.map((row) => (
                      <HistoryRow
                        key={row.key}
                        label={row.label}
                        providerKey={row.providerKey}
                        tokens={row.totals.totalTokens}
                        cost={row.cost[costBasis]}
                        metric={metric}
                        total={primary}
                      />
                    ))
                  : data?.dailyTotals.map((row) => (
                      <HistoryRow
                        key={row.day}
                        label={formatDay(row.day)}
                        tokens={row.totals.totalTokens}
                        cost={row.cost[costBasis]}
                        metric={metric}
                        total={primary}
                      />
                    ))}
              </tbody>
            </table>
          </div>
          {data !== undefined && data.totals.requestCount === 0 ? (
            <p className="provider-history__empty">
              No provider history was found in this period. Check the source coverage below.
            </p>
          ) : null}
        </section>
        {data === undefined ? null : (
          <details className="provider-history__coverage">
            <summary>Source coverage</summary>
            <ul>
              {data.coverage.map((source) => (
                <li
                  key={`${historyProviderName(source.sourceKind)}/${source.sourceInstallationId}`}
                >
                  <strong>{historyProviderName(source.sourceKind)}</strong>
                  <span>
                    {source.status} · {source.detail}
                  </span>
                </li>
              ))}
            </ul>
            {(data.cost.pricingReferences?.length ?? 0) === 0 ? null : (
              <ul>
                {data.cost.pricingReferences?.map((reference) => (
                  <li key={`${reference.source}/${reference.revision}`}>
                    <a href={reference.source} target="_blank" rel="noreferrer">
                      {reference.source.replace(/^https:\/\//, "").split("/")[0]} · rates{" "}
                      {reference.revision}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <p>
              API estimates use the recorded standard rates. Cache savings compare priced input with
              the same input uncached; negative savings mean cache-write overhead.
            </p>
            <p>
              Activity recorded by provider tools on this computer can include Octant sessions. It
              is not added to Octant’s own ledger. Read {new Date(data.queryAt).toLocaleString()}.
            </p>
          </details>
        )}
      </div>
    </section>
  );
}

function Metric(props: {
  readonly label: string;
  readonly value: number | undefined;
  readonly coverage?: { readonly measured: number; readonly total: number } | undefined;
  readonly loading?: boolean;
  readonly format?: "money";
}) {
  const partial = props.coverage !== undefined && props.coverage.measured < props.coverage.total;
  return (
    <div>
      <span>{props.label}</span>
      <strong>
        {props.value === undefined
          ? props.loading
            ? "—"
            : "Unavailable"
          : props.format === "money"
            ? dollars(props.value)
            : compactTokens(props.value)}
      </strong>
      {partial && props.value !== undefined ? (
        <small>
          {props.coverage?.measured.toLocaleString()} of {props.coverage?.total.toLocaleString()}{" "}
          requests measured
        </small>
      ) : null}
    </div>
  );
}
function HistoryRow(props: {
  readonly label: string;
  readonly providerKey?: string;
  readonly tokens: number;
  readonly cost: number | undefined;
  readonly metric: HistoryMetric;
  readonly total: number | undefined;
}) {
  const value = props.metric === "tokens" ? props.tokens : props.cost;
  return (
    <tr>
      <th scope="row">
        <span className="provider-history__model-label">
          {props.providerKey === undefined ? null : (
            <span title={props.providerKey}>
              <ProviderGlyph
                driverKind={props.providerKey === "claude-code" ? "claude" : props.providerKey}
                displayName={props.providerKey}
                size={14}
              />
              <span className="sr-only">{props.providerKey}: </span>
            </span>
          )}
          {props.label}
        </span>
      </th>
      <td>{props.cost === undefined ? "—" : dollars(props.cost)}</td>
      <td>
        {value === undefined || props.total === undefined || props.total === 0
          ? "—"
          : new Intl.NumberFormat(undefined, {
              style: "percent",
              maximumFractionDigits: 1,
              minimumFractionDigits: 1,
            }).format(value / props.total)}
      </td>
      <td>{compactTokens(props.tokens)}</td>
    </tr>
  );
}
function metricValue(
  row: LocalUsageHistoryGroup,
  metric: HistoryMetric,
  basis: HistoryCostBasis,
): number | undefined {
  return metric === "tokens" ? row.totals.totalTokens : row.cost[basis];
}
function displayValue(value: number | undefined, metric: HistoryMetric): string {
  return value === undefined ? "—" : metric === "tokens" ? compactTokens(value) : dollars(value);
}

function pauseImport(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
