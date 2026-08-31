import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function EmptyState({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "grid w-full max-w-[480px] grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 rounded-[var(--octant-radius-panel)] bg-card p-5 text-left text-card-foreground shadow-[var(--octant-shadow-sm)]",
        className,
      )}
      data-slot="empty-state"
      {...props}
    />
  );
}

const emptyStateMediaVariants = cva(
  "grid size-8 shrink-0 place-items-center rounded-[var(--octant-radius-control)] border border-border bg-secondary text-muted-foreground",
  {
    variants: {
      tone: {
        neutral: "",
        warning: "text-[var(--octant-warning-text)]",
        destructive: "text-destructive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type EmptyStateMediaProps = ComponentProps<"span"> &
  VariantProps<typeof emptyStateMediaVariants>;

export function EmptyStateMedia({ className, tone, ...props }: EmptyStateMediaProps) {
  return (
    <span
      className={cn(emptyStateMediaVariants({ tone }), className)}
      data-slot="empty-state-media"
      {...props}
    />
  );
}

export function EmptyStateCopy({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0", className)} data-slot="empty-state-copy" {...props} />;
}

export function EmptyStateEyebrow({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "mb-1 block text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase",
        className,
      )}
      data-slot="empty-state-eyebrow"
      {...props}
    />
  );
}

export function EmptyStateTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      // An empty state fills a region of a page that already owns the level-1
      // heading, so claiming that level again would give the page two roots.
      // A caller that really is the page can still say so through `aria-level`.
      aria-level={2}
      className={cn("m-0 text-base leading-none font-semibold tracking-[-0.015em]", className)}
      data-slot="empty-state-title"
      role="heading"
      {...props}
    />
  );
}

export function EmptyStateDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "m-0 mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-muted-foreground",
        className,
      )}
      data-slot="empty-state-description"
      {...props}
    />
  );
}

export function EmptyStateActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("col-start-2 flex items-center gap-2", className)}
      data-slot="empty-state-actions"
      {...props}
    />
  );
}
