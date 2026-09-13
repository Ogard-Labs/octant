/**
 * Preview a child of the host-reported default folder using the separator
 * already in that path. The host canonicalizes `DefaultFolder`; this renderer
 * must not import Node `path`, and it must not invent a Windows execution
 * contract.
 */
export function joinDefaultFolderDisplayPath(folder: string, child: string): string {
  const windows = folder.includes("\\") && !folder.includes("/");
  const separator = windows ? "\\" : "/";
  let base = folder;
  while (base.endsWith("/") || base.endsWith("\\")) {
    base = base.slice(0, -1);
  }
  return `${base}${separator}${child}`;
}
