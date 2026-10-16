/**
 * Linear-time trailing trims. A regex such as `/\/+$/` retries from every
 * slash in a long run of slashes, which is quadratic on hostile input.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** Drops trailing `)`, `,`, `.` and `;` that a URL picked up from surrounding prose. */
export function trimTrailingUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && "),.;".includes(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}
