import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

export const Slider = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Slider(
  { className, ...props },
  ref,
) {
  return (
    <input
      className={cn(
        "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      data-slot="slider"
      ref={ref}
      type="range"
      {...props}
    />
  );
});
