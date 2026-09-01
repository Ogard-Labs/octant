import { useMemo, useState } from "react";
import type {
  UsageAttributionDimension,
  UsageBreakdownGroup,
  UsageCacheStats,
  UsageDashboardResponse,
  UsageDetailRow,
  UsageDimensionSource,
  UsageHostCoverage,
  UsageQuality,
  UsageQueryFilter,
} from "@octant/contracts";
import type { UsageDashboardClient } from "@octant/client-runtime";
import { AlertTriangle, ArrowLeft, BarChart3, RefreshCw } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { UsageActivityHeatmap } from "./UsageActivityHeatmap";
import { LatencyStatsSection } from "./LatencyStatsSection";
import { useUsageDashboardController } from "./useUsageDashboardController";
import "./usageWorkspace.css";

export interface UsageWorkspaceProps {
  readonly client: UsageDashboardClient | undefined;
  /** Pre-applied filter, used when the surface is opened from a thread. */
  readonly initialFilter?: UsageQueryFilter;
  readonly isNarrow?: boolean;
  /** Opens the subject the row attributes usage to, without embedding its text. */
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
  /**
   * Returns to the surface this dashboard replaced. Without it the standalone
   * mount has no way back, so hosts that swap their whole chrome for this
   * surface must supply it.
   */
  readonly onBack?: () => void;
}

type RangePreset = "7d" | "30d" | "90d" | "all";

const VIEWING_TIME_ZONE = resolveTimeZone();

const RANGE_PRESETS: ReadonlyArray<{ readonly value: RangePreset; readonly label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All recorded usage" },
];

const QUALITY_WORDS: Readonly<Record<UsageQuality, string>> = {
  exact: "Exact",
  estimated: "Estimated",
  reconciled: "Reconciled",
  stale: "Stale",
  unavailable: "Unavailable",
};

const DIMENSION_WORDS: Readonly<Record<UsageAttributionDimension, string>> = {
  provider: "Provider instance",
  model: "Model",
  host: "Host",
  mode: "Mode",
  project: "Project",
  thread: "Thread",
  "request-shape": "Request shape",
  "context-category": "Context category",
  component: "Skill, plugin, tool, and MCP component",
  cost: "Monetary cost",
};

const SOURCE_STATUS_WORDS = {
  recorded: "Recorded",
  partial: "Partly recorded",
  unavailable: "Not recorded",
} as const;

/**
 * The shared global Usage destination.
 *
 * The surface is analytical only: it reads one host-built projection and shows
 * what that host can attribute, while retention, export, and reset stay in
 * Settings so a reading task cannot become a destructive one by mis-click. Every
 * total, bucket, and breakdown row arrives finished from the host — the renderer
 * neither sums nor estimates — and a dimension the host cannot source is stated
 * as unavailable rather than shown as zero.
 */
