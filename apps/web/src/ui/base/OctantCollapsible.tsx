import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export interface OctantCollapsibleProps extends Omit<ComponentProps<"details">, "children"> {
  /** The always-visible row that opens and closes the body: any content, one line or several. */
  readonly summary: ReactNode;
  readonly summaryClassName?: string;
  /** Native summary attributes (an `id`, an `aria-label`) other than its content and class. */
  readonly summaryProps?: Omit<ComponentProps<"summary">, "children" | "className">;
  /**
   * Where the chevron sits. **start** leads the row; **end** closes a row whose
   * label spans it, such as a section heading.
   */
  readonly chevron?: "start" | "end";
  readonly chevronSize?: 12 | 14 | 16;
  readonly children?: ReactNode;
}

/**
 * A disclosure: a summary row with a chevron that turns when open. It stays a
 * native `<details>` so the browser's find-in-page opens a closed body that
 * holds a match, and Enter/Space on the summary toggle it without script. The
 * user-agent triangle is hidden; the chevron is the only mark. The chevron
 * turns on its own disclosure's `open`, not an ancestor's, so a closed
 * disclosure nested in an open one keeps pointing closed.
 */
export function OctantCollapsible({
  summary,
  summaryClassName,
  summaryProps,
  chevron = "start",
  chevronSize = 14,
  className,
  children,
  ...props
}: OctantCollapsibleProps) {
  const mark = (
    <ChevronRight
      aria-hidden="true"
      className="shrink-0 [[open]>summary>&]:rotate-90"
      data-slot="collapsible-chevron"
      size={chevronSize}
    />
  );
  return (
    <details className={["group/collapsible", className].filter(Boolean).join(" ")} {...props}>
      <summary
        {...summaryProps}
        className={[
          "flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden",
          summaryClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {chevron === "start" ? mark : null}
        {summary}
        {chevron === "end" ? mark : null}
      </summary>
      {children}
    </details>
  );
}
