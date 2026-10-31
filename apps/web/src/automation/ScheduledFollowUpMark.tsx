import { AlarmClock } from "lucide-react";

/**
 * The line over a turn a follow-up sent into its thread, so a reader can tell
 * the host sent it at a scheduled time and the person did not type it then.
 * The host's own heading is what marks such a turn; the transcript shows the
 * fixed prompt under this line instead of the heading.
 */
export function ScheduledFollowUpMark() {
  return (
    <p className="turn-scheduled-mark">
      <AlarmClock aria-hidden="true" size={12} strokeWidth={1.8} />
      <span>Scheduled follow-up</span>
    </p>
  );
}
