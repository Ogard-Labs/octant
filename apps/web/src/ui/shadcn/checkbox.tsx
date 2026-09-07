import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * A styled native checkbox rather than the style's Base UI composition.
 *
 * The composition renders a button, and a `<label>` only names a labelable
 * element, so wrapping one the way every call site here does leaves the control
 * with no accessible name. The style solves that with a Field system this repo
 * does not have; swapping without it silently unnamed nine surfaces.
 *
 * `appearance: none` still buys the thing that mattered: `accent-color` let the
 * browser draw its own checkbox, so the operating system's control appeared in
 * the middle of Octant's surfaces and ignored the theme. The mark below is
 * drawn from theme tokens instead.
 */
export function Checkbox({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "octant-checkbox size-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-input bg-transparent outline-none transition-colors checked:border-primary checked:bg-primary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      data-slot="checkbox"
      type="checkbox"
      {...props}
    />
  );
}
