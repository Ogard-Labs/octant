import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

export const Slider = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Slider(
  { className, ...props },
  ref,
) {
  return (
    <input
      className={cn(
        "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary outline-none accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      type="range"
      {...props}
    />
  );
});
