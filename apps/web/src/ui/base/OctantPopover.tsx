import { useCallback, type ReactNode } from "react";
import { buttonVariants } from "../shadcn/button";
import { cn } from "../shadcn/utils";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverPortal,
  PopoverPositioner,
  PopoverTitle,
  PopoverTrigger,
} from "../shadcn/popover";
import { OctantTooltip } from "./OctantTooltip";

export interface OctantPopoverProps {
  readonly align?: "start" | "center" | "end";
  readonly children: ReactNode;
  readonly className?: string;
  readonly description?: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly side?: "top" | "bottom";
  readonly sideOffset?: number;
  /**
   * Accessible name for the popup, rendered as an own sr-only heading. Omit
   * it and pass `titledBy` instead when the content already renders its own
   * visible heading — otherwise the two duplicate each other.
   */
  readonly title?: string;
  /** Id of an existing (usually visible) heading in `children` that already
   * names the popup; the adapter labels the popup with it instead of adding
   * its own sr-only title. */
  readonly titledBy?: string;
  /**
   * Reflects a toggleable product state the trigger represents (e.g. "a pool
   * is currently active"), distinct from the popup's own open/closed state,
   * which Base UI's trigger already exposes as `aria-expanded`.
   */
  readonly triggerAriaPressed?: boolean;
  readonly trigger: ReactNode;
  readonly triggerClassName?: string;
  /**
   * Extra `data-*` hooks for the trigger button (e.g. a non-default-state
   * marker, or a status the trigger's own styling keys off). Product state,
   * not the popover's own mechanism, so the adapter passes it through rather
   * than naming each one.
   */
  readonly triggerDataAttributes?: Readonly<Record<`data-${string}`, string | boolean>>;
  /** Points the trigger at extra descriptive text elsewhere in the DOM (e.g. a `sr-only` summary). */
  readonly triggerDescribedBy?: string;
  readonly triggerDisabled?: boolean;
  readonly triggerLabel: string;
  /** Adds a hover tooltip over the trigger, for a compact icon-only trigger the visible label alone won't identify. */
  readonly triggerTooltip?: ReactNode;
  /** Paints the trigger with the owned button recipe, so a custom-content trigger (icon, label, chevron) still reads as a button. */
  readonly triggerVariant?: "ghost" | "ghost-icon" | "outline";
}

/** Product-facing popover adapter over the owned shadcn/Base UI recipe. */
export function OctantPopover(props: OctantPopoverProps) {
  const { onOpenChange } = props;
  // Base UI's Popover calls this with a second, internal event-details
  // argument; a stable wrapper keeps the adapter's `(open: boolean) => void`
  // contract honest without giving Base UI a new function identity on every
  // render, which previously reset its own mount-transition tracking.
  const handleOpenChange = useCallback((open: boolean) => onOpenChange(open), [onOpenChange]);

  const variantClassName =
    props.triggerVariant === undefined
      ? undefined
      : buttonVariants({
          variant: props.triggerVariant === "ghost-icon" ? "ghost" : props.triggerVariant,
          size: props.triggerVariant === "ghost-icon" ? "icon" : undefined,
        });

  // A trigger painted from `buttonVariants` says which variant it wears, the
  // same way the button recipe does. Without it a ghost trigger is only
  // identifiable by the class string it happened to be given.
  const triggerButton = (
    <PopoverTrigger
      aria-label={props.triggerLabel}
      className={cn("window-no-drag", variantClassName, props.triggerClassName)}
      {...(props.triggerVariant === undefined
        ? {}
        : {
            "data-variant": props.triggerVariant === "ghost-icon" ? "ghost" : props.triggerVariant,
          })}
      title={props.triggerTooltip === undefined ? props.triggerLabel : undefined}
      {...props.triggerDataAttributes}
      {...(props.triggerAriaPressed === undefined
        ? {}
        : { "aria-pressed": props.triggerAriaPressed })}
      {...(props.triggerDescribedBy === undefined
        ? {}
        : { "aria-describedby": props.triggerDescribedBy })}
      {...(props.triggerDisabled === undefined ? {} : { disabled: props.triggerDisabled })}
    >
      {props.trigger}
    </PopoverTrigger>
  );

  return (
    <Popover onOpenChange={handleOpenChange} open={props.open}>
      {props.triggerTooltip === undefined ? (
        triggerButton
      ) : (
        <OctantTooltip label={props.triggerTooltip}>{triggerButton}</OctantTooltip>
      )}
      <PopoverPortal>
        <PopoverPositioner
          align={props.align ?? "start"}
          className="z-50 window-no-drag"
          side={props.side ?? "bottom"}
          sideOffset={props.sideOffset ?? 4}
        >
          <PopoverPopup
            className={props.className}
            {...(props.titledBy === undefined ? {} : { "aria-labelledby": props.titledBy })}
          >
            {props.titledBy !== undefined || props.title === undefined ? null : (
              <PopoverTitle className="sr-only">{props.title}</PopoverTitle>
            )}
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
