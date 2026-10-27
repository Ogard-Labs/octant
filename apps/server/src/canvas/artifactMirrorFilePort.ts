import { constants, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { openConfinedPath, removeConfinedEntry } from "../confinedPathOpen";
import { writeConfinedWorkFile } from "../work/workConfinedWrite";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import type { ArtifactMirrorFilePort } from "./artifactMirrorService";

/**
 * The mirror's one door to the filesystem.
 *
 * Every write and removal lands under the root it was anchored to. The service
 * composes paths from a root plus a policy-checked relative path, so this is
 * the second check rather than the only one — but a port that trusted its
 * caller is how one missed decode becomes a write anywhere on the disk.
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

    async ensureRoot(absolutePath) {
      if (!isAbsolute(absolutePath)) return;
      await mkdir(absolutePath, { recursive: true });
    },

    async write(absolutePath, contents, root) {
      // A repository destination is a Code checkout or Work folder an agent
      // can rename folders in. Creating the folders by path and then checking
      // where they resolved compared a folder with itself, so a mirrored folder
      // swapped for a link to a host folder received the bundle and its
      // sidecars. Work's confined write is used instead: a replacement opens
      // the file where it must land on its canonical path, and a new file is
      // created by walking from the held root one no-follow folder at a time.
      const names = namesUnderRoot(root, absolutePath);
      if (names === undefined) throw new Error("Refusing to write outside the mirror root.");
      const bytes = new TextEncoder().encode(contents);
      const replaced = await writeConfinedWorkFile({
        filesystem: liveWorkFilesystem,
        canonicalPath: absolutePath,
        allowCreate: false,
        bytes,
      });
      if (replaced) return;
      const opened = await liveWorkFilesystem.stat(root);
      const created = await writeConfinedWorkFile({
        filesystem: liveWorkFilesystem,
        canonicalPath: absolutePath,
        parent: {
          absolutePath: root,
          identity: { device: opened.device, inode: opened.inode },
          remaining: names,
        },
        allowCreate: true,
        bytes,
      });
      if (!created) throw new Error("Refusing to write outside the mirror root.");
    },

    async read(absolutePath, root) {
      // A repository destination is the Code checkout or Work folder an agent
      // can rename folders in. A plain read followed an ancestor of the bundle
      // swapped for a link to a host folder holding the same names, and handed
      // host bytes to re-import. The path is resolved and contained first, and
      // the open must land on that canonical path.
      try {
        const canonicalPath = await realpath(absolutePath);
        if (!isContained(root, canonicalPath)) return undefined;
        const file = await openConfinedPath(
          canonicalPath,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
          if (!(await file.stat()).isFile()) return undefined;
          return await file.readFile("utf8");
        } finally {
          await file.close().catch(() => undefined);
        }
      } catch {
        return undefined;
      }
    },

    async remove(absolutePath, root) {
      // A path removal followed a mirrored folder swapped for a host link and
      // deleted the host file with the stale name, so the name is removed from
      // its folder only once that folder is proved to be inside the root.
      const names = namesUnderRoot(root, absolutePath);
      const name = names?.[names.length - 1];
      if (name === undefined) throw new Error("Refusing to remove outside the mirror root.");
      await removeConfinedEntry(absolutePath.slice(0, absolutePath.lastIndexOf("/")), name);
    },
  };
}

/**
 * The plain names from a canonical root down to a path under it, or nothing
 * when the path is not spelled as that root plus plain names.
 *
 * The confined write and removal prove a handle landed on this exact path, so
 * a spelling with `.`, `..`, or an empty name is refused here rather than
 * failing a comparison there.
 */
function namesUnderRoot(root: string, absolutePath: string): ReadonlyArray<string> | undefined {
  if (!absolutePath.startsWith(`${root}/`)) return undefined;
  const names = absolutePath.slice(root.length + 1).split("/");
  return names.every((name) => name !== "" && name !== "." && name !== "..") ? names : undefined;
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
