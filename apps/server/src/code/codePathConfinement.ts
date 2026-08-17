import { classifyPathContainment, classifySymlinkContainment } from "@octant/domain";
import type {
  CodeDirectoryPort,
  CodeDirectoryStat,
  CodeOpenDirectory,
  CodePathPort,
} from "./codeDirectoryPort";

/**
 * The one confinement sequence every read of a bound Code checkout runs.
 *
 * Canonicalize nothing on trust: a candidate is `lstat`ed first, a symlink is
 * resolved and its target re-checked before the link is followed, the candidate
 * is then `realpath`ed — which also collapses any symlinked parent directory —
 * and the canonical result is re-checked against the canonical root. A path that
 * fails any step is skipped rather than reported, so a link planted inside the
 * checkout can never make a Code surface read the rest of the host.
 *
 * Both the file explorer listing and repository-test discovery call this, so
 * there is exactly one implementation of the boundary to review.
 */
export async function resolveContainedPath(
  port: CodePathPort,
  canonicalRoot: string,
  absolute: string,
): Promise<{ readonly canonical: string; readonly stat: CodeDirectoryStat } | undefined> {
  try {
    const linkStat = await port.lstat(absolute);
    if (linkStat.isSymbolicLink) {
      const target = await port.readlink(absolute);
      const resolvedTarget = await port.realpath(
        target.startsWith("/") ? target : joinCodePath(parentCodePath(absolute), target),
      );
      if (classifySymlinkContainment(canonicalRoot, resolvedTarget) === "escapes-root") {
        return undefined;
      }
    }
    const canonical = await port.realpath(absolute);
    if (classifyPathContainment(canonicalRoot, canonical) === "escapes-root") return undefined;
    return { canonical, stat: await port.stat(canonical) };
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
 * catch a swapped *ancestor*, which is why the device and inode equality —
 * not the open — is what closes that window.
 *
 * The port cannot make that guarantee absolute: enumerating and identifying
 * are two path resolutions, so a precisely timed swap can still be identified
 * as the resolved object while yielding another directory's names. Every name
 * a caller acts on must be re-resolved through `resolveContainedPath`, which is
 * what keeps a foreign entry out; the residual is that a name existing in both
 * directories is indistinguishable from one that only exists here.
 *
 * The read is capped at the caller's remaining budget, so a directory far
 * larger than the caller can report costs that budget rather than its own size,
 * and a port that ignores the cap is refused rather than trusted.
 */
export async function readContainedDirectoryNames(
  port: CodeDirectoryPort,
  canonical: string,
  identity: CodeDirectoryStat,
  maximumNames: number,
): Promise<ReadonlyArray<string> | undefined> {
  let directory: CodeOpenDirectory;
  try {
    directory = await port.openDirectory(canonical);
  } catch {
    return undefined;
  }
  try {
    const opened = await directory.stat();
    if (!opened.isDirectory) return undefined;
    if (opened.device !== identity.device || opened.inode !== identity.inode) return undefined;
    const children = await directory.read(maximumNames);
    if (children.length > maximumNames) return undefined;
    return children.map((child) => child.name).sort(compareCodePathNames);
  } catch {
    return undefined;
  } finally {
    await directory.close().catch(() => undefined);
  }
}

/** Stable, case-insensitive name order, so a walk is reproducible. */
export function compareCodePathNames(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

export function joinCodePath(base: string, segment: string): string {
  return `${base.replace(/\/+$/, "")}/${segment}`;
}

export function parentCodePath(absolute: string): string {
  const index = absolute.lastIndexOf("/");
  return index <= 0 ? "/" : absolute.slice(0, index);
}

export function isAbsolutePosixPath(value: string): boolean {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}
