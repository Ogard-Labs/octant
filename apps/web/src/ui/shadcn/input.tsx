import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return (
    <input
      className={cn(
        "flex h-8 w-full rounded-md border border-input bg-secondary px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    />
  );
});
