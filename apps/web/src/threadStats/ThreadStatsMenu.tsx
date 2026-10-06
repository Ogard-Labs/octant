import { ChevronRight } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { useThreadStatsScope } from "./threadStatsScope";
import "./threadStats.css";

/**
 * The context meter's way to the thread's stats: the switch for the quiet line
 * and the per-turn detail. This is what keeps the detail reachable when the
 * line is hidden, and the switch reachable when there is no line to click.
 */
export function ThreadStatsMenu(props: { readonly onOpenDetail: () => void }) {
  const scope = useThreadStatsScope();
  if (scope.summary === undefined) return null;
  return (
    <div className="thread-stats-menu" data-testid="thread-stats-menu">
      <div className="thread-stats-menu__switch">
        <span>Stats line under the composer</span>
        <OctantSwitch
          checked={scope.lineVisible}
          label="Stats line under the composer"
          onCheckedChange={scope.setLineVisible}
        />
      </div>
      <OctantButton
        className="context-window-popover__footer-action"
        onClick={() => {
          props.onOpenDetail();
          scope.openDetail();
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <span>Turn details</span>
        <ChevronRight aria-hidden="true" size={14} />
      </OctantButton>
    </div>
  );
}
