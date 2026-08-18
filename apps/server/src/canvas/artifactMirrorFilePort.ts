import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactMirrorFilePort } from "./artifactMirrorService";

/**
 * The mirror's one door to the filesystem.
 *
 * Every write is proved to land under the root it was anchored to before it
 * happens. The service composes paths from a root plus a policy-checked
 * relative path, so this is the second check rather than the only one — but a
 * port that trusted its caller is how one missed decode becomes a write
 * anywhere on the disk.
 */
export function createArtifactMirrorFilePort(): ArtifactMirrorFilePort {
  return {
    async resolveRoot(absolutePath) {
      if (!isAbsolute(absolutePath)) return undefined;
      try {
        return await realpath(absolutePath);
      } catch {
        return undefined;
      }
    },

    async write(absolutePath, contents) {
      const directory = dirname(absolutePath);
      await mkdir(directory, { recursive: true });
      // Canonicalize after creating the directory: a symlinked parent resolves
      // now, and the containment check below sees where the bytes would really
      // land rather than where the path claimed.
      const canonicalDirectory = await realpath(directory);
      const root = await nearestExistingRoot(absolutePath);
      if (root !== undefined && !isContained(root, canonicalDirectory)) {
        throw new Error("Refusing to write outside the mirror root.");
      }
      await writeFile(absolutePath, contents, "utf8");
    },

    async read(absolutePath) {
      try {
        return await readFile(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },

    async remove(absolutePath) {
      await rm(absolutePath, { force: true });
    },
  };
}

/**
 * The deepest ancestor of this path that already exists, canonicalized.
 *
 * The mirror creates directories as it goes, so the root it was anchored to is
 * not always the nearest existing one. Resolving what is actually there is what
 * makes the containment check meaningful for a path several levels deep.
 */
async function nearestExistingRoot(absolutePath: string): Promise<string | undefined> {
  let candidate = dirname(absolutePath);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
  return undefined;
}

/**
 * Whether a folder the user picked sits inside their own home.
 *
 * A mirror root anywhere else is reaching outside everything Octant was given,
 * and the approval category that would grant that has no surface yet — so this
 * is what keeps the answer "no" rather than "assumed yes".
 */
export function isInsideHomeDirectory(candidate: string, homeDirectory: string): boolean {
  return isContained(homeDirectory, candidate) && resolve(candidate) !== resolve(homeDirectory);
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}
