import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Checkbox({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded-[3px] border border-input bg-secondary accent-[var(--octant-focus-ring)] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      type="checkbox"
      {...props}
    />
  );
}
