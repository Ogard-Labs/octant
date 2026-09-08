import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type {
  ProviderInstance,
  ProviderServiceLimits,
  ProviderUsageLimitsEntry,
  ProviderUsageLimitsSnapshot,
  ServiceLimitBucket,
} from "@octant/contracts";
import { SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { driverLabel } from "../providers/providerSettingsPresentation";
import "../styles/usage.css";

export function ProviderUsageLimitsPanel(props: {
  readonly client: ProviderUsageLimitsClient;
  readonly instances: ReadonlyArray<ProviderInstance>;
}) {
  const [snapshot, setSnapshot] = useState<ProviderUsageLimitsSnapshot>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [message, setMessage] = useState<string>();
  const names = useMemo(
    () => new Map(props.instances.map((instance) => [String(instance.id), instance])),
    [props.instances],
  );

  useEffect(() => {
    let active = true;
    void props.client.list().then(
      (value) => active && setSnapshot(value),
      () => active && setMessage("Provider limits are unavailable."),
    );
    return () => {
      active = false;
    };
  }, [props.client]);

  async function refresh(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      setSnapshot(await props.client.refresh());
    } catch {
      setMessage("Provider limits could not be refreshed. Last successful values remain visible.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SurfaceSection
      actions={
        <OctantButton
          aria-label="Refresh provider limits"
          disabled={busy}
          onClick={() => void refresh()}
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
      {snapshot?.entries.length === 0 ? (
        <p className="surface-section__note" role="status">
          No configured providers have reported limits.
        </p>
      ) : null}
      {snapshot === undefined || snapshot.entries.length === 0 ? null : (
        <ul className="surface-list provider-limits__list">
          {snapshot.entries.map((entry) => {
            const instance = names.get(String(entry.providerInstanceId));
            return (
              <li
                className="surface-row provider-limits__row"
                key={String(entry.providerInstanceId)}
              >
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
                  <span className="oct-row-detail">{limitScope(entry)}</span>
                </div>
                <div className="surface-row__control">
                  <EntryDetails
                    entry={entry}
                    now={now}
                    runtime={
                      instance === undefined ? "This runtime" : driverLabel(instance.driverKind)
                    }
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
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
};

const DURATION_UNITS: Readonly<Record<string, string>> = { m: "minute", h: "hour", d: "day" };

/**
 * Codex names its windows by slot and length (`primary_5h`, `secondary_7d`);
 * the length is what a reader recognizes, so it leads the label.
 */
function windowLabel(window: string): string {
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
            <p>Retry after {formatTime(entry.failure.retryAt)}</p>
          )}
          {entry.lastSuccessfulAt === undefined ? null : (
            <p>Last successful read {formatTime(entry.lastSuccessfulAt)}</p>
          )}
        </div>
      ) : null}
      {limits === undefined ? <p>Unavailable</p> : <LimitBuckets limits={limits} now={now} />}
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
  const buckets = [
    ["requests", limits.requests],
    ["tokens", limits.tokens],
    ["concurrent", limits.concurrency],
  ] as const;
  const hasBuckets = buckets.some(([, bucket]) => bucket.status === "available");
  return (
    <div className="provider-limits__buckets">
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
        />
      ))}
      {limits.retry.status === "active" ? (
        <p className="provider-limits__warning">
          Retry window until {formatTime(limits.retry.until)}
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
      detail={`${props.bucket.remaining.toLocaleString()} remaining of ${props.bucket.limit.toLocaleString()} ${props.label}`}
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
}) {
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
              ? "Not reported"
              : `${remaining}% left`}
        </span>
        {props.resetsAt === undefined || expired ? null : (
          <time dateTime={props.resetsAt} title={formatTime(props.resetsAt)}>
            {resetCountdown(props.resetsAt, props.now)}
          </time>
        )}
      </div>
      {props.detail === undefined || expired ? null : <p>{props.detail}</p>}
    </div>
  );
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

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
