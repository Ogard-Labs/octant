import type { ComponentProps } from "react";
import { ToggleGroup, ToggleGroupItem } from "../shadcn/toggle-group";
import { cn } from "../shadcn/utils";

export function OctantToggleGroup<Value extends string>({
  className,
  ...props
}: ComponentProps<typeof ToggleGroup<Value>>) {
  return <ToggleGroup<Value> className={cn("window-no-drag", className)} {...props} />;
}

export function OctantToggleGroupItem<Value extends string>({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupItem<Value>>) {
  return <ToggleGroupItem<Value> className={cn("window-no-drag", className)} {...props} />;
}
