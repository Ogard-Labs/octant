import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPreviewCard } from "../ui/base/OctantPreviewCard";
import type { AccountUsageLine } from "./accountUsage";
import "./rail-usage.css";

export interface RailUsageRingsProps {
  readonly lines: ReadonlyArray<AccountUsageLine>;
  readonly onOpenUsage: () => void;
}

/** The ring's radius in its 26px box: a 2px stroke that ends on the box's edge. */
const RING_RADIUS = 12;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * Each account's mark in a ring of the window that stops work first. One arc,
 * not one per window: two concentric arcs around a 14px mark could not be told
 * apart, and the card names every window.
 */
export function RailUsageRings(props: RailUsageRingsProps) {
  // The foot's own column, so the rings and the face keep one spacing.
  return (
    <div aria-label="Plan usage" className="sidebar-rail__foot" role="group">
      {props.lines.map((line) => (
        <RailUsageRing key={String(line.instance.id)} line={line} onOpenUsage={props.onOpenUsage} />
      ))}
    </div>
  );
}

function RailUsageRing(props: {
  readonly line: AccountUsageLine;
  readonly onOpenUsage: () => void;
}) {
  const { instance, lowest, windows } = props.line;
  const label = `${instance.displayName} plan usage`;
  const summary = windows.map((window) => `${window.short} ${window.standing}`).join(", ");
  return (
    <OctantPreviewCard
      align="end"
      content={<RailUsageCard {...props.line} />}
      label={label}
      side="right"
    >
      <OctantButton
        aria-label={`${label}, ${summary}`}
        className="sidebar-rail__button window-no-drag hover:no-underline"
        onClick={props.onOpenUsage}
        type="button"
        variant="rail"
      >
        <span aria-hidden="true" className="sidebar-rail__face">
          {/* Wrapped, so the rail's 16px glyph rule, which reaches the face's own
              svg children, sizes neither the ring nor the mark. */}
          <span className="absolute inline-flex">
            <svg className="rail-usage-ring" data-level={lowest.level} viewBox="0 0 26 26">
              <circle className="rail-usage-ring__track" cx="13" cy="13" r={RING_RADIUS} />
              {/* A provider can call a window exhausted with a few percent
                  unused, and that sliver would read as plan still left. */}
              {lowest.level === "spent" ? null : (
                <circle
                  className="rail-usage-ring__arc"
                  cx="13"
                  cy="13"
                  r={RING_RADIUS}
                  strokeDasharray={`${((RING_LENGTH * lowest.percent) / 100).toFixed(2)} ${RING_LENGTH.toFixed(2)}`}
                />
              )}
            </svg>
          </span>
          <span className="inline-flex">
            <ProviderGlyph
              className="size-[14px]"
              displayName={instance.displayName}
              driverKind={instance.driverKind}
              size={14}
            />
          </span>
        </span>
      </OctantButton>
    </OctantPreviewCard>
  );
}

/** Every window of one account's plan: what is left of it and when it resets. */
function RailUsageCard(props: AccountUsageLine) {
  return (
    <div className="rail-usage-card">
      <div>
        <p className="rail-usage-card__title">{props.instance.displayName}</p>
        {props.age === undefined ? null : <span className="oct-meta">{props.age}</span>}
      </div>
      {props.windows.map((window) => (
        <div className="rail-usage-card__window" data-level={window.level} key={window.window}>
          <div className="rail-usage-card__head">
            <span className="oct-row-label">{window.name}</span>
            <span className="rail-usage-card__left">{window.standing}</span>
          </div>
          <span aria-hidden="true" className="rail-usage-card__bar">
            <span style={{ width: window.level === "spent" ? 0 : `${String(window.percent)}%` }} />
          </span>
          {window.reset === undefined ? null : <span className="oct-meta">{window.reset}</span>}
        </div>
      ))}
    </div>
  );
}
