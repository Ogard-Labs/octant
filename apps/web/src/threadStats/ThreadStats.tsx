import { threadStats, threadStatsInputOf } from "@octant/domain";
import { ChevronRight } from "../ui/icons";
import { useMemo } from "react";
import { useComposerContextMeterScope } from "../context/composerContextMeterScope";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
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
