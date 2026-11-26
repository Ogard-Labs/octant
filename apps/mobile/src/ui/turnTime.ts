/** When a message was sent or a reply finished, as short as its line has room for. */
export function messageTime(at: string, now: Date): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "";
  const clock = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (time.toDateString() === now.toDateString()) return clock;
  const day = time.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(time.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}, ${clock}`;
}

/** How long a turn has run: seconds, then minutes, then hours and minutes. */
export function turnElapsed(since: string, now: Date): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
