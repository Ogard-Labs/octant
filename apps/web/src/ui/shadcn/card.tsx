import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * A card is bounded by a hairline ring rather than lifted by a shadow (0090):
 * it sits in the page, and shadow now means something that floats above it.
 * Semantic elements stay — a card is a section with a heading, not a stack of
 * divs.
 *
 * The glass variant carries no paint of its own. It marks the card as wearing
 * the glass material, which the static system defines once beside the other
 * surfaces that wear it, together with its reduced-transparency and
 * no-`backdrop-filter` fallbacks (octant.css, 0107). Duplicating the ladder in
 * utilities here would give the material two definitions.
 *
 * Glass belongs only on a surface with a ground behind it (0107). Asking for
 * it on a flat page produces a blurred card over nothing.
 */
const cardVariants = cva(
  "flex flex-col gap-4 overflow-hidden rounded-xl border-0 py-4 text-card-foreground",
  {
    variants: {
      variant: {
        default: "bg-card ring-1 ring-foreground/10",
        glass: "",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type CardProps = ComponentProps<"section"> & VariantProps<typeof cardVariants>;

export function Card({ className, variant, ...props }: CardProps) {
  return (
    <section
      className={cn(cardVariants({ variant }), className)}
      data-slot="card"
      data-variant={variant ?? "default"}
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