export function UsageWorkspace(props: UsageWorkspaceProps) {
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [filter, setFilter] = useState<UsageQueryFilter>(props.initialFilter ?? {});

  const request = useMemo(() => {
    const range = rangeFor(preset);
    const merged: Record<string, unknown> = { ...filter, ...range };
    // A pre-applied filter may already end before the preset window begins; the
    // host rejects an inverted range, so the caller's explicit end date wins.
    if (
      typeof merged.from === "string" &&
      typeof merged.to === "string" &&
      merged.from > merged.to
    ) {
      delete merged.from;
    }
    return {
      filter: merged as UsageQueryFilter,
      timeZone: VIEWING_TIME_ZONE,
    };
  }, [filter, preset]);

  const controller = useUsageDashboardController({ client: props.client, request });
  const dashboard = controller.dashboard;

  return (
    <section aria-label="Usage" className="usage-workspace">
      <header className="usage-workspace__header">
        {props.onBack === undefined ? null : (
          <OctantButton
            className="usage-workspace__back"
            onClick={props.onBack}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Back to app</span>
          </OctantButton>
        )}
        <h2 className="usage-workspace__title">
          <BarChart3 aria-hidden="true" size={16} /> Usage
        </h2>
        <p className="usage-workspace__subtitle">
          Operational token attribution for this host, in {VIEWING_TIME_ZONE}.
        </p>
        <OctantButton
          aria-label="Refresh usage"
          onClick={controller.reload}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} />
        </OctantButton>
      </header>

      <UsageWorkspaceFilters
        filter={filter}
        onFilterChange={setFilter}
        onPresetChange={setPreset}
        preset={preset}
      />

      <p aria-live="polite" className="usage-workspace__status" role="status">
        {statusMessage(controller.status, controller.stale)}
      </p>

      {controller.status === "unauthorized" ||
      controller.status === "unavailable" ||
      controller.status === "failure" ? (
        <div className="usage-workspace__error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <p>{controller.errorMessage ?? "The usage dashboard could not be loaded."}</p>
          <OctantButton onClick={controller.reload} type="button">
            Retry
          </OctantButton>
        </div>
      ) : null}

      {dashboard === undefined ? null : (
        <>
          {controller.stale ? (
            <p aria-label="Stale usage" className="usage-workspace__stale" role="note">
              These figures are this host's last successful read of the same query, at{" "}
              {new Date(dashboard.queryAt).toLocaleString()}. The latest read failed, so newer usage
              may be missing.
            </p>
          ) : null}
          <SummarySection dashboard={dashboard} />
          <UsageActivityHeatmap
            cells={dashboard.activity}
            timeZone={dashboard.timeZone}
            truncated={dashboard.activityTruncated}
          />
          {dashboard.summary.totals.totalRequests === 0 ? (
            <EmptySection scanTruncated={dashboard.scanTruncated} />
          ) : (
            <>
              <BreakdownSection groups={dashboard.breakdown} isNarrow={props.isNarrow ?? false} />
              <DetailSection
                rows={dashboard.detail}
                truncated={dashboard.detailTruncated}
                {...(props.onOpenSubject === undefined
                  ? {}
                  : { onOpenSubject: props.onOpenSubject })}
              />
            </>
          )}
          <CacheSection stats={dashboard.cacheStats} />
          <HostSection hosts={dashboard.hosts} />
          <AttributionSourceSection sources={dashboard.dimensionSources} />
          <LatencyStatsSection
            className="usage-workspace__section"
            connectionLatencyMs={controller.connectionLatencyMs}
            latencyStats={dashboard.latencyStats}
          />
          <p className="usage-workspace__footer">
            Read from this host at {new Date(dashboard.queryAt).toLocaleString()}. Retention,
            export, and reset live in Settings under Usage and data.
          </p>
        </>
      )}
    </section>
  );
}

function statusMessage(
  status: ReturnType<typeof useUsageDashboardController>["status"],
  stale: boolean,
): string {
  // A failed refresh of the same query has not made usage unreadable; saying so
  // beside the figures it left on screen would contradict them.
  if (stale) return "Usage could not be refreshed, so this is the last successful read.";
  switch (status) {
    case "loading":
      return "Loading usage…";
    case "refreshing":
      return "Refreshing usage…";
    case "ready":
      return "Usage is up to date.";
    case "unauthorized":
      return "Usage is not authorized in this window.";
    case "unavailable":
      return "The host is unreachable, so no usage can be read.";
    case "failure":
      return "Usage could not be loaded.";
    default:
      return "Usage is unavailable in this window.";
  }
}

interface UsageWorkspaceFiltersProps {
  readonly filter: UsageQueryFilter;
  readonly onFilterChange: (filter: UsageQueryFilter) => void;
  readonly onPresetChange: (preset: RangePreset) => void;
  readonly preset: RangePreset;
}

