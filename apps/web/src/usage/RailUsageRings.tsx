import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type { ProviderInstance } from "@octant/contracts";
import { useMemo, type CSSProperties } from "react";
import { ProviderGlyph, providerGlyphColor } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPreviewCard } from "../ui/base/OctantPreviewCard";
import {
  railUsageReadings,
  readingAgePhrase,
  resetPhrase,
  type RailUsageReading,
} from "./railUsageReading";
import { useProviderUsageSnapshot } from "./useProviderUsageSnapshot";
import "../styles/usage.css";

const OUTER_RADIUS = 11;
const INNER_RADIUS = 7;

/**
 * One ring per provider that reports plan limits, at the foot of the rail:
 * the outer arc is what is left of the longest window (the week), the inner
 * arc what is left of the shortest (five hours). Hovering or focusing a ring
 * opens a card with every window and when it resets.
 */
export function RailUsageRings(props: {
  readonly client: ProviderUsageLimitsClient;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly onOpenUsage?: () => void;
}) {
  const { snapshot, now } = useProviderUsageSnapshot(props.client);
  const instances = useMemo(
    () => new Map(props.instances.map((instance) => [String(instance.id), instance])),
    [props.instances],
  );
  const readings = useMemo(
    () =>
      snapshot === undefined
        ? []
        : railUsageReadings(
            snapshot.entries.filter((entry) => instances.has(String(entry.providerInstanceId))),
            now,
          ),
    [instances, now, snapshot],
  );
  if (readings.length === 0) return null;
  return (
    <div aria-label="Plan usage" className="rail-usage" role="group">
      {readings.map((reading) => {
        const instance = instances.get(reading.providerInstanceId);
        if (instance === undefined) return null;
        return (
          <RailUsageRing
            instance={instance}
            key={reading.providerInstanceId}
            now={now}
            {...(props.onOpenUsage === undefined ? {} : { onOpenUsage: props.onOpenUsage })}
            reading={reading}
          />
        );
      })}
    </div>
  );
}

function RailUsageRing(props: {
  readonly instance: ProviderInstance;
  readonly reading: RailUsageReading;
  readonly now: number;
  readonly onOpenUsage?: () => void;
}) {
  const { instance, reading } = props;
  const summary = reading.windows
    .map((window) => `${window.short} ${window.percent}% left`)
    .join(", ");
  const age = readingAgePhrase(reading.observedAt, props.now);
  return (
    <OctantPreviewCard
      align="end"
      content={
        <div className="rail-usage__card">
          <div>
            <p className="rail-usage__card-title">{instance.displayName}</p>
            {age === undefined ? null : <span className="oct-meta">{age}</span>}
          </div>
          {reading.windows.map((window) => {
            const reset = resetPhrase(reading.resetsAt.get(window.window), props.now);
            return (
              <div className="rail-usage__window" data-level={window.level} key={window.window}>
                <div className="rail-usage__window-head">
                  <span className="oct-row-label">{window.name}</span>
                  <span className="rail-usage__left">{window.percent}% left</span>
                </div>
                <span aria-hidden="true" className="rail-usage__bar">
                  <span style={{ width: `${window.percent}%` }} />
                </span>
                {reset === undefined ? null : <span className="oct-meta">{reset}</span>}
              </div>
            );
          })}
        </div>
      }
      label={`${instance.displayName} plan usage`}
      side="right"
    >
      <OctantButton
        aria-label={`${instance.displayName} usage: ${summary}`}
        className="rail-usage__ring window-no-drag hover:no-underline"
        onClick={() => props.onOpenUsage?.()}
        style={
          {
            "--rail-usage-color": providerGlyphColor(instance.driverKind),
          } as CSSProperties
        }
        type="button"
        variant="link"
      >
        <span aria-hidden="true" className="rail-usage__face">
          <svg className="rail-usage__rings" viewBox="0 0 26 26">
            <circle className="rail-usage__track" cx="13" cy="13" r={OUTER_RADIUS} />
            <circle
              className="rail-usage__arc"
              cx="13"
              cy="13"
              data-level={reading.outer.level}
              r={OUTER_RADIUS}
              strokeDasharray={arc(OUTER_RADIUS, reading.outer.percent)}
            />
            {reading.inner === undefined ? null : (
              <>
                <circle className="rail-usage__track" cx="13" cy="13" r={INNER_RADIUS} />
                <circle
                  className="rail-usage__arc rail-usage__arc--inner"
                  cx="13"
                  cy="13"
                  data-level={reading.inner.level}
                  r={INNER_RADIUS}
                  strokeDasharray={arc(INNER_RADIUS, reading.inner.percent)}
                />
              </>
            )}
          </svg>
          <ProviderGlyph
            className="rail-usage__glyph"
            displayName={instance.displayName}
            driverKind={instance.driverKind}
            size={12}
          />
        </span>
      </OctantButton>
    </OctantPreviewCard>
  );
}

/** A dash pattern that draws `percent` of a circle of radius `radius`. */
function arc(radius: number, percent: number): string {
  const circumference = 2 * Math.PI * radius;
  return `${((circumference * percent) / 100).toFixed(2)} ${circumference.toFixed(2)}`;
}
