import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { expandClaudeMemoryImports, type ClaudeMemoryFileRead } from "./claudeMemoryImports";

/** The most one instruction file may weigh; a larger file is skipped, not cut. */
export const MAX_CLAUDE_INSTRUCTION_FILE_BYTES = 64 * 1024;
/** The most all of a session's instruction files may weigh together. */
export const MAX_CLAUDE_INSTRUCTION_TOTAL_BYTES = 256 * 1024;
/** The most rule files read from one `.claude/rules` folder. */
const MAX_RULE_FILES = 64;

export interface ClaudeInstructionSkip {
  readonly path: string;
  readonly reason:
    | "too-large"
    | "outside-folder"
    | "not-text"
    | "total-exceeded"
    | "unreadable"
    | "protected"
    | "import-limit";
}

export interface ClaudeInstructionFiles {
  /** The files' text, each under its path, or undefined when none was read. */
  readonly text: string | undefined;
  readonly skipped: ReadonlyArray<ClaudeInstructionSkip>;
}

interface Reading {
  /** Whether a file is one this session may not read, in any form it resolves to. */
  readonly refuses: (path: string) => boolean;
  /** The resolved folders an import may load from: the account's and the Project's. */
  readonly roots: string[];
  readonly parts: string[];
  readonly skipped: ClaudeInstructionSkip[];
  readonly seen: Set<string>;
  bytes: number;
}

/**
 * Reads the instruction files Claude Code would load for a folder, as text
 * with no authority, for a session whose setting sources do not load them
 * (maintainer decision, 2026-11-14: Claude always reads the person's global
 * and the Project's CLAUDE.md, even before the Project is trusted; its
 * settings, hooks and `.mcp.json` still wait for trust).
 *
 * The account's file is `CLAUDE.md` in its config folder. A Project's are
 * the files Claude Code's loader reads at its root (`CLAUDE.md`,
 * `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md`) and the
 * files they import with `@path`, expanded as Claude Code expands them
 * ({@link expandClaudeMemoryImports}): relative, `@~/` and absolute imports
 * that resolve inside the account's or the Project's folder. Ancestors above
 * the Project root are outside the Project and are not read; nested folders'
 * files Claude Code loads only when it reads inside them. A file is skipped,
 * with its reason, when it is too large, not text, resolves (through a
 * symlink or an import) outside the folders read here, or is one `refuses`
 * names: a file or import the session may not read is skipped before it is
 * opened. An import left out because the import bound was reached is
 * skipped the same way.
 *
 * `importRoots` names more folders an import may load from without reading
 * their top-level files: the account's folder stays one when Claude Code
 * loads the account's own CLAUDE.md, so a Project file's `@~/.claude/...`
 * import still resolves.
 */
export async function readClaudeInstructionFiles(input: {
  readonly configDir?: string;
  readonly projectRoot?: string;
  readonly importRoots?: ReadonlyArray<string>;
  readonly refuses?: (path: string) => boolean;
}): Promise<ClaudeInstructionFiles> {
  const reading: Reading = {
    refuses: input.refuses ?? (() => false),
    roots: [],
    parts: [],
    skipped: [],
    seen: new Set(),
    bytes: 0,
  };
  for (const folder of [input.configDir, input.projectRoot, ...(input.importRoots ?? [])]) {
    if (folder === undefined || !isAbsolute(folder)) continue;
    try {
      const root = await realpath(folder);
      if (!reading.roots.includes(root)) reading.roots.push(root);
    } catch {
      // A folder that does not resolve holds nothing to import.
    }
  }
  if (input.configDir !== undefined && isAbsolute(input.configDir)) {
    await readFolderFiles(reading, input.configDir, [join(input.configDir, "CLAUDE.md")]);
  }
  if (input.projectRoot !== undefined && isAbsolute(input.projectRoot)) {
    const root = input.projectRoot;
    await readFolderFiles(reading, root, [
      join(root, "CLAUDE.md"),
      join(root, ".claude", "CLAUDE.md"),
      ...(await ruleFiles(join(root, ".claude", "rules"))),
      join(root, "CLAUDE.local.md"),
    ]);
  }
  return {
    text: reading.parts.length === 0 ? undefined : reading.parts.join("\n\n"),
    skipped: reading.skipped,
  };
}

async function ruleFiles(folder: string): Promise<ReadonlyArray<string>> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
      .map((entry) => join(folder, entry.name))
      .toSorted()
      .slice(0, MAX_RULE_FILES);
  } catch {
    return [];
  }
}

async function readFolderFiles(
  reading: Reading,
  folder: string,
  paths: ReadonlyArray<string>,
): Promise<void> {
  let realFolder: string;
  try {
    realFolder = await realpath(folder);
  } catch {
    return;
  }
  for (const path of paths) await readOne(reading, realFolder, path);
}

