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
import { BarChart3, RefreshCw, AlertTriangle, Download, Trash2, Eraser } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import "../styles/usage.css";

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

export function UsageDashboard(props: UsageDashboardProps) {
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [data, setData] = useState<UsageQueryResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [filter, setFilter] = useState<UsageQueryFilter>({});
  const [activityView, setActivityView] = useState<ActivityView>("daily");
  const [confirmAction, setConfirmAction] = useState<
    | { readonly kind: "export"; readonly format: UsageExportFormat }
    | { readonly kind: "reset" }
    | { readonly kind: "retain" }
    | null
  >(null);
  const [actionMessage, setActionMessage] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const dataRef = useRef<UsageQueryResponse | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    const hasPriorData = dataRef.current !== null;
    if (hasPriorData) setRefreshing(true);
    else setStatus("loading");
    setErrorMessage(undefined);
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
        <p className="usage-dashboard__status" role="status">
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
          <OctantButton onClick={() => void load()} type="button">
            Retry
          </OctantButton>
        </div>
      </section>
    );
  }

  if (data === null) return null;

  const isEmpty = data.records.length === 0;
  const activitySeries = activitySeriesFor(data, activityView);

  return (
    <section aria-busy={refreshing} aria-label="Usage dashboard" className="usage-dashboard">
      <header
        className={`usage-dashboard__header${props.showHeading === false ? " usage-dashboard__header--embedded" : ""}`}
      >
        {props.showHeading === false ? null : (
          <h2>
            <BarChart3 aria-hidden="true" size={16} /> Usage
          </h2>
        )}
        <OctantButton
          aria-label="Refresh usage data"
          onClick={() => void load()}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} />
        </OctantButton>
      </header>

      <UsageFilters filter={filter} onChange={setFilter} />

      {refreshing ? (
        <p className="usage-dashboard__status" role="status">
          Refreshing usage data…
        </p>
      ) : null}
      {status === "ready" && errorMessage !== undefined ? (
        <div className="usage-dashboard__error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <p>{errorMessage}</p>
          <OctantButton onClick={() => void load()} type="button">
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

      <div className="usage-dashboard__totals" role="group" aria-label="Summary totals">
        <TotalsCard label="Total requests" value={data.totals.totalRequests} />
        <TotalsCard label="Input tokens" value={data.totals.totalInputTokens} />
        <TotalsCard label="Output tokens" value={data.totals.totalOutputTokens} />
        <TotalsCard label="Reasoning tokens" value={data.totals.totalReasoningTokens} />
        <TotalsCard label="Cache read tokens" value={data.totals.totalCacheReadInputTokens} />
        <TotalsCard label="Cache write tokens" value={data.totals.totalCacheWriteInputTokens} />
        <TotalsCard
          label="Provider execution time"
          value={data.totals.totalProviderExecutionDurationMs}
          suffix=" ms"
        />
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
        <p className="usage-dashboard__empty" role="status">
          No usage records match the selected filters.
        </p>
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
            <div className="usage-dashboard__section">
              <h3>By provider</h3>
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
            </div>
          ) : null}

          {data.byCategory.length > 0 ? (
            <div className="usage-dashboard__section">
              <h3>By category</h3>
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
            </div>
          ) : null}
        </>
      )}

      <UsageControls
        onExportCsv={() => setConfirmAction({ kind: "export", format: "csv" })}
        onExportJson={() => setConfirmAction({ kind: "export", format: "json" })}
        onReset={() => setConfirmAction({ kind: "reset" })}
        onRetain={() => setConfirmAction({ kind: "retain" })}
        {...(actionMessage ? { message: actionMessage } : {})}
      />

      <p className="usage-dashboard__footer">
        Queried at {new Date(data.queryAt).toLocaleString()}
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

interface UsageFiltersProps {
  readonly filter: UsageQueryFilter;
  readonly onChange: (filter: UsageQueryFilter) => void;
}

function UsageFilters({ filter, onChange }: UsageFiltersProps) {
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
    <div className="usage-dashboard__filters" role="group" aria-label="Usage filters">
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
        <OctantNativeSelect
          aria-label="Filter by mode"
          className="usage-dashboard__select select window-no-drag"
          onChange={(event) =>
            update(
              "mode",
              event.currentTarget.value === ""
                ? undefined
                : (event.currentTarget.value as UsageQueryFilter["mode"]),
            )
          }
          value={filter.mode ?? ""}
        >
          {MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </OctantNativeSelect>
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
            onChange({ ...filter, subjectAggregateType: "chat-thread", subjectAggregateId: value });
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
        <OctantNativeSelect
          aria-label="Filter by measurement quality"
          className="usage-dashboard__select select window-no-drag"
          onChange={(event) =>
            update(
              "quality",
              event.currentTarget.value === ""
                ? undefined
                : (event.currentTarget.value as UsageQueryFilter["quality"]),
            )
          }
          value={filter.quality ?? ""}
        >
          {QUALITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </OctantNativeSelect>
      </label>
      <label className="usage-dashboard__field">
        <span>Category</span>
        <OctantNativeSelect
          aria-label="Filter by context category"
          className="usage-dashboard__select select window-no-drag"
          onChange={(event) =>
            update(
              "category",
              event.currentTarget.value === ""
                ? undefined
                : (event.currentTarget.value as ContextEntryCategory),
            )
          }
          value={filter.category ?? ""}
        >
          <option value="">All categories</option>
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </OctantNativeSelect>
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
    <div className="usage-dashboard__section">
      <div className="usage-dashboard__section-header">
        <h3>Activity</h3>
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
    </div>
  );
}

function TopConsumersSection({
  consumers,
}: {
  readonly consumers: ReadonlyArray<UsageTopConsumer>;
}) {
  return (
    <div className="usage-dashboard__section">
      <h3>Top consumers</h3>
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
    </div>
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
      <OctantButton onClick={props.onExportCsv} type="button">
        <Download aria-hidden="true" size={14} /> Export CSV
      </OctantButton>
      <OctantButton onClick={props.onExportJson} type="button">
        <Download aria-hidden="true" size={14} /> Export JSON
      </OctantButton>
      <OctantButton onClick={props.onRetain} type="button">
        <Eraser aria-hidden="true" size={14} /> Purge older than 30 days
      </OctantButton>
      <OctantButton onClick={props.onReset} type="button">
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
        <OctantButton onClick={onCancel} type="button" variant="outline">
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

function TotalsCard(props: {
  readonly label: string;
  readonly value: number | undefined;
  readonly suffix?: string;
}) {
  return (
    <OctantCard className="usage-dashboard__total-card grid min-w-0 gap-[3px] p-3">
      <span className="usage-dashboard__total-value">
        {props.value === undefined
          ? "Unavailable"
          : `${formatNumber(props.value)}${props.suffix ?? ""}`}
      </span>
      <span className="usage-dashboard__total-label">{props.label}</span>
    </OctantCard>
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
