import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  RadioGroup as RadioGroupPrimitive,
  type RadioGroupProps,
} from "@base-ui/react/radio-group";
import type { ComponentProps, KeyboardEvent } from "react";
import { buttonVariants, type ButtonProps } from "./button";
import { cn } from "./utils";

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.matches(
      'input:not([type="radio"]):not([type="checkbox"]), textarea, [contenteditable="true"]',
    )
  );
}

function handleRadioGroupHomeEnd(event: KeyboardEvent<HTMLDivElement>): void {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableTarget(event.target)
  ) {
    return;
  }
  if (event.key !== "Home" && event.key !== "End") return;
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  ).filter((radio) => !radio.matches(':disabled, [aria-disabled="true"]'));
  const target = event.key === "Home" ? radios[0] : radios.at(-1);
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
  target.click();
}

export type ShadcnRadioGroupProps<Value extends string = string> = RadioGroupProps<Value> & {
  /** `"segmented"` renders the pill rail matching ToggleGroup with radio keyboard semantics. */
  readonly appearance?: "bare" | "segmented";
};

export function RadioGroup<Value extends string = string>({
  appearance = "bare",
  className,
  onKeyDown,
  onKeyDownCapture,
  ...props
}: ShadcnRadioGroupProps<Value>) {
  return (
    <RadioGroupPrimitive<Value>
      className={cn(
        appearance === "segmented" &&
          "inline-flex w-fit items-center rounded-lg bg-(--oct-fill-4) p-[2px]",
        className,
      )}
      data-slot="radio-group"
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event);
        if (
          isEditableTarget(event.target) &&
          (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")
        ) {
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        handleRadioGroupHomeEnd(event);
      }}
      {...props}
    />
  );
}

export type RadioGroupItemProps<Value extends string = string> = Omit<
  ComponentProps<typeof RadioPrimitive.Root<Value>>,
  "nativeButton" | "render"
> & {
  readonly appearance?: "bare" | "segmented";
  readonly variant?: ButtonProps["variant"];
  readonly size?: ButtonProps["size"];
};

export function RadioGroupItem<Value extends string = string>({
  appearance = "bare",
  className,
  size,
  variant,
  ...props
}: RadioGroupItemProps<Value>) {
  const buttonStyle =
    variant !== undefined || size !== undefined
      ? buttonVariants({
          variant: variant ?? "bare",
          ...(size === undefined ? {} : { size }),
        })
      : appearance === "segmented"
        ? "inline-flex h-[round(1.714rem,2px)] cursor-default items-center justify-center gap-1 rounded-sm border border-transparent px-2 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground data-checked:bg-(--oct-fill-2) data-checked:text-foreground disabled:pointer-events-none disabled:cursor-default disabled:opacity-(--oct-disabled-opacity)"
        : "cursor-default outline-none disabled:cursor-default disabled:opacity-(--oct-disabled-opacity)";
  return (
    <RadioPrimitive.Root<Value>
      className={cn(buttonStyle, className)}
      data-slot="radio-group-item"
      nativeButton
      render={<button type="button" />}
      {...props}
    />
  );
}
