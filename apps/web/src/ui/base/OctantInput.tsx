import { forwardRef, type ComponentProps } from "react";
import { Input } from "../shadcn/input";
import { cn } from "../shadcn/utils";

export type OctantInputProps = ComponentProps<typeof Input>;

/** Octant input adapter over the owned shadcn Input recipe. */
export const OctantInput = forwardRef<HTMLInputElement, OctantInputProps>(function OctantInput(
  { className, ...props },
  ref,
) {
  return <Input className={cn("window-no-drag", className)} ref={ref} {...props} />;
});
