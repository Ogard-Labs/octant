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
  onFocus,
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
      onFocus={(event) => {
        onFocus?.(event);
        // Base UI's CompositeRoot selects all text inside any descendant native
        // input on focus; prevent that so refocusing a custom-answer field never
        // overwrites the person's text on the next keystroke.
        if (isEditableTarget(event.target)) {
          event.preventBaseUIHandler();
        }
      }}
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event);
        if (
          isEditableTarget(event.target) &&
          (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")
        ) {
          event.preventBaseUIHandler();
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          isEditableTarget(event.target) &&
          (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")
        ) {
          event.preventBaseUIHandler();
          return;
        }
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
  disabled,
  onKeyDown,
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
        : buttonVariants({ variant: "bare" });
  return (
    <RadioPrimitive.Root<Value>
      className={cn(buttonStyle, className)}
      data-slot="radio-group-item"
      disabled={disabled}
      nativeButton
      onKeyDown={(event) => {
        onKeyDown?.(event);
        // Base UI's RadioRoot suppresses Enter even on native buttons; restore
        // Enter selection for focused radio choices unless the caller already
        // handled the key (for example closing an ink-picker popover).
        if (
          !event.defaultPrevented &&
          disabled !== true &&
          event.key === "Enter" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      render={<button type="button" />}
      {...props}
    />
  );
}
