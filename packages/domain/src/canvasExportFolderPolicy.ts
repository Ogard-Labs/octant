/**
 * Pure policy for exporting a Canvas to a folder.
 *
 * Which folder a Canvas exports to, whether it may be written at all, and what
 * the file is called are decided here. Nothing in this module touches a
 * filesystem: every fact it reads was measured by the host, and every answer it
 * gives is a decision the host then carries out.
 *
 * Two invariants live here. A folder outside the person's home is refused
 * unless the standing access-outside-project approval exists — the same rule
 * the artifact mirror's global folder follows. And a name that is already taken
 * is only reused when the person approved that exact file; otherwise the export
 * lands beside it as a numbered copy, so an export never silently eats a file
 * the person kept.
 */

import type { CanvasExportImplementedFormat } from "@octant/contracts/canvas-export";
import type { CanvasExportFolderSettings } from "@octant/contracts/canvas-export-folder";

export type CanvasExportFolderRefusal = "outside-home" | "folder-unavailable";

/**
 * The folder one Canvas exports to.
 *
 * A Project's own choice wins over the host's, and the absence of both means no
 * folder has been chosen — a valid, and the starting, answer. `projectId` is
 * absent for a thread filed nowhere, which is exactly what the host fallback is
 * for.
 */
export function resolveCanvasExportFolder(
  settings: Pick<CanvasExportFolderSettings, "fallback" | "overrides">,
  projectId: string | undefined,
): string | undefined {
  if (projectId !== undefined) {
    const override = settings.overrides.find(
      (candidate) => String(candidate.projectId) === String(projectId),
    );
    if (override !== undefined) return override.folder;
  }
  return settings.fallback;
}

export interface CanvasExportFolderFacts {
  /** The folder as the host canonicalized it. */
  readonly folder: string;
  /** Whether the folder exists and can be written. */
  readonly writable: boolean;
  /** Whether the folder sits inside the person's own home. */
  readonly insideHome: boolean;
  /** Whether the host holds the standing grant for reaching outside home. */
  readonly standingOutsideApproval: boolean;
}

export type CanvasExportFolderVerdict =
  | { readonly status: "accepted"; readonly folder: string }
  | { readonly status: "refused"; readonly reason: CanvasExportFolderRefusal };

/**
 * Whether this folder may be written, right now.
 *
 * A folder the person picked can be anywhere, so it is governed by the standing
 * approval for reaching outside a bound root — which the host does not grant
 * yet, so this fails closed rather than assuming yes.
 */
export function judgeCanvasExportFolder(facts: CanvasExportFolderFacts): CanvasExportFolderVerdict {
  if (!facts.writable) return { status: "refused", reason: "folder-unavailable" };
  if (!facts.insideHome && !facts.standingOutsideApproval) {
    return { status: "refused", reason: "outside-home" };
  }
  return { status: "accepted", folder: facts.folder };
}

/** What the person is told when a folder cannot be used, in the words of the state. */
export function canvasExportFolderRefusalText(reason: CanvasExportFolderRefusal): string {
  switch (reason) {
    case "outside-home":
      return "That folder is outside your home folder, and reaching outside it has not been approved.";
    case "folder-unavailable":
      return "The export folder could not be read or written.";
  }
}

/** How many numbered copies are tried before an export gives up on a name. */
export const MAX_CANVAS_EXPORT_NAME_COPIES = 999;

const UNUSABLE_NAME_CHARACTERS = /[/\\:*?"<>|]/;
const MAX_STEM_CHARS = 80;

/**
 * A title with no character a file system would refuse to hold.
 *
 * Control characters and the reserved punctuation become spaces; they are
 * scanned by code point rather than with a character class, because a title is
 * short and a regular expression that carries raw control characters is exactly
 * the kind of thing a source scanner flags.
 */
function withoutUnusableCharacters(value: string): string {
  let cleaned = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    cleaned +=
      code < 32 || code === 127 || UNUSABLE_NAME_CHARACTERS.test(character) ? " " : character;
  }
  return cleaned;
}

/**
 * A filesystem-safe piece of a Canvas title.
 *
 * Titles are written by people and by providers, so they contain anything at
 * all. Runs of whitespace collapse so a title that wrapped does not become a
 * filename with a line break in it, path separators and characters a filesystem
 * reserves become spaces, and a leading dot is dropped so the file is not
 * hidden. The rest of the title survives: this is the name a person reads in
 * their folder, not a slug.
 */
export function canvasExportStem(title: string): string {
  const collapsed = withoutUnusableCharacters(title.normalize("NFC")).replace(/\s+/g, " ").trim();
  // A word that is nothing but dots is a path fragment (or a hidden file
  // marker), not part of a title, and dropping it is what keeps "../../etc"
  // from arriving in the folder as ".. etc".
  const words = collapsed.split(" ").filter((word) => /[^.]/.test(word));
  const joined = words.join(" ").replace(/^\.+/, "").trim();
  if (joined.length === 0) return "canvas";
  const bounded = joined.length > MAX_STEM_CHARS ? joined.slice(0, MAX_STEM_CHARS) : joined;
  const trimmed = bounded.replace(/[\s.]+$/, "");
  return trimmed.length === 0 ? "canvas" : trimmed;
}

/** The extension a rendered format is written with. */
export function canvasExportFileExtension(format: CanvasExportImplementedFormat): "md" | "html" {
  return format === "html" ? "html" : "md";
}

/** The name this document wants, before anything is known about what is there. */
export function canvasExportPlannedName(
  title: string,
  format: CanvasExportImplementedFormat,
): string {
  return `${canvasExportStem(title)}.${canvasExportFileExtension(format)}`;
}

export interface CanvasExportNameFacts {
  readonly title: string;
  readonly format: CanvasExportImplementedFormat;
  /** Whether a file with this name is already in the chosen folder. */
  readonly taken: (fileName: string) => boolean;
  /** Whether the person approved replacing the name this document wants. */
  readonly replacesConfirmed: boolean;
}

/**
 * The name this export will be written under, or nothing when there is no free
 * one.
 *
 * A taken name is reused only when it was confirmed: the confirmation is the
 * approval card naming that file, so approving it is the person saying "replace
 * this one". Anything else gets the next numbered copy. Returning nothing
 * rather than picking a name outside the bound keeps an unbounded folder from
 * turning one export into a long scan.
 */
export function planCanvasExportFileName(facts: CanvasExportNameFacts): string | undefined {
  const planned = canvasExportPlannedName(facts.title, facts.format);
  if (facts.replacesConfirmed) return planned;
  if (!facts.taken(planned)) return planned;
  const base = canvasExportStem(facts.title);
  const extension = canvasExportFileExtension(facts.format);
  for (let copy = 2; copy <= MAX_CANVAS_EXPORT_NAME_COPIES + 1; copy += 1) {
    const candidate = `${base} (${copy}).${extension}`;
    if (!facts.taken(candidate)) return candidate;
  }
  return undefined;
}
