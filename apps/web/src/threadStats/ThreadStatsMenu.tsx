import { ChevronRight } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { useThreadStatsScope } from "./threadStatsScope";
import "./threadStats.css";

/** The context meter's way to the thread's per-turn detail. */
export function ThreadStatsMenu(props: { readonly onOpenDetail: () => void }) {
  const scope = useThreadStatsScope();
  if (scope.summary === undefined) return null;
  return (
    <div className="thread-stats-menu" data-testid="thread-stats-menu">
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
