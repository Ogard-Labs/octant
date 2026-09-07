import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * The lean five primitives, not the style's full field system: its version
 * needs a Label component this repo does not have and adds a selectable-card
 * treatment nothing here asks for. Spacing follows the style down a notch,
 * and the label leads `snug` rather than `none` so descenders survive.
 *
 * Disabled is read as presence (`data-disabled:`), which is what Base UI
 * writes; the style's `data-[disabled=true]` form would match nothing here.
 */

export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-4", className)} data-slot="field-group" {...props} />
  );
}

export function Field({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("group/field flex flex-col gap-1.5 data-disabled:opacity-50", className)}
      data-slot="field"
      {...props}
    />
  );
}

export function FieldLabel({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn("flex w-fit items-center gap-2 text-sm leading-snug font-medium", className)}
      data-slot="field-label"
      {...props}
    />
  );
}

export function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("m-0 text-sm leading-normal text-muted-foreground", className)}
      data-slot="field-description"
      {...props}
    />
  );
}

export function FieldError({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("m-0 text-sm font-normal text-destructive", className)}
      data-slot="field-error"
      role="alert"
      {...props}
    />
  );
}
