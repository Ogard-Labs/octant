import { threadStats, threadStatsInputOf, type ThreadStat } from "@octant/domain";
import { EyeOff } from "lucide-react";
import { Fragment, useMemo } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { useThreadStatsScope } from "./threadStatsScope";
import "./threadStats.css";

/**
 * The thread's quiet stats line under the composer. It reads the host's
 * recorded turns, so every provider and mode shows the same figures worded by
 * one shared module. It is the first thing to go when there is nothing honest
 * to say: a provider that reported no usage shows no line, and the per-turn
 * detail is still reachable from the context meter.
 */
export function ThreadStats() {
  const scope = useThreadStatsScope();
  const stats = useMemo(() => threadStats(threadStatsInputOf(scope.summary)), [scope.summary]);
  const showLine = scope.summary !== undefined && scope.lineVisible && stats.length > 0;
  return showLine ? (
    <ThreadStatsLine onHide={() => scope.setLineVisible(false)} stats={stats} />
  ) : null;
}

function ThreadStatsLine(props: {
  readonly onHide: () => void;
  readonly stats: ReadonlyArray<ThreadStat>;
}) {
  const scope = useThreadStatsScope();
  return (
    <div className="thread-stats" data-testid="thread-stats-line">
      <OctantButton
        aria-label={`Thread stats: ${props.stats.map((stat) => stat.label).join(", ")}. Open turn details`}
        className="thread-stats__line"
        onClick={scope.openDetail}
        type="button"
        variant="bare"
      >
        {props.stats.map((stat, index) => (
          <Fragment key={stat.key}>
            {index === 0 ? null : (
              <span aria-hidden="true" className="thread-stats__separator">
                {" · "}
              </span>
            )}
            {stat.hint === undefined ? (
              <span className="thread-stats__item">{stat.text}</span>
            ) : (
              <OctantTooltip label={stat.hint} side="top">
                <span className="thread-stats__item" data-hinted="true">
                  {stat.text}
                </span>
              </OctantTooltip>
            )}
          </Fragment>
        ))}
      </OctantButton>
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
