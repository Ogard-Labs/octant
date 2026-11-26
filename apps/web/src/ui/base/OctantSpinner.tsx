import { LoaderCircle } from "../icons";
import { cn } from "../shadcn/utils";

export interface OctantSpinnerProps {
  /** 12 in a chip or a 20px button, 14 in a 24px control or beside 13px text, 16 elsewhere, 20 in an empty state. */
  readonly size?: 12 | 14 | 16 | 20;
  /**
   * Names the wait for a screen reader. Leave it out where a word beside the
   * spinner already says what is running: the spinner is then decoration.
   */
  readonly label?: string;
  readonly className?: string;
}

/**
 * The one spinner: the open ring every "this is running" mark draws, turning
 * once per `--oct-motion-spin`. Each feature used to animate its own class with
 * its own copy of the keyframe, eight of them, and they had come to disagree
 * about reduced motion: one kept turning slowly and the rest stopped, which
 * reads as a hung app. This one turns slowly there.
 */
export function OctantSpinner({ className, label, size = 16 }: OctantSpinnerProps) {
  return (
    <LoaderCircle
      {...(label === undefined ? {} : { "aria-label": label, role: "img" })}
      className={cn("octant-spinner", className)}
      size={size}
    />
  );
}
