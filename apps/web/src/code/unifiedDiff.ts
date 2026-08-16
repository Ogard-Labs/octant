/**
 * Splits one unified diff blob into per-file sides.
 *
 * The host records a checkout's changes as a single `git diff` blob. A file
 * list and a two-pane comparison both need that blob broken apart, and a
 * unified hunk already carries both sides: context and removed lines are the
 * original, context and added lines are the modified. Reconstructing them here
 * keeps the diff view honest — it shows exactly what the host recorded — while
 * needing neither a second server round trip nor the file's full contents.
 *
 * Only the changed regions appear; the unchanged remainder of each file is not
 * reconstructed, so neither side is presented as the file's full contents.
 */

export type DiffFileChange = "created" | "deleted" | "modified" | "renamed";

export interface ParsedDiffFile {
  /** Stable key for lists and model URIs. */
  readonly id: string;
  /** Path as the user knows it: the new path, or the old one for a deletion. */
  readonly path: string;
  readonly previousPath?: string;
  readonly change: DiffFileChange;
  readonly additions: number;
  readonly deletions: number;
  /** Reconstructed left side of the changed regions. */
  readonly original: string;
  /** Reconstructed right side of the changed regions. */
  readonly modified: string;
  /** True when the diff carried no textual hunks (binary or metadata only). */
  readonly binary: boolean;
}

interface FileAccumulator {
  oldPath?: string;
  newPath?: string;
  change: DiffFileChange;
  additions: number;
  deletions: number;
  original: string[];
  modified: string[];
  sawHunk: boolean;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function newAccumulator(): FileAccumulator {
  return {
    change: "modified",
    additions: 0,
    deletions: 0,
    original: [],
    modified: [],
    sawHunk: false,
  };
}

function unquote(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
}

function stripPrefix(path: string): string {
  const unquoted = unquote(path);
  if (unquoted === "/dev/null") return unquoted;
  return unquoted.replace(/^[abciow]\//, "");
}

function finish(accumulator: FileAccumulator, index: number): ParsedDiffFile | undefined {
  const oldPath = accumulator.oldPath;
  const newPath = accumulator.newPath;
  const path = newPath !== undefined && newPath !== "/dev/null" ? newPath : oldPath;
  if (path === undefined || path === "/dev/null") return undefined;
  const renamed =
    oldPath !== undefined &&
    newPath !== undefined &&
    oldPath !== "/dev/null" &&
    newPath !== "/dev/null" &&
    oldPath !== newPath;
  const change: DiffFileChange =
    newPath === "/dev/null"
      ? "deleted"
      : oldPath === "/dev/null"
        ? "created"
        : renamed
          ? "renamed"
          : accumulator.change;
  return {
    id: `${String(index)}:${path}`,
    path,
    ...(renamed && oldPath !== undefined ? { previousPath: oldPath } : {}),
    change,
    additions: accumulator.additions,
    deletions: accumulator.deletions,
    original: accumulator.original.join("\n"),
    modified: accumulator.modified.join("\n"),
    binary: !accumulator.sawHunk,
  };
}

export function parseUnifiedDiff(diff: string): ReadonlyArray<ParsedDiffFile> {
  const files: ParsedDiffFile[] = [];
  let accumulator: FileAccumulator | undefined;
  const flush = () => {
    if (accumulator === undefined) return;
    const parsed = finish(accumulator, files.length);
    if (parsed !== undefined) files.push(parsed);
    accumulator = undefined;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      accumulator = newAccumulator();
      // `diff --git a/x b/y` is the only reliable path source for a file whose
      // hunks are absent, such as a binary or pure-mode change.
      const paths = /^diff --git (.+?) (\S+)$/.exec(line);
      if (paths?.[1] !== undefined && paths[2] !== undefined) {
        accumulator.oldPath = stripPrefix(paths[1]);
        accumulator.newPath = stripPrefix(paths[2]);
      }
      continue;
    }
    if (accumulator === undefined) continue;
    if (line.startsWith("--- ")) {
      accumulator.oldPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      accumulator.newPath = stripPrefix(line.slice(4));
      continue;
    }
    if (HUNK.test(line)) {
      accumulator.sawHunk = true;
      // A gap between hunks is not contiguous text; mark it so neither side
      // reads as one continuous file.
      if (accumulator.original.length > 0) accumulator.original.push("");
      if (accumulator.modified.length > 0) accumulator.modified.push("");
      continue;
    }
    if (!accumulator.sawHunk) continue;
    if (line.startsWith("+")) {
      accumulator.additions += 1;
      accumulator.modified.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      accumulator.deletions += 1;
      accumulator.original.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      accumulator.original.push(line.slice(1));
      accumulator.modified.push(line.slice(1));
      continue;
    }
    // `\ No newline at end of file` and any trailing blank line carry no content.
  }
  flush();
  return files;
}
