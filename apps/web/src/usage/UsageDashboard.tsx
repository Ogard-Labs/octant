import type {
  UsageExportFormat,
  UsageQueryFilter,
  UsageQueryResponse,
  UsageTopConsumer,
} from "@octant/contracts/usage-rpc";
import type { UsageQuality } from "@octant/contracts";
import type { ContextEntryCategory } from "@octant/contracts/context";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { HostId } from "@octant/contracts/host";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  Filter,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SurfaceEmpty, SurfaceHeader, SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import "../styles/usage.css";
import { LatencyStatsSection } from "./LatencyStatsSection";

export interface UsageDashboardProps {
  readonly client: UsageClient;
  readonly isNarrow?: boolean;
  readonly showHeading?: boolean;
}

type DashboardStatus = "loading" | "ready" | "error";
type ActivityView = "daily" | "weekly" | "cumulative";

const VIEWING_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone.trim() === ""
    ? "UTC"
    : Intl.DateTimeFormat().resolvedOptions().timeZone;

const QUALITY_LABELS: Readonly<Record<UsageQuality, string>> = {
  exact: "Exact",
  estimated: "Estimated",
  reconciled: "Reconciled",
  stale: "Stale",
  unavailable: "Unavailable",
};

const MODE_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "", label: "All modes" },
  { value: "chat", label: "Chat" },
  { value: "work", label: "Work" },
  { value: "code", label: "Code" },
];

const QUALITY_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "", label: "All quality" },
  { value: "exact", label: "Exact" },
  { value: "estimated", label: "Estimated" },
  { value: "reconciled", label: "Reconciled" },
  { value: "stale", label: "Stale" },
  { value: "unavailable", label: "Unavailable" },
];

const CATEGORY_OPTIONS: ReadonlyArray<{
  readonly value: ContextEntryCategory;
  readonly label: string;
}> = [
  { value: "provider-framing", label: "Provider framing" },
  { value: "octant-policy", label: "Octant policy" },
  { value: "user-instructions", label: "User instructions" },
  { value: "project-instructions", label: "Project instructions" },
  { value: "project-memory", label: "Project memory" },
  { value: "conversation", label: "Conversation" },
  { value: "current-request", label: "Current request" },
  { value: "workspace-context", label: "Workspace context" },
  { value: "extension-instructions", label: "Extension instructions" },
  { value: "octant-tools", label: "Octant tools" },
  { value: "mcp", label: "MCP" },
  { value: "tool-results", label: "Tool results" },
  { value: "subagent-results", label: "Subagent results" },
  { value: "reserves", label: "Reserves" },
];

const FILTER_KEYS: ReadonlyArray<keyof UsageQueryFilter> = [
  "providerInstanceId",
  "modelId",
  "hostId",
  "mode",
  "projectId",
  "subjectAggregateId",
  "requestShape",
  "quality",
  "category",
  "from",
  "to",
];

