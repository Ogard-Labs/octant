import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * A memory file Octant reads itself, and each file its `@path` imports name,
 * in the order Claude Code loads them: the file, then each import where it
 * appears, depth first.
 */
export interface ClaudeMemoryEntry {
  readonly path: string;
  readonly text: string;
}

export interface ClaudeMemoryExpansion {
  readonly entries: ReadonlyArray<ClaudeMemoryEntry>;
  /** Whether an import was left out because a depth, file, or size bound was reached. */
  readonly truncated: boolean;
  /**
   * The imports left out because the file or size bound was reached, each
   * once. Octant sets those bounds, so a reader reports them; the depth bound
   * is Claude Code's own rule, and an import past it is one Claude Code would
   * not load either.
   */
  readonly omitted: ReadonlyArray<string>;
}

/**
 * Reads one file for the expansion: its text and the path it resolves to
 * once every symbolic link is followed, or undefined when it is not a
 * readable file. The expansion judges the resolved path, so a link out of
 * the allowed folders is refused however the import names it.
 */
export type ClaudeMemoryFileRead = (
  path: string,
) => { readonly text: string; readonly realPath: string } | undefined;

/**
 * Claude Code follows imports at most five hops from the file that started
 * them. The file and byte bounds keep a Project's memory from pulling in an
 * unbounded tree.
 */
export const CLAUDE_MEMORY_IMPORT_LIMITS = {
  maxDepth: 5,
  maxFiles: 32,
  maxBytes: 256 * 1024,
} as const;

/**
 * Expands the `@path` imports of a CLAUDE.md file the way Claude Code does,
 * for the places Octant reads the file itself (an untrusted Project, where the
 * runtime does not read it). A relative import resolves from the importing
 * file's folder and `@~/` from the home folder. An import inside a code span
 * or a fenced code block is text, not an import. Only a file inside one of
 * `allowedRoots` (the Project's folders and the account's config folders,
 * given as resolved paths) is read; a file that resolves outside them through
 * a symbolic link is refused. A file already loaded is not loaded again, so a
 * cycle ends.
 */
export function expandClaudeMemoryImports(input: {
  readonly path: string;
  readonly text: string;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly homeDirectory: string;
  readonly read: ClaudeMemoryFileRead;
}): ClaudeMemoryExpansion {
  const entries: ClaudeMemoryEntry[] = [];
  const loaded = new Set<string>();
  let bytes = 0;
  let truncated = false;
  const omitted: string[] = [];
  const allowed = (path: string) =>
    input.allowedRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));

  const visit = (path: string, text: string, depth: number) => {
    entries.push({ path, text });
    for (const name of claudeMemoryImportNames(text)) {
      const target = claudeMemoryImportPath(name, dirname(path), input.homeDirectory);
      if (target === undefined || !allowed(target)) continue;
      if (depth >= CLAUDE_MEMORY_IMPORT_LIMITS.maxDepth) {
        truncated = true;
        continue;
      }
      const file = input.read(target);
      if (file === undefined || !allowed(file.realPath) || loaded.has(file.realPath)) continue;
      const size = Buffer.byteLength(file.text, "utf8");
      if (
        entries.length >= CLAUDE_MEMORY_IMPORT_LIMITS.maxFiles ||
        bytes + size > CLAUDE_MEMORY_IMPORT_LIMITS.maxBytes
      ) {
        truncated = true;
        if (!omitted.includes(target)) omitted.push(target);
        continue;
      }
      loaded.add(file.realPath);
      bytes += size;
      visit(target, file.text, depth + 1);
    }
  };

  const root = input.read(input.path);
  loaded.add(root?.realPath ?? input.path);
  bytes = Buffer.byteLength(input.text, "utf8");
  visit(input.path, input.text, 0);
  return { entries, truncated, omitted };
}

/** The `@path` names a memory file imports, in order, leaving out code. */
export function claudeMemoryImportNames(text: string): ReadonlyArray<string> {
  const names: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const prose = line.replace(/`[^`]*`/gu, " ");
    for (const match of prose.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/gu)) {
      const name = match[1]?.replaceAll("\\ ", " ");
      if (name !== undefined && name !== "") names.push(name);
    }
  }
  return names;
}

/** The absolute path an import names, or undefined for one that names no file. */
function claudeMemoryImportPath(
  name: string,
  folder: string,
  homeDirectory: string,
): string | undefined {
  if (name.startsWith("~/")) return resolve(join(homeDirectory, name.slice(2)));
  if (isAbsolute(name)) return resolve(name);
  // An address such as `@scope/package` or `@mention` with no folder or
  // extension is still a relative name in Claude Code; it simply resolves to
  // a file that is usually missing.
  return resolve(folder, name);
}
