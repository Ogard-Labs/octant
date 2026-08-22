import type { SettingsDeepLink } from "@octant/contracts";
import type { RefObject } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import { NavigatorPanel } from "./NavigatorPanel";
import type { NavigatorAssistantController } from "./useNavigatorAssistant";

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
  if (!props.open) return null;
  return (
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
  );
}
