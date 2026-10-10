import { threadStats, threadStatsInputOf, type ThreadStat } from "@octant/domain";
import { EyeOff } from "lucide-react";
import { Fragment, useMemo } from "react";
import { useComposerContextMeterScope } from "../context/composerContextMeterScope";
import { composerLimitWindows, type ComposerLimitWindow } from "../context/composerLimitWindows";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { useThreadStatsScope } from "./threadStatsScope";
import "./threadStats.css";

/**
 * The thread's quiet stats line under the composer. It reads the host's
 * recorded turns, so every provider and mode shows the same figures worded by
 * one shared module. The provider's account windows lead the line when it
 * reported any, so a person sees how much of the 5-hour or weekly limit is
 * left without opening the meter. It is the first thing to go when there is
 * nothing honest to say: a provider that reported neither usage nor limits
 * shows no line, and the per-turn detail is still reachable from the context
 * meter.
 */
export function ThreadStats() {
  const scope = useThreadStatsScope();
  const meter = useComposerContextMeterScope();
  const stats = useMemo(
    () => (scope.summary === undefined ? [] : threadStats(threadStatsInputOf(scope.summary))),
    [scope.summary],
  );
  // Read on every render, not memoized: a window whose reset passes must drop
  // out of the line when the next render comes, not stay until the figures change.
  const limits = composerLimitWindows({
    now: Date.now(),
    snapshot: meter.snapshot,
    fallback: meter.fallback,
  });
  const showLine = scope.lineVisible && (stats.length > 0 || limits.length > 0);
  return showLine ? (
    <ThreadStatsLine limits={limits} onHide={() => scope.setLineVisible(false)} stats={stats} />
  ) : null;
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
  return (
    <div className="thread-stats" data-testid="thread-stats-line">
      <OctantButton
        aria-label={`Thread stats: ${described.join(", ")}. Open turn details`}
        className="thread-stats__line"
        onClick={scope.openDetail}
        type="button"
        variant="bare"
      >
        {props.limits.map((limit, index) => (
          <Fragment key={limit.window}>
            {index === 0 ? null : (
              <span aria-hidden="true" className="thread-stats__separator">
                {" · "}
              </span>
            )}
            <OctantTooltip label={`${limit.name}, ${String(limit.percent)}% left`} side="top">
              <span className="thread-stats__limit" data-level={limit.level}>
                <span className="thread-stats__limit-name">{limit.short}</span>
                <span aria-hidden="true" className="thread-stats__limit-meter">
                  <span style={{ width: `${String(limit.percent)}%` }} />
                </span>
                <span className="thread-stats__item">{`${String(limit.percent)}%`}</span>
              </span>
            </OctantTooltip>
          </Fragment>
        ))}
        {props.limits.length > 0 && props.stats.length > 0 ? (
          <span aria-hidden="true" className="thread-stats__separator">
            {" · "}
          </span>
        ) : null}
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
