import { mkdir, readdir, readFile, realpath, lstat, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyPathContainment } from "@octant/domain";
import type { NativeHarnessToolResultBounds } from "@octant/contracts";

/** Directories a search never descends into unless the pattern names them. */
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const MAX_READ_RESULT_BYTES = 64 * 1024;
const MAX_GREP_RESULT_BYTES = 64 * 1024;
const MAX_GREP_SCANNED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_GREP_PATTERN_LENGTH = 512;
/** A scan the model asked for never holds the event loop longer than this. */
const MAX_GREP_SCAN_MS = 5_000;
const MAX_GLOB_RESULTS = 1_000;
const MAX_WALKED_ENTRIES = 50_000;
const MAX_GREP_LINE_LENGTH = 512;

export type NativeHarnessFileRefusal =
  | "path-escapes-root"
  | "path-not-found"
  | "not-a-file"
  | "file-too-large"
  | "not-read-first"
  | "file-changed-since-read"
  | "old-text-not-found"
  | "old-text-ambiguous"
  | "pattern-invalid";

export type NativeHarnessReadResult =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly startLine: number;
      readonly lines: ReadonlyArray<string>;
      readonly totalLines: number;
      readonly nextLine?: number;
      readonly bounds: NativeHarnessToolResultBounds;
    }
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly entries: ReadonlyArray<{
        readonly name: string;
        readonly kind: "file" | "directory" | "other";
      }>;
    }
  | { readonly kind: "refused"; readonly reason: NativeHarnessFileRefusal };

export type NativeHarnessEditResult =
  | {
      readonly kind: "edited";
      readonly path: string;
      readonly replacements: number;
      readonly fuzzy: boolean;
    }
  | { readonly kind: "refused"; readonly reason: NativeHarnessFileRefusal };

export type NativeHarnessWriteResult =
  | {
      readonly kind: "written";
      readonly path: string;
      readonly bytes: number;
      readonly created: boolean;
    }
  | { readonly kind: "refused"; readonly reason: NativeHarnessFileRefusal };

export interface NativeHarnessGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export type NativeHarnessGrepResult =
  | {
      readonly kind: "matches";
      readonly matches: ReadonlyArray<NativeHarnessGrepMatch>;
      readonly filesScanned: number;
      readonly bounds: NativeHarnessToolResultBounds;
    }
  | { readonly kind: "refused"; readonly reason: NativeHarnessFileRefusal };

export type NativeHarnessGlobResult =
  | { readonly kind: "paths"; readonly paths: ReadonlyArray<string>; readonly truncated: boolean }
  | { readonly kind: "refused"; readonly reason: NativeHarnessFileRefusal };

export interface NativeHarnessFileSystemOptions {
  /** Absolute, already-canonical root every path is confined to. */
  readonly root: string;
  readonly maxFileBytes?: number;
}

/**
 * The files a harness session may touch, and nothing outside them.
 *
 * Every path the model names is canonicalized and checked against the root
 * after symlinks are resolved, so a link planted inside the root cannot make
 * a read or a write reach the rest of the host. A write to a path that does
 * not exist yet checks its nearest existing ancestor the same way.
 *
 * An edit is honest about what it saw: it needs a prior read of the same file
 * through this instance, and it refuses when the file changed since, which is
 * also what makes the defensive re-read before every edit unnecessary.
 */
export class NativeHarnessFileSystem {
  readonly #root: string;
  readonly #maxFileBytes: number;
  readonly #readMarks = new Map<string, string>();

