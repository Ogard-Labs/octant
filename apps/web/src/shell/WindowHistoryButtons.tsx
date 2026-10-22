import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "./IconButton";
import type { WindowHistory } from "./windowHistory";

/**
 * Back and forward through the pages and tabs this window opened. They sit in
 * the title band beside the sidebar control, where a Mac window keeps its
 * navigation, and stay in place (disabled) at either end so the band does not
 * shift as history grows.
 */
export function WindowHistoryButtons(props: {
  readonly history: WindowHistory;
  readonly className?: string;
}) {
  return (
    <>
      <IconButton
        className={props.className}
        disabled={!props.history.canGoBack}
        icon={ChevronLeft}
        label="Back"
        onClick={props.history.goBack}
      />
      <IconButton
        className={props.className}
        disabled={!props.history.canGoForward}
        icon={ChevronRight}
        label="Forward"
        onClick={props.history.goForward}
      />
    </>
  );
}
