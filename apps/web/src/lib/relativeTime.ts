/**
 * "just now", "4m ago", "3h ago", "2d ago": the compact age a board card or
 * an issue row shows beside an item, with the absolute time left to a title.
 */
export function relativeTimeLabel(at: string, now: number = Date.now()): string {
  const elapsedMs = Math.max(0, now - Date.parse(at));
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const absoluteTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
