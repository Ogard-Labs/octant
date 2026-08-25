import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

const separatorVariants = cva("shrink-0 bg-border", {
  variants: {
    orientation: {
      horizontal: "h-px w-full",
      vertical: "h-full w-px",
    },
  },
  defaultVariants: { orientation: "horizontal" },
});

export type SeparatorProps = ComponentProps<"div"> & VariantProps<typeof separatorVariants>;

export function Separator({ className, orientation, ...props }: SeparatorProps) {
  return (
    <div
      aria-orientation={orientation ?? "horizontal"}
      className={cn(separatorVariants({ orientation }), className)}
      data-slot="separator"
      role="separator"
      {...props}
    />
  );
}

/** A labeled rule — a line, a piece of text, a line — for marking a boundary inline in a content stream. */
export function SeparatorWithLabel({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground before:h-px before:flex-1 before:shrink before:grow before:basis-auto before:bg-border before:content-[''] after:h-px after:flex-1 after:shrink after:grow after:basis-auto after:bg-border after:content-['']",
        className,
      )}
      data-slot="separator-label"
      role="separator"
      {...props}
    >
      {children}
    </div>
  );
}
