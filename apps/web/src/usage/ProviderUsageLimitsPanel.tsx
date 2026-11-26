import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, RefreshCw } from "../ui/icons";
import type {
  ProviderLimitsCaptureStatus,
  ProviderUsageLimitsClient,
} from "@octant/client-runtime/provider-usage-limits-client";
import type {
  ProviderInstance,
  ProviderServiceLimits,
  ProviderUsageLimitsEntry,
  ProviderUsageLimitsSnapshot,
  ServiceLimitBucket,
} from "@octant/contracts";
import { SurfaceSection } from "../surface/SurfaceHeader";
import { useTimestampFormat } from "../theme/ThemeSettingsProvider";
import { formatDateTime, type TimestampFormatPreference } from "../theme/timestampFormat";
import { OctantButton } from "../ui/base/OctantButton";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { driverLabel } from "../providers/providerSettingsPresentation";
import { poolProviderLimits, type PooledProvider, type PooledWindow } from "./pooledProviderLimits";
import {
  limitForecast,
  outlookPhrase,
  paceDuration,
  type LimitForecast,
  type LimitWindowReading,
} from "./limitPace";
import { UsageInfoMark } from "./UsageInfoMark";
import "../styles/usage.css";

const CAPTURE_POLL_INTERVAL_MS = 2_000;
const CAPTURE_POLL_DURATION_MS = 60_000;

