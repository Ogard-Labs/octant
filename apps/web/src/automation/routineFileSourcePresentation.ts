import type { AutomationFileSourceSummary } from "@octant/contracts";

export function routineFileSourceLabel(source: AutomationFileSourceSummary | undefined): string {
  if (source === undefined) return "Input status unknown";
  if (source.phase === "paused") return "Paused";
  if (source.reason === "known-activity") return "Waiting for Project activity";
  if (source.reason === "activity-history-limit") return "Owned activity history incomplete";
  if (source.reason === "activity-unknown") return "Project activity unconfirmed";
  if (source.reason === "source-changed" || source.reason === "authority-changed")
    return "Setup changed; edit to review";
  if (source.phase === "arming") return "Arming";
  if (source.phase === "unavailable") return "Input unavailable";
  if (source.phase === "held") return "Input held for review";
  if (source.phase === "needs-rearm") return "Review and re-arm";
  return "Watching";
}
