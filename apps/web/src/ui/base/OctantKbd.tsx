import type { ReactNode } from "react";
import { cn } from "../shadcn/utils";

export interface OctantKbdProps {
  /**
   * `cap` is the boxed key in a sentence, a tooltip or a field. `bare` is the
   * quiet chord at the end of a row (a sidebar row, a menu or palette row),
   * where a box on every row would read as a column of buttons.
   */
  readonly form?: "cap" | "bare";
  /** Hidden from a screen reader where the control's own name or description already says the chord. */
  readonly decorative?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A keyboard chord, drawn one way. It is set in the interface face, as a
 * native menu sets its shortcuts: the hand-drawn hints used the interface, the
 * display and the mono face in turn, in two forms and seven paints.
 */
export function OctantKbd({ children, className, decorative, form = "cap" }: OctantKbdProps) {
  return (
    <kbd
      aria-hidden={decorative === true ? true : undefined}
      className={cn("octant-kbd", className)}
      data-form={form}
    >
      {children}
    </kbd>
  );
}
