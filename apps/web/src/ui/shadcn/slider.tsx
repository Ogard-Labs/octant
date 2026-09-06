import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

/*
 * A styled native range rather than the style's Base UI composition, for the
 * same reason as the checkbox: the composition is not a labelable element, and
 * every caller here names it with a wrapping `<label>`.
 *
 * `appearance: none` drops the thumb the browser drew for itself, which
 * `accent-color` could tint but not shape, so it read as an operating-system
 * control. The thumb is drawn from theme tokens in `components.css`.
 */

export const Slider = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Slider(
  { className, ...props },
  ref,
) {
  return (
    <input
      className={cn(
        "octant-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      data-slot="slider"
      ref={ref}
      type="range"
      {...props}
    />
  );
});
