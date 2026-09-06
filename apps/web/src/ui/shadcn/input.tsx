import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

/*
 * Radius stays `rounded-md`: 0070 pins the control radius and `--radius-md`
 * projects it. The style's own `rounded-lg` would be 12px here, two off.
 * No focus ring either — the global `:focus-visible` rule is the only keyboard
 * focus treatment, and a recipe that adds its own draws a second halo.
 */
export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return (
    <input
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm",
        className,
      )}
      data-slot="input"
      ref={ref}
      type={type}
      {...props}
    />
  );
});
