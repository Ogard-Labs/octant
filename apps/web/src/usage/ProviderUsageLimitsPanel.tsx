import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "../ui/icons";
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
import "../styles/usage.css";

const CAPTURE_POLL_INTERVAL_MS = 2_000;
const CAPTURE_POLL_DURATION_MS = 60_000;

function entryReadingMarker(entry: ProviderUsageLimitsEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;
  if (entry.status === "available") return `available:${entry.limits.updatedAt}`;
  if (entry.status === "failed") return `failed:${entry.lastSuccessfulAt ?? entry.observedAt}`;
  return undefined;
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
    (instanceId: string, baselineMarker: string | undefined) => {
      stopCapturePoll();
      const deadline = Date.now() + CAPTURE_POLL_DURATION_MS;
      pollTimer.current = setInterval(() => {
        if (Date.now() >= deadline) {
          stopCapturePoll();
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
            const nextMarker = entryReadingMarker(updatedEntry);
            if (nextMarker !== undefined && nextMarker !== baselineMarker) {
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
        const result = await props.client.triggerLimitsCaptureRefresh(instanceId);
        if (result.launched) {
          setCaptureNotices((prev) => ({
            ...prev,
            [instanceId]: "Opened interactive terminal. Waiting for fresh limits…",
          }));
          startCapturePoll(instanceId, entryReadingMarker(entry));
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
  // Providers that cannot report limits collapse into one closing row instead
  // of a wall of identical cards; the runtime's reason still names each.
  const unavailable =
    visible?.filter(
      (entry): entry is Extract<ProviderUsageLimitsEntry, { status: "unavailable" }> =>
        entry.status === "unavailable" && captureFor(entry) === undefined,
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
          {visible.map((entry) => {
            const instanceId = String(entry.providerInstanceId);
            const capture = captureFor(entry);
            if (entry.status === "unavailable" && capture === undefined) return null;
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
      }
      className="provider-limits"
      label="Provider limits"
      note="Provider-reported limits can include usage from other apps. An unreported window stays unknown; a reset requires a fresh reading."
    >
      {body}
    </SurfaceSection>
  );
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
      {limits === undefined ? <p>Unavailable</p> : <LimitBuckets limits={limits} now={now} />}
      <p className="provider-limits__updated">
        Last updated {formatTime(limits?.updatedAt ?? entry.observedAt, timestampFormat)}
      </p>
    </div>
  );
}

function LimitBuckets({
  limits,
  now,
}: {
  readonly limits: ProviderServiceLimits;
  readonly now: number;
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
        <LimitBucket bucket={bucket} key={label} label={label} now={now} />
      ))}
      {limits.rateLimitWindows?.map((window) => (
        <QuotaWindow
          key={window.window}
          label={windowLabel(window.window)}
          now={now}
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
}) {
  if (props.bucket.status === "unavailable") return null;
  return (
    <QuotaWindow
      label={capitalize(props.label)}
      now={props.now}
      remainingPercent={Math.floor((props.bucket.remaining / props.bucket.limit) * 100)}
      detail={`${props.bucket.remaining.toLocaleString("en")} remaining of ${props.bucket.limit.toLocaleString("en")} ${props.label}`}
      {...(props.bucket.resetsAt === undefined ? {} : { resetsAt: props.bucket.resetsAt })}
    />
  );
}

function QuotaWindow(props: {
  readonly label: string;
  readonly now: number;
  readonly status?: string;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
  readonly detail?: string;
  readonly overage?: string;
}) {
  const timestampFormat = useTimestampFormat();
  const expired = props.resetsAt !== undefined && Date.parse(props.resetsAt) <= props.now;
  const remaining = expired ? undefined : props.remainingPercent;
  return (
    <div className="provider-limits__window">
      <div className="provider-limits__window-heading">
        <span>{props.label}</span>
        {expired || props.status === undefined ? null : <span>{props.status}</span>}
      </div>
      {remaining === undefined ? null : (
        <meter aria-label={`${props.label} remaining`} min={0} max={100} value={remaining} />
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
      {props.overage === undefined || expired ? null : <p>{props.overage}</p>}
      {props.detail === undefined || expired ? null : <p>{props.detail}</p>}
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
