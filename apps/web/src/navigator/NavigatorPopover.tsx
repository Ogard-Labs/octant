import type { SettingsDeepLink } from "@octant/contracts";
import { lazy, Suspense, type RefObject } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import type { NavigatorAssistantController } from "./useNavigatorAssistant";

// Opened from a menu or a shortcut, so its composer stays out of the first bundle.
const NavigatorPanel = lazy(() =>
  import("./NavigatorPanel").then((module) => ({ default: module.NavigatorPanel })),
);

export interface NavigatorPopoverProps {
  readonly controller: NavigatorAssistantController;
  readonly onClose: () => void;
  readonly onOpenSettings: (target: SettingsDeepLink) => void;
  readonly open: boolean;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/**
 * Host-owned Navigator as an app-wide popover. Opening it never changes the
 * active Project or thread; the conversation is the host's, not a pane's.
 */
export function NavigatorPopover(props: NavigatorPopoverProps) {
  return (
    <OctantDialogPresence>
      {props.open ? (
        // Outside the dialog, so it opens once with its panel and focuses into it.
        <Suspense fallback={null}>
          <OctantDialog
            className="navigator-popover"
            label="Navigator"
            onClose={props.onClose}
            open
            popupId="navigator-popover"
            {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
          >
            <NavigatorPanel
              controller={props.controller}
              onClose={props.onClose}
              onOpenSettings={props.onOpenSettings}
            />
          </OctantDialog>
        </Suspense>
      ) : null}
    </OctantDialogPresence>
  );
}
