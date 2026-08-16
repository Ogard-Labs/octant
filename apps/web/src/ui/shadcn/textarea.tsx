import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        className={cn(
          "flex min-h-16 w-full rounded-md border border-input bg-secondary px-2.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
