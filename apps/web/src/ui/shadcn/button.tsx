import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * Focus stays free of outline and ring utilities. Ghost and outline controls
 * use a quiet focus fill so keyboard navigation remains visible without a
 * drawn halo (0094).
 *
 * A press moves the button down a pixel, except where it opens something — a
 * menu trigger that sinks while its menu appears reads as a glitch, not a
 * press, so `aria-haspopup` opts out.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color] outline-none select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        link: "h-auto p-0 text-foreground underline-offset-4 hover:underline",
      },
      // Heights are rem so a control grows with the interface size. The root is
      // 13px, not the 16px these steps assume, so the odd steps landed between
      // pixels: 1.75rem was 22.75px and 2.25rem was 29.25px, and about a hundred
      // small buttons drew a blurred edge. Each step rounds to a whole 2px,
      // which gives 20, 24, 28, and 32 at the default size.
      size: {
        default:
          "h-[round(2.154rem,2px)] gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-[round(down,1.538rem,2px)] gap-1 rounded-md px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[round(1.846rem,2px)] gap-1 rounded-md px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-[round(2.462rem,2px)] gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-[round(2.154rem,2px)]",
        "icon-xs":
          "size-[round(down,1.538rem,2px)] rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[round(1.846rem,2px)] rounded-md [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = ComponentProps<typeof ButtonPrimitive> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      className={cn(buttonVariants({ variant, size }), className)}
      data-size={size ?? "default"}
      data-slot="button"
      data-variant={variant ?? "default"}
      {...props}
    />
  );
}

export { buttonVariants };
