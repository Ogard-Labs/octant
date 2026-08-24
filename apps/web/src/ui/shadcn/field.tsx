import type { ComponentProps } from "react";
import { cn } from "./utils";

export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-5", className)} data-slot="field-group" {...props} />
  );
}

export function Field({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("group/field flex flex-col gap-2 data-disabled:opacity-50", className)}
      data-slot="field"
      {...props}
    />
  );
}

export function FieldLabel({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn("flex items-center gap-2 text-sm leading-none font-medium", className)}
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
