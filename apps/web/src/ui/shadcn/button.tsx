import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * Focus stays free of outline and ring utilities: the shared keyboard focus
 * edge in octant.css is the indicator, and a recipe ring would draw a second
 * one. The ghost and outline focus fill is emphasis, not the indicator.
 *
 * A press darkens the fill and moves nothing. The button used to sink a pixel
 * unless it opened a menu, so one row of sidebar controls had some that bounced
 * and some that did not, and the list wobbled under the pointer.
 *
 * An outline button rests on the page colour, unless the shell names another
 * rest fill: under Glass the page colour is opaque while the page around the
 * button is not, and every outline button drew a black pill on the grey
 * glass of an OLED preset.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-default items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] outline-none select-none disabled:pointer-events-none disabled:cursor-default disabled:opacity-(--oct-disabled-opacity) aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // A filled button is a raised tile: the control shadow puts light on
        // its top edge and a short shadow under it, and pressing sinks it. The
        // primary one is the accent as a gradient with a soft glow under it.
        // Ghost, link, bare and chip draw no tile, so they stay flat.
        default:
          "bg-primary bg-(image:--octant-accent-sheen) text-primary-foreground shadow-(--octant-shadow-primary) hover:bg-primary/90 active:bg-primary/80 active:shadow-(--octant-shadow-control-pressed)",
        // The primary text colour as a fill, with the page colour on it: the
        // one action a surface is for, where the accent would compete with
        // the content beside it (a composer's send, next to the prompt).
        solid:
          "bg-foreground text-background shadow-(--octant-shadow-control) hover:bg-foreground/85 active:bg-foreground/75 active:shadow-(--octant-shadow-control-pressed)",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 active:bg-destructive/25",
        outline:
          "border-border bg-[var(--octant-outline-rest,var(--background))] shadow-(--octant-shadow-control) active:shadow-(--octant-shadow-control-pressed) hover:bg-muted active:bg-(--octant-control-pressed) hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground [html[data-octant-increased-contrast=true]_&]:border-(--octant-border-strong)",
        secondary:
          "bg-secondary text-secondary-foreground shadow-(--octant-shadow-control) active:shadow-(--octant-shadow-control-pressed) hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] active:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted active:bg-(--octant-control-pressed) hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        link: "h-auto p-0 text-foreground underline-offset-4 hover:underline",
        // A card-shaped button (a count tile, a rail entry, a live card) whose
        // feature stylesheet owns the paint. It keeps the button's behaviour,
        // focus handling, and disabled state and draws nothing of its own, so
        // the feature never fights a ghost hover fill or a fixed height.
        bare: "h-auto rounded-none p-0 text-inherit",
        // A small outlined pill that suggests something to type or pick: a
        // suggestion chip. Quiet until hovered, so a row of them reads as a
        // set rather than a row of calls to action.
        chip: "rounded-full border-border bg-transparent text-muted-foreground hover:text-foreground",
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
    // A chip sizes itself, so its height and padding follow the label rather
    // than a size step, which would otherwise win over the variant.
    compoundVariants: [
      {
        variant: "chip",
        class: "h-auto px-2 py-0.5 text-xs",
      },
    ],
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
