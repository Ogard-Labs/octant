import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export interface OctantCollapsibleProps extends Omit<ComponentProps<"details">, "children"> {
  /** The always-visible row that opens and closes the body. */
  readonly summary: ReactNode;
  readonly summaryClassName?: string;
  readonly children?: ReactNode;
}

/**
 * A disclosure: a summary row with a chevron that turns when open. It stays a
 * native `<details>` so the browser's find-in-page opens a closed body that
 * holds a match, and Enter/Space on the summary toggle it without script. The
 * user-agent triangle is hidden; the chevron is the only mark.
 */
export function OctantCollapsible({
  summary,
  summaryClassName,
  className,
  children,
  ...props
}: OctantCollapsibleProps) {
  return (
    <details className={["group/collapsible", className].filter(Boolean).join(" ")} {...props}>
      <summary
        className={[
          "flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden",
          summaryClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <ChevronRight
          aria-hidden="true"
          className="shrink-0 group-open/collapsible:rotate-90"
          size={14}
        />
        {summary}
      </summary>
      {children}
    </details>
  );
}
