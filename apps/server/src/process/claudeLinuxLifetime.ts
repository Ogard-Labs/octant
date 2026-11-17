import { readdirSync, realpathSync, statSync } from "node:fs";

/** Lifetime ownership only, without an outer command/filesystem sandbox.
 * Flatten top-level symlinks in the private root so Claude's native read-deny
 * mounts can re-allow /bin and /lib on merged-/usr hosts. Each source remains
 * the same host object; the native command sandbox applies the restrictions. */
export function claudeLinuxLifetimeArguments(
  root: string,
  selectedRoots: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const mounts: string[] = [];
  for (const name of readdirSync("/").sort()) {
    if (name === "dev" || name === "proc") continue;
    const path = `/${name}`;
    try {
      const source = realpathSync(path);
      const identity = statSync(source);
      if (identity.isDirectory() || identity.isFile()) mounts.push("--bind", source, path);
    } catch {
      // A disappearing optional host root entry is not a selected grant.
    }
  }
  return [
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/",
    ...mounts,
    ...[...new Set(selectedRoots)].flatMap((path) => ["--bind", path, path]),
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    root,
    "--",
  ];
}
