import { mkdir, readdir, readFile, realpath, lstat, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyPathContainment } from "@octant/domain";
import {
  MAX_PROVIDER_TOOL_IMAGE_BASE64_LENGTH,
  type NativeHarnessReplacement,
  type NativeHarnessToolResultBounds,
  type ProviderToolImage,
} from "@octant/contracts";
import { secretGuardRefusal } from "../process/secretGuard";
import { DEFAULT_DOCUMENT_BUDGET, parseDocument } from "../preview/previewDocumentChunker";
import { DEFAULT_PDF_BUDGET, parsePdf } from "../preview/previewPdfChunker";
import { sniffPreviewKind } from "../preview/previewSniffer";
import { DEFAULT_SLIDES_BUDGET, parseSlides } from "../preview/previewSlidesChunker";
import {
  DEFAULT_WORKBOOK_BUDGET,
  parseWorkbook,
  type WorkbookWorksheet,
} from "../preview/previewWorkbookChunker";

/** Directories a search never descends into unless the pattern names them. */
export const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const MAX_READ_RESULT_BYTES = 64 * 1024;
export const MAX_GREP_RESULT_BYTES = 64 * 1024;
/** The largest image a read returns: what one tool image may carry once base64-encoded. */
export const MAX_READ_IMAGE_BYTES = (MAX_PROVIDER_TOOL_IMAGE_BASE64_LENGTH / 4) * 3;
export const MAX_GREP_SCANNED_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_GREP_PATTERN_LENGTH = 512;
/** A scan the model asked for never holds the event loop longer than this. */
const MAX_GREP_SCAN_MS = 5_000;
export const MAX_GLOB_RESULTS = 1_000;
export const MAX_WALKED_ENTRIES = 50_000;
export const MAX_GREP_LINE_LENGTH = 512;

export type NativeHarnessFileRefusal =
  | "path-escapes-root"
  | "path-not-found"
  | "not-a-file"
  | "file-too-large"
  | "not-read-first"
  | "file-changed-since-read"
  | "old-text-not-found"
  | "old-text-ambiguous"
  | "pattern-invalid"
  /**
   * The files' machine cannot be reached. Nothing reached the files. Kept so
   * a refusal recorded by an earlier build still reads.
   */
  | "target-unavailable"
  /** The secret guard's list names the file; `message` says which rule and channel. */
  | "protected-file"
  /** Not text and not a format a read extracts; `message` names what a read can open. */
  | "binary-file"
  /** Recognized as a Word, PowerPoint, Excel, or PDF file, but its parser could not read it. */
  | "document-unreadable";

export interface NativeHarnessFileRefused {
  readonly kind: "refused";
  readonly reason: NativeHarnessFileRefusal;
  readonly message?: string;
}

/** The formats a read extracts text from, named by their usual extension. */
export type NativeHarnessExtractedFormat = "docx" | "pptx" | "xlsx" | "pdf";

export type NativeHarnessReadResult =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly startLine: number;
      readonly lines: ReadonlyArray<string>;
      readonly totalLines: number;
      readonly nextLine?: number;
      readonly bounds: NativeHarnessToolResultBounds;
      /**
       * The format the lines were extracted from; absent for a text file.
       * Extracted lines are not the file's bytes, so such a read never
       * counts as the read an edit needs.
       */
      readonly extractedFrom?: NativeHarnessExtractedFormat;
      /** Set when the format's parser stopped at one of its limits; says what was left out. */
      readonly parserNote?: string;
    }
  /**
   * An image, recognized by its bytes. `data` is the base64 the model is
   * handed; whether it may be is the tool's decision, not the files'.
   */
  | {
      readonly kind: "image";
      readonly path: string;
      readonly mimeType: ProviderToolImage["mimeType"];
      readonly bytes: number;
      readonly data: string;
    }
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly entries: ReadonlyArray<{
        readonly name: string;
        readonly kind: "file" | "directory" | "other";
      }>;
    }
  | NativeHarnessFileRefused;

export type NativeHarnessEditResult =
  | {
      readonly kind: "edited";
      readonly path: string;
      readonly replacements: number;
      readonly fuzzy: boolean;
    }
  | NativeHarnessFileRefused;