function UsageWorkspaceFilters(props: UsageWorkspaceFiltersProps) {
  const update = (key: "providerInstanceId" | "modelId" | "hostId" | "mode", value: string) => {
    const next = { ...props.filter } as Record<string, unknown>;
    if (value === "") delete next[key];
    else next[key] = value;
    props.onFilterChange(next as UsageQueryFilter);
  };

  return (
    <div aria-label="Usage filters" className="usage-workspace__filters" role="group">
      <label className="usage-workspace__field">
        <span>Range</span>
        <OctantSelectField
          aria-label="Usage range"
          onValueChange={(value) => props.onPresetChange(value as RangePreset)}
          options={RANGE_PRESETS.map((option) => ({
            id: option.value,
            label: option.label,
          }))}
          value={props.preset}
        />
      </label>
      <label className="usage-workspace__field">
        <span>Mode</span>
        <OctantSelectField
          aria-label="Filter usage by mode"
          onValueChange={(value) => update("mode", value)}
          options={[
            { id: "", label: "All modes" },
            { id: "chat", label: "Chat" },
            { id: "work", label: "Work" },
            { id: "code", label: "Code" },
          ]}
          value={props.filter.mode ?? ""}
        />
      </label>
      <label className="usage-workspace__field">
        <span>Provider</span>
        <OctantInput
          aria-label="Filter usage by provider instance id"
          onChange={(event) => update("providerInstanceId", event.currentTarget.value.trim())}
          placeholder="provider instance id"
          type="search"
          value={props.filter.providerInstanceId ?? ""}
        />
      </label>
      <label className="usage-workspace__field">
        <span>Model</span>
        <OctantInput
          aria-label="Filter usage by model id"
          onChange={(event) => update("modelId", event.currentTarget.value.trim())}
          placeholder="model id"
          type="search"
          value={props.filter.modelId ?? ""}
        />
      </label>
      <label className="usage-workspace__field">
        <span>Host</span>
        <OctantInput
          aria-label="Filter usage by host id"
          onChange={(event) => update("hostId", event.currentTarget.value.trim())}
          placeholder="host id"
          type="search"
          value={props.filter.hostId ?? ""}
        />
      </label>
    </div>
  );
}

