import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * The badge stays an outline-only status label rather than the style's filled
 * pill: it marks state next to a row of text, and a filled pill at that size
 * reads as a button. Padding tightens beside an icon the way the style does.
 * No focus ring here either — the global `:focus-visible` rule owns that.
 */

const badgeVariants = cva(
  "inline-flex min-h-4 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[4px] border px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap transition-colors has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-border bg-transparent text-foreground",
        secondary: "border-transparent bg-transparent text-muted-foreground",
        destructive: "border-destructive/30 bg-transparent text-destructive",
        outline: "border-border bg-transparent text-foreground",
        success:
          "border-[var(--octant-success-border)] bg-transparent text-[var(--octant-success-text)]",
        warning:
          "border-[var(--octant-warning-border)] bg-transparent text-[var(--octant-warning-text)]",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      data-variant={variant ?? "secondary"}
      {...props}
    />
  );
}

export { badgeVariants };