/**
 * Several replacements in one call. A refusal names the replacement that
 * failed, by its index in the call, and means no file changed. A write that
 * fails after every check passed puts back the files the call had written;
 * `unrestored` lists any that could not be put back.
 */
export type NativeHarnessEditFilesResult =
  | {
      readonly kind: "edited";
      readonly files: ReadonlyArray<{
        readonly path: string;
        readonly replacements: number;
        readonly fuzzy: boolean;
      }>;
    }
  | (NativeHarnessFileRefused & { readonly edit: number })
  | {
      readonly kind: "write-failed";
      readonly path: string;
      readonly unrestored: ReadonlyArray<string>;
    };

/** A file an edit may rewrite: checked against its read, with the content that read saw. */
export interface NativeHarnessEditTarget {
  readonly kind: "loaded";
  /** What the port writes to: the real path. */
  readonly key: string;
  readonly path: string;
  readonly content: string;
}

export type NativeHarnessWriteResult =
  | {
      readonly kind: "written";
      readonly path: string;
      readonly bytes: number;
      readonly created: boolean;
    }
  | NativeHarnessFileRefused;

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
  | NativeHarnessFileRefused;

export type NativeHarnessGlobResult =
  | { readonly kind: "paths"; readonly paths: ReadonlyArray<string>; readonly truncated: boolean }
  | NativeHarnessFileRefused;

/**
 * The files a harness session's tools reach: a folder on this host, or a
 * remote root the target's executor reaches for it with this same class.
 */
export type NativeHarnessFileSystemPort = Pick<
  NativeHarnessFileSystem,
  "root" | "read" | "write" | "edit" | "editFiles" | "glob" | "grep"
> & {
  /** The Project's extra folders; the shell reaches them as it reaches `root`. */
  readonly extraRoots?: ReadonlyArray<string>;
};

export interface NativeHarnessFileSystemOptions {
  /** Absolute, already-canonical root relative paths resolve against. */
  readonly root: string;
  /**
   * The Project's extra folders, absolute and canonical. A path in one is
   * inside the Project exactly as a path in `root` is.
   */
  readonly extraRoots?: ReadonlyArray<string>;
  readonly maxFileBytes?: number;
  /**
   * The secret guard's refusal for a path, or undefined. Defaults to this
   * host's protected list; a Project that holds the home folder still never
   * hands a key to these tools, at any level.
   */
  readonly protectedFileRefusal?: (path: string) => string | undefined;
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
  readonly #extraRoots: ReadonlyArray<string>;
  readonly #maxFileBytes: number;
  readonly #readMarks = new Map<string, string>();
  readonly #protectedFileRefusal: (path: string) => string | undefined;

  constructor(options: NativeHarnessFileSystemOptions) {
    if (!isAbsolute(options.root)) {
      throw new Error("Native harness file system root must be absolute.");
    }
    this.#root = options.root.replace(/\/+$/, "");
    if ((options.extraRoots ?? []).some((root) => !isAbsolute(root))) {
      throw new Error("Native harness file system extra roots must be absolute.");
    }
    this.#extraRoots = (options.extraRoots ?? []).map((root) => root.replace(/\/+$/, ""));
    this.#maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.#protectedFileRefusal =
      options.protectedFileRefusal ?? ((path) => secretGuardRefusal(path));
  }

