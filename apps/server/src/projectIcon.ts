import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ProjectId, WindowId } from "@octant/contracts";
import type { ProjectService } from "./projectService";

/** An icon larger than this is a picture, not a favicon; the lookup moves on. */
export const MAX_PROJECT_ICON_BYTES = 262_144;

/**
 * The only places the host looks for a Project's icon, in order, first valid
 * hit wins. A fixed list keeps the read bounded and predictable: the host never
 * walks the folder or expands a pattern, so a large repository costs a handful
 * of failed opens.
 */
export const PROJECT_ICON_CANDIDATES: ReadonlyArray<string> = [
  "favicon.svg",
  "favicon.png",
  "favicon.ico",
  "public/favicon.svg",
  "public/favicon.png",
  "public/favicon.ico",
  "static/favicon.svg",
  "static/favicon.png",
  "static/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  "assets/icon.svg",
  "assets/icon.png",
  "docs/public/favicon.svg",
  "docs/public/favicon.png",
  "docs/public/favicon.ico",
  "icon.svg",
  "icon.png",
  "logo.svg",
];

export type ProjectIconMediaType = "image/svg+xml" | "image/png" | "image/x-icon";

export type ProjectIconLookup =
  | {
      readonly status: "found";
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly mediaType: ProjectIconMediaType;
      /** Size and modification time: enough to notice an edited file without hashing it. */
      readonly etag: string;
    }
  | { readonly status: "none" };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// An icon directory: reserved zero, then type 1 (icon).
const ICO_SIGNATURE = [0x00, 0x00, 0x01, 0x00];
const SVG_PROLOGUE =
  /^(?:\s*(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?>))*\s*<svg[\s>/]/i;

function startsWith(bytes: Uint8Array, signature: ReadonlyArray<number>): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function mediaTypeFor(candidate: string): ProjectIconMediaType | undefined {
  if (candidate.endsWith(".svg")) return "image/svg+xml";
  if (candidate.endsWith(".png")) return "image/png";
  if (candidate.endsWith(".ico")) return "image/x-icon";
  return undefined;
}

/** The extension names the type; the first bytes must agree, or the file is not an icon. */
function bytesMatch(mediaType: ProjectIconMediaType, bytes: Uint8Array): boolean {
  if (mediaType === "image/png") return startsWith(bytes, PNG_SIGNATURE);
  if (mediaType === "image/x-icon") return startsWith(bytes, ICO_SIGNATURE);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return false;
  }
  return SVG_PROLOGUE.test(text);
}

function insideRoot(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function readCandidate(
  root: string,
  candidate: string,
): Promise<Extract<ProjectIconLookup, { status: "found" }> | undefined> {
  const mediaType = mediaTypeFor(candidate);
  if (mediaType === undefined) return undefined;
  try {
    // The real path decides containment: a link that stays inside the folder is
    // the person's own arrangement, one that leaves it is never followed.
    const real = await realpath(join(root, candidate));
    if (!insideRoot(root, real)) return undefined;
    // Non-blocking so a FIFO swapped in under the name cannot hold the open.
    const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size > MAX_PROJECT_ICON_BYTES || details.size === 0) {
        return undefined;
      }
      const buffer = new Uint8Array(new ArrayBuffer(MAX_PROJECT_ICON_BYTES + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      // The file may have grown since the stat.
      if (bytesRead > MAX_PROJECT_ICON_BYTES) return undefined;
      const bytes = buffer.slice(0, bytesRead);
      if (!bytesMatch(mediaType, bytes)) return undefined;
      return {
        status: "found",
        bytes,
        mediaType,
        etag: `"${details.size.toString(16)}-${Math.trunc(details.mtimeMs).toString(16)}"`,
      };
    } finally {
      await handle.close();
    }
  } catch {
    // A missing, unreadable, or vanished file is simply not this Project's icon.
    return undefined;
  }
}

/** Find the icon inside one Project folder. Reads only the folder it is given. */
export async function findProjectIcon(canonicalRoot: string): Promise<ProjectIconLookup> {
  let root: string;
  try {
    root = await realpath(canonicalRoot);
  } catch {
    return { status: "none" };
  }
  for (const candidate of PROJECT_ICON_CANDIDATES) {
    const found = await readCandidate(root, candidate);
    if (found !== undefined) return found;
  }
  return { status: "none" };
}

export interface ProjectIconReader {
  readonly read: (windowId: WindowId, projectId: ProjectId) => Promise<ProjectIconLookup>;
}

/**
 * Reads the icon for a Project this window can reach. A Project that is not
 * bound to a folder (Chat), is not active, or is unknown to this window has no
 * icon, the same answer as a folder without one.
 */
export function createProjectIconReader(dependencies: {
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly find?: (canonicalRoot: string) => Promise<ProjectIconLookup>;
}): ProjectIconReader {
  const find = dependencies.find ?? findProjectIcon;
  return {
    read: async (windowId, projectId) => {
      const bootstrap = await dependencies.projects.bootstrap(windowId);
      const project = bootstrap.active.find((candidate) => candidate.id === projectId);
      if (project === undefined || project.type === "chat") return { status: "none" };
      return find(project.binding.canonicalRoot);
    },
  };
}
