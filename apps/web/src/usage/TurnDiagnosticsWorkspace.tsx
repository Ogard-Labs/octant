import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  DiagnosticsPercentiles,
  OctantMode,
  ProviderInstance,
  TurnDiagnosticsBucketSize,
  TurnDiagnosticsReport,
  TurnFailureFacts,
  TurnStopReason,
  UsageQueryFilter,
} from "@octant/contracts";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import { Copy, RefreshCw } from "lucide-react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { Surface, SurfaceEmpty, SurfaceHeader, SurfaceSection } from "../surface/SurfaceHeader";
import { HostHealthSection } from "./HostHealthSection";
import { UsageName } from "./UsageName";
import "./usageWorkspace.css";
import "./turnDiagnostics.css";

export interface TurnDiagnosticsWorkspaceProps {
  /** `hostHealth` adds the Host health section; without it the section is left out. */
  readonly client: Pick<UsageClient, "diagnostics"> & Partial<Pick<UsageClient, "hostHealth">>;
  readonly providers?: ReadonlyArray<ProviderInstance>;
  readonly sourceControl?: ReactNode;
  readonly onBack?: () => void;
  /** Opens the thread a troubled turn belongs to. */
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
  /** Places day boundaries; defaults to the viewer's zone. */
  readonly timeZone?: string;
  /** Writes the report for offline analysis; defaults to the clipboard. */
  readonly copyText?: (text: string) => Promise<void>;
  readonly now?: () => number;
  /**
   * Inside another page (Settings): no page title or back button, and the
   * source control, copy, and refresh sit in one row above the filters.
   */
  readonly embedded?: boolean;
}

/** The zone every time on the page is written in, the same one day buckets use. */
const TimeZoneContext = createContext("UTC");

function useWhen(): (timestamp: string) => string {
  const timeZone = useContext(TimeZoneContext);
  return (timestamp) => formatWhen(timestamp, timeZone);
}

function formatWhen(timestamp: string, timeZone: string): string {
  try {
    return new Date(timestamp).toLocaleString(undefined, { timeZone });
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

type RangePreset = "24h" | "7d" | "30d" | "90d" | "all";

const RANGE_PRESETS: ReadonlyArray<{ readonly id: RangePreset; readonly label: string }> = [
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "all", label: "All recorded turns" },
];

const RANGE_MS: Readonly<Record<Exclude<RangePreset, "all">, number>> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

const STOP_WORDS: Readonly<Record<TurnStopReason, string>> = {
  "end-of-turn": "Finished",
  "max-tokens": "Cut at output limit",
  cancelled: "Stopped",
  failed: "Failed",
  waiting: "Left waiting",
};

const CATEGORY_WORDS: Readonly<Record<TurnFailureFacts["category"], string>> = {
  unavailable: "Provider unavailable",
  unauthenticated: "Not signed in",
  incompatible: "Incompatible runtime",
  unsupported: "Unsupported request",
  unauthorized: "Not authorized",
  interrupted: "Interrupted",
  "stale-resume": "Could not resume session",
  "invalid-configuration": "Invalid configuration",
  protocol: "Protocol error",
  "rate-limited": "Rate limited",
  "provider-failed": "Provider failed",
};

const PROCESS_WORDS: Readonly<Record<NonNullable<TurnFailureFacts["process"]>["kind"], string>> = {
  "spawn-failed": "could not start",
  exited: "exited",
  signaled: "was killed",
  "timed-out": "timed out",
  "version-mismatch": "wrong version",
  "confinement-denied": "blocked by the sandbox",
  "protocol-failed": "protocol broke",
  "authentication-failed": "sign-in failed",
  "cleanup-unconfirmed": "cleanup unconfirmed",
};

const RETRY_WORDS = {
  "rate-limited": "Rate limited",
  unavailable: "Endpoint unavailable",
  "stream-interrupted": "Stream broke off",
  "empty-completion": "Empty reply",
} as const;

const SUBJECT_TYPE: Readonly<Record<OctantMode, string>> = {
  chat: "chat-thread",
  work: "work-thread",
  code: "code-thread",
};

type DiagnosticsRequest = Parameters<UsageClient["diagnostics"]>[0];

type LoadState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly report: TurnDiagnosticsReport;
      // The request the report was read for, so a changed query can tell the
      // figures on screen belong to the previous one.
      readonly request: DiagnosticsRequest;
    }
  | { readonly status: "failure"; readonly message: string };

