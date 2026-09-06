import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Checkbox({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded-[4px] border border-input bg-transparent accent-primary shadow-xs outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      data-slot="checkbox"
      type="checkbox"
      {...props}
    />
  );
}
