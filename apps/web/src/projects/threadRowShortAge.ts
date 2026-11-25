/**
 * The row's own age: the shortest true reading, because the row has one word
 * of room at its edge and the card beside it spells the rest out. Minutes,
 * hours, days, weeks and years floor, so "59m" never rounds up to a false
 * "60m". It never runs past three characters ("52w", "2y"), because the age
 * sits in a slot of fixed width and a date would not fit; the tooltip carries
 * the full moment.
 */
export function threadRowShortAge(
  updatedAt: string | undefined,
  now: number = Date.now(),
): string | undefined {
  if (updatedAt === undefined) return undefined;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}
