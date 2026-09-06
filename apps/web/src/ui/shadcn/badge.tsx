import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * A filled pill on the type ramp (0086). The previous outline-only label was
 * drawn at 10px, a size 0073's hierarchy does not have, and read as a second
 * kind of border next to the hairlines that already separate rows.
 *
 * `success` and `warning` are Octant statuses the style has no equivalent for.
 * They follow the same tonal shape as `destructive` so the four statuses read
 * as one set rather than two.
 */
const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive/10 text-destructive",
        outline: "border-border text-foreground",
        success: "bg-[var(--octant-success-surface)] text-[var(--octant-success-text)]",
        warning: "bg-[var(--octant-warning-surface)] text-[var(--octant-warning-text)]",
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
