import { classifyPathContainment, classifySymlinkContainment } from "@octant/domain";
import type { CodeDirectoryStat, CodePathPort } from "./codeDirectoryPort";

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
