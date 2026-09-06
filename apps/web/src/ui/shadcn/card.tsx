import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * A card is bounded by a hairline ring rather than lifted by a shadow (0086):
 * it sits in the page, and shadow now means something that floats above it.
 * Semantic elements stay — a card is a section with a heading, not a stack of
 * divs.
 */

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 overflow-hidden rounded-xl border-0 bg-card py-4 text-card-foreground ring-1 ring-foreground/10",
        className,
      )}
      data-slot="card"
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn("grid auto-rows-min gap-1 px-4", className)}
      data-slot="card-header"
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("m-0 text-base leading-snug font-medium", className)}
      data-slot="card-title"
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("m-0 text-sm text-muted-foreground", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-4", className)} data-slot="card-content" {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn("flex items-center px-4", className)}
      data-slot="card-footer"
      {...props}
    />
  );
}