function entryReadingTimestampMs(entry: ProviderUsageLimitsEntry | undefined): number | undefined {
  if (entry === undefined) return undefined;
  const iso =
    entry.status === "available"
      ? entry.limits.updatedAt
      : entry.status === "failed"
        ? (entry.lastSuccessfulAt ?? entry.observedAt)
        : undefined;
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function ProviderUsageLimitsPanel(props: {
  readonly client: ProviderUsageLimitsClient;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly compact?: boolean;
}) {
  const [reading, setReading] = useState<{
    readonly client: ProviderUsageLimitsClient;
    readonly snapshot?: ProviderUsageLimitsSnapshot;
    readonly message?: string;
    readonly busy: boolean;
  }>();
  const sequence = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const current = reading?.client === props.client ? reading : undefined;
  const snapshot = current?.snapshot;
  const message = current?.message;
  const busy = current?.busy ?? true;
  const [now, setNow] = useState(Date.now);
  const [captures, setCaptures] = useState<Readonly<Record<string, ProviderLimitsCaptureStatus>>>(
    {},
  );
  const [captureBusyId, setCaptureBusyId] = useState<string>();
  const [captureNotices, setCaptureNotices] = useState<Readonly<Record<string, string>>>({});
  const names = useMemo(
    () => new Map(props.instances.map((instance) => [String(instance.id), instance])),
    [props.instances],
  );
  const stopCapturePoll = useCallback(() => {
    if (pollTimer.current !== undefined) {
      clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    }
  }, []);
  const loadCaptures = useCallback(async () => {
    if (props.client.listLimitsCaptures === undefined) return;
    try {
      const next = await props.client.listLimitsCaptures();
      setCaptures(next);
    } catch {
      // Optional capability; ignore if unavailable.
    }
  }, [props.client]);
  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      const request = ++sequence.current;
      setReading((previous) => ({
        client: props.client,
        busy: true,
        ...(refresh && previous?.client === props.client && previous.snapshot !== undefined
          ? { snapshot: previous.snapshot }
          : {}),
      }));
      try {
        const next = await (refresh ? props.client.refresh() : props.client.list());
        if (request !== sequence.current) return;
        setNow(Date.now());
        setReading({ client: props.client, snapshot: next, busy: false });
        void loadCaptures();
      } catch {
        if (request !== sequence.current) return;
        setReading((previous) => ({
          client: props.client,
          busy: false,
          ...(refresh && previous?.client === props.client && previous.snapshot !== undefined
            ? { snapshot: previous.snapshot }
            : {}),
          message: refresh
            ? "Provider limits could not be refreshed. Last successful values remain visible."
            : "Provider limits are unavailable.",
        }));
      }
    },
    [loadCaptures, props.client],
  );
  const startCapturePoll = useCallback(
    (instanceId: string, watermarkMs: number) => {
      stopCapturePoll();
      const deadline = Date.now() + CAPTURE_POLL_DURATION_MS;
      pollTimer.current = setInterval(() => {
        if (Date.now() >= deadline) {
          stopCapturePoll();
          setCaptureNotices((prev) => ({
            ...prev,
            [instanceId]: "No new reading arrived yet. Press Refresh after the CLI updates.",
          }));
          return;
        }
        const request = ++sequence.current;
        void props.client
          .list()
          .then((next) => {
            if (request !== sequence.current) return;
            setNow(Date.now());
            setReading({ client: props.client, snapshot: next, busy: false });
            void loadCaptures();
            const updatedEntry = next.entries.find(
              (entry) => String(entry.providerInstanceId) === instanceId,
            );
            const updatedMs = entryReadingTimestampMs(updatedEntry);
            if (
              updatedEntry?.status === "available" &&
              updatedMs !== undefined &&
              updatedMs >= watermarkMs
            ) {
              stopCapturePoll();
              setCaptureNotices((prev) => ({
                ...prev,
                [instanceId]: "Updated limits received.",
              }));
            }
          })
          .catch(() => undefined);
      }, CAPTURE_POLL_INTERVAL_MS);
    },
    [loadCaptures, props.client, stopCapturePoll],
  );
  const handleConnectCapture = useCallback(
    async (instanceId: string) => {
      if (props.client.connectLimitsCapture === undefined) return;
      stopCapturePoll();
      setCaptureBusyId(instanceId);
      setCaptureNotices((prev) => {
        const { [instanceId]: _removed, ...rest } = prev;
        return rest;
      });
      try {
        const status = await props.client.connectLimitsCapture(instanceId);
        setCaptures((prev) => ({ ...prev, [instanceId]: status }));
        setCaptureNotices((prev) => ({ ...prev, [instanceId]: status.connectedHint }));
        await load(true);
      } catch (error) {
        setCaptureNotices((prev) => ({
          ...prev,
          [instanceId]:
            error instanceof Error ? error.message : "Could not connect local limits capture.",
        }));
      } finally {
        setCaptureBusyId(undefined);
      }
    },
    [load, props.client, stopCapturePoll],
  );
  const handleDisconnectCapture = useCallback(
    async (instanceId: string) => {
      if (props.client.disconnectLimitsCapture === undefined) return;
      stopCapturePoll();
      setCaptureBusyId(instanceId);
      setCaptureNotices((prev) => {
        const { [instanceId]: _removed, ...rest } = prev;
        return rest;
      });
      try {
        const result = await props.client.disconnectLimitsCapture(instanceId);
        setCaptures((prev) => ({ ...prev, [instanceId]: result.status }));
        setCaptureNotices((prev) => ({
          ...prev,
          [instanceId]: result.restored
            ? "Status line disconnected and previous settings restored."
            : "Status line disconnected.",
        }));
        await load(true);
      } catch (error) {
        setCaptureNotices((prev) => ({
          ...prev,
          [instanceId]:
            error instanceof Error ? error.message : "Could not disconnect local limits capture.",
        }));
      } finally {
        setCaptureBusyId(undefined);
      }
    },
    [load, props.client, stopCapturePoll],
  );
  const handleTriggerCaptureRefresh = useCallback(
    async (instanceId: string, entry: ProviderUsageLimitsEntry) => {
      if (props.client.triggerLimitsCaptureRefresh === undefined) return;
      setCaptureBusyId(instanceId);
      setCaptureNotices((prev) => {
        const { [instanceId]: _removed, ...rest } = prev;
        return rest;
      });
      try {
        const launchMs = Date.now();
        const baselineMs = entryReadingTimestampMs(entry);
        const watermarkMs =
          baselineMs === undefined ? launchMs : Math.max(launchMs, baselineMs + 1);
        const result = await props.client.triggerLimitsCaptureRefresh(instanceId);
        if (result.launched) {
          setCaptureNotices((prev) => ({
            ...prev,
            [instanceId]: "Opened interactive terminal. Waiting for fresh limits…",
          }));
          startCapturePoll(instanceId, watermarkMs);
        } else {
          setCaptureNotices((prev) => ({
            ...prev,
            [instanceId]:
              result.message ?? "Run the provider CLI interactively in a terminal to refresh.",
          }));
        }
      } catch (error) {
        setCaptureNotices((prev) => ({
          ...prev,
          [instanceId]:
            error instanceof Error ? error.message : "Could not launch interactive refresh.",
        }));
      } finally {
        setCaptureBusyId(undefined);
      }
    },
    [props.client, startCapturePoll],
  );
  useEffect(() => {
    void load(false);
    return () => {
      sequence.current += 1;
      stopCapturePoll();
    };
  }, [load, stopCapturePoll]);
  useEffect(() => {
    const resets =
      snapshot?.entries
        .flatMap((entry) => {
          const limits =
            entry.status === "available"
              ? entry.limits
              : entry.status === "failed"
                ? entry.staleLimits
                : undefined;
          if (limits === undefined) return [];
          return [
            limits.requests,
            limits.tokens,
            limits.concurrency,
            ...(limits.rateLimitWindows ?? []),
          ].flatMap((bucket) =>
            "resetsAt" in bucket && bucket.resetsAt !== undefined
              ? [Date.parse(bucket.resetsAt)]
              : [],
          );
        })
        .filter((reset) => reset > now) ?? [];
    const delay = Math.max(1, Math.min(60_000, ...resets.map((reset) => reset - Date.now())));
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [snapshot, now]);

  const visible = snapshot?.entries.filter((entry) => names.has(String(entry.providerInstanceId)));
  const captureFor = (entry: ProviderUsageLimitsEntry): ProviderLimitsCaptureStatus | undefined =>
    captures[String(entry.providerInstanceId)];
  // A provider with more than one account reads as one row: a bar per limit
  // window with a segment per account. Its accounts' own rows fold into it.
  const pooled = useMemo(
    () =>
      // A provider with no window to draw keeps its accounts on their own
      // rows, where a quota warning is not hidden behind Each account.
      poolProviderLimits({ entries: visible ?? [], instances: props.instances, now }).filter(
        (provider) => provider.accounts.length > 1 && provider.windows.length > 0,
      ),
    [visible, props.instances, now],
  );
  const pooledIds = new Set(
    pooled.flatMap((provider) => provider.accounts.map((account) => String(account.id))),
  );
  // Providers that cannot report limits collapse into one closing row instead
  // of a wall of identical cards; the runtime's reason still names each.
  // An account that has not reported yet sits in its provider's pool as No
  // reading, so it is not listed again here; one with a capture keeps its row.
  const unavailable =
    visible?.filter(
      (entry): entry is Extract<ProviderUsageLimitsEntry, { status: "unavailable" }> =>
        entry.status === "unavailable" &&
        captureFor(entry) === undefined &&
        !pooledIds.has(String(entry.providerInstanceId)),
    ) ?? [];
  const body = (
    <>
      {message === undefined ? null : (
        <p className="surface-section__note" role="status">
          {message}
        </p>
      )}
      {snapshot === undefined && message === undefined ? (
        <p className="surface-section__note" role="status">
          Loading provider limits…
        </p>
      ) : null}
      {visible?.length === 0 ? (
        <p className="surface-section__note" role="status">
          No configured providers have reported limits.
        </p>
      ) : null}
      {visible === undefined || visible.length === 0 ? null : (
        <ul className="surface-list provider-limits__list">
          {pooled.map((provider) => (
            <PooledProviderRow
              compact={props.compact === true}
              entries={visible}
              key={provider.driverKind}
              now={now}
              provider={provider}
            />
          ))}
          {visible.map((entry) => {
            const instanceId = String(entry.providerInstanceId);
            const capture = captureFor(entry);
            if (entry.status === "unavailable" && capture === undefined) return null;
            if (pooledIds.has(instanceId)) return null;
            const instance = names.get(instanceId);
            const scopeDetail =
              capture?.planTier !== undefined
                ? `${capture.planTier} · ${limitScope(entry)}`
                : limitScope(entry);
            const captureBusy = captureBusyId === instanceId;
            const captureNotice = captureNotices[instanceId];
            return (
              <li className="surface-row provider-limits__row" key={instanceId}>
                <div className="surface-row__copy">
                  <span className="provider-limits__identity">
                    {instance === undefined ? null : (
                      <ProviderGlyph
                        displayName={instance.displayName}
                        driverKind={instance.driverKind}
                        size={16}
                      />
                    )}
                    <span className="oct-row-label">{instance?.displayName ?? "Provider"}</span>
                  </span>
                  <span className="oct-row-detail">
                    {entry.status === "unavailable" && capture !== undefined
                      ? capture.summary
                      : scopeDetail}
                  </span>
                  {props.compact === true ? null : (
                    <LimitHeadline now={now} readings={entryReadings(entry, now)} />
                  )}
                </div>
                <div className="surface-row__control">
                  <div className="provider-limits__details">
                    {entry.status === "unavailable" && capture !== undefined ? (
                      <p className="provider-limits__state">
                        {capture.connected ? capture.connectedHint : capture.disconnectedHint}
                      </p>
                    ) : (
                      <EntryDetails
                        entry={entry}
                        now={now}
                        runtime={
                          instance === undefined ? "This runtime" : driverLabel(instance.driverKind)
                        }
                      />
                    )}
                    {capture === undefined ? null : (
                      <div className="provider-limits__actions">
                        {capture.connected ? (
                          <>
                            {capture.refreshActionLabel === undefined ||
                            props.client.triggerLimitsCaptureRefresh === undefined ? null : (
                              <OctantButton
                                disabled={captureBusy}
                                onClick={() => void handleTriggerCaptureRefresh(instanceId, entry)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {capture.refreshActionLabel}
                              </OctantButton>
                            )}
                            {props.client.disconnectLimitsCapture === undefined ? null : (
                              <OctantButton
                                disabled={captureBusy}
                                onClick={() => void handleDisconnectCapture(instanceId)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                Disconnect
                              </OctantButton>
                            )}
                          </>
                        ) : props.client.connectLimitsCapture === undefined ? null : (
                          <OctantButton
                            disabled={captureBusy}
                            onClick={() => void handleConnectCapture(instanceId)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {capture.connectLabel}
                          </OctantButton>
                        )}
                      </div>
                    )}
                    {captureNotice === undefined ? null : (
                      <p className="provider-limits__updated" role="status">
                        {captureNotice}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {unavailable.length === 0 ? null : (
            <li className="surface-row provider-limits__row provider-limits__row--quiet">
              <div className="surface-row__copy">
                <span className="oct-row-label">Not reporting limits</span>
              </div>
              <div className="surface-row__control">
                <ul className="provider-limits__quiet-list">
                  {unavailable.map((entry) => {
                    const instance = names.get(String(entry.providerInstanceId));
                    return (
                      <li key={String(entry.providerInstanceId)}>
                        {instance === undefined ? null : (
                          <ProviderGlyph
                            displayName={instance.displayName}
                            driverKind={instance.driverKind}
                            size={16}
                          />
                        )}
                        {instance?.displayName ?? "Provider"} ·{" "}
                        {unavailableCopy(
                          entry.reason,
                          instance === undefined
                            ? "This runtime"
                            : driverLabel(instance.driverKind),
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          )}
        </ul>
      )}
    </>
  );
  if (props.compact === true) {
    return (
      <div className="provider-limits provider-limits--compact" data-account-usage="">
        {body}
      </div>
    );
  }
  return (
    <SurfaceSection
      actions={
        <>
          <UsageInfoMark label="About provider limits">
            Provider-reported limits can include usage from other apps. An unreported window stays
            unknown; a reset requires a fresh reading. The marker on a bar is where spending evenly
            over the window would be now, and a forecast assumes the pace so far.
          </UsageInfoMark>
          <OctantButton
            aria-label="Refresh provider limits"
            disabled={busy}
            onClick={() => void load(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" size={14} />
            Refresh
          </OctantButton>
        </>
      }
      className="provider-limits"
      label="Provider limits"
    >
      {body}
    </SurfaceSection>
  );
}

/**
 * One provider's accounts pooled: each limit window is one bar with a segment
 * per account, side by side and ordered by which refills first, never an
 * averaged share, since Octant does not know each account's plan size. Each
 * account's full reading stays one disclosure away.
 */
function PooledProviderRow(props: {
  readonly compact: boolean;
  readonly provider: PooledProvider;
  readonly entries: ReadonlyArray<ProviderUsageLimitsEntry>;
  readonly now: number;
}) {
  const first = props.provider.accounts[0];
  const runtime = driverLabel(props.provider.driverKind as ProviderInstance["driverKind"]);
  return (
    <li className="surface-row provider-limits__row provider-limits__row--pooled">
      <div className="surface-row__copy">
        <span className="provider-limits__identity">
          {first === undefined ? null : (
            <ProviderGlyph displayName={runtime} driverKind={first.driverKind} size={16} />
          )}
          <span className="oct-row-label">{runtime}</span>
        </span>
        <span className="oct-row-detail">
          {props.provider.accounts.length} accounts · each account counted on its own
        </span>
        {props.compact ? null : (
          <LimitHeadline now={props.now} readings={pooledReadings(props.provider)} />
        )}
      </div>
      <div className="surface-row__control">
        <div className="provider-limits__details">
          {props.provider.windows.map((window) => (
            <PooledWindowBar key={window.window} now={props.now} window={window} />
          ))}
          <details className="provider-limits__accounts">
            <summary>Each account</summary>
            {props.provider.accounts.map((account) => {
              const entry = props.entries.find(
                (candidate) => String(candidate.providerInstanceId) === String(account.id),
              );
              return entry === undefined ? null : (
                <div className="provider-limits__account" key={String(account.id)}>
                  <p className="oct-row-label">{account.displayName}</p>
                  <EntryDetails entry={entry} now={props.now} runtime={runtime} />
                </div>
              );
            })}
          </details>
        </div>
      </div>
    </li>
  );
}

function PooledWindowBar(props: { readonly window: PooledWindow; readonly now: number }) {
  const timestampFormat = useTimestampFormat();
  const label = windowLabel(props.window.window);
  return (
    <div className="provider-limits__window" data-pooled-window={props.window.window}>
      <div className="provider-limits__window-heading">
        <span>{label}</span>
        {props.window.soonestResetAt === undefined ? null : (
          <time
            dateTime={props.window.soonestResetAt}
            title={formatTime(props.window.soonestResetAt, timestampFormat)}
          >
            Soonest reset {formatTime(props.window.soonestResetAt, timestampFormat)} ·{" "}
            {resetCountdown(props.window.soonestResetAt, props.now)}
          </time>
        )}
      </div>
      <div className="provider-limits__segments">
        {props.window.segments.map((segment) =>
          // A spent account is a meter in its exhausted state, holding what
          // share its window still reports (empty when none), never the dashed
          // outline of an account with no reading: the two must never look
          // alike. Its name carries the warning the legend shows, since a
          // screen reader can reach the meter on its own.
          segment.kind === "reading" &&
          (segment.remainingPercent !== undefined || segment.exhausted) ? (
            <span className="provider-limits__track" key={segment.providerInstanceId}>
              <meter
                aria-label={`${segment.account}, ${label} remaining${segment.exhausted ? ", limit reached" : ""}`}
                data-state={segment.exhausted ? "exhausted" : "reading"}
                max={100}
                min={0}
                value={segment.remainingPercent ?? 0}
              />
              <PaceMarker
                account={segment.account}
                forecast={limitForecast({ ...segment, window: props.window.window }, props.now)}
              />
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="provider-limits__segment-empty"
              data-state={
                segment.kind === "missing"
                  ? "missing"
                  : segment.awaitingUpdate
                    ? "awaiting"
                    : "unreported"
              }
              key={segment.providerInstanceId}
            />
          ),
        )}
      </div>
      <ul className="provider-limits__segment-legend">
        {props.window.segments.map((segment) => (
          <li data-segment={segment.kind} key={segment.providerInstanceId}>
            <span>{segment.account}</span>
            <span>{segmentReading(segment, timestampFormat)}</span>
            {segment.kind === "missing" ? null : (
              <ForecastLine
                forecast={limitForecast({ ...segment, window: props.window.window }, props.now)}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function segmentReading(
  segment: PooledWindow["segments"][number],
  timestampFormat: TimestampFormatPreference | undefined,
): string {
  if (segment.kind === "missing") return "No reading";
  if (segment.awaitingUpdate) return `Awaiting updated limits${segment.stale ? " · stale" : ""}`;
  // The account is spent even when this window still reports a share left:
  // Codex flags the account, not the window that ran out.
  const share = segment.exhausted
    ? segment.remainingPercent !== undefined && segment.remainingPercent > 0
      ? `Limit reached · ${segment.remainingPercent}% of this window left`
      : "Limit reached"
    : segment.remainingPercent !== undefined
      ? `${segment.remainingPercent}% left`
      : "Remaining not reported";
  const reset =
    segment.resetsAt === undefined
      ? ""
      : ` · resets ${formatTime(segment.resetsAt, timestampFormat)}`;
  return `${share}${reset}${segment.stale ? " · stale" : ""}`;
}

/**
 * A flat "Unavailable" said nothing about whether limits could ever appear.
 * The row carries one short value naming the actual state; the section note
 * explains once why an idle provider has not reported yet. A runtime with no
 * limits channel, a local model, or a silent endpoint says which it is.
 */
function unavailableCopy(
  reason: Extract<ProviderUsageLimitsEntry, { status: "unavailable" }>["reason"],
  runtime: string,
): string {
  switch (reason) {
    case "unsupported":
      return "Not reported yet";
    case "not-configured":
      return "Provider off";
    case "not-ready":
      return "Waiting for the provider";
    case "runtime-does-not-report":
      return `Not reported by ${runtime}`;
    case "local-runtime":
      return "Runs locally, no account limits";
    case "endpoint-silent":
      return "No rate-limit headers on the last request";
    case "plan-limits-do-not-apply":
      return "Plan limits do not apply";
  }
}

function limitScope(entry: ProviderUsageLimitsEntry): string {
  const limits =
    entry.status === "available"
      ? entry.limits
      : entry.status === "failed"
        ? entry.staleLimits
        : undefined;
  switch (limits?.scope) {
    case "account":
      return "Account limits · includes other apps";
    case "model":
      return "Model limits";
    case "provider-instance":
      return "Provider instance limits";
    default:
      return "Scope not reported";
  }
}

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour window",
  seven_day: "7-day window",
  seven_day_opus: "7-day Opus window",
  seven_day_sonnet: "7-day Sonnet window",
  seven_day_overage_included: "7-day overage included",
  monthly: "Monthly window",
  overage: "Overage",
};

const DURATION_UNITS: Readonly<Record<string, string>> = { m: "minute", h: "hour", d: "day" };

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  gemini: "Gemini",
  claude_gpt: "Claude & GPT",
};

/**
 * Codex names its windows by slot and length (`primary_5h`, `secondary_7d`);
 * the length is what a reader recognizes, so it leads the label.
 */
function windowLabel(window: string): string {
  const separator = window.lastIndexOf(":");
  if (separator >= 0) {
    const scope = window.slice(0, separator);
    const label = windowLabel(window.slice(separator + 1));
    if (scope === "account" || scope === "codex") return label;
    const scopeLabel = SCOPE_LABELS[scope] ?? scope.replaceAll("_", " ");
    return `${scopeLabel} · ${label}`;
  }
  const known = WINDOW_LABELS[window];
  if (known !== undefined) return known;
  const codex = /^(primary|secondary)(?:_(\d+)([mhd]))?$/.exec(window);
  if (codex === null) return window.replaceAll("_", " ");
  const [, slot, amount, unit] = codex;
  const length =
    amount === undefined || unit === undefined ? "" : `${amount}-${DURATION_UNITS[unit]} `;
  return `${length}window (${slot})`;
}

function EntryDetails({
  entry,
  runtime,
  now,
}: {
  readonly entry: ProviderUsageLimitsEntry;
  readonly runtime: string;
  readonly now: number;
}) {
  const timestampFormat = useTimestampFormat();
  if (entry.status === "unavailable") {
    return <p className="provider-limits__state">{unavailableCopy(entry.reason, runtime)}</p>;
  }
  const limits = entry.status === "available" ? entry.limits : entry.staleLimits;
  return (
    <div className="provider-limits__details">
      {entry.status === "failed" ? (
        <div className="provider-limits__warning">
          <p>{limits === undefined ? "Refresh failed" : "Stale · refresh failed"}</p>
          {entry.failure.retryAt === undefined ? null : (
            <p>Retry after {formatTime(entry.failure.retryAt, timestampFormat)}</p>
          )}
          {entry.lastSuccessfulAt === undefined ? null : (
            <p>Last successful read {formatTime(entry.lastSuccessfulAt, timestampFormat)}</p>
          )}
        </div>
      ) : null}
      {limits === undefined ? (
        <p>Unavailable</p>
      ) : (
        <LimitBuckets limits={limits} now={now} stale={entry.status === "failed"} />
      )}
      <p className="provider-limits__updated">
        Last updated {formatTime(limits?.updatedAt ?? entry.observedAt, timestampFormat)}
      </p>
    </div>
  );
}

function LimitBuckets({
  limits,
  now,
  stale,
}: {
  readonly limits: ProviderServiceLimits;
  readonly now: number;
  readonly stale: boolean;
}) {
  const timestampFormat = useTimestampFormat();
  const buckets = [
    ["requests", limits.requests],
    ["tokens", limits.tokens],
    ["concurrent", limits.concurrency],
  ] as const;
  const hasBuckets = buckets.some(([, bucket]) => bucket.status === "available");
  return (
    <div className="provider-limits__buckets">
      {limits.quota === "exhausted" ? (
        <p className="provider-limits__warning">
          {limits.scope === "account" ? "Account limit reached" : "Provider limit reached"}
        </p>
      ) : null}
      {!hasBuckets && (limits.rateLimitWindows?.length ?? 0) === 0 ? (
        <p>No quota windows reported</p>
      ) : null}
      {buckets.map(([label, bucket]) => (
        <LimitBucket
          bucket={bucket}
          key={label}
          label={label}
          now={now}
          observedAt={limits.updatedAt}
          stale={stale}
        />
      ))}
      {limits.rateLimitWindows?.map((window) => (
        <QuotaWindow
          key={window.window}
          label={windowLabel(window.window)}
          now={now}
          pace={{
            window: window.window,
            observedAt: window.observedAt,
            exhausted: window.status === "exhausted",
            stale,
          }}
          status={capitalize(window.status)}
          {...(window.utilization === undefined
            ? {}
            : { remainingPercent: Math.floor((1 - window.utilization) * 100 + 1e-9) })}
          {...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt })}
          {...(window.overage === undefined ? {} : { overage: overageCopy(window.overage) })}
        />
      ))}
      {limits.retry.status === "active" ? (
        <p className="provider-limits__warning">
          Retry window until {formatTime(limits.retry.until, timestampFormat)}
        </p>
      ) : null}
    </div>
  );
}

function LimitBucket(props: {
  readonly bucket: ServiceLimitBucket;
  readonly label: string;
  readonly now: number;
  readonly observedAt: string;
  readonly stale: boolean;
}) {
  if (props.bucket.status === "unavailable") return null;
  return (
    <QuotaWindow
      label={capitalize(props.label)}
      now={props.now}
      pace={{
        window: props.label,
        observedAt: props.observedAt,
        exhausted: props.bucket.remaining <= 0,
        stale: props.stale,
      }}
      remainingPercent={Math.floor((props.bucket.remaining / props.bucket.limit) * 100)}
      detail={`${props.bucket.remaining.toLocaleString("en")} remaining of ${props.bucket.limit.toLocaleString("en")} ${props.label}`}
      {...(props.bucket.resetsAt === undefined ? {} : { resetsAt: props.bucket.resetsAt })}
    />
  );
}

function QuotaWindow(props: {
  readonly label: string;
  readonly now: number;
  readonly pace: Pick<LimitWindowReading, "window" | "observedAt" | "exhausted" | "stale">;
  readonly status?: string;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
  readonly detail?: string;
  readonly overage?: string;
}) {
  const timestampFormat = useTimestampFormat();
  const expired = props.resetsAt !== undefined && Date.parse(props.resetsAt) <= props.now;
  const remaining = expired ? undefined : props.remainingPercent;
  const forecast = limitForecast(
    {
      ...props.pace,
      ...(remaining === undefined ? {} : { remainingPercent: remaining }),
      ...(props.resetsAt === undefined ? {} : { resetsAt: props.resetsAt }),
    },
    props.now,
  );
  return (
    <div className="provider-limits__window">
      <div className="provider-limits__window-heading">
        <span>{props.label}</span>
        {expired || props.status === undefined ? null : <span>{props.status}</span>}
      </div>
      {remaining === undefined ? null : (
        <span className="provider-limits__track">
          <meter aria-label={`${props.label} remaining`} min={0} max={100} value={remaining} />
          <PaceMarker forecast={forecast} />
        </span>
      )}
      <div className="provider-limits__window-reading">
        <span>
          {expired
            ? "Awaiting updated limits"
            : remaining === undefined
              ? props.status === "Exhausted"
                ? "Limit reached"
                : "Remaining capacity not reported"
              : `${remaining}% left`}
        </span>
        {props.resetsAt === undefined || expired ? null : (
          <time dateTime={props.resetsAt} title={formatTime(props.resetsAt, timestampFormat)}>
            {formatTime(props.resetsAt, timestampFormat)} ·{" "}
            {resetCountdown(props.resetsAt, props.now)}
          </time>
        )}
      </div>
      <ForecastLine forecast={forecast} />
      {props.overage === undefined || expired ? null : <p>{props.overage}</p>}
      {props.detail === undefined || expired ? null : <p>{props.detail}</p>}
    </div>
  );
}

/** Where spending evenly over the window would be now, drawn on the bar of what is left. */
function PaceMarker(props: { readonly forecast: LimitForecast; readonly account?: string }) {
  const elapsed = props.forecast.elapsedPercent;
  if (elapsed === undefined) return null;
  const account = props.account === undefined ? "" : `${props.account}: `;
  return (
    <span
      aria-label={`${account}Even spending would leave ${100 - elapsed}% by now: ${elapsed}% of the window has passed`}
      className="provider-limits__pace"
      role="img"
      style={{ insetInlineStart: `${100 - elapsed}%` }}
      title={`Even spending would leave ${100 - elapsed}% by now`}
    />
  );
}

function ForecastLine(props: { readonly forecast: LimitForecast }) {
  const { back, outlook } = props.forecast;
  if (back === undefined && outlook === undefined) return null;
  return (
    <p className="provider-limits__forecast">
      {outlook === undefined ? null : (
        <span data-outlook={outlook.kind}>{outlookPhrase(outlook)}</span>
      )}
      {back === undefined ? null : (
        <span>{`+${back.percent}% back in ${paceDuration(back.inMs)}`}</span>
      )}
    </p>
  );
}

/** A reading a provider's headline can lead with. */
interface HeadlineReading extends LimitWindowReading {
  readonly account?: string;
}

function entryReadings(
  entry: ProviderUsageLimitsEntry,
  now: number,
): ReadonlyArray<HeadlineReading> {
  const limits =
    entry.status === "available"
      ? entry.limits
      : entry.status === "failed"
        ? entry.staleLimits
        : undefined;
  if (limits === undefined) return [];
  const stale = entry.status === "failed";
  const windows = (limits.rateLimitWindows ?? []).map(
    (window): HeadlineReading => ({
      window: window.window,
      observedAt: window.observedAt,
      exhausted: window.status === "exhausted",
      stale,
      ...(window.utilization === undefined
        ? {}
        : { remainingPercent: Math.floor((1 - window.utilization) * 100 + 1e-9) }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    }),
  );
  const buckets = (
    [
      ["requests", limits.requests],
      ["tokens", limits.tokens],
      ["concurrent", limits.concurrency],
    ] as const
  ).flatMap(
    ([window, bucket]): ReadonlyArray<HeadlineReading> =>
      bucket.status === "unavailable"
        ? []
        : [
            {
              window,
              observedAt: limits.updatedAt,
              exhausted: bucket.remaining <= 0,
              stale,
              remainingPercent: Math.floor((bucket.remaining / bucket.limit) * 100),
              ...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt }),
            },
          ],
  );
  return [...windows, ...buckets].filter(
    (reading) => reading.resetsAt === undefined || Date.parse(reading.resetsAt) > now,
  );
}

function pooledReadings(provider: PooledProvider): ReadonlyArray<HeadlineReading> {
  return provider.windows.flatMap((window) =>
    window.segments.flatMap((segment) =>
      segment.kind === "missing" || segment.awaitingUpdate
        ? []
        : [{ ...segment, window: window.window }],
    ),
  );
}

/**
 * The reading closest to running out, large: the share left, whether spending is
 * ahead of or behind an even pace, and whose window it is. Pooled accounts are
 * never averaged, so the headline is one account's own figure and names it.
 */
function LimitHeadline(props: {
  readonly readings: ReadonlyArray<HeadlineReading>;
  readonly now: number;
}) {
  const rank = (reading: HeadlineReading) =>
    reading.exhausted ? -1 : (reading.remainingPercent ?? Number.POSITIVE_INFINITY);
  const lead = [...props.readings]
    .filter((reading) => reading.exhausted || reading.remainingPercent !== undefined)
    .sort((a, b) => rank(a) - rank(b))[0];
  if (lead === undefined) return null;
  const forecast = limitForecast(lead, props.now);
  const detail = [
    ...(lead.account === undefined ? [] : [lead.account]),
    windowLabel(lead.window),
    ...(lead.stale ? ["last reading, refresh failed"] : []),
  ].join(" · ");
  return (
    <div className="provider-limits__headline">
      <div>
        <strong>{lead.exhausted ? "Limit reached" : `${lead.remainingPercent}% left`}</strong>
        {forecast.trend === undefined || forecast.trend === "even" ? null : (
          <span className="provider-limits__trend" data-trend={forecast.trend}>
            {forecast.trend === "faster" ? (
              <ArrowDownRight aria-hidden="true" size={20} />
            ) : (
              <ArrowUpRight aria-hidden="true" size={20} />
            )}
            <span className="sr-only">Spending {forecast.trend} than an even pace</span>
          </span>
        )}
      </div>
      <span>{detail}</span>
    </div>
  );
}

function overageCopy(
  overage: NonNullable<ProviderServiceLimits["rateLimitWindows"]>[number]["overage"],
): string {
  if (overage === undefined) return "Overage available";
  if (overage.disabledReason !== undefined) {
    return overage.disabledReason.startsWith("Pay as you go")
      ? overage.disabledReason
      : `Overage: ${overage.disabledReason}`;
  }
  if (overage.inUse === true) return "Overage in use";
  if (overage.status === "exhausted") return "Overage exhausted";
  if (overage.status === "warning") return "Overage warning";
  return "Overage available";
}

function resetCountdown(resetsAt: string, now: number): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(resetsAt) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  if (days > 0) return `Resets in ${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `Resets in ${hours}h${remainder > 0 ? ` ${remainder}m` : ""}`;
  return `Resets in ${minutes}m`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTime(value: string, timestampFormat?: TimestampFormatPreference): string {
  return formatDateTime(value, { dateStyle: "medium", timeStyle: "short" }, timestampFormat);
}
