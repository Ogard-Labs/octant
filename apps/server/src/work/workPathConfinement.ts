import { classifyPathContainment, classifySymlinkContainment } from "@octant/domain";
import type { WorkFileStat, WorkFilesystemPort, WorkOpenDirectory } from "./workFilesystemPort";

/**
 * The one confinement sequence every read of a bound Work folder runs.
 *
 * Canonicalize nothing on trust: a candidate is `lstat`ed first, a symlink is
 * resolved and its target re-checked before the link is followed, the candidate
 * is then `realpath`ed — which also collapses any symlinked parent directory —
 * and the canonical result is re-checked against the canonical root. A path
 * that fails any step is refused rather than reported, so a link planted inside
 * the folder can never make a Work surface read the rest of the host.
 *
 * A relative link target is relative to the link's own directory, not to the
 * server process's working directory. Canonicalizing it raw would misjudge an
 * ordinary in-folder link as escaping; joining it to the link's parent first
 * keeps the containment check the only thing that decides, so an escaping
 * target is still refused.
 *
 * Research freshness and the file listing both call this, so there is exactly
 * one implementation of the Work boundary to review.
 */
export async function resolveContainedWorkPath(
  filesystem: WorkFilesystemPort,
  canonicalRoot: string,
  absolute: string,
): Promise<{ readonly canonical: string; readonly stat: WorkFileStat } | undefined> {
  try {
    const linkStat = await filesystem.lstat(absolute);
    if (linkStat.isSymbolicLink) {
      const target = await filesystem.readlink(absolute);
      const resolvedTarget = await filesystem.realpath(
        target.startsWith("/") ? target : joinWorkPath(parentWorkPath(absolute), target),
      );
      if (classifySymlinkContainment(canonicalRoot, resolvedTarget) === "escapes-root") {
        return undefined;
      }
    }
    const canonical = await filesystem.realpath(absolute);
    if (classifyPathContainment(canonicalRoot, canonical) === "escapes-root") return undefined;
    return { canonical, stat: await filesystem.stat(canonical) };
  } catch {
    return undefined;
  }
}

/**
 * Names of the one directory containment proved, read from a single handle.
 *
 * The handle refuses a symlinked final component, and the object it reports
 * must be the object containment resolved, so a directory swapped in after
 * that proof is refused rather than enumerated. `O_NOFOLLOW` alone would not
 * catch a swapped *ancestor*, which is why the device and inode equality — not
 * the open — is what closes that window.
 *
 * The guarantee is not absolute: enumerating and identifying are two path
 * resolutions, so a precisely timed swap can still be identified as the
 * resolved object while yielding another directory's names. Every name a caller
 * acts on must be re-resolved through `resolveContainedWorkPath`, which is what
 * keeps a foreign entry out; the residual is that a name existing in both
 * directories is indistinguishable from one that only exists here.
 *
 * The read is capped at the caller's remaining budget, so a directory far
 * larger than the caller can report costs that budget rather than its own size,
 * and a port that ignores the cap is refused rather than trusted.
 */
export async function readContainedWorkDirectoryNames(
  filesystem: WorkFilesystemPort,
  canonical: string,
  identity: WorkFileStat,
  maximumNames: number,
): Promise<ReadonlyArray<string> | undefined> {
  let directory: WorkOpenDirectory;
  try {
    directory = await filesystem.openDirectory(canonical);
  } catch {
    return undefined;
  }
  try {
    const opened = await directory.stat();
    if (!opened.isDirectory) return undefined;
    if (opened.device !== identity.device || opened.inode !== identity.inode) return undefined;
    const children = await directory.read(maximumNames);
    if (children.length > maximumNames) return undefined;
    return children.map((child) => child.name).sort(compareWorkPathNames);
  } catch {
    return undefined;
  } finally {
    await directory.close().catch(() => undefined);
  }
}

/** Stable, case-insensitive name order, so a walk is reproducible. */
export function compareWorkPathNames(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

export function joinWorkPath(root: string, segment: string): string {
  return `${root.replace(/\/+$/, "")}/${segment}`;
}

export function parentWorkPath(absolutePath: string): string {
  const index = absolutePath.lastIndexOf("/");
  return index <= 0 ? "/" : absolutePath.slice(0, index);
}
