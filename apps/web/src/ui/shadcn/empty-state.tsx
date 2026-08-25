import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function EmptyState({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "grid w-full max-w-[440px] grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 p-[18px] text-left",
        className,
      )}
      data-slot="empty-state"
      {...props}
    />
  );
}

const emptyStateMediaVariants = cva(
  "grid size-[30px] shrink-0 place-items-center rounded-[7px] border border-border bg-secondary text-muted-foreground",
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
      aria-level={1}
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
        "m-0 mt-[5px] max-w-[420px] text-xs leading-relaxed text-muted-foreground",
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
