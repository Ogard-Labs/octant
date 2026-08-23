import type { ComponentProps, ReactNode } from "react";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectPortal,
  SelectPositioner,
  SelectTrigger,
  SelectValue,
} from "../shadcn/select";
import { cn } from "../shadcn/utils";

export {
  Select as OctantSelectRoot,
  SelectItem as OctantSelectItem,
  SelectPopup as OctantSelectPopup,
  SelectPortal as OctantSelectPortal,
  SelectPositioner as OctantSelectPositioner,
  SelectTrigger as OctantSelectTrigger,
  SelectValue as OctantSelectValue,
};

export interface OctantSelectOption {
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly id: string;
  readonly label: string;
}

export interface OctantSelectFieldProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly onValueChange: (value: string) => void;
  readonly options: ReadonlyArray<OctantSelectOption>;
  readonly placeholder?: ReactNode;
  readonly triggerClassName?: string;
  readonly value: string;
}

/**
 * Convenience select for product forms that previously used native `<select>`.
 * Compound primitives remain available for advanced layouts.
 */
export function OctantSelectField(props: OctantSelectFieldProps) {
  const selectedOption = props.options.find((option) => option.id === props.value);
  return (
    <Select
      disabled={props.disabled}
      onValueChange={(value) => {
        if (typeof value === "string") {
          props.onValueChange(value);
        }
      }}
      value={props.value}
    >
      <SelectTrigger
        aria-label={props["aria-label"]}
        className={cn("window-no-drag", props.triggerClassName, props.className)}
        id={props.id}
      >
        <SelectValue placeholder={props.placeholder}>{selectedOption?.label}</SelectValue>
      </SelectTrigger>
      <SelectPortal>
        <SelectPositioner className="z-50 outline-none window-no-drag" sideOffset={4}>
          <SelectPopup>
            {props.options.map((option) => (
              <SelectItem
                disabled={option.disabled}
                key={option.id}
                title={option.disabledReason}
                value={option.id}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </SelectPositioner>
      </SelectPortal>
    </Select>
  );
}

export type OctantNativeSelectProps = ComponentProps<"select">;

/**
 * Styled native select for dense forms where Base UI Select would fight
 * existing label/CSS structure (settings grids). Prefer SelectField for new UI.
 */
export function OctantNativeSelect({ className, ...props }: OctantNativeSelectProps) {
  return (
    <select
      className={cn(
        "flex h-8 w-full rounded-md border border-input bg-secondary px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 window-no-drag",
        className,
      )}
      {...props}
    />
  );
}