function inside(folder: string, path: string): boolean {
  const between = relative(folder, path);
  return (
    between === "" || (!between.startsWith(`..${sep}`) && between !== ".." && !isAbsolute(between))
  );
}

async function readOne(reading: Reading, realFolder: string, path: string) {
  try {
    await lstat(path);
  } catch {
    return;
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    reading.skipped.push({ path, reason: "unreadable" });
    return;
  }
  if (reading.seen.has(real)) return;
  reading.seen.add(real);
  // An import is judged here too, as the path it names and the file it
  // resolves to, so `@.env` or a link to a key is skipped before it is opened.
  if (reading.refuses(path) || reading.refuses(real)) {
    reading.skipped.push({ path, reason: "protected" });
    return;
  }
  if (!inside(realFolder, real)) {
    reading.skipped.push({ path, reason: "outside-folder" });
    return;
  }
  let content: Buffer;
  try {
    const stats = await lstat(real);
    if (!stats.isFile()) return;
    if (stats.size > MAX_CLAUDE_INSTRUCTION_FILE_BYTES) {
      reading.skipped.push({ path, reason: "too-large" });
      return;
    }
    content = await readFile(real);
  } catch {
    reading.skipped.push({ path, reason: "unreadable" });
    return;
  }
  if (content.byteLength > MAX_CLAUDE_INSTRUCTION_FILE_BYTES) {
    reading.skipped.push({ path, reason: "too-large" });
    return;
  }
  const text = textOf(content);
  if (text === undefined) {
    reading.skipped.push({ path, reason: "not-text" });
    return;
  }
  if (text.trim() === "") return;
  if (reading.bytes + content.byteLength > MAX_CLAUDE_INSTRUCTION_TOTAL_BYTES) {
    reading.skipped.push({ path, reason: "total-exceeded" });
    return;
  }
  reading.bytes += content.byteLength;
  reading.parts.push(`Contents of ${path}:\n\n${text.trimEnd()}`);
  readImports(reading, real, text);
}

/**
 * Adds the files a read instruction file imports, in Claude Code's order.
 * Each import meets the same checks as the file itself before it is opened:
 * the refusal list, the folders read here, the size bound, and plain text.
 */
function readImports(reading: Reading, real: string, text: string): void {
  const resolved = new Map<string, string>();
  const read: ClaudeMemoryFileRead = (path) => {
    let target: string;
    try {
      lstatSync(path);
      target = realpathSync(path);
    } catch {
      return undefined;
    }
    if (reading.seen.has(target)) return undefined;
    if (reading.refuses(path) || reading.refuses(target)) {
      reading.skipped.push({ path, reason: "protected" });
      return undefined;
    }
    if (!reading.roots.some((root) => inside(root, target))) {
      reading.skipped.push({ path, reason: "outside-folder" });
      return undefined;
    }
    let content: Buffer;
    try {
      const stats = lstatSync(target);
      if (!stats.isFile()) return undefined;
      if (stats.size > MAX_CLAUDE_INSTRUCTION_FILE_BYTES) {
        reading.skipped.push({ path, reason: "too-large" });
        return undefined;
      }
      content = readFileSync(target);
    } catch {
      reading.skipped.push({ path, reason: "unreadable" });
      return undefined;
    }
    if (content.byteLength > MAX_CLAUDE_INSTRUCTION_FILE_BYTES) {
      reading.skipped.push({ path, reason: "too-large" });
      return undefined;
    }
    const imported = textOf(content);
    if (imported === undefined) {
      reading.skipped.push({ path, reason: "not-text" });
      return undefined;
    }
    resolved.set(path, target);
    return { text: imported, realPath: target };
  };
  const expansion = expandClaudeMemoryImports({
    path: real,
    text,
    allowedRoots: reading.roots,
    homeDirectory: homedir(),
    read,
  });
  for (const entry of expansion.entries.slice(1)) {
    const target = resolved.get(entry.path) ?? entry.path;
    if (reading.seen.has(target)) continue;
    reading.seen.add(target);
    if (entry.text.trim() === "") continue;
    const bytes = Buffer.byteLength(entry.text, "utf8");
    if (reading.bytes + bytes > MAX_CLAUDE_INSTRUCTION_TOTAL_BYTES) {
      reading.skipped.push({ path: entry.path, reason: "total-exceeded" });
      continue;
    }
    reading.bytes += bytes;
    reading.parts.push(`Contents of ${entry.path}:\n\n${entry.text.trimEnd()}`);
  }
  for (const path of expansion.omitted) reading.skipped.push({ path, reason: "import-limit" });
}

/** UTF-8 text with no NUL byte; anything else is not an instruction file. */
function textOf(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}
