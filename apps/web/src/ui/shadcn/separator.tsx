import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * Orientation is read as `data-[orientation=…]`, not the style's shorthand
 * `data-horizontal:`. That shorthand is a custom variant upstream ships in a
 * stylesheet this repo does not import; Base UI writes the value form, so the
 * shorthand would compile to an attribute nothing sets and leave the rule with
 * no height at all.
 *
 * Vertical uses `self-stretch` rather than `h-full`, which measures nothing in
 * a flex row unless the parent happens to have a resolved height.
 */
export function Separator({ className, ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className,
      )}
      data-slot="separator"
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
