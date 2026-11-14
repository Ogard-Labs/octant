import { Toggle } from "@base-ui/react/toggle";
import {
  ToggleGroup as ToggleGroupPrimitive,
  type ToggleGroupProps,
} from "@base-ui/react/toggle-group";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupProps<Value>) {
  return (
    <ToggleGroupPrimitive<Value>
      className={cn("inline-flex w-fit items-center rounded-lg bg-(--oct-fill-4) p-[2px]", className)}
      data-slot="toggle-group"
      {...props}
    />
  );
}

export function ToggleGroupItem<Value extends string>({
  className,
  ...props
}: ComponentProps<typeof Toggle<Value>>) {
  return (
    <Toggle<Value>
      className={cn(
        "inline-flex h-[round(1.846rem,2px)] cursor-default items-center justify-center gap-1 rounded-sm border border-transparent px-2 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground data-pressed:bg-(--oct-fill-2) data-pressed:text-foreground disabled:pointer-events-none disabled:cursor-default disabled:opacity-(--oct-disabled-opacity)",
        className,
      )}
      data-slot="toggle-group-item"
      {...props}
    />
  );
}
