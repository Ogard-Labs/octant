import type { ComponentProps } from "react";
import { Checkbox } from "../shadcn/checkbox";
import { cn } from "../shadcn/utils";

export type OctantCheckboxProps = Omit<ComponentProps<typeof Checkbox>, "type">;

/** Octant checkbox adapter over the owned shadcn Checkbox recipe. */
export function OctantCheckbox({ className, ...props }: OctantCheckboxProps) {
  return <Checkbox className={cn("window-no-drag", className)} {...props} />;
}
