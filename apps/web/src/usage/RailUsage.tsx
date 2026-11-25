import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPreviewCard } from "../ui/base/OctantPreviewCard";
import { railUsageLines, useAccountUsage, type AccountUsageLine } from "./accountUsage";
import { usePlanUsageReading } from "./PlanUsageContext";
import { readingAgePhrase, resetPhrase, windowHours } from "./railUsageReading";
import "./plan-usage-line.css";
import "./rail-usage.css";

/** The ring's radius in its 26px box: a 2px stroke that ends on the box's edge. */
const RING_RADIUS = 12;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * What is left of each account's plan, above the person's face at the foot of
 * the rail: the provider's mark in a ring of the window that stops work first.
 * One arc, not one per window: two concentric arcs around a 12px mark could not
 * be told apart, and the card names every window. An account that reports no
 * window draws nothing, because an empty ring would claim a limit nobody
 * reported.
 */
export function RailUsage(props: { readonly onOpenUsage: () => void }) {
  const usage = useAccountUsage();
  const lines = railUsageLines(usage.lines);
  if (lines.length === 0) return null;
  return (
    <div aria-label="Plan usage" className="rail-usage" role="group">
      {lines.map((line) => (
        <RailUsageRing key={String(line.instance.id)} line={line} onOpenUsage={props.onOpenUsage} />
      ))}
    </div>
  );
}

function RailUsageRing(props: {
  readonly line: AccountUsageLine;
  readonly onOpenUsage: () => void;
}) {
  const { instance, lowest, reading } = props.line;
  const { now } = usePlanUsageReading();
  const age = readingAgePhrase(reading.observedAt, now);
  // Shortest window first, as the start screen's plan usage line lists them.
  const windows = [...reading.windows].sort(
    (a, b) => windowHours(a.window) - windowHours(b.window),
  );
  const summary = windows
    .map((window) => `${window.short} ${String(window.percent)}% left`)
    .join(", ");
  return (
    <OctantPreviewCard
      align="end"
      content={
        <div className="rail-usage__card">
          <div>
            <p className="rail-usage__title">{instance.displayName}</p>
            {age === undefined ? null : <span className="oct-meta">{age}</span>}
          </div>
          {windows.map((window) => {
            const reset = resetPhrase(reading.resetsAt.get(window.window), now);
            return (
              <div className="rail-usage__window" data-level={window.level} key={window.window}>
                <div className="rail-usage__window-head">
                  <span className="oct-row-label">{window.name}</span>
                  <span
                    className="oct-meta tabular-nums plan-usage-line__part"
                    data-level={window.level}
                  >
                    {window.percent}% left
                  </span>
                </div>
                <span aria-hidden="true" className="rail-usage__bar">
                  <span style={{ width: `${String(window.percent)}%` }} />
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
        aria-label={`${instance.displayName} plan usage, ${summary}`}
        className="sidebar-rail__button window-no-drag hover:no-underline"
        onClick={props.onOpenUsage}
        type="button"
        variant="rail"
      >
        <span aria-hidden="true" className="sidebar-rail__face rail-usage__face">
          <span className="rail-usage__ring">
            <svg viewBox="0 0 26 26">
              <circle className="rail-usage__track" cx="13" cy="13" r={RING_RADIUS} />
              <circle
                className="rail-usage__arc"
                cx="13"
                cy="13"
                data-level={lowest.level}
                r={RING_RADIUS}
                strokeDasharray={`${((RING_LENGTH * lowest.percent) / 100).toFixed(2)} ${RING_LENGTH.toFixed(2)}`}
              />
            </svg>
          </span>
          <ProviderGlyph
            className="rail-usage__glyph"
            displayName={instance.displayName}
            driverKind={instance.driverKind}
            size={14}
          />
        </span>
      </OctantButton>
    </OctantPreviewCard>
  );
}