/**
 * How turns went across every provider and mode: what failed and why, which
 * tools break, where retries and rate limits cost time, which turns probably
 * missed the prompt cache, and how fast each model answers. The host builds
 * every figure; the window only words them. A figure no turn measured reads
 * as unavailable rather than zero.
 */
export function TurnDiagnosticsWorkspace(props: TurnDiagnosticsWorkspaceProps) {
  const timeZone = props.timeZone ?? resolveTimeZone();
  const now = props.now ?? Date.now;
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [bucket, setBucket] = useState<TurnDiagnosticsBucketSize>("day");
  const [filter, setFilter] = useState<{ mode?: OctantMode; providerInstanceId?: string }>({});
  // The moment a relative range is measured back from: set when the range is
  // chosen or the page is refreshed, so a re-render never moves the window.
  const [anchor, setAnchor] = useState(() => now());
  // Counts explicit refreshes, so Retry asks again even when the clock has not moved.
  const [reads, setReads] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  const request = useMemo(() => {
    const range =
      preset === "all" ? {} : { from: new Date(anchor - RANGE_MS[preset]).toISOString() };
    return {
      filter: { ...filter, ...range } as UsageQueryFilter,
      bucket,
      timeZone,
    };
  }, [preset, bucket, filter, timeZone, anchor, reads]);
  const refresh = () => {
    setAnchor(now());
    setReads((count) => count + 1);
  };

  useEffect(() => {
    let current = true;
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    props.client.diagnostics(request).then(
      (report) => {
        if (current) setState({ status: "ready", report, request });
      },
      (error: unknown) => {
        if (current) {
          setState({
            status: "failure",
            message: error instanceof Error ? error.message : "Diagnostics could not be loaded.",
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [props.client, request]);

  const report = state.status === "ready" ? state.report : undefined;
  // While a changed query loads, the previous report stays on screen so the page
  // does not jump, but it is marked as old and cannot be copied as the answer.
  const updating = state.status === "ready" && state.request !== request;
  // A copy result describes the report it copied; asking for another reading
  // replaces it, even when the host answers with the same figures.
  useEffect(() => setCopied("idle"), [request]);

  const copyReport = useCallback(async () => {
    if (report === undefined) return;
    const write =
      props.copyText ??
      ((text: string) =>
        navigator.clipboard === undefined
          ? Promise.reject(new Error("Clipboard unavailable"))
          : navigator.clipboard.writeText(text));
    try {
      await write(JSON.stringify(report, null, 2));
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }, [props.copyText, report]);

  const filtered = filter.mode !== undefined || filter.providerInstanceId !== undefined;
  const actions = (
    <>
      {props.sourceControl}
      <OctantButton
        aria-label="Copy diagnostics report as JSON"
        disabled={report === undefined || updating}
        onClick={() => void copyReport()}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Copy aria-hidden="true" size={14} />
      </OctantButton>
      <OctantButton
        aria-label="Refresh diagnostics"
        onClick={refresh}
        size="icon"
        type="button"
        variant="ghost"
      >
        <RefreshCw aria-hidden="true" size={14} />
      </OctantButton>
    </>
  );
  const zoneWords = `Days and times in ${timeZone}, hours in UTC`;
  const body = (
    <TimeZoneContext.Provider value={timeZone}>
      {props.embedded === true ? (
        <div className="turn-diagnostics__toolbar">
          {actions}
          <span className="usage-workspace__note">{zoneWords}</span>
        </div>
      ) : (
        <SurfaceHeader
          actions={actions}
          {...(props.onBack === undefined ? {} : { onBack: props.onBack })}
          detail={filtered ? `Filtered · ${zoneWords}` : `Every provider and mode · ${zoneWords}`}
          title="Diagnostics"
        />
      )}

      <div aria-label="Diagnostics filters" className="usage-workspace__filters" role="group">
        <label className="usage-workspace__field">
          <span>Range</span>
          <OctantSelectField
            aria-label="Diagnostics range"
            onValueChange={(value) => {
              setPreset(value as RangePreset);
              refresh();
            }}
            options={RANGE_PRESETS}
            value={preset}
          />
        </label>
        <label className="usage-workspace__field">
          <span>Mode</span>
          <OctantSelectField
            aria-label="Filter diagnostics by mode"
            onValueChange={(value) =>
              setFilter((previous) => withField(previous, "mode", value as OctantMode | ""))
            }
            options={[
              { id: "", label: "All modes" },
              { id: "chat", label: "Chat" },
              { id: "work", label: "Work" },
              { id: "code", label: "Code" },
            ]}
            value={filter.mode ?? ""}
          />
        </label>
        <label className="usage-workspace__field">
          <span>Provider</span>
          <OctantSelectField
            aria-label="Filter diagnostics by provider"
            onValueChange={(value) =>
              setFilter((previous) => withField(previous, "providerInstanceId", value))
            }
            options={[
              { id: "", label: "All providers" },
              ...(props.providers ?? []).map((provider) => ({
                id: String(provider.id),
                label: provider.displayName,
              })),
            ]}
            value={filter.providerInstanceId ?? ""}
          />
        </label>
        <label className="usage-workspace__field">
          <span>Trend by</span>
          <OctantSelectField
            aria-label="Diagnostics trend bucket"
            onValueChange={(value) => setBucket(value as TurnDiagnosticsBucketSize)}
            options={[
              { id: "day", label: "Day" },
              { id: "hour", label: "Hour" },
            ]}
            value={bucket}
          />
        </label>
      </div>

      <p aria-live="polite" className="usage-workspace__status" role="status">
        {state.status === "loading"
          ? "Loading diagnostics…"
          : state.status === "failure"
            ? "Diagnostics could not be loaded."
            : updating
              ? "Updating… figures shown are for the previous filters."
              : copied === "copied"
                ? "Report copied as JSON."
                : copied === "failed"
                  ? "The report could not be copied."
                  : `Read at ${formatWhen(state.report.generatedAt, timeZone)}.`}
      </p>

      {state.status === "failure" ? (
        <OctantAlert tone="warning">
          <p>{state.message}</p>
          <OctantButton onClick={refresh} type="button">
            Retry
          </OctantButton>
        </OctantAlert>
      ) : null}

      {report === undefined ? null : report.turns === 0 ? (
        <SurfaceEmpty
          detail="Turns are recorded when they end, on every provider. Widen the range or clear a filter."
          title="No turns in this range"
        />
      ) : (
        <ReportSections
          report={report}
          stale={updating}
          {...(props.onOpenSubject === undefined ? {} : { onOpenSubject: props.onOpenSubject })}
        />
      )}
      {props.client.hostHealth === undefined ? null : (
        <HostHealthSection
          client={{ hostHealth: props.client.hostHealth.bind(props.client) }}
          from={request.filter.from}
          readKey={request}
          when={(timestamp) => formatWhen(timestamp, timeZone)}
        />
      )}
    </TimeZoneContext.Provider>
  );
  return props.embedded === true ? (
    <section
      aria-label="Diagnostics"
      className="usage-workspace turn-diagnostics"
      data-embedded="true"
    >
      {body}
    </section>
  ) : (
    <Surface ariaLabel="Diagnostics">
      <div className="usage-workspace turn-diagnostics">{body}</div>
    </Surface>
  );
}

function ReportSections(props: {
  readonly report: TurnDiagnosticsReport;
  readonly stale?: boolean;
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
}) {
  const { report } = props;
  return (
    <div aria-busy={props.stale === true} data-stale={props.stale === true ? "true" : undefined}>
      <SummarySection report={report} />
      <TrendSection report={report} />
      <ModelSection report={report} />
      <FailureSection report={report} />
      <ToolSection report={report} />
      <PressureSection report={report} />
      <TroubledTurnSection
        report={report}
        {...(props.onOpenSubject === undefined ? {} : { onOpenSubject: props.onOpenSubject })}
      />
      <CacheMissSection report={report} />
      {report.diagnosedTurns < report.turns ? (
        <p className="usage-workspace__footer" role="note">
          {report.turns - report.diagnosedTurns} of {report.turns} turns were recorded before tool,
          retry, and failure counts existed. They count toward how turns ended and their speed, not
          toward tool or retry totals.
        </p>
      ) : null}
    </div>
  );
}

function SummarySection({ report }: { readonly report: TurnDiagnosticsReport }) {
  const { totals } = report;
  const stopped = totals.stopReasons;
  return (
    <SurfaceSection label="Summary">
      <dl className="usage-workspace__totals">
        <Figure label="Turns" value={report.turns.toLocaleString("en")} />
        <Figure label="Failed" value={countAndShare(stopped.failed, report.turns)} />
        <Figure label="Stopped" value={countAndShare(stopped.cancelled, report.turns)} />
        <Figure
          label="Cut at output limit"
          value={countAndShare(stopped["max-tokens"], report.turns)}
        />
        <Figure
          label="Tool failures"
          value={countAndShare(totals.toolFailures, totals.toolCalls, "calls")}
        />
        <Figure
          label="Retries"
          value={totals.retries.reduce((sum, tally) => sum + tally.count, 0).toLocaleString("en")}
        />
        <Figure label="Likely cache misses" value={totals.likelyCacheMisses.toLocaleString("en")} />
        <Figure label="First token, typical" value={milliseconds(totals.timeToFirstTokenMs?.p50)} />
        <Figure
          label="First token, slow (p95)"
          value={milliseconds(totals.timeToFirstTokenMs?.p95)}
        />
        <Figure label="Speed, typical" value={rate(totals.decodeTokensPerSecond?.p50)} />
        <Figure label="Turn length, typical" value={milliseconds(totals.wallMs?.p50)} />
        <Figure label="Turn length, slow (p95)" value={milliseconds(totals.wallMs?.p95)} />
      </dl>
    </SurfaceSection>
  );
}

/**
 * Turns per bucket as bars, with failed and stopped turns as a marked segment
 * at the base. The table beside it carries the same readings, so nothing is
 * told by colour or height alone.
 */
function TrendSection({ report }: { readonly report: TurnDiagnosticsReport }) {
  const maximum = Math.max(1, ...report.trend.map((bucket) => bucket.turns));
  const label = report.bucket === "hour" ? "hour" : "day";
  return (
    <SurfaceSection label={`Turns by ${label}`}>
      <figure className="turn-diagnostics__trend">
        <ul aria-hidden="true" className="turn-diagnostics__bars">
          {report.trend.map((bucket) => {
            const troubled = bucket.failed + bucket.cancelled;
            return (
              <li
                className="turn-diagnostics__bar"
                key={bucket.key}
                style={{ height: `${Math.max(4, (bucket.turns / maximum) * 100)}%` }}
                title={`${bucketWords(bucket.key)} · ${bucket.turns} turns · ${bucket.failed} failed · ${bucket.cancelled} stopped`}
              >
                <span
                  className="turn-diagnostics__bar-troubled"
                  style={{ height: `${(troubled / bucket.turns) * 100}%` }}
                />
              </li>
            );
          })}
        </ul>
        <figcaption className="turn-diagnostics__legend">
          <span className="turn-diagnostics__swatch" data-kind="ok" /> Finished or cut off
          <span className="turn-diagnostics__swatch" data-kind="troubled" /> Failed or stopped
        </figcaption>
      </figure>
      <details className="turn-diagnostics__details">
        <summary>Show as a table</summary>
        <div className="usage-table-scroll">
          <table aria-label={`Turns by ${label}`} className="usage-table">
            <thead>
              <tr>
                <th scope="col">{label === "hour" ? "Hour (UTC)" : "Day"}</th>
                <th scope="col">Turns</th>
                <th scope="col">Failed</th>
                <th scope="col">Stopped</th>
                <th scope="col">Tool failures</th>
                <th scope="col">Retries</th>
                <th scope="col">First token, typical</th>
                <th scope="col">Speed, typical</th>
              </tr>
            </thead>
            <tbody>
              {report.trend.map((bucket) => (
                <tr key={bucket.key}>
                  <th scope="row">{bucketWords(bucket.key)}</th>
                  <td>{bucket.turns}</td>
                  <td>{bucket.failed}</td>
                  <td>{bucket.cancelled}</td>
                  <td>{countAndShare(bucket.toolFailures, bucket.toolCalls, "calls")}</td>
                  <td>{bucket.retries}</td>
                  <td>{milliseconds(bucket.timeToFirstTokenP50Ms)}</td>
                  <td>{rate(bucket.decodeTokensPerSecondP50)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </SurfaceSection>
  );
}

function ModelSection({ report }: { readonly report: TurnDiagnosticsReport }) {
  return (
    <SurfaceSection label="Benchmarks by model">
      <p className="usage-workspace__note">
        Typical is the median turn (p50) and slow is the 95th percentile. Speed is output tokens
        over the time spent writing them, with tool time taken out. A figure no turn measured reads
        as unavailable.
      </p>
      <div className="usage-table-scroll">
        <table aria-label="Benchmarks by model" className="usage-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Provider</th>
              <th scope="col">Turns</th>
              <th scope="col">Failed</th>
              <th scope="col">Tool failures</th>
              <th scope="col">Retries</th>
              <th scope="col">First token p50 / p95</th>
              <th scope="col">Speed p50 / p95</th>
              <th scope="col">Turn p50 / p95</th>
              <th scope="col">Cache read</th>
              <th scope="col">Likely misses</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {report.models.map((row) => (
              <tr key={`${String(row.providerInstanceId)}/${String(row.modelId)}`}>
                <th scope="row">{String(row.modelId)}</th>
                <td>
                  <UsageName id={String(row.providerInstanceId)} kind="provider" />
                </td>
                <td>{row.turns}</td>
                <td>{countAndShare(row.stopReasons.failed, row.turns)}</td>
                <td>{countAndShare(row.toolFailures, row.toolCalls, "calls")}</td>
                <td>{row.retries}</td>
                <td>{pair(row.timeToFirstTokenMs, milliseconds)}</td>
                <td>{pair(row.decodeTokensPerSecond, rate)}</td>
                <td>{pair(row.wallMs, milliseconds)}</td>
                <td>
                  {row.cache === undefined || row.cache.inputTokens === 0
                    ? "Not reported"
                    : percent(Math.min(1, row.cache.readTokens / row.cache.inputTokens))}
                </td>
                <td>{row.likelyCacheMisses}</td>
                <td>{row.costUsd === undefined ? "Not reported" : dollars(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SurfaceSection>
  );
}

function FailureSection({ report }: { readonly report: TurnDiagnosticsReport }) {
  const when = useWhen();
  const unexplained =
    report.totals.stopReasons.failed -
    report.failureGroups.reduce((sum, group) => sum + group.count, 0);
  return (
    <SurfaceSection label="Failures by cause">
      {report.failureGroups.length === 0 ? (
        <p className="usage-workspace__note">No provider reported a failure in this range.</p>
      ) : (
        <div className="usage-table-scroll">
          <table aria-label="Failures by cause" className="usage-table">
            <thead>
              <tr>
                <th scope="col">Cause</th>
                <th scope="col">Turns</th>
                <th scope="col">First</th>
                <th scope="col">Latest</th>
                <th scope="col">Latest message</th>
              </tr>
            </thead>
            <tbody>
              {report.failureGroups.map((group) => (
                <tr key={`${group.category}/${group.processKind ?? ""}`}>
                  <th scope="row">
                    {CATEGORY_WORDS[group.category]}
                    {group.processKind === undefined
                      ? ""
                      : ` · process ${PROCESS_WORDS[group.processKind]}`}
                  </th>
                  <td>{group.count}</td>
                  <td>{when(group.firstAt)}</td>
                  <td>{when(group.lastAt)}</td>
                  <td className="turn-diagnostics__message">
                    {group.lastMessage ?? "No message kept"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unexplained > 0 ? (
        <p className="usage-workspace__note">
          {unexplained} failed turn{unexplained === 1 ? "" : "s"} ended before the provider gave a
          reason, or were recorded before reasons were kept.
        </p>
      ) : null}
    </SurfaceSection>
  );
}

function ToolSection({ report }: { readonly report: TurnDiagnosticsReport }) {
  if (report.tools.length === 0) return null;
  return (
    <SurfaceSection label="Tools">
      <p className="usage-workspace__note">
        Most failures first. Unfinished calls started and never reported a result before their turn
        ended. Times cover calls that finished.
      </p>
      {(report.totals.toolTalliesTruncatedTurns ?? 0) > 0 ? (
        <p className="usage-workspace__note" role="note">
          Tool figures are partial: {report.totals.toolTalliesTruncatedTurns} turn
          {report.totals.toolTalliesTruncatedTurns === 1 ? "" : "s"} ran more tools than were kept
          per turn, so the per-tool rows and unfinished calls leave out the least-called ones. Call
          and failure totals are complete.
        </p>
      ) : null}
      <div className="usage-table-scroll">
        <table aria-label="Tool reliability" className="usage-table">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Calls</th>
              <th scope="col">Failed</th>
              <th scope="col">Unfinished</th>
              <th scope="col">Non-zero exits</th>
              <th scope="col">Average</th>
              <th scope="col">Longest</th>
              <th scope="col">Turns</th>
            </tr>
          </thead>
          <tbody>
            {report.tools.map((tool) => {
              const finished = tool.calls - tool.unfinished;
              return (
                <tr key={tool.toolName}>
                  <th scope="row">{tool.toolName}</th>
                  <td>{tool.calls.toLocaleString("en")}</td>
                  <td>{countAndShare(tool.failed, tool.calls)}</td>
                  <td>{tool.unfinished}</td>
                  <td>{tool.nonZeroExits}</td>
                  <td>{finished > 0 ? milliseconds(tool.totalMs / finished) : "Unavailable"}</td>
                  <td>{finished > 0 ? milliseconds(tool.maxMs) : "Unavailable"}</td>
                  <td>{tool.turns}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SurfaceSection>
  );
}

function PressureSection({ report }: { readonly report: TurnDiagnosticsReport }) {
  const { totals } = report;
  return (
    <SurfaceSection label="Retries, limits, and waits">
      <dl className="usage-workspace__totals">
        {totals.retries.map((tally) => (
          <Figure
            key={tally.reason}
            label={`Retries · ${RETRY_WORDS[tally.reason]}`}
            value={`${tally.count.toLocaleString("en")} · waited ${milliseconds(tally.waitMs)}`}
          />
        ))}
        <Figure label="Rate-limit warnings" value={totals.rateLimitWarnings.toLocaleString("en")} />
        <Figure
          label="Turns that ran out of allowance"
          value={totals.rateLimitExhaustedTurns.toLocaleString("en")}
        />
        <Figure label="Approval requests" value={totals.approvalRequests.toLocaleString("en")} />
        <Figure label="Questions asked" value={totals.inputRequests.toLocaleString("en")} />
        <Figure label="Runtime compactions" value={totals.compactions.toLocaleString("en")} />
        <Figure
          label="Content-filter stops"
          value={totals.contentFilterStops.toLocaleString("en")}
        />
        <Figure
          label="Tool calls left unfinished"
          value={totals.unfinishedToolCalls.toLocaleString("en")}
        />
      </dl>
    </SurfaceSection>
  );
}

function TroubledTurnSection(props: {
  readonly report: TurnDiagnosticsReport;
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
}) {
  const when = useWhen();
  const turns = props.report.troubledTurns;
  if (turns.length === 0) return null;
  return (
    <SurfaceSection label="Turns to investigate">
      <p className="usage-workspace__note">
        The newest turns that failed, were stopped, were cut off, had a tool fail, or retried. Open
        one to read its transcript.
      </p>
      <div className="usage-table-scroll">
        <table aria-label="Turns to investigate" className="usage-table">
          <thead>
            <tr>
              <th scope="col">Ended</th>
              <th scope="col">Thread</th>
              <th scope="col">Model</th>
              <th scope="col">Outcome</th>
              <th scope="col">Reason</th>
              <th scope="col">Tool failures</th>
              <th scope="col">Retries</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {turns.map((turn, index) => {
              const subjectType = SUBJECT_TYPE[turn.mode];
              return (
                <tr key={`${turn.threadId}/${turn.endedAt}/${index}`}>
                  <th scope="row">{when(turn.endedAt)}</th>
                  <td>
                    <UsageName id={turn.threadId} kind={subjectType} />
                  </td>
                  <td>{String(turn.modelId)}</td>
                  <td>{STOP_WORDS[turn.stopReason]}</td>
                  <td className="turn-diagnostics__message">{failureWords(turn.failure)}</td>
                  <td>{turn.toolFailures}</td>
                  <td>{turn.retries}</td>
                  <td>
                    {props.onOpenSubject === undefined ? null : (
                      <OctantButton
                        aria-label={`Open the thread of the turn that ended ${when(turn.endedAt)}`}
                        onClick={() => props.onOpenSubject?.(subjectType, turn.threadId)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Open
                      </OctantButton>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SurfaceSection>
  );
}

function CacheMissSection({ report }: { readonly report: TurnDiagnosticsReport }) {
  const when = useWhen();
  if (report.cacheMisses.length === 0) return null;
  return (
    <SurfaceSection label="Likely prompt-cache misses">
      <p className="usage-workspace__note">
        A turn that followed a cached turn in the same thread within five minutes, sent a large
        prompt, and read nothing from the cache. This is a likelihood, not a provider report: a
        changed instruction or tool list also starts a new cache.
      </p>
      <div className="usage-table-scroll">
        <table aria-label="Likely prompt-cache misses" className="usage-table">
          <thead>
            <tr>
              <th scope="col">Ended</th>
              <th scope="col">Thread</th>
              <th scope="col">Model</th>
              <th scope="col">Input tokens</th>
              <th scope="col">Gap after previous turn</th>
            </tr>
          </thead>
          <tbody>
            {report.cacheMisses.map((miss, index) => (
              <tr key={`${miss.threadId}/${miss.endedAt}/${index}`}>
                <th scope="row">{when(miss.endedAt)}</th>
                <td>
                  <UsageName id={miss.threadId} kind="thread" />
                </td>
                <td>{String(miss.modelId)}</td>
                <td>{miss.inputTokens.toLocaleString("en")}</td>
                <td>{milliseconds(miss.gapMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SurfaceSection>
  );
}

function Figure(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="usage-workspace__total">
      <dt>{props.label}</dt>
      <dd data-unavailable={props.value === "Unavailable" ? "true" : "false"}>{props.value}</dd>
    </div>
  );
}

function withField<K extends "mode" | "providerInstanceId">(
  previous: { mode?: OctantMode; providerInstanceId?: string },
  key: K,
  value: string,
): { mode?: OctantMode; providerInstanceId?: string } {
  const next = { ...previous };
  if (value === "") delete next[key];
  else Object.assign(next, { [key]: value });
  return next;
}

function failureWords(failure: TurnFailureFacts | undefined): string {
  if (failure === undefined) return "—";
  const process =
    failure.process === undefined
      ? ""
      : ` · process ${PROCESS_WORDS[failure.process.kind]}${
          failure.process.exitCode === undefined ? "" : ` (exit ${failure.process.exitCode})`
        }${failure.process.signal === undefined ? "" : ` (${failure.process.signal})`}`;
  const message = failure.message === undefined ? "" : ` · ${failure.message}`;
  return `${CATEGORY_WORDS[failure.category]}${process}${message}`;
}

function countAndShare(count: number, of: number, unit?: string): string {
  if (of === 0) return unit === undefined ? "0" : `0 of 0 ${unit}`;
  const share = percent(count / of);
  return unit === undefined
    ? `${count.toLocaleString("en")} · ${share}`
    : `${count.toLocaleString("en")} of ${of.toLocaleString("en")} ${unit} · ${share}`;
}

function percent(ratio: number): string {
  if (ratio > 0 && ratio < 0.01) return "<1%";
  return `${Math.round(ratio * 100)}%`;
}

export function milliseconds(value: number | undefined): string {
  if (value === undefined) return "Unavailable";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes} min ${seconds} s`;
}

function rate(value: number | undefined): string {
  return value === undefined ? "Unavailable" : `${value.toLocaleString("en")} tok/s`;
}

function pair(
  value: DiagnosticsPercentiles | undefined,
  format: (value: number | undefined) => string,
): string {
  return value === undefined ? "Unavailable" : `${format(value.p50)} / ${format(value.p95)}`;
}

function dollars(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function bucketWords(key: string): string {
  return key.length > 10 ? `${key.slice(0, 10)} ${key.slice(11, 16)}` : key;
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
