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

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number on the original side; absent for an added line. */
  readonly oldNumber?: number;
  /** Line number on the modified side; absent for a removed line. */
  readonly newNumber?: number;
}

/** One `@@` region, numbered on both sides so a reader can place it in the file. */
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** What git printed after the range: usually the enclosing function. */
  readonly heading: string;
  readonly lines: ReadonlyArray<DiffLine>;
}

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
  /** The changed regions in order, as git printed them. */
  readonly hunks: ReadonlyArray<DiffHunk>;
}

interface HunkAccumulator {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly heading: string;
  readonly lines: DiffLine[];
  oldNext: number;
  newNext: number;
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
  hunks: HunkAccumulator[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function newAccumulator(): FileAccumulator {
  return {
    change: "modified",
    additions: 0,
    deletions: 0,
    original: [],
    modified: [],
    sawHunk: false,
    hunks: [],
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
    hunks: accumulator.hunks.map(({ oldNext: _oldNext, newNext: _newNext, ...hunk }) => hunk),
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
    const range = HUNK.exec(line);
    if (range !== null) {
      accumulator.sawHunk = true;
      // A gap between hunks is not contiguous text; mark it so neither side
      // reads as one continuous file.
      if (accumulator.original.length > 0) accumulator.original.push("");
      if (accumulator.modified.length > 0) accumulator.modified.push("");
      const oldStart = Number(range[1]);
      const newStart = Number(range[3]);
      accumulator.hunks.push({
        oldStart,
        oldLines: range[2] === undefined ? 1 : Number(range[2]),
        newStart,
        newLines: range[4] === undefined ? 1 : Number(range[4]),
        heading: (range[5] ?? "").trim(),
        lines: [],
        oldNext: oldStart,
        newNext: newStart,
      });
      continue;
    }
    if (!accumulator.sawHunk) continue;
    const hunk = accumulator.hunks.at(-1);
    if (line.startsWith("+")) {
      accumulator.additions += 1;
      accumulator.modified.push(line.slice(1));
      if (hunk !== undefined) {
        hunk.lines.push({ kind: "added", text: line.slice(1), newNumber: hunk.newNext });
        hunk.newNext += 1;
      }
      continue;
    }
    if (line.startsWith("-")) {
      accumulator.deletions += 1;
      accumulator.original.push(line.slice(1));
      if (hunk !== undefined) {
        hunk.lines.push({ kind: "removed", text: line.slice(1), oldNumber: hunk.oldNext });
        hunk.oldNext += 1;
      }
      continue;
    }
    if (line.startsWith(" ")) {
      accumulator.original.push(line.slice(1));
      accumulator.modified.push(line.slice(1));
      if (hunk !== undefined) {
        hunk.lines.push({
          kind: "context",
          text: line.slice(1),
          oldNumber: hunk.oldNext,
          newNumber: hunk.newNext,
        });
        hunk.oldNext += 1;
        hunk.newNext += 1;
      }
      continue;
    }
    // `\ No newline at end of file` and any trailing blank line carry no content.
  }
  flush();
  return files;
}
