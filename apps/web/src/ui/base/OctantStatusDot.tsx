import { cn } from "../shadcn/utils";

/**
 * What a dot says. `neutral` is resting or unknown, `active` is running or
 * connected with nothing to report, and the rest are the status roles.
 */
export type OctantStatusTone = "neutral" | "active" | "success" | "warning" | "danger" | "accent";

export interface OctantStatusDotProps {
  readonly tone?: OctantStatusTone;
  /** 6px for a chip or a dense list; the dot is 8px beside a row's text. */
  readonly small?: boolean;
  /** A live dot breathes while the thing it marks is going on. */
  readonly live?: boolean;
  readonly className?: string;
}

/**
 * The one status dot. It is always decoration: colour never carries a state
 * alone, so the word or the label beside it is what a screen reader reads, and
 * the dot is hidden from it.
 */
export function OctantStatusDot({
  className,
  live,
  small,
  tone = "neutral",
}: OctantStatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("octant-status-dot", className)}
      data-live={live === true ? "true" : undefined}
      data-size={small === true ? "sm" : undefined}
      data-tone={tone}
    />
  );
}
