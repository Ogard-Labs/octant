import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * The recipe is the design system's, not Tailwind's: octant.css owns layout,
 * color, focus, and disabled treatment for `.btn` and its modifiers, and its
 * unlayered rules beat layered utilities anyway. Only behavior the system
 * stylesheet does not express stays here as utilities: labels never wrap, and
 * inline icons render at 14px regardless of their width/height attributes.
 */
const buttonVariants = cva("whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:size-3.5", {
  variants: {
    variant: {
      default: "btn-primary",
      // `.btn` itself paints nothing; `.btn-secondary` is the system's
      // outline/neutral look, so both `secondary` and `outline` land on it.
      secondary: "btn-secondary",
      outline: "btn-secondary",
      ghost: "btn-ghost",
      destructive: "btn-danger",
    },
    size: {
      default: "btn",
      sm: "btn btn-sm",
      // octant.css has no large recipe; `lg` gets the base control height.
      lg: "btn",
      // Icon recipes are standalone in octant.css (they reset `.btn`'s
      // min-height and padding by coming later in the sheet), so `size="icon"`
      // must not emit `btn`. Which recipe applies depends on the variant —
      // see compoundVariants.
      icon: "",
    },
  },
  compoundVariants: [
    // The system's only filled square control is the send/stop circle;
    // `.btn-icon` would win the source-order tie against `.btn-primary` and
    // strip the fill, so filled icon buttons use `.btn-send` instead.
    { size: "icon", variant: "default", class: "btn-send" },
    {
      size: "icon",
      variant: ["secondary", "outline", "ghost", "destructive"],
      // `.btn-icon` has no disabled treatment of its own (`.btn[disabled]`
      // only covers `.btn`), so the disabled utilities stay for this shape.
      class: "btn-icon disabled:pointer-events-none disabled:opacity-50",
    },
  ],
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ButtonProps = ComponentProps<typeof ButtonPrimitive> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

export { buttonVariants };
