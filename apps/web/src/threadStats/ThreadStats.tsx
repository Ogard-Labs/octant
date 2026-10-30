import { threadStats, threadStatsInputOf, type ThreadStat } from "@octant/domain";
import { EyeOff } from "lucide-react";
import { useMemo } from "react";
import { useComposerContextMeterScope } from "../context/composerContextMeterScope";
import { composerLimitWindows, type ComposerLimitWindow } from "../context/composerLimitWindows";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { PlanUsageMeters } from "../usage/PlanUsageMeters";
import { useThreadStatsScope } from "./threadStatsScope";
import "./threadStats.css";

/**
 * The thread's quiet stats line under the composer. It reads the host's
 * recorded turns, so every provider and mode shows the same figures worded by
 * one shared module. Where the provider's account windows have a place of
 * their own ({@link ThreadPlanWindows} in the strip above a thread's box),
 * `windows={false}` leaves them out; elsewhere they lead the line, so a person
 * sees how much of the 5-hour or weekly limit is left without opening the
 * meter. It is the first thing to go when there is nothing honest to say: a
 * provider that reported neither usage nor limits shows no line, and the
 * per-turn detail is still reachable from the context meter.
 */
export function ThreadStats(props: { readonly windows?: boolean }) {
  const scope = useThreadStatsScope();
  const meter = useComposerContextMeterScope();
  const stats = useMemo(
    () => (scope.summary === undefined ? [] : threadStats(threadStatsInputOf(scope.summary))),
    [scope.summary],
  );
  // The line belongs to the active pane only. The turn figures and the meter's
  // limits come from one shell-wide scope, so an inactive split pane would
  // otherwise show another thread's figures and provider capacity.
  if (!meter.visible) return null;
  const limits = props.windows === false ? [] : currentLimitWindows(meter);
  const showLine = scope.lineVisible && (stats.length > 0 || limits.length > 0);
  return showLine ? (
    <ThreadStatsLine limits={limits} onHide={() => scope.setLineVisible(false)} stats={stats} />
  ) : null;
}

/**
 * The provider's remaining plan usage for a thread, right-aligned in the strip
 * above its box, as the start screen shows it beside where a new thread runs.
 * The stats line's switch hides the figures under the box, not these meters:
 * the start screen offers no way to hide them either. Active pane only, for the
 * same reason as the line.
 */
export function ThreadPlanWindows() {
  const meter = useComposerContextMeterScope();
  if (!meter.visible) return null;
  const limits = currentLimitWindows(meter);
  if (limits.length === 0) return null;
  return (
    <div className="thread-plan-windows">
      <PlanUsageMeters windows={limits} />
    </div>
  );
}

/**
 * Read on every render, not memoized: a window whose reset passes must drop
 * out when the next render comes, not stay until the figures change.
 */
function currentLimitWindows(
  meter: ReturnType<typeof useComposerContextMeterScope>,
): ReadonlyArray<ComposerLimitWindow> {
  return composerLimitWindows({
    now: Date.now(),
    snapshot: meter.snapshot,
    fallback: meter.fallback,
  });
}

function ThreadStatsLine(props: {
  readonly limits: ReadonlyArray<ComposerLimitWindow>;
  readonly onHide: () => void;
  readonly stats: ReadonlyArray<ThreadStat>;
}) {
  const scope = useThreadStatsScope();
  const described = [
    ...props.limits.map((limit) => `${limit.name} ${String(limit.percent)}% left`),
    ...props.stats.map((stat) => stat.label),
  ];
  const content = (
    <>
      <PlanUsageMeters windows={props.limits} />
      {props.limits.length > 0 && props.stats.length > 0 ? (
        <span aria-hidden="true" className="thread-stats__separator">
          {" · "}
        </span>
      ) : null}
      {props.stats.length === 0 ? null : (
        // Each figure draws its own leading dot, and this box clips whatever
        // sits at its left edge, so a wrapped line never opens on a lone
        // separator (seen with the dock open beside a thread).
        <span className="thread-stats__figures">
          <span className="thread-stats__figures-row">
            {props.stats.map((stat) =>
              stat.hint === undefined ? (
                <span className="thread-stats__item" key={stat.key}>
                  {stat.text}
                </span>
              ) : (
                <OctantTooltip key={stat.key} label={stat.hint} side="top">
                  <span className="thread-stats__item" data-hinted="true">
                    {stat.text}
                  </span>
                </OctantTooltip>
              ),
            )}
          </span>
        </span>
      )}
    </>
  );
  return (
    <div className="thread-stats" data-testid="thread-stats-line">
      {/* Without a recorded turn there is no turn detail to open, so the line is a
          plain group rather than a button that does nothing when pressed. */}
      {scope.summary === undefined ? (
        <div
          aria-label={`Thread stats: ${described.join(", ")}`}
          className="thread-stats__line"
          role="group"
        >
          {content}
        </div>
      ) : (
        <OctantButton
          aria-label={`Thread stats: ${described.join(", ")}. Open turn details`}
          className="thread-stats__line"
          onClick={scope.openDetail}
          type="button"
          variant="bare"
        >
          {content}
        </OctantButton>
      )}
      <OctantButton
        aria-label="Hide stats line"
        className="thread-stats__hide"
        onClick={props.onHide}
        size="icon-xs"
        title="Hide stats line"
        type="button"
        variant="ghost"
      >
        <EyeOff aria-hidden="true" size={12} />
      </OctantButton>
    </div>
  );
}