  /** A refusal naming the rule, for a path the secret guard protects. */
  #protected(...paths: ReadonlyArray<string>): NativeHarnessFileRefused | undefined {
    for (const path of paths) {
      const message = this.#protectedFileRefusal(path);
      if (message !== undefined) return { kind: "refused", reason: "protected-file", message };
    }
    return undefined;
  }

  #lexical(candidate: string): string {
    return isAbsolute(candidate) ? candidate : resolve(this.#root, candidate);
  }

  get root(): string {
    return this.#root;
  }

  get extraRoots(): ReadonlyArray<string> {
    return this.#extraRoots;
  }

  async read(input: {
    readonly path: string;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
    /**
     * Whether this read lets a later edit of the file through. A read Octant
     * makes for itself, not one the model asked for, passes false.
     */
    readonly marksRead?: boolean;
  }): Promise<NativeHarnessReadResult> {
    const resolved = await this.#contained(input.path);
    if (resolved === undefined) return { kind: "refused", reason: "path-escapes-root" };
    const guarded = this.#protected(this.#lexical(input.path), resolved);
    if (guarded !== undefined) return guarded;
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
    const content = await readFile(resolved);
    const result = readFileContent(display, content, input);
    if (input.marksRead !== false && countsAsTextRead(result)) {
      this.#readMarks.set(resolved, info.mtime.toISOString());
    }
    return result;
  }

  async write(input: {
    readonly path: string;
    readonly content: string;
  }): Promise<NativeHarnessWriteResult> {
    const target = await this.#containedForWrite(input.path);
    if (target === undefined) return { kind: "refused", reason: "path-escapes-root" };
    const guarded = this.#protected(this.#lexical(input.path), target);
    if (guarded !== undefined) return guarded;
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
    const target = await this.#loadForEdit(input.path);
    if (target.kind === "refused") return target;
    const edited = editedText(target.content, input);
    if (edited.kind === "refused") return edited;
    await this.#put(target.key, edited.text);
    return {
      kind: "edited",
      path: target.path,
      replacements: edited.count,
      fuzzy: edited.fuzzy,
    };
  }

  editFiles(edits: ReadonlyArray<NativeHarnessReplacement>): Promise<NativeHarnessEditFilesResult> {
    return editFiles(edits, {
      load: (path) => this.#loadForEdit(path),
      put: (key, text) => this.#put(key, text),
    });
  }

  async #loadForEdit(path: string): Promise<NativeHarnessEditTarget | NativeHarnessFileRefused> {
    const resolved = await this.#contained(path);
    if (resolved === undefined) return { kind: "refused", reason: "path-escapes-root" };
    const guarded = this.#protected(this.#lexical(path), resolved);
    if (guarded !== undefined) return guarded;
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
    return { kind: "loaded", key: resolved, path: this.#display(resolved), content };
  }

  async #put(key: string, text: string): Promise<undefined> {
    await writeFile(key, text, "utf8");
    const after = await stat(key);
    this.#readMarks.set(key, after.mtime.toISOString());
    return undefined;
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
    if (baseInfo.isFile()) {
      const guarded = this.#protected(this.#lexical(input.path ?? "."), base);
      if (guarded !== undefined) return guarded;
    }
    const files = baseInfo.isFile()
      ? [{ path: base, isFile: true }]
      : this.#walk(base, SKIPPED_DIRECTORY_NAMES.has(firstSegment(input.path ?? "")));
    for await (const entry of files) {
      if (!entry.isFile) continue;
      // A search across a folder passes over a protected file without
      // opening it; naming the file itself is refused above.
      if (this.#protected(entry.path) !== undefined) continue;
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
    return this.#inProject(canonical) ? canonical : undefined;
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
        return this.#inProject(target) ? target : undefined;
      }
      trailing.push(ancestor.slice(dirname(ancestor).length + 1));
      ancestor = dirname(ancestor);
    }
    return undefined;
  }

  #inProject(canonical: string): boolean {
    return [this.#root, ...this.#extraRoots].some(
      (root) => classifyPathContainment(root, canonical) === "contained",
    );
  }

  #display(canonical: string): string {
    // A file in an extra folder is named by its absolute path, since a path
    // relative to the root would read as climbing out of it.
    if (classifyPathContainment(this.#root, canonical) !== "contained") return canonical;
    const rel = relative(this.#root, canonical);
    return rel === "" ? "." : rel.split(sep).join("/");
  }
}

/**
 * What a read of one file returns, decided by its bytes, whatever the file is
 * named: an image; a Word, PowerPoint, or Excel file or a PDF as extracted
 * text, through the same bounded parsers the preview uses; a text file as
 * numbered lines; and a refusal for anything else that is not text.
 */
export function readFileContent(
  path: string,
  content: Buffer,
  input: { readonly offset?: number | undefined; readonly limit?: number | undefined },
): NativeHarnessReadResult {
  const mimeType = imageMimeType(content);
  if (mimeType !== undefined) {
    if (content.length > MAX_READ_IMAGE_BYTES) {
      return {
        kind: "refused",
        reason: "file-too-large",
        message: `This image is ${content.length} bytes; a read returns images up to ${MAX_READ_IMAGE_BYTES} bytes.`,
      };
    }
    return {
      kind: "image",
      path,
      mimeType,
      bytes: content.length,
      data: content.toString("base64"),
    };
  }
  const sniffed = sniffPreviewKind(content, "", "application/octet-stream", {
    maxSniffBytes: SNIFFED_HEAD_BYTES,
    maxByteSize: content.length,
  });
  const kind = sniffed.ok ? sniffed.kind : "unsupported";
  if (kind === "document" || kind === "slides" || kind === "workbook" || kind === "pdf") {
    const extracted = extractedText(kind, content);
    if (extracted === undefined) {
      return {
        kind: "refused",
        reason: "document-unreadable",
        message: `This looks like ${EXTRACTED_FORMAT_NAMES[EXTRACTED_FORMATS[kind]]}, but it could not be parsed.`,
      };
    }
    return {
      ...readSlice(path, extracted.text, input),
      extractedFrom: EXTRACTED_FORMATS[kind],
      ...(extracted.truncated
        ? {
            parserNote: `Reading ${EXTRACTED_FORMAT_NAMES[EXTRACTED_FORMATS[kind]]} stopped at one of its limits (at most ${MAX_EXTRACTED_TEXT_BYTES} bytes of text per file), so some of the file's content is not shown.`,
          }
        : {}),
    };
  }
  if (kind === "unsupported" || kind === "image") {
    return {
      kind: "refused",
      reason: "binary-file",
      message:
        "This is a binary file. A read opens text, PNG, JPEG, GIF, and WebP images, Word (.docx), PowerPoint (.pptx), and Excel (.xlsx) files, and PDFs.",
    };
  }
  return readSlice(path, content.toString("utf8"), input);
}

/** How much of a file's start decides whether it is text, as the preview sniffs it. */
const SNIFFED_HEAD_BYTES = 4096;

const EXTRACTED_FORMATS = {
  document: "docx",
  slides: "pptx",
  workbook: "xlsx",
  pdf: "pdf",
} as const satisfies Record<string, NativeHarnessExtractedFormat>;

const EXTRACTED_FORMAT_NAMES: Readonly<Record<NativeHarnessExtractedFormat, string>> = {
  docx: "a Word document",
  pptx: "a PowerPoint presentation",
  xlsx: "an Excel workbook",
  pdf: "a PDF",
};

/** Whether a read saw the file's own text, the only read an edit may follow. */
export function countsAsTextRead(result: NativeHarnessReadResult): boolean {
  return result.kind === "file" && result.extractedFrom === undefined;
}

/**
 * The most text a read extracts from one file, sixty-four pages of a read
 * result. A format's parser bounds what it keeps of each part, not what the
 * parts add up to: a workbook whose 20,000 cells name one 32,767-character
 * shared string would render to about 625 MB from a small file. The text is
 * built against this budget and stops there, so that expansion never exists.
 */
export const MAX_EXTRACTED_TEXT_BYTES = 64 * MAX_READ_RESULT_BYTES;

/** Text appended piece by piece until it reaches {@link MAX_EXTRACTED_TEXT_BYTES}. */
function extractionBudget() {
  const parts: string[] = [];
  let bytes = 0;
  let full = false;
  return {
    /** Adds a piece, cut to the room left; false once the budget is spent. */
    append(piece: string): boolean {
      if (full) return false;
      const room = MAX_EXTRACTED_TEXT_BYTES - bytes;
      // A character is at least one byte, so a piece longer in characters
      // than the room left is cut before it is measured.
      const head = piece.length > room ? piece.slice(0, room) : piece;
      const size = Buffer.byteLength(head, "utf8");
      if (size <= room && head.length === piece.length) {
        parts.push(head);
        bytes += size;
        return true;
      }
      const cut = Buffer.from(head, "utf8")
        .subarray(0, room)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
      parts.push(cut);
      bytes += Buffer.byteLength(cut, "utf8");
      full = true;
      return false;
    },
    get full(): boolean {
      return full;
    },
    text(): string {
      return parts.join("");
    },
  };
}

/**
 * A format's content as plain text, with a marker line before each slide,
 * page, and worksheet, under the preview parsers' own limits and the
 * extraction budget. `truncated` says either one cut it.
 */
function extractedText(
  kind: keyof typeof EXTRACTED_FORMATS,
  content: Buffer,
): { readonly text: string; readonly truncated: boolean } | undefined {
  const budget = extractionBudget();
  const lines = (parts: ReadonlyArray<string>) => {
    for (const [index, part] of parts.entries()) {
      if (index > 0 && !budget.append("\n")) return;
      if (!budget.append(part)) return;
    }
  };
  const sections = (marker: string, parts: ReadonlyArray<string>) => {
    for (const [index, part] of parts.entries()) {
      if (index > 0 && !budget.append("\n")) return;
      if (!budget.append(`--- ${marker} ${index + 1} ---\n`) || !budget.append(part)) return;
    }
  };
  let truncated: boolean;
  switch (kind) {
    case "document": {
      const parsed = parseDocument(content, DEFAULT_DOCUMENT_BUDGET);
      if (parsed === undefined) return undefined;
      lines(parsed.blocks);
      truncated = parsed.truncated;
      break;
    }
    case "slides": {
      const parsed = parseSlides(content, DEFAULT_SLIDES_BUDGET);
      if (parsed === undefined) return undefined;
      sections("Slide", parsed.slides);
      truncated = parsed.truncated;
      break;
    }
    case "pdf": {
      const parsed = parsePdf(content, DEFAULT_PDF_BUDGET);
      if (parsed === undefined) return undefined;
      sections("Page", parsed.pages);
      truncated = parsed.truncated;
      break;
    }
    case "workbook": {
      const parsed = parseWorkbook(content, DEFAULT_WORKBOOK_BUDGET);
      if (parsed === undefined) return undefined;
      appendWorksheets(budget, parsed.worksheets);
      truncated = parsed.truncated;
      break;
    }
  }
  return { text: budget.text(), truncated: truncated || budget.full };
}

function appendWorksheets(
  budget: ReturnType<typeof extractionBudget>,
  worksheets: ReadonlyArray<WorkbookWorksheet>,
): void {
  for (const [sheetIndex, sheet] of worksheets.entries()) {
    if (sheetIndex > 0 && !budget.append("\n")) return;
    if (!budget.append(`--- Sheet: ${sheet.name} ---`)) return;
    for (const row of sheet.rows) {
      if (!budget.append("\n")) return;
      for (const [cellIndex, cell] of row.entries()) {
        if (cellIndex > 0 && !budget.append("\t")) return;
        // A tab or line break inside a cell would read as a new cell or
        // row, so it becomes a space. Only what can still fit is copied.
        const value = cell === null ? "" : String(cell).slice(0, MAX_EXTRACTED_TEXT_BYTES);
        if (!budget.append(value.replace(/[\t\r\n]+/g, " "))) return;
      }
    }
  }
}

function imageMimeType(content: Buffer): ProviderToolImage["mimeType"] | undefined {
  if (startsWith(content, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (startsWith(content, "\xff\xd8\xff")) return "image/jpeg";
  if (startsWith(content, "GIF87a") || startsWith(content, "GIF89a")) return "image/gif";
  if (startsWith(content, "RIFF") && content.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function startsWith(content: Buffer, signature: string): boolean {
  return content.subarray(0, signature.length).toString("latin1") === signature;
}

/** The lines of a file a read returns, from `offset`, at most `limit` and the result's byte bound. */
export function readSlice(
  path: string,
  content: string,
  input: { readonly offset?: number | undefined; readonly limit?: number | undefined },
): Extract<NativeHarnessReadResult, { readonly kind: "file" }> {
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
    path,
    startLine,
    lines,
    totalLines: allLines.length,
    ...(truncated ? { nextLine: cursor } : {}),
    bounds: truncated
      ? { truncated, returnedBytes, omittedBytes, nextOffset: cursor }
      : { truncated, returnedBytes },
  };
}

/**
 * A file's text after an edit, or why the edit names no single span. Shared
 * by every place the harness's files live, so an edit reads the same on this
 * host and on a server.
 */
export function editedText(
  content: string,
  input: {
    readonly oldText: string;
    readonly newText: string;
    readonly replaceAll?: boolean | undefined;
  },
):
  | {
      readonly kind: "edited";
      readonly text: string;
      readonly count: number;
      readonly fuzzy: boolean;
    }
  | NativeHarnessFileRefused {
  const exact = countOccurrences(content, input.oldText);
  if (exact > 0) {
    if (exact > 1 && input.replaceAll !== true) {
      return { kind: "refused", reason: "old-text-ambiguous" };
    }
    const replaced = replaceOccurrences(
      content,
      input.oldText,
      input.newText,
      input.replaceAll === true,
    );
    return { kind: "edited", ...replaced, fuzzy: false };
  }
  // One whitespace-normalized retry: a model that reproduces indentation
  // slightly wrong still names an unambiguous span, and the file's own
  // bytes outside that span are left exactly as they were.
  const spans = fuzzySpans(content, input.oldText);
  if (spans.length === 0) return { kind: "refused", reason: "old-text-not-found" };
  if (spans.length > 1 && input.replaceAll !== true) {
    return { kind: "refused", reason: "old-text-ambiguous" };
  }
  const chosen = input.replaceAll === true ? spans : spans.slice(0, 1);
  let text = content;
  for (const span of [...chosen].reverse()) {
    text = text.slice(0, span.start) + input.newText + text.slice(span.end);
  }
  return { kind: "edited", text, count: chosen.length, fuzzy: true };
}

/**
 * Applies several replacements all or nothing, wherever the files live.
 * Every replacement is checked against its file's read, and against the text
 * the earlier replacements in the same file leave, before any file is
 * written. `put` refuses or throws on a failed write; the files written
 * before it are then written back as they were read.
 */
export async function editFiles(
  edits: ReadonlyArray<NativeHarnessReplacement>,
  port: {
    readonly load: (path: string) => Promise<NativeHarnessEditTarget | NativeHarnessFileRefused>;
    readonly put: (key: string, text: string) => Promise<NativeHarnessFileRefused | undefined>;
  },
): Promise<NativeHarnessEditFilesResult> {
  const planned = new Map<
    string,
    {
      readonly target: NativeHarnessEditTarget;
      text: string;
      replacements: number;
      fuzzy: boolean;
    }
  >();
  for (const [index, edit] of edits.entries()) {
    const target = await port.load(edit.path);
    if (target.kind === "refused") return { ...target, edit: index };
    const file = planned.get(target.key) ?? {
      target,
      text: target.content,
      replacements: 0,
      fuzzy: false,
    };
    const edited = editedText(file.text, edit);
    if (edited.kind === "refused") return { ...edited, edit: index };
    file.text = edited.text;
    file.replacements += edited.count;
    file.fuzzy ||= edited.fuzzy;
    planned.set(target.key, file);
  }
  const written: NativeHarnessEditTarget[] = [];
  for (const file of planned.values()) {
    if (await wrote(port, file.target.key, file.text)) {
      written.push(file.target);
      continue;
    }
    // A failed write can leave its file half written; it is put back too
    // unless it still reads exactly as it was read.
    const failed = await port.load(file.target.key).catch(() => undefined);
    const untouched = failed?.kind === "loaded" && failed.content === file.target.content;
    const unrestored: string[] = [];
    for (const target of [...(untouched ? [] : [file.target]), ...[...written].reverse()]) {
      if (!(await wrote(port, target.key, target.content))) unrestored.push(target.path);
    }
    return { kind: "write-failed", path: file.target.path, unrestored };
  }
  return {
    kind: "edited",
    files: [...planned.values()].map((file) => ({
      path: file.target.path,
      replacements: file.replacements,
      fuzzy: file.fuzzy,
    })),
  };
}

async function wrote(
  port: { readonly put: (key: string, text: string) => Promise<unknown> },
  key: string,
  text: string,
): Promise<boolean> {
  try {
    return (await port.put(key, text)) === undefined;
  } catch {
    return false;
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

export function firstSegment(pattern: string): string {
  return pattern.split("/")[0] ?? "";
}

export function globToRegExp(pattern: string): RegExp {
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
