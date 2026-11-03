import { createHash } from "node:crypto";
import {
  decodeCodeRelativePath,
  MAX_CODE_GIT_HUNKS,
  type CodeGitHunk,
  type CodeGitHunkScope,
  type CodeGitHunkUnavailable,
  type CodeRelativePath,
} from "@octant/contracts";
import { parseUnifiedDiff } from "@octant/domain";
import type { GitObservation, GitScopedDiffResult } from "./gitObservationPort";

export interface GitHunkComparison {
  readonly status: "ready";
  readonly scope: CodeGitHunkScope;
  readonly stateToken: string;
  readonly digest: string;
  readonly diff: GitObservation["diff"];
  readonly hunks: ReadonlyArray<CodeGitHunk>;
  readonly unavailable: ReadonlyArray<CodeGitHunkUnavailable>;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function pathOf(path: string): CodeRelativePath | undefined {
  try {
    return decodeCodeRelativePath(path);
  } catch {
    return undefined;
  }
}

/** Identities and raw patches come from one canonical host read, never renderer patch text. */
export function prepareGitHunks(
  scope: CodeGitHunkScope,
  observation: GitObservation,
  comparison: Extract<GitScopedDiffResult, { readonly status: "ready" }>,
): GitHunkComparison {
  const digest = hash(`${scope}\0${comparison.diff.text}`);
  const base = {
    status: "ready" as const,
    scope,
    stateToken: observation.stateToken,
    digest,
    diff: comparison.diff,
  };
  if (comparison.diff.truncated)
    return { ...base, hunks: [], unavailable: [{ reason: "truncated" }] };
  const files = parseUnifiedDiff(comparison.diff.text, { retainSource: true });
  const paths = new Set(comparison.paths);
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  const unavailable: CodeGitHunkUnavailable[] = [];
  const hunks: CodeGitHunk[] = [];
  const blocked = new Map<string, "rename" | "conflict">();
  for (const entry of observation.statusEntries) {
    if (entry.originalPath !== undefined || entry.index === "R" || entry.worktree === "R") {
      blocked.set(entry.path, "rename");
      if (entry.originalPath !== undefined) blocked.set(entry.originalPath, "rename");
    }
    if (
      entry.index === "U" ||
      entry.worktree === "U" ||
      ["AA", "DD"].includes(entry.index + entry.worktree)
    )
      blocked.set(entry.path, "conflict");
    if (scope === "unstaged" && entry.index === "?" && entry.worktree === "?") {
      const path = pathOf(entry.path);
      unavailable.push({ ...(path === undefined ? {} : { path }), reason: "untracked" });
    }
  }
  for (const [name, reason] of blocked) {
    const path = pathOf(name);
    if (paths.has(name)) unavailable.push({ ...(path === undefined ? {} : { path }), reason });
  }
  for (const file of files) {
    const path = pathOf(file.path);
    const refuse = (reason: CodeGitHunkUnavailable["reason"]) =>
      unavailable.push({ ...(path === undefined ? {} : { path }), reason });
    if (
      path === undefined ||
      !paths.has(file.path) ||
      counts.get(file.path) !== 1 ||
      file.source === undefined
    ) {
      refuse("path-encoding");
      continue;
    }
    const reason = blocked.get(file.path);
    if (reason !== undefined) continue;
    if (file.binary || file.hunks.length === 0) {
      refuse("binary");
      continue;
    }
    const header = comparison.diff.text.slice(file.source.start, file.source.headerEnd);
    if (
      /^(?:old mode |new mode )/m.test(header) ||
      /(?:^index .* |^(?:new file mode|deleted file mode) )(?:120000|160000)(?:\n|$)/m.test(header)
    ) {
      refuse("mode-change");
      continue;
    }
    const selected: CodeGitHunk[] = [];
    for (const [index, hunk] of file.hunks.entries()) {
      if (
        hunk.source === undefined ||
        ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        hunk.lines.filter((line) => line.kind !== "added").length !== hunk.oldLines ||
        hunk.lines.filter((line) => line.kind !== "removed").length !== hunk.newLines
      ) {
        selected.length = 0;
        refuse("invalid-hunk");
        break;
      }
      const raw = comparison.diff.text.slice(hunk.source.start, hunk.source.end);
      if (
        raw
          .split("\n")
          .slice(1)
          .some(
            (line) =>
              line !== "" && !/^[ +-]/.test(line) && line !== "\\ No newline at end of file",
          )
      ) {
        selected.length = 0;
        refuse("invalid-hunk");
        break;
      }
      selected.push({
        id: hash(`${scope}\0${header}\0${raw}`),
        path,
        index,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
      });
    }
    hunks.push(...selected);
  }
  if (hunks.length > MAX_CODE_GIT_HUNKS)
    return { ...base, hunks: [], unavailable: [{ reason: "too-many-hunks" }] };
  return { ...base, hunks, unavailable };
}

/** Selects only exact recorded identities in their native file/hunk order. */
export function selectedGitHunkPatch(
  comparison: GitHunkComparison,
  selected: readonly string[],
): string | undefined {
  const ids = new Set(selected);
  if (
    ids.size === 0 ||
    ids.size !== selected.length ||
    selected.some((id) => !comparison.hunks.some((hunk) => hunk.id === id))
  )
    return undefined;
  let patch = "";
  for (const file of parseUnifiedDiff(comparison.diff.text, { retainSource: true })) {
    if (file.source === undefined) return undefined;
    const chosen = comparison.hunks.filter((hunk) => hunk.path === file.path && ids.has(hunk.id));
    if (chosen.length === 0) continue;
    patch += comparison.diff.text.slice(file.source.start, file.source.headerEnd);
    for (const identity of chosen) {
      const source = file.hunks[identity.index]?.source;
      if (source === undefined) return undefined;
      patch += comparison.diff.text.slice(source.start, source.end);
    }
  }
  return patch === "" ? undefined : patch;
}
