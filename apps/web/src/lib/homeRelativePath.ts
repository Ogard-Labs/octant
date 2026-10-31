/** The home prefix repeats on every path; show `~` and keep the full path for a title or a screen reader. */
export function homeRelativePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}
