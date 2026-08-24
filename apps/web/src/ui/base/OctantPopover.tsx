import type { ReactNode } from "react";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverPortal,
  PopoverPositioner,
  PopoverTitle,
  PopoverTrigger,
} from "../shadcn/popover";

export interface OctantPopoverProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly description?: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly trigger: ReactNode;
  readonly triggerLabel: string;
}

/** Product-facing popover adapter over the owned shadcn/Base UI recipe. */
export function OctantPopover(props: OctantPopoverProps) {
  return (
    <Popover onOpenChange={props.onOpenChange} open={props.open}>
      <PopoverTrigger
        aria-expanded={props.open}
        aria-label={props.triggerLabel}
        className="window-no-drag"
        title={props.triggerLabel}
      >
        {props.trigger}
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverPositioner
          align="start"
          className="z-50 window-no-drag"
          side="bottom"
          sideOffset={4}
        >
          <PopoverPopup className={props.className}>
            <PopoverTitle className="sr-only">{props.title}</PopoverTitle>
            {props.description === undefined ? null : (
              <PopoverDescription className="sr-only">{props.description}</PopoverDescription>
            )}
            {props.children}
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </Popover>
  );
}
