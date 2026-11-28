import type { ComponentProps } from "react";
import { RadioGroup, RadioGroupItem, type RadioGroupItemProps } from "../shadcn/radio-group";
import { cn } from "../shadcn/utils";
import { chooseByNumber } from "./radioGroupKeys";

export type OctantRadioGroupProps<Value extends string = string> = ComponentProps<
  typeof RadioGroup<Value>
> & {
  /** When true, keys 1–9 choose the matching option by position when not typing in a field. */
  readonly numberShortcuts?: boolean | undefined;
};

/**
 * Shared radio group adapter over Base UI RadioGroup + Radio.
 * Provides roving tabindex (Tab lands once on the active option), Arrow/Home/End
 * movement with selection on focus, and automatic skipping of disabled options.
 */
export function OctantRadioGroup<Value extends string = string>({
  className,
  numberShortcuts = false,
  onKeyDown,
  ...props
}: OctantRadioGroupProps<Value>) {
  return (
    <RadioGroup<Value>
      className={cn("window-no-drag", className)}
      onKeyDown={(event) => {
        if (numberShortcuts) chooseByNumber(event);
        onKeyDown?.(event);
      }}
      {...props}
    />
  );
}

export type OctantRadioGroupItemProps<Value extends string = string> = RadioGroupItemProps<Value>;

export function OctantRadioGroupItem<Value extends string = string>({
  className,
  ...props
}: OctantRadioGroupItemProps<Value>) {
  return <RadioGroupItem<Value> className={cn("window-no-drag", className)} {...props} />;
}
