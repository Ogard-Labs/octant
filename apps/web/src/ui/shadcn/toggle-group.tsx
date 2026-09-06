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
      className={cn("inline-flex w-fit items-center rounded-lg bg-muted p-[3px]", className)}
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
        "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-[color,box-shadow] hover:text-foreground data-pressed:bg-(--oct-fg-soft) data-pressed:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      data-slot="toggle-group-item"
      {...props}
    />
  );
}
