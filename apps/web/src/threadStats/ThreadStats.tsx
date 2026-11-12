import { threadStats, threadStatsInputOf } from "@octant/domain";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useComposerContextMeterScope } from "../context/composerContextMeterScope";
import { composerLimitWindows, type ComposerLimitWindow } from "../context/composerLimitWindows";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { PlanUsageMeters } from "../usage/PlanUsageMeters";
import { useThreadStatsScope } from "./threadStatsScope";
import "./threadStats.css";

/**
 * The thread's turn figures, as one compact block at the top of the Thread info
 * panel. They read the host's recorded turns, so every provider and mode shows
 * the same figures worded by one shared module. They are not drawn under the
 * composer: with the row of controls and a card, that made four layers under
 * a chip. It shows nothing when there is nothing honest to say (a provider
 * that reported neither usage nor timing), and the per-turn detail opens from
 * the block's own link and from the context meter. Active pane only: the
 * figures come from one shell-wide scope, so an inactive split pane would
 * otherwise show another thread's figures.
 */
export function ThreadStatsBlock() {
  const scope = useThreadStatsScope();
  const meter = useComposerContextMeterScope();
  const stats = useMemo(
    () => (scope.summary === undefined ? [] : threadStats(threadStatsInputOf(scope.summary))),
    [scope.summary],
  );
  if (!meter.visible || stats.length === 0) return null;
  return (
    <div
      aria-label={`Thread stats: ${stats.map((stat) => stat.label).join(", ")}`}
      className="thread-stats"
      data-testid="thread-stats-block"
      role="group"
    >
      <span className="thread-stats__figures">
        <span className="thread-stats__figures-row">
          {stats.map((stat) =>
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
      {scope.summary === undefined ? null : (
        <OctantButton
          className="thread-stats__details"
          onClick={scope.openDetail}
          size="sm"
          type="button"
          variant="ghost"
        >
          <span>Turn details</span>
          <ChevronRight aria-hidden="true" size={14} />
        </OctantButton>
      )}
    </div>
  );
}

/**
 * The provider's remaining plan usage for a thread, right-aligned in the strip
 * above its box, as the start screen shows it beside where a new thread runs.
 * The start screen offers no way to hide them either. Active pane only, for the
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