function SummarySection({ dashboard }: { readonly dashboard: UsageDashboardResponse }) {
  const { summary } = dashboard;
  return (
    <section aria-label="Summary" className="usage-workspace__section">
      <h3>Summary</h3>
      {dashboard.scanTruncated ? (
        <p className="usage-workspace__truncated" role="note">
          This range holds more records than one read returns. Every total below is a floor, not a
          complete figure. Narrow the range or the filters to read the rest.
        </p>
      ) : null}
      <dl className="usage-workspace__totals">
        <TotalItem label="Requests" value={summary.totals.totalRequests} />
        <TotalItem label="Input tokens" value={summary.totals.totalInputTokens} />
        <TotalItem label="Output tokens" value={summary.totals.totalOutputTokens} />
        <TotalItem label="Reasoning tokens" value={summary.totals.totalReasoningTokens} />
        <TotalItem label="Cache read tokens" value={summary.totals.totalCacheReadInputTokens} />
        <TotalItem label="Cache write tokens" value={summary.totals.totalCacheWriteInputTokens} />
        <TotalItem
          label="Provider execution time"
          suffix=" ms"
          value={summary.totals.totalProviderExecutionDurationMs}
        />
        <TotalItem
          label="Requests without reported usage"
          value={summary.requestsWithUnavailableUsage}
        />
      </dl>

      <h4 className="usage-workspace__subheading">Measurement coverage</h4>
      <ul className="usage-workspace__coverage">
        {summary.coverage.map((slice) => (
          <li data-quality={slice.quality} key={slice.quality}>
            <span className="usage-workspace__coverage-label">{QUALITY_WORDS[slice.quality]}</span>
            <span className="usage-workspace__coverage-count">
              {slice.requestCount} request{slice.requestCount === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
      <p className="usage-workspace__note">
        Totals mix measurements of different accuracy. Exact, estimated, reconciled, stale, and
        unavailable requests are counted separately above; unavailable usage is never counted as
        zero.
      </p>

      <ul className="usage-workspace__highlights">
        <li>
          Highest-usage day:{" "}
          {summary.peakDay === undefined
            ? "Unavailable"
            : `${summary.peakDay.date} · ${summary.peakDay.totalTokens.toLocaleString()} tokens across ${summary.peakDay.requestCount} request${summary.peakDay.requestCount === 1 ? "" : "s"}`}
        </li>
        <li>
          Highest-usage model:{" "}
          {summary.peakModel === undefined
            ? "Unavailable"
            : `${summary.peakModel.modelId} on ${summary.peakModel.providerInstanceId} · ${summary.peakModel.totalTokens.toLocaleString()} tokens`}
        </li>
        <li>Monetary cost: Unavailable — no reviewed or user-supplied pricing is configured.</li>
      </ul>

      {summary.excludedRecordCount > 0 ? (
        <p className="usage-workspace__excluded" role="note">
          {summary.excludedRecordCount} durable record
          {summary.excludedRecordCount === 1 ? " was" : "s were"} excluded from these totals because
          the host could not read them as consistent measurements.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Cache efficiency for this host.
 *
 * Rates are drawn as meters as well as written out, because a ratio is easier
 * to compare at a glance than to read, and a reader who cannot see the meter
 * still gets the same numbers. Freshness and pacing sit beside the rates: a
 * high hit rate on contents nobody could refresh is not efficiency.
 */
function CacheSection({ stats }: { readonly stats: UsageCacheStats }) {
  if (stats.caches.length === 0 && stats.providerTokenCaches.length === 0) return null;
  const now = Date.now();
  return (
    <section aria-label="Cache efficiency" className="usage-workspace__section">
      <h3>Cache efficiency</h3>
      {stats.caches.length === 0 ? null : (
        <div className="usage-table-scroll">
          <table aria-label="Host cache hit and miss rates" className="usage-table">
            <thead>
              <tr>
                <th scope="col">Cache</th>
                <th scope="col">Hits</th>
                <th scope="col">Misses</th>
                <th scope="col">Hit rate</th>
                <th scope="col">Miss rate</th>
                <th scope="col">Last refresh</th>
                <th scope="col">Refresh pacing</th>
              </tr>
            </thead>
            <tbody>
              {stats.caches.map((cache) => (
                <tr key={cache.key}>
                  <th scope="row">{cache.label}</th>
                  <td>{cache.hitCount.toLocaleString()}</td>
                  <td>{cache.missCount.toLocaleString()}</td>
                  <td>
                    <RateMeter label={`${cache.label} hit rate`} ratio={cache.hitRatio} />
                  </td>
                  <td>
                    <RateMeter
                      label={`${cache.label} miss rate`}
                      ratio={cache.hitRatio === undefined ? undefined : 1 - cache.hitRatio}
                    />
                  </td>
                  <td>{freshnessWords(cache.lastRefreshAt, cache.stalenessMs)}</td>
                  <td>{pacingWords(cache.failureStreak, cache.retryAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4 className="usage-workspace__subheading">Provider prompt cache</h4>
      {stats.providerTokenCaches.length === 0 ? (
        <p className="usage-workspace__note">
          No provider reported prompt-cache tokens in this range, so reuse is unavailable rather
          than zero.
        </p>
      ) : (
        <>
          <p className="usage-workspace__note">
            Reuse across every provider instance in range:{" "}
            <RateMeter label="Token cache hit ratio" ratio={stats.tokenCacheHitRatio} />
          </p>
          <div className="usage-table-scroll">
            <table aria-label="Provider prompt cache reuse" className="usage-table">
              <thead>
                <tr>
                  <th scope="col">Provider instance</th>
                  <th scope="col">Requests</th>
                  <th scope="col">Cache read tokens</th>
                  <th scope="col">Cache write tokens</th>
                  <th scope="col">Reuse</th>
                </tr>
              </thead>
              <tbody>
                {stats.providerTokenCaches.map((provider) => (
                  <tr key={provider.providerInstanceId}>
                    <th scope="row">{provider.providerInstanceId}</th>
                    <td>{provider.requestCount.toLocaleString()}</td>
                    <td>{provider.cacheReadInputTokens.toLocaleString()}</td>
                    <td>{provider.cacheWriteInputTokens.toLocaleString()}</td>
                    <td>
                      <RateMeter
                        label={`${provider.providerInstanceId} prompt cache reuse`}
                        ratio={provider.hitRatio}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="usage-workspace__note">
        Hit and miss counts are what this host has observed since it started, so they begin again
        after a restart. Prompt-cache tokens come from the requests in the selected range.
      </p>
    </section>
  );
}

function RateMeter(props: { readonly label: string; readonly ratio: number | undefined }) {
  if (props.ratio === undefined) return <span data-unavailable="true">Unavailable</span>;
  const percent = `${Math.round(props.ratio * 100)}%`;
  return (
    <>
      <meter aria-label={props.label} max={1} min={0} value={props.ratio} /> <span>{percent}</span>
    </>
  );
}

function freshnessWords(
  lastRefreshAt: string | undefined,
  stalenessMs: number | undefined,
): string {
  if (lastRefreshAt === undefined) return "Never refreshed";
  const age =
    stalenessMs === undefined ? "" : ` · ${Math.round(stalenessMs / 1000).toLocaleString()}s old`;
  return `${new Date(lastRefreshAt).toLocaleString()}${age}`;
}

function pacingWords(failureStreak: number, retryAt: string | undefined, now: number): string {
  if (failureStreak === 0) return "Not paced";
  const streak = `${failureStreak} failure${failureStreak === 1 ? "" : "s"} in a row`;
  if (retryAt === undefined) return `${streak} · next read may retry`;
  const seconds = Math.max(0, Math.round((new Date(retryAt).getTime() - now) / 1000));
  return `${streak} · automatic retry in ${seconds.toLocaleString()}s; refresh still works`;
}

function TotalItem(props: {
  readonly label: string;
  readonly value: number | undefined;
  readonly suffix?: string;
}) {
  return (
    <div className="usage-workspace__total">
      <dt>{props.label}</dt>
      <dd data-unavailable={props.value === undefined ? "true" : "false"}>
        {props.value === undefined
          ? "Unavailable"
          : `${props.value.toLocaleString()}${props.suffix ?? ""}`}
      </dd>
    </div>
  );
}

function EmptySection({ scanTruncated }: { readonly scanTruncated: boolean }) {
  // A capped scan that surfaced nothing readable is not the same as an empty
  // range, and saying so would be a confident false claim about the host's
  // records.
  if (scanTruncated) {
    return (
      <section aria-label="Usage unread" className="usage-workspace__section">
        <p className="usage-workspace__empty" role="note">
          This range holds more records than one read returns, and none of the records read carried
          usage that could be shown. Narrow the range or the filters to read the rest — this is not
          a report that the range is empty.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="No usage" className="usage-workspace__section">
      <p className="usage-workspace__empty" role="note">
        No usage has been recorded for this range. Providers that report token facts populate this
        view after their first reconciled request; a runtime that reports no token details still
        appears here as request activity with usage marked unavailable.
      </p>
    </section>
  );
}

function BreakdownSection(props: {
  readonly groups: ReadonlyArray<UsageBreakdownGroup>;
  readonly isNarrow: boolean;
}) {
  if (props.groups.length === 0) return null;
  return (
    <section aria-label="Breakdown" className="usage-workspace__section">
      <h3>Breakdown</h3>
      {props.groups.map((group) => (
        <div className="usage-workspace__breakdown" key={group.dimension}>
          <h4 className="usage-workspace__subheading">{DIMENSION_WORDS[group.dimension]}</h4>
          <div className="usage-table-scroll">
            <table
              className={`usage-table${props.isNarrow ? " usage-table--narrow" : ""}`}
              aria-label={`Usage by ${DIMENSION_WORDS[group.dimension].toLowerCase()}`}
            >
              <thead>
                <tr>
                  <th scope="col">{DIMENSION_WORDS[group.dimension]}</th>
                  <th scope="col">Requests</th>
                  <th scope="col">Input tokens</th>
                  <th scope="col">Output tokens</th>
                  {group.dimension === "context-category" ? (
                    <th scope="col">Planned tokens</th>
                  ) : null}
                  <th scope="col">Without reported usage</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr data-availability={row.availability} key={`${group.dimension}-${row.key}`}>
                    <th scope="row">{row.label}</th>
                    <td>{row.requestCount}</td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    {group.dimension === "context-category" ? (
                      <td>{(row.plannedTokens ?? 0).toLocaleString()}</td>
                    ) : null}
                    <td>{row.unavailableRequestCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {group.truncated ? (
            <p className="usage-workspace__note">
              Showing the highest-usage rows only; narrow the filters to see the rest.
            </p>
          ) : null}
        </div>
      ))}
      <p className="usage-workspace__note">
        Context category totals describe the planned composition of each request, not
        provider-reported per-category actuals.
      </p>
    </section>
  );
}

function DetailSection(props: {
  readonly rows: ReadonlyArray<UsageDetailRow>;
  readonly truncated: boolean;
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <section aria-label="Request detail" className="usage-workspace__section">
      <h3>Request detail</h3>
      <div className="usage-table-scroll">
        <table aria-label="Usage request detail" className="usage-table">
          <thead>
            <tr>
              <th scope="col">Observed</th>
              <th scope="col">Host</th>
              <th scope="col">Provider</th>
              <th scope="col">Model</th>
              <th scope="col">Mode</th>
              <th scope="col">Project</th>
              <th scope="col">Thread</th>
              <th scope="col">Request shape</th>
              <th scope="col">Measurement</th>
              <th scope="col">Planned input</th>
              <th scope="col">Actual input</th>
              <th scope="col">Output</th>
              <th scope="col">Variance</th>
              <th scope="col">Categories</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.reconciliationId}>
                <th scope="row">{row.observedAt}</th>
                <td>{row.hostId}</td>
                <td>{row.providerInstanceId}</td>
                <td>{row.modelId}</td>
                <td>{row.mode ?? "Unavailable"}</td>
                <td>{row.projectId ?? "Unavailable"}</td>
                <td>
                  {props.onOpenSubject === undefined ? (
                    `${row.subjectType}/${row.subjectId}`
                  ) : (
                    <OctantButton
                      onClick={() => props.onOpenSubject?.(row.subjectType, row.subjectId)}
                      type="button"
                      variant="ghost"
                    >
                      {row.subjectType}/{row.subjectId}
                    </OctantButton>
                  )}
                </td>
                <td>{row.requestShape}</td>
                <td>{QUALITY_WORDS[row.quality]}</td>
                <td>{row.plannedInputTokens.toLocaleString()}</td>
                <td>{row.inputTokens.toLocaleString()}</td>
                <td>{row.outputTokens.toLocaleString()}</td>
                <td>{row.varianceTokens.toLocaleString()}</td>
                <td>
                  {row.attribution.map((entry) => entry.category).join(", ") || "Unavailable"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.truncated ? (
        <p className="usage-workspace__note">
          Showing the most recent requests in this range; narrow the range or filters to see older
          ones.
        </p>
      ) : null}
    </section>
  );
}

function HostSection({ hosts }: { readonly hosts: ReadonlyArray<UsageHostCoverage> }) {
  return (
    <section aria-label="Contributing hosts" className="usage-workspace__section">
      <h3>Contributing hosts</h3>
      {hosts.length === 0 ? (
        <p className="usage-workspace__note" role="note">
          No host contributed usage in this range.
        </p>
      ) : (
        <ul className="usage-workspace__hosts">
          {hosts.map((host) => (
            <li data-status={host.status} key={host.hostId}>
              <span className="usage-workspace__host-id">{host.hostId}</span>
              <span>
                {host.requestCount} request{host.requestCount === 1 ? "" : "s"}
              </span>
              <span>
                {host.status === "stale"
                  ? "Stale · last synchronized "
                  : "Contributing · last seen "}
                {host.lastObservedAt}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="usage-workspace__note">
        This host reports only its own recorded usage. Another host's usage is excluded until
        multi-host composition is authorized, so an absent host is not a host with zero usage.
      </p>
    </section>
  );
}

function AttributionSourceSection({
  sources,
}: {
  readonly sources: ReadonlyArray<UsageDimensionSource>;
}) {
  return (
    <section aria-label="Attribution sources" className="usage-workspace__section">
      <h3>What this host can attribute</h3>
      <dl className="usage-workspace__sources">
        {sources.map((source) => (
          <div data-status={source.status} key={source.dimension}>
            <dt>
              {DIMENSION_WORDS[source.dimension]}
              <span className="usage-workspace__source-status">
                {SOURCE_STATUS_WORDS[source.status]}
              </span>
            </dt>
            <dd>{source.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function rangeFor(preset: RangePreset): Record<string, string> {
  if (preset === "all") return {};
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString() };
}

function resolveTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved === undefined || resolved.trim() === "" ? "UTC" : resolved;
}
