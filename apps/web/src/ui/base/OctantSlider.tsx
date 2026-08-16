import { forwardRef, type ComponentProps } from "react";
import { Slider } from "../shadcn/slider";
import { cn } from "../shadcn/utils";

export type OctantSliderProps = Omit<ComponentProps<typeof Slider>, "type">;

/** Octant slider adapter over the owned shadcn Slider recipe. */
export const OctantSlider = forwardRef<HTMLInputElement, OctantSliderProps>(function OctantSlider(
  { className, ...props },
  ref,
) {
  return <Slider className={cn("window-no-drag", className)} ref={ref} {...props} />;
});
