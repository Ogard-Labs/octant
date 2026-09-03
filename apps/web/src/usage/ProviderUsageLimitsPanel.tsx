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
import { SurfaceEmpty, SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { ProviderGlyph } from "../providers/ProviderGlyph";

export function ProviderUsageLimitsPanel(props: {
  readonly client: ProviderUsageLimitsClient;
  readonly instances: ReadonlyArray<ProviderInstance>;
}) {
  const [snapshot, setSnapshot] = useState<ProviderUsageLimitsSnapshot>();
  const [busy, setBusy] = useState(false);
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
      className="provider-limits"
      label="Provider limits"
      note="Live provider capacity is separate from Octant's local recorded usage."
    >
      <div className="surface-toolbar">
        {message === undefined ? null : (
          <p className="oct-row-detail" role="status">
            {message}
          </p>
        )}
        {snapshot === undefined && message === undefined ? (
          <p className="oct-row-detail" role="status">
            Loading provider limits…
          </p>
        ) : null}
        <span className="surface-toolbar__spacer" />
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
      </div>
      {snapshot?.entries.length === 0 ? (
        <SurfaceEmpty title="No configured providers have reported limits." />
      ) : null}
      {snapshot === undefined || snapshot.entries.length === 0 ? null : (
        <ul className="surface-list">
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
                  <span className="oct-row-detail">
                    {entry.source === "provider-runtime" ? "Provider runtime" : "Local observer"}
                  </span>
                </div>
                <div className="surface-row__control">
                  <EntryDetails entry={entry} />
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
 * The reason names the actual state: most runtimes only report their windows
 * while a session runs, so an idle provider has simply not reported yet.
 */
const UNAVAILABLE_COPY: Readonly<Record<"unsupported" | "not-configured" | "not-ready", string>> = {
  unsupported: "Not reported yet. Limits appear once a session with this runtime reports them.",
  "not-configured": "Provider is off.",
  "not-ready": "Waiting for the provider.",
};

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour window",
  seven_day: "7-day window",
  seven_day_opus: "7-day Opus window",
  seven_day_sonnet: "7-day Sonnet window",
};

function windowLabel(window: string): string {
  return WINDOW_LABELS[window] ?? window.replaceAll("_", " ");
}

function EntryDetails({ entry }: { readonly entry: ProviderUsageLimitsEntry }) {
  if (entry.status === "unavailable") {
    return <p className="provider-limits__state">{UNAVAILABLE_COPY[entry.reason]}</p>;
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
      {limits === undefined ? <p>Unavailable</p> : <LimitBuckets limits={limits} />}
    </div>
  );
}

function LimitBuckets({ limits }: { readonly limits: ProviderServiceLimits }) {
  const buckets = [
    ["requests", limits.requests],
    ["tokens", limits.tokens],
    ["concurrent", limits.concurrency],
  ] as const;
  return (
    <div className="provider-limits__buckets">
      {buckets.map(([label, bucket]) => (
        <LimitBucket bucket={bucket} key={label} label={label} />
      ))}
      {limits.rateLimitWindows?.map((window) => (
        <div className="provider-limits__window" key={window.window}>
          <p>
            {windowLabel(window.window)} · {capitalize(window.status)}
            {window.utilization === undefined
              ? ""
              : ` · ${Math.round(window.utilization * 100)}% used`}
            {window.resetsAt === undefined ? "" : ` · resets ${formatTime(window.resetsAt)}`}
          </p>
          {window.utilization === undefined ? null : (
            <progress
              aria-label={`${windowLabel(window.window)} used`}
              max={100}
              value={Math.round(window.utilization * 100)}
            />
          )}
        </div>
      ))}
      {limits.retry.status === "active" ? (
        <p className="provider-limits__warning">
          Retry window until {formatTime(limits.retry.until)}
        </p>
      ) : null}
    </div>
  );
}

function LimitBucket(props: { readonly bucket: ServiceLimitBucket; readonly label: string }) {
  if (props.bucket.status === "unavailable") {
    return <p>{capitalize(props.label)} · Unavailable</p>;
  }
  const used = props.bucket.limit - props.bucket.remaining;
  const usedPercent = Math.round((used / props.bucket.limit) * 100);
  return (
    <div className="provider-limits__bucket">
      <p>
        {props.bucket.remaining} remaining of {props.bucket.limit} {props.label}
        {props.bucket.resetsAt === undefined
          ? ""
          : ` · resets ${formatTime(props.bucket.resetsAt)}`}
      </p>
      <progress aria-label={`${capitalize(props.label)} used`} max={100} value={usedPercent} />
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
