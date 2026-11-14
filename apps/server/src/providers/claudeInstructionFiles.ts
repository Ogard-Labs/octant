import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The most one instruction file may weigh; a larger file is skipped, not cut. */
export const MAX_CLAUDE_INSTRUCTION_FILE_BYTES = 64 * 1024;
/** The most all of a session's instruction files may weigh together. */
export const MAX_CLAUDE_INSTRUCTION_TOTAL_BYTES = 256 * 1024;
/**
 * How deep `@path` imports are followed. Claude Code's own loader stops at
 * five levels (`lle` in the bundled 2.1 runtime, read 2026-11-14).
 */
const MAX_IMPORT_DEPTH = 5;
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
    | "protected";
}

export interface ClaudeInstructionFiles {
  /** The files' text, each under its path, or undefined when none was read. */
  readonly text: string | undefined;
  readonly skipped: ReadonlyArray<ClaudeInstructionSkip>;
}

interface Reading {
  /** Whether a file is one this session may not read, in any form it resolves to. */
  readonly refuses: (path: string) => boolean;
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
 * files they import with `@path`. Ancestors above the Project root are
 * outside the Project and are not read; nested folders' files Claude Code
 * loads only when it reads inside them. A file is skipped, with its reason,
 * when it is too large, not text, resolves (through a symlink or an import)
 * outside the folder it came from, or is one `refuses` names: a file or
 * import the session may not read is skipped before it is opened.
 */
export async function readClaudeInstructionFiles(input: {
  readonly configDir?: string;
  readonly projectRoot?: string;
  readonly refuses?: (path: string) => boolean;
}): Promise<ClaudeInstructionFiles> {
  const reading: Reading = {
    refuses: input.refuses ?? (() => false),
    parts: [],
    skipped: [],
    seen: new Set(),
    bytes: 0,
  };
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
  for (const path of paths) await readOne(reading, realFolder, path, 0);
}

function inside(folder: string, path: string): boolean {
  const between = relative(folder, path);
  return (
    between === "" || (!between.startsWith(`..${sep}`) && between !== ".." && !isAbsolute(between))
  );
}

async function readOne(reading: Reading, realFolder: string, path: string, depth: number) {
  if (depth > MAX_IMPORT_DEPTH) return;
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
  for (const imported of importsOf(text)) {
    await readOne(reading, realFolder, resolve(dirname(real), imported), depth + 1);
  }
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

/**
 * The `@path` imports a file names outside code: a relative path, as Claude
 * Code reads them. A home path (`@~/…`) or an absolute one is left alone,
 * since it would leave the folder the file came from.
 */
function importsOf(text: string): ReadonlyArray<string> {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const outsideSpans = line.replace(/`[^`]*`/g, "");
    for (const match of outsideSpans.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      const target = match[1];
      if (target === undefined || target.startsWith("~") || isAbsolute(target)) continue;
      if (!/[./]/.test(target)) continue;
      found.push(target);
    }
  }
  return found;
}