export function UsageDashboard(props: UsageDashboardProps) {
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [data, setData] = useState<UsageQueryResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [filter, setFilter] = useState<UsageQueryFilter>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activityView, setActivityView] = useState<ActivityView>("daily");
  const [confirmAction, setConfirmAction] = useState<
    | { readonly kind: "export"; readonly format: UsageExportFormat }
    | { readonly kind: "reset" }
    | { readonly kind: "retain" }
    | null
  >(null);
  const [actionMessage, setActionMessage] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [connectionLatencyMs, setConnectionLatencyMs] = useState<number>();
  const mounted = useRef(false);
  const dataRef = useRef<UsageQueryResponse | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    const hasPriorData = dataRef.current !== null;
    if (hasPriorData) setRefreshing(true);
    else setStatus("loading");
    setErrorMessage(undefined);
    const startedAt = performance.now();
    try {
      const result = await props.client.query({
        filter,
        ...(filter.from === undefined && filter.to === undefined
          ? {}
          : { timeZone: VIEWING_TIME_ZONE }),
      });
      if (!mounted.current || requestId !== requestSequence.current) return;
      dataRef.current = result;
      setData(result);
      setConnectionLatencyMs(Math.max(0, performance.now() - startedAt));
      setRefreshing(false);
      setStatus("ready");
    } catch (error) {
      if (!mounted.current || requestId !== requestSequence.current) return;
      setErrorMessage(error instanceof Error ? error.message : "Cannot load usage data.");
      setRefreshing(false);
      setStatus(hasPriorData ? "ready" : "error");
    }
  }, [props.client, filter]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unavailablePresent = data?.totals.unavailableCount ?? 0;
  const hasUnavailableUsage = unavailablePresent > 0;

  const runExport = useCallback(
    async (format: UsageExportFormat) => {
      try {
        const result = await props.client.export({ format, confirm: true, filter });
        const blob = new Blob([result.body], {
          type: format === "csv" ? "text/csv" : "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `octant-usage.${format}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setActionMessage(`Exported ${format.toUpperCase()} usage data.`);
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Export failed.");
      }
    },
    [props.client, filter],
  );

  const runReset = useCallback(async () => {
    try {
      const result = await props.client.reset({ confirm: true });
      setActionMessage(`Reset usage records. Purged ${result.purgedCount} record(s).`);
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Reset failed.");
    }
  }, [props.client, load]);

  const runRetain = useCallback(async () => {
    const olderThan = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const result = await props.client.retain({ olderThan: olderThan as never, confirm: true });
      setActionMessage(`Purged ${result.purgedCount} record(s) older than 30 days.`);
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Retention purge failed.");
    }
  }, [props.client, load]);

  if (status === "loading") {
    return (
      <section aria-label="Usage dashboard" aria-busy="true" className="usage-dashboard">
        <p className="oct-row-detail usage-dashboard__status" role="status">
          Loading usage data…
        </p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section aria-label="Usage dashboard" className="usage-dashboard">
        <div className="usage-dashboard__error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <p>{errorMessage}</p>
          <OctantButton onClick={() => void load()} size="sm" type="button">
            Retry
          </OctantButton>
        </div>
      </section>
    );
  }

  if (data === null) return null;

  const isEmpty = data.records.length === 0;
  const hasFilter = Object.keys(filter).length > 0;
  const activeFilterCount = FILTER_KEYS.filter(
    (key) => filter[key] !== undefined && filter[key] !== "",
  ).length;
  const activitySeries = activitySeriesFor(data, activityView);

  return (
    <section aria-busy={refreshing} aria-label="Usage dashboard" className="usage-dashboard">
      {props.showHeading === false ? null : (
        <SurfaceHeader subtitle="Activity and usage across providers." title="Usage" />
      )}

      <div className="surface-toolbar">
        <OctantButton
          aria-controls="usage-dashboard-filters"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((current) => !current)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Filter aria-hidden="true" size={14} />
          <span>Filters</span>
          {activeFilterCount === 0 ? null : (
            <span className="oct-meta usage-dashboard__filter-count">{activeFilterCount}</span>
          )}
          {filtersOpen ? (
            <ChevronUp aria-hidden="true" size={14} />
          ) : (
            <ChevronDown aria-hidden="true" size={14} />
          )}
        </OctantButton>
        <span className="surface-toolbar__spacer" />
        <OctantButton
          aria-label="Refresh usage data"
          onClick={() => void load()}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} />
        </OctantButton>
      </div>

      <UsageFilters filter={filter} onChange={setFilter} open={filtersOpen} />

      {refreshing ? (
        <p className="oct-row-detail usage-dashboard__status" role="status">
          Refreshing usage data…
        </p>
      ) : null}
      {status === "ready" && errorMessage !== undefined ? (
        <div className="usage-dashboard__error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <p>{errorMessage}</p>
          <OctantButton onClick={() => void load()} size="sm" type="button">
            Retry
          </OctantButton>
        </div>
      ) : null}

      {hasUnavailableUsage ? (
        <p className="usage-dashboard__unavailable-note" role="status">
          Some usage is unavailable or estimated and shown as measurement quality, never as zero
          cost.
        </p>
      ) : null}

      <div className="usage-totals" role="group" aria-label="Summary totals">
        <UsageTotal label="Total requests" value={data.totals.totalRequests} />
        <UsageTotal label="Input tokens" value={data.totals.totalInputTokens} />
        <UsageTotal label="Output tokens" value={data.totals.totalOutputTokens} />
      </div>

      <div className="usage-dashboard__quality" role="group" aria-label="Data quality">
        <QualityBadge count={data.totals.exactCount} label="Exact" quality="exact" />
        <QualityBadge count={data.totals.estimatedCount} label="Estimated" quality="estimated" />
        <QualityBadge count={data.totals.reconciledCount} label="Reconciled" quality="reconciled" />
        <QualityBadge count={data.totals.staleCount} label="Stale" quality="stale" />
        <QualityBadge
          count={data.totals.unavailableCount}
          label="Unavailable"
          quality="unavailable"
        />
      </div>

      {isEmpty ? (
        <SurfaceEmpty
          {...(hasFilter
            ? {
                action: (
                  <OctantButton
                    onClick={() => setFilter({})}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Clear filters
                  </OctantButton>
                ),
              }
            : {})}
          detail={
            hasFilter
              ? "Clear or adjust the active filters to see other usage."
              : "Usage appears after an agent completes a provider request."
          }
          title={hasFilter ? "No usage matches these filters" : "No usage recorded yet"}
        />
      ) : (
        <>
          <ActivitySection
            view={activityView}
            onViewChange={setActivityView}
            series={activitySeries}
            isNarrow={props.isNarrow ?? false}
          />

          {data.topConsumers.length > 0 ? (
            <TopConsumersSection consumers={data.topConsumers} />
          ) : null}

          {data.byProvider.length > 0 ? (
            <SurfaceSection className="usage-dashboard__section" label="By provider">
              <table className="usage-dashboard__table" aria-label="Usage by provider">
                <thead>
                  <tr>
                    <th scope="col">Provider</th>
                    <th scope="col">Model</th>
                    <th scope="col">Requests</th>
                    <th scope="col">Input tokens</th>
                    <th scope="col">Output tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProvider.map((row) => (
                    <tr key={`${row.providerInstanceId}/${row.modelId}`}>
                      <td>{row.providerInstanceId}</td>
                      <td>{row.modelId}</td>
                      <td>{row.requestCount}</td>
                      <td>{formatNumber(row.totalInputTokens)}</td>
                      <td>{formatNumber(row.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SurfaceSection>
          ) : null}

          {data.byCategory.length > 0 ? (
            <SurfaceSection className="usage-dashboard__section" label="By category">
              <table className="usage-dashboard__table" aria-label="Usage by category">
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Planned tokens</th>
                    <th scope="col">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCategory.map((row) => (
                    <tr key={row.category}>
                      <td>{row.category}</td>
                      <td>{formatNumber(row.plannedTokens)}</td>
                      <td>{row.entryCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SurfaceSection>
          ) : null}
        </>
      )}

      <details className="usage-dashboard__operational-details">
        <summary className="oct-section-label">Operational details</summary>
        <div
          aria-label="Operational metrics"
          className="usage-dashboard__operational-metrics"
          role="group"
        >
          <OperationalMetric label="Reasoning tokens" value={data.totals.totalReasoningTokens} />
          <OperationalMetric
            label="Cache read tokens"
            value={data.totals.totalCacheReadInputTokens}
          />
          <OperationalMetric
            label="Cache write tokens"
            value={data.totals.totalCacheWriteInputTokens}
          />
          <OperationalMetric
            label="Provider execution time"
            suffix=" ms"
            value={data.totals.totalProviderExecutionDurationMs}
          />
        </div>
        <LatencyStatsSection
          className="usage-dashboard__section"
          connectionLatencyMs={connectionLatencyMs}
          latencyStats={data.latencyStats}
        />
      </details>

      <UsageControls
        onExportCsv={() => setConfirmAction({ kind: "export", format: "csv" })}
        onExportJson={() => setConfirmAction({ kind: "export", format: "json" })}
        onReset={() => setConfirmAction({ kind: "reset" })}
        onRetain={() => setConfirmAction({ kind: "retain" })}
        {...(actionMessage ? { message: actionMessage } : {})}
      />

      <p className="oct-meta usage-dashboard__footer">
        Queried {queriedAtLabel(data.queryAt)}
        {data.hasMore ? " · More data available" : ""}
      </p>

      {confirmAction !== null ? (
        <ConfirmDialog
          action={confirmAction}
          onCancel={() => setConfirmAction(null)}
          onConfirm={async () => {
            const action = confirmAction;
            setConfirmAction(null);
            if (action.kind === "export") {
              await runExport(action.format);
            } else if (action.kind === "reset") {
              await runReset();
            } else {
              await runRetain();
            }
          }}
        />
      ) : null}
    </section>
  );
}

function activitySeriesFor(
  data: UsageQueryResponse,
  view: ActivityView,
): ReadonlyArray<{
  readonly label: string;
  readonly input: number;
  readonly output: number;
  readonly requests: number;
}> {
  if (view === "daily") {
    return data.byDay.map((bucket) => ({
      label: shortDate(bucket.bucketStart),
      input: bucket.inputTokens,
      output: bucket.outputTokens,
      requests: bucket.requestCount,
    }));
  }
  if (view === "weekly") {
    return data.byWeek.map((bucket) => ({
      label: shortDate(bucket.bucketStart),
      input: bucket.inputTokens,
      output: bucket.outputTokens,
      requests: bucket.requestCount,
    }));
  }
  return data.cumulative.map((point) => ({
    label: shortDate(point.bucketStart),
    input: point.cumulativeInputTokens,
    output: point.cumulativeOutputTokens,
    requests: point.cumulativeRequests,
  }));
}

function shortDate(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** "21:36 on 1 Sep 2026" in the viewer's time zone: a sentence, not a stamp. */
function queriedAtLabel(timestamp: string): string {
  const at = new Date(timestamp);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: VIEWING_TIME_ZONE,
  }).format(at);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: VIEWING_TIME_ZONE,
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${time} on ${parts.day} ${parts.month} ${parts.year}`;
}

interface UsageFiltersProps {
  readonly filter: UsageQueryFilter;
  readonly onChange: (filter: UsageQueryFilter) => void;
  readonly open: boolean;
}

function UsageFilters({ filter, onChange, open }: UsageFiltersProps) {
  const [rangeError, setRangeError] = useState<string>();
  const update = <K extends keyof UsageQueryFilter>(
    key: K,
    value: UsageQueryFilter[K] | undefined,
  ) => {
    const next = { ...filter };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const clear = (...keys: ReadonlyArray<keyof UsageQueryFilter>) => {
    const next = { ...filter };
    for (const key of keys) delete next[key];
    onChange(next);
  };
  const updateDate = (key: "from" | "to", value: string) => {
    const next = { ...filter };
    const encoded = value === "" ? undefined : dateInputToUtc(value, key === "to");
    if (value !== "" && encoded === undefined) {
      setRangeError("Enter a valid calendar date.");
      return;
    }
    if (encoded === undefined) delete next[key];
    else next[key] = encoded as UsageQueryFilter[typeof key];
    if (next.from !== undefined && next.to !== undefined && next.from > next.to) {
      setRangeError("From date must be on or before the to date.");
      return;
    }
    setRangeError(undefined);
    onChange(next);
  };
  return (
    <div
      aria-label="Usage filters"
      className="usage-dashboard__filters"
      hidden={!open}
      id="usage-dashboard-filters"
      role="group"
    >
      <label className="usage-dashboard__field">
        <span>Provider</span>
        <OctantInput
          aria-label="Filter by provider instance id"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) =>
            update(
              "providerInstanceId",
              event.currentTarget.value.trim() === ""
                ? undefined
                : (event.currentTarget.value.trim() as ProviderInstanceId),
            )
          }
          placeholder="provider instance id"
          type="search"
          value={filter.providerInstanceId ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Model</span>
        <OctantInput
          aria-label="Filter by model id"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) =>
            update(
              "modelId",
              event.currentTarget.value.trim() === ""
                ? undefined
                : (event.currentTarget.value.trim() as ProviderModelId),
            )
          }
          placeholder="model id"
          type="search"
          value={filter.modelId ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Host</span>
        <OctantInput
          aria-label="Filter by host id"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) =>
            update(
              "hostId",
              event.currentTarget.value.trim() === ""
                ? undefined
                : (event.currentTarget.value.trim() as HostId),
            )
          }
          placeholder="host id"
          type="search"
          value={filter.hostId ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Mode</span>
        <OctantSelectField
          aria-label="Filter by mode"
          className="usage-dashboard__select select window-no-drag"
          onValueChange={(value) =>
            update("mode", value === "" ? undefined : (value as UsageQueryFilter["mode"]))
          }
          options={MODE_OPTIONS.map((option) => ({
            id: option.value,
            label: option.label,
          }))}
          value={filter.mode ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Project</span>
        <OctantInput
          aria-label="Filter by project id"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) =>
            update(
              "projectId",
              event.currentTarget.value.trim() === ""
                ? undefined
                : event.currentTarget.value.trim(),
            )
          }
          placeholder="project id"
          type="search"
          value={filter.projectId ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Thread</span>
        <OctantInput
          aria-label="Filter by thread id"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) => {
            const value = event.currentTarget.value.trim();
            if (value === "") {
              clear("subjectAggregateType", "subjectAggregateId");
              return;
            }
            onChange({
              ...filter,
              subjectAggregateType: "chat-thread",
              subjectAggregateId: value,
            });
          }}
          placeholder="thread id"
          type="search"
          value={filter.subjectAggregateId ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Request shape</span>
        <OctantInput
          aria-label="Filter by request shape"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) =>
            update(
              "requestShape",
              event.currentTarget.value.trim() === ""
                ? undefined
                : event.currentTarget.value.trim(),
            )
          }
          placeholder="request shape"
          type="search"
          value={filter.requestShape ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Quality</span>
        <OctantSelectField
          aria-label="Filter by measurement quality"
          className="usage-dashboard__select select window-no-drag"
          onValueChange={(value) =>
            update("quality", value === "" ? undefined : (value as UsageQueryFilter["quality"]))
          }
          options={QUALITY_OPTIONS.map((option) => ({
            id: option.value,
            label: option.label,
          }))}
          value={filter.quality ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>Category</span>
        <OctantSelectField
          aria-label="Filter by context category"
          className="usage-dashboard__select select window-no-drag"
          onValueChange={(value) =>
            update("category", value === "" ? undefined : (value as ContextEntryCategory))
          }
          options={[
            { id: "", label: "All categories" },
            ...CATEGORY_OPTIONS.map((option) => ({
              id: option.value,
              label: option.label,
            })),
          ]}
          value={filter.category ?? ""}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>From date</span>
        <OctantInput
          aria-label="Usage from date"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) => updateDate("from", event.currentTarget.value)}
          type="date"
          value={dateInputValue(filter.from)}
        />
      </label>
      <label className="usage-dashboard__field">
        <span>To date</span>
        <OctantInput
          aria-label="Usage to date"
          className="usage-dashboard__text-input input window-no-drag"
          onChange={(event) => updateDate("to", event.currentTarget.value)}
          type="date"
          value={dateInputValue(filter.to)}
        />
      </label>
      {rangeError !== undefined ? (
        <p className="usage-dashboard__filter-error" role="alert">
          {rangeError}
        </p>
      ) : null}
    </div>
  );
}

interface ActivitySectionProps {
  readonly view: ActivityView;
  readonly onViewChange: (view: ActivityView) => void;
  readonly series: ReadonlyArray<{
    readonly label: string;
    readonly input: number;
    readonly output: number;
    readonly requests: number;
  }>;
  readonly isNarrow: boolean;
}

function ActivitySection({ view, onViewChange, series, isNarrow }: ActivitySectionProps) {
  return (
    <section aria-label="Activity" className="surface-section usage-dashboard__section">
      <div className="usage-dashboard__section-header">
        <h2 className="oct-section-label">Activity</h2>
        <OctantToggleGroup<ActivityView>
          aria-label="Activity view"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected !== undefined) onViewChange(selected);
          }}
          value={[view]}
        >
          <OctantToggleGroupItem value="daily">Daily</OctantToggleGroupItem>
          <OctantToggleGroupItem value="weekly">Weekly</OctantToggleGroupItem>
          <OctantToggleGroupItem value="cumulative">Cumulative</OctantToggleGroupItem>
        </OctantToggleGroup>
      </div>
      <table
        aria-label={`${view} activity`}
        className={`usage-dashboard__table${isNarrow ? " usage-dashboard__table--narrow" : ""}`}
      >
        <thead>
          <tr>
            <th scope="col">{view === "cumulative" ? "Date" : "Bucket start"}</th>
            <th scope="col">Input tokens</th>
            <th scope="col">Output tokens</th>
            <th scope="col">Requests</th>
          </tr>
        </thead>
        <tbody>
          {series.map((point) => (
            <tr key={point.label}>
              <td>{point.label}</td>
              <td>{formatNumber(point.input)}</td>
              <td>{formatNumber(point.output)}</td>
              <td>{point.requests}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TopConsumersSection({
  consumers,
}: {
  readonly consumers: ReadonlyArray<UsageTopConsumer>;
}) {
  return (
    <SurfaceSection className="usage-dashboard__section" label="Top consumers">
      <table className="usage-dashboard__table" aria-label="Top usage consumers">
        <thead>
          <tr>
            <th scope="col">Subject type</th>
            <th scope="col">Subject id</th>
            <th scope="col">Requests</th>
            <th scope="col">Input tokens</th>
            <th scope="col">Output tokens</th>
          </tr>
        </thead>
        <tbody>
          {consumers.map((consumer) => (
            <tr key={`${consumer.subjectType}/${consumer.subjectId}`}>
              <td>{consumer.subjectType}</td>
              <td>{consumer.subjectId}</td>
              <td>{consumer.requestCount}</td>
              <td>{formatNumber(consumer.inputTokens)}</td>
              <td>{formatNumber(consumer.outputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SurfaceSection>
  );
}

interface UsageControlsProps {
  readonly onExportCsv: () => void;
  readonly onExportJson: () => void;
  readonly onReset: () => void;
  readonly onRetain: () => void;
  readonly message?: string;
}

function UsageControls(props: UsageControlsProps) {
  return (
    <div className="usage-dashboard__controls" role="group" aria-label="Usage data controls">
      <OctantButton onClick={props.onExportCsv} size="sm" type="button" variant="outline">
        <Download aria-hidden="true" size={14} /> Export CSV
      </OctantButton>
      <OctantButton onClick={props.onExportJson} size="sm" type="button" variant="outline">
        <Download aria-hidden="true" size={14} /> Export JSON
      </OctantButton>
      <OctantButton
        onClick={props.onRetain}
        className="usage-dashboard__danger"
        size="sm"
        type="button"
        variant="ghost"
      >
        <Eraser aria-hidden="true" size={14} /> Purge older than 30 days
      </OctantButton>
      <OctantButton
        onClick={props.onReset}
        className="usage-dashboard__danger"
        size="sm"
        type="button"
        variant="ghost"
      >
        <Trash2 aria-hidden="true" size={14} /> Reset all usage
      </OctantButton>
      {props.message !== undefined ? (
        <p className="usage-dashboard__action-message" role="status">
          {props.message}
        </p>
      ) : null}
    </div>
  );
}

interface ConfirmDialogProps {
  readonly action:
    | { readonly kind: "export"; readonly format: UsageExportFormat }
    | { readonly kind: "reset" }
    | { readonly kind: "retain" };
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function ConfirmDialog({ action, onCancel, onConfirm }: ConfirmDialogProps) {
  const message = confirmMessageFor(action);
  return (
    <div className="usage-dashboard__confirm" role="alertdialog" aria-label="Confirm usage action">
      <p>{message}</p>
      <div className="usage-dashboard__confirm-actions">
        <OctantButton onClick={onCancel} size="sm" type="button" variant="outline">
          Cancel
        </OctantButton>
        {/*
          Reset and retain purge usage data for good. Backing out and going
          through with it must not look like the same button, so the one that
          destroys says so and the way out stays neutral. Export keeps the
          ordinary treatment: it takes nothing away.
        */}
        <OctantButton
          autoFocus
          onClick={onConfirm}
          size="sm"
          type="button"
          variant={action.kind === "export" ? "default" : "destructive"}
        >
          Confirm
        </OctantButton>
      </div>
    </div>
  );
}

function confirmMessageFor(action: ConfirmDialogProps["action"]): string {
  if (action.kind === "export") {
    return `Export usage data as ${action.format.toUpperCase()}? Only safe reference fields are included; no prompts, file contents, credentials, or account identifiers.`;
  }
  if (action.kind === "reset") {
    return "Reset all usage records? This permanently clears the local usage projection and cannot be undone.";
  }
  return "Purge usage records older than 30 days? This removes durable usage records older than the retention threshold.";
}

function UsageTotal(props: { readonly label: string; readonly value: number | undefined }) {
  return (
    <div className="usage-total">
      <span className="usage-total__value">
        {props.value === undefined ? "Unavailable" : formatNumber(props.value)}
      </span>
      <span className="oct-meta">{props.label}</span>
    </div>
  );
}

function OperationalMetric(props: {
  readonly label: string;
  readonly value: number | undefined;
  readonly suffix?: string;
}) {
  return (
    <div className="surface-row usage-dashboard__operational-metric">
      <span className="oct-row-label">{props.label}</span>
      <span className="surface-row__control usage-dashboard__metric-value">
        {props.value === undefined
          ? "Unavailable"
          : `${formatNumber(props.value)}${props.suffix ?? ""}`}
      </span>
    </div>
  );
}

function QualityBadge(props: {
  readonly count: number;
  readonly label: string;
  readonly quality: UsageQuality;
}) {
  if (props.count === 0) return null;
  return (
    <span
      className={`usage-dashboard__quality-badge usage-dashboard__quality-badge--${props.quality}`}
      data-quality={props.quality}
    >
      {QUALITY_LABELS[props.quality]}: {props.count}
    </span>
  );
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(0)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function dateInputValue(timestamp: string | undefined): string {
  if (timestamp === undefined) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VIEWING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateInputToUtc(value: string, endOfDay: boolean): string | undefined {
  const parsed = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export { formatNumber as formatUsageNumber };