  constructor(options: NativeHarnessFileSystemOptions) {
    if (!isAbsolute(options.root)) {
      throw new Error("Native harness file system root must be absolute.");
    }
    this.#root = options.root.replace(/\/+$/, "");
    this.#maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  }

  get root(): string {
    return this.#root;
  }

  async read(input: {
    readonly path: string;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<NativeHarnessReadResult> {
    const resolved = await this.#contained(input.path);
    if (resolved === undefined) return { kind: "refused", reason: "path-escapes-root" };
    let info;
    try {
      info = await stat(resolved);
    } catch {
      return { kind: "refused", reason: "path-not-found" };
    }
    const display = this.#display(resolved);
    if (info.isDirectory()) {
      const names = await readdir(resolved, { withFileTypes: true });
      return {
        kind: "directory",
        path: display,
        entries: names
          .slice(0, MAX_GLOB_RESULTS)
          .map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory()
              ? ("directory" as const)
              : entry.isFile()
                ? ("file" as const)
                : ("other" as const),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      };
    }
    if (!info.isFile()) return { kind: "refused", reason: "not-a-file" };
    if (info.size > this.#maxFileBytes) return { kind: "refused", reason: "file-too-large" };
    const content = await readFile(resolved, "utf8");
    this.#readMarks.set(resolved, info.mtime.toISOString());
    const allLines = content.split("\n");
    const startLine = Math.min(input.offset ?? 0, allLines.length);
    const limit = input.limit ?? 2_000;
    const lines: string[] = [];
    let returnedBytes = 0;
    let cursor = startLine;
    while (cursor < allLines.length && lines.length < limit) {
      const line = allLines[cursor] ?? "";
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (returnedBytes + bytes > MAX_READ_RESULT_BYTES && lines.length > 0) break;
      lines.push(line);
      returnedBytes += bytes;
      cursor += 1;
    }
    const omittedBytes = allLines
      .slice(cursor)
      .reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
    const truncated = cursor < allLines.length;
    return {
      kind: "file",
      path: display,
      startLine,
      lines,
      totalLines: allLines.length,
      ...(truncated ? { nextLine: cursor } : {}),
      bounds: truncated
        ? { truncated, returnedBytes, omittedBytes, nextOffset: cursor }
        : { truncated, returnedBytes },
    };
  }

  async write(input: {
    readonly path: string;
    readonly content: string;
  }): Promise<NativeHarnessWriteResult> {
    const target = await this.#containedForWrite(input.path);
    if (target === undefined) return { kind: "refused", reason: "path-escapes-root" };
    let created = true;
    try {
      const existing = await lstat(target);
      created = false;
      if (!existing.isFile()) return { kind: "refused", reason: "not-a-file" };
    } catch {
      await mkdir(dirname(target), { recursive: true });
    }
    await writeFile(target, input.content, "utf8");
    const info = await stat(target);
    this.#readMarks.set(target, info.mtime.toISOString());
    return {
      kind: "written",
      path: this.#display(target),
      bytes: Buffer.byteLength(input.content, "utf8"),
      created,
    };
  }

  async edit(input: {
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly replaceAll?: boolean | undefined;
  }): Promise<NativeHarnessEditResult> {
    const resolved = await this.#contained(input.path);
    if (resolved === undefined) return { kind: "refused", reason: "path-escapes-root" };
    const mark = this.#readMarks.get(resolved);
    if (mark === undefined) return { kind: "refused", reason: "not-read-first" };
    let info;
    try {
      info = await stat(resolved);
    } catch {
      return { kind: "refused", reason: "path-not-found" };
    }
    if (!info.isFile()) return { kind: "refused", reason: "not-a-file" };
    if (info.mtime.toISOString() !== mark) {
      return { kind: "refused", reason: "file-changed-since-read" };
    }
    const content = await readFile(resolved, "utf8");
    const exact = countOccurrences(content, input.oldText);
    let edited: { readonly text: string; readonly count: number } | undefined;
    let fuzzy = false;
    if (exact > 0) {
      if (exact > 1 && input.replaceAll !== true) {
        return { kind: "refused", reason: "old-text-ambiguous" };
      }
      edited = replaceOccurrences(content, input.oldText, input.newText, input.replaceAll === true);
    } else {
      // One whitespace-normalized retry: a model that reproduces indentation
      // slightly wrong still names an unambiguous span, and the file's own
      // bytes outside that span are left exactly as they were.
      const spans = fuzzySpans(content, input.oldText);
      if (spans.length === 0) return { kind: "refused", reason: "old-text-not-found" };
      if (spans.length > 1 && input.replaceAll !== true) {
        return { kind: "refused", reason: "old-text-ambiguous" };
      }
      fuzzy = true;
      const chosen = input.replaceAll === true ? spans : spans.slice(0, 1);
      let text = content;
      for (const span of [...chosen].reverse()) {
        text = text.slice(0, span.start) + input.newText + text.slice(span.end);
      }
      edited = { text, count: chosen.length };
    }
    await writeFile(resolved, edited.text, "utf8");
    const after = await stat(resolved);
    this.#readMarks.set(resolved, after.mtime.toISOString());
    return { kind: "edited", path: this.#display(resolved), replacements: edited.count, fuzzy };
  }

  async glob(input: {
    readonly pattern: string;
    readonly path?: string | undefined;
  }): Promise<NativeHarnessGlobResult> {
    const base = await this.#contained(input.path ?? ".");
    if (base === undefined) return { kind: "refused", reason: "path-escapes-root" };
    let matcher: RegExp;
    try {
      matcher = globToRegExp(input.pattern);
    } catch {
      return { kind: "refused", reason: "pattern-invalid" };
    }
    const descendSkipped = SKIPPED_DIRECTORY_NAMES.has(firstSegment(input.pattern));
    const paths: string[] = [];
    let truncated = false;
    for await (const entry of this.#walk(base, descendSkipped)) {
      if (!entry.isFile) continue;
      const candidate = relative(base, entry.path).split(sep).join("/");
      if (!matcher.test(candidate)) continue;
      if (paths.length >= MAX_GLOB_RESULTS) {
        truncated = true;
        break;
      }
      paths.push(this.#display(entry.path));
    }
    paths.sort();
    return { kind: "paths", paths, truncated };
  }

  async grep(input: {
    readonly pattern: string;
    readonly path?: string | undefined;
    readonly include?: string | undefined;
    readonly maxMatches?: number | undefined;
  }): Promise<NativeHarnessGrepResult> {
    const base = await this.#contained(input.path ?? ".");
    if (base === undefined) return { kind: "refused", reason: "path-escapes-root" };
    let expression: RegExp;
    let include: RegExp | undefined;
    if (input.pattern.length > MAX_GREP_PATTERN_LENGTH) {
      return { kind: "refused", reason: "pattern-invalid" };
    }
    try {
      expression = new RegExp(input.pattern);
      include = input.include === undefined ? undefined : globToRegExp(input.include);
    } catch {
      return { kind: "refused", reason: "pattern-invalid" };
    }
    const deadline = Date.now() + MAX_GREP_SCAN_MS;
    const maxMatches = input.maxMatches ?? 200;
    const matches: NativeHarnessGrepMatch[] = [];
    let filesScanned = 0;
    let returnedBytes = 0;
    let truncated = false;
    let baseInfo;
    try {
      baseInfo = await stat(base);
    } catch {
      return { kind: "refused", reason: "path-not-found" };
    }
    const files = baseInfo.isFile()
      ? [{ path: base, isFile: true }]
      : this.#walk(base, SKIPPED_DIRECTORY_NAMES.has(firstSegment(input.path ?? "")));
    for await (const entry of files) {
      if (!entry.isFile) continue;
      const name = relative(base, entry.path).split(sep).join("/") || entry.path;
      if (include !== undefined && !include.test(name.split("/").at(-1) ?? name)) continue;
      let info;
      try {
        info = await stat(entry.path);
      } catch {
        continue;
      }
      if (info.size > MAX_GREP_SCANNED_FILE_BYTES) continue;
      const content = await readFile(entry.path);
      if (content.includes(0)) continue;
      filesScanned += 1;
      const lines = content.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        // A pattern that backtracks badly is cut off by time, not by luck.
        if ((index & 255) === 0 && Date.now() > deadline) {
          truncated = true;
          break;
        }
        const line = lines[index] ?? "";
        if (!expression.test(line)) continue;
        const text =
          line.length > MAX_GREP_LINE_LENGTH ? `${line.slice(0, MAX_GREP_LINE_LENGTH)}…` : line;
        const bytes = Buffer.byteLength(text, "utf8") + 32;
        if (matches.length >= maxMatches || returnedBytes + bytes > MAX_GREP_RESULT_BYTES) {
          truncated = true;
          break;
        }
        matches.push({ path: this.#display(entry.path), line: index + 1, text });
        returnedBytes += bytes;
      }
      if (truncated) break;
    }
    return {
      kind: "matches",
      matches,
      filesScanned,
      bounds: truncated
        ? { truncated, returnedBytes, omittedBytes: 1, nextOffset: matches.length }
        : { truncated, returnedBytes },
    };
  }

  async *#walk(
    base: string,
    descendSkipped: boolean,
  ): AsyncGenerator<{ readonly path: string; readonly isFile: boolean }> {
    const pending: string[] = [base];
    let visited = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > MAX_WALKED_ENTRIES) return;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          // A link is followed only when its target stays inside the root.
          const contained = await this.#contained(path);
          if (contained === undefined) continue;
          let info;
          try {
            info = await stat(contained);
          } catch {
            continue;
          }
          if (info.isFile()) yield { path, isFile: true };
          continue;
        }
        if (entry.isDirectory()) {
          if (!descendSkipped && SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
          pending.push(path);
          continue;
        }
        if (entry.isFile()) yield { path, isFile: true };
      }
    }
  }

  async #contained(candidate: string): Promise<string | undefined> {
    const absolute = isAbsolute(candidate) ? candidate : resolve(this.#root, candidate);
    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch {
      return undefined;
    }
    return classifyPathContainment(this.#root, canonical) === "contained" ? canonical : undefined;
  }

  async #containedForWrite(candidate: string): Promise<string | undefined> {
    const absolute = isAbsolute(candidate) ? candidate : resolve(this.#root, candidate);
    const existing = await this.#contained(absolute);
    if (existing !== undefined) return existing;
    // The file does not exist yet. Its nearest ancestor that does exist must
    // itself be contained — a symlinked directory that escapes the root is
    // refused here, not skipped over — and the segments below it are literal,
    // because nothing exists there for a link to hide in.
    let ancestor = dirname(absolute);
    const trailing: string[] = [absolute.slice(ancestor.length + 1)];
    while (ancestor !== dirname(ancestor)) {
      let exists = false;
      try {
        await lstat(ancestor);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        const contained = await this.#contained(ancestor);
        if (contained === undefined) return undefined;
        const target = join(contained, ...trailing.reverse());
        return classifyPathContainment(this.#root, target) === "contained" ? target : undefined;
      }
      trailing.push(ancestor.slice(dirname(ancestor).length + 1));
      ancestor = dirname(ancestor);
    }
    return undefined;
  }

  #display(canonical: string): string {
    const rel = relative(this.#root, canonical);
    return rel === "" ? "." : rel.split(sep).join("/");
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceOccurrences(
  haystack: string,
  needle: string,
  replacement: string,
  all: boolean,
): { readonly text: string; readonly count: number } {
  if (!all) {
    const index = haystack.indexOf(needle);
    return {
      text: haystack.slice(0, index) + replacement + haystack.slice(index + needle.length),
      count: 1,
    };
  }
  const count = countOccurrences(haystack, needle);
  return { text: haystack.split(needle).join(replacement), count };
}

/**
 * Where `needle` occurs in `text` once every run of whitespace on both sides
 * is read as a single space. Each span is in the original text's own indices,
 * so replacing it leaves every byte outside the span untouched.
 */
function fuzzySpans(
  text: string,
  needle: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const normalizedNeedle = needle.replace(/\s+/g, " ").trim();
  if (normalizedNeedle.length === 0) return [];
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const whitespace = /\s/;
  let index = 0;
  while (index < text.length) {
    if (whitespace.test(text[index]!)) {
      const runStart = index;
      while (index < text.length && whitespace.test(text[index]!)) index += 1;
      normalized += " ";
      starts.push(runStart);
      ends.push(index);
    } else {
      normalized += text[index];
      starts.push(index);
      ends.push(index + 1);
      index += 1;
    }
  }
  const spans: { start: number; end: number }[] = [];
  let at = normalized.indexOf(normalizedNeedle);
  while (at !== -1) {
    spans.push({ start: starts[at]!, end: ends[at + normalizedNeedle.length - 1]! });
    at = normalized.indexOf(normalizedNeedle, at + normalizedNeedle.length);
  }
  return spans;
}

function firstSegment(pattern: string): string {
  return pattern.split("/")[0] ?? "";
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const slashFollows = pattern[index + 2] === "/";
        source += slashFollows ? "(?:.*/)?" : ".*";
        index += slashFollows ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "{") {
      const close = pattern.indexOf("}", index);
      if (close === -1) throw new Error("Unterminated brace in glob.");
      const options = pattern
        .slice(index + 1, close)
        .split(",")
        .map((option) => option.replace(/[.+^$()|[\]\\]/g, "\\$&"));
      source += `(?:${options.join("|")})`;
      index = close;
    } else if (/[.+^$()|[\]\\]/.test(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`${source}$`);
}
