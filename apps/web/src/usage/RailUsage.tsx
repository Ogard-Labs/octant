import { lazy, Suspense, type ComponentType } from "react";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPreviewCard } from "../ui/base/OctantPreviewCard";
import { railUsageLines, useAccountUsage, type AccountUsageLine } from "./accountUsage";
import { usePlanUsageReading } from "./PlanUsageContext";
import { readingAgePhrase, resetPhrase, windowHours } from "./railUsageReading";
import type { RailUsageCardProps } from "./RailUsageCard";

/** The ring's radius in its 26px box: a 2px stroke that ends on the box's edge. */
const RING_RADIUS = 12;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const TRACK = "color-mix(in oklab, var(--oct-fg) 12%, transparent)";
/**
 * The arc is the meta ink, so a healthy plan is as quiet as the rail's icons; a
 * window close to its limit takes the warning ink. A spent one draws no arc (a
 * provider can call a window exhausted with a few percent unused, and that
 * sliver would read as plan still left) over a track in the danger ink, held
 * back so the empty ring cannot read as a full one.
 */
const RING_INK = {
  ok: { track: TRACK, arc: "color-mix(in oklab, var(--oct-fg) 50%, transparent)" },
  near: { track: TRACK, arc: "var(--oct-warn-fg)" },
  spent: { track: "color-mix(in oklab, var(--oct-danger-fg) 55%, transparent)", arc: "none" },
} as const;

/**
 * The card and its styles load on the first approach to a ring. One that cannot
 * load names the account and its windows in a line instead: thrown out of
 * render, the failure would take the whole window down for a hover. Awaited in
 * a try for the reason `importThreadRowInfoCard` is.
 */
async function importRailUsageCard(): Promise<{
  readonly default: ComponentType<RailUsageCardProps>;
}> {
  try {
    const module = await import("./RailUsageCard");
    return { default: module.RailUsageCard };
  } catch {
    return {
      default: (card) => (
        <span>
          {card.title},{" "}
          {card.windows
            .map((window) => `${window.name} ${String(window.percent)}% left`)
            .join(", ")}
        </span>
      ),
    };
  }
}
let railUsageCard: ReturnType<typeof importRailUsageCard> | undefined;
const loadRailUsageCard = () => (railUsageCard ??= importRailUsageCard());
const RailUsageCard = lazy(loadRailUsageCard);

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
  // The foot's own column, so the rings and the face keep one spacing.
  return (
    <div aria-label="Plan usage" className="sidebar-rail__foot" role="group">
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
  const ink = RING_INK[lowest.level];
  return (
    <OctantPreviewCard
      align="end"
      content={
        <Suspense fallback={null}>
          <RailUsageCard
            {...(age === undefined ? {} : { age })}
            title={instance.displayName}
            windows={windows.map((window) => {
              const reset = resetPhrase(reading.resetsAt.get(window.window), now);
              return {
                id: window.window,
                name: window.name,
                percent: window.percent,
                level: window.level,
                ...(reset === undefined ? {} : { reset }),
              };
            })}
          />
        </Suspense>
      }
      label={`${instance.displayName} plan usage`}
      onApproach={() => void loadRailUsageCard()}
      side="right"
    >
      <OctantButton
        aria-label={`${instance.displayName} plan usage, ${summary}`}
        className="sidebar-rail__button window-no-drag hover:no-underline"
        onClick={props.onOpenUsage}
        type="button"
        variant="rail"
      >
        <span aria-hidden="true" className="sidebar-rail__face">
          {/* Wrapped, so the rail's 16px glyph rule, which reaches the face's own
              svg children, sizes neither the ring nor the mark. */}
          <span className="absolute inline-flex">
            <svg
              fill="none"
              strokeWidth={2}
              style={{ width: 26, height: 26, transform: "rotate(-90deg)" }}
              viewBox="0 0 26 26"
            >
              <circle cx="13" cy="13" r={RING_RADIUS} style={{ stroke: ink.track }} />
              <circle
                cx="13"
                cy="13"
                r={RING_RADIUS}
                strokeDasharray={`${((RING_LENGTH * lowest.percent) / 100).toFixed(2)} ${RING_LENGTH.toFixed(2)}`}
                strokeLinecap="round"
                style={{ stroke: ink.arc }}
              />
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
