import {
  MAX_IMPORTED_TERMINAL_ENTRIES,
  MAX_IMPORTED_TERMINAL_ENTRY_LENGTH,
  MAX_IMPORTED_TERMINAL_TEXT_LENGTH,
  MAX_TERMINAL_SESSION_TITLE_LENGTH,
  MAX_TERMINAL_SESSIONS_LISTED,
  type ImportedTerminalEntry,
  type TerminalSessionProvider,
} from "@octant/contracts";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reads the sessions the Claude Code and Codex command-line tools keep on
 * this Mac. Only these two adapters know the files' shapes; the rest of the
 * host sees summaries and bounded user and assistant text.
 *
 * Files are read, never written, and only their head and tail: a long
 * session runs to tens of megabytes, and what a new thread needs is how it
 * began (its folder and first request) and where it ended.
 */

export interface TerminalSessionRoots {
  /** `projects` inside the Claude configuration folder. */
  readonly claudeProjects: string;
  /** `sessions` inside the Codex home. */
  readonly codexSessions: string;
  /** The Codex home's session name index, when it keeps one. */
  readonly codexSessionIndex?: string;
}

export interface TerminalSessionListing {
  readonly provider: TerminalSessionProvider;
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface TerminalSessionTranscript {
  readonly provider: TerminalSessionProvider;
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly entries: ReadonlyArray<ImportedTerminalEntry>;
  readonly truncated: boolean;
}

export type TerminalSessionRead =
  | { readonly status: "read"; readonly transcript: TerminalSessionTranscript }
  | {
      readonly status: "refused";
      readonly reason: "not-found" | "other-folder" | "empty" | "unreadable";
    };

const HEAD_BYTES = 256 * 1024;
const LIST_TAIL_BYTES = 64 * 1024;
const READ_TAIL_BYTES = 8 * 1024 * 1024;
const INDEX_TAIL_BYTES = 512 * 1024;
/** Codex keeps sessions by day; the picker offers recent ones, so the walk stops early. */
const MAX_CODEX_FILES_SCANNED = 400;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const CODEX_FILE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const DATE_PART = /^\d{2,4}$/;
/**
 * Text the tools wrap in a tag of their own (slash-command echoes, injected
 * reminders, environment and instruction blocks) is the tool talking, not the
 * person, and would read to the model as instructions it never got.
 */
const TOOL_WRAPPED = /^\s*<[a-z][a-z0-9_-]*>/i;
const INJECTED_INSTRUCTIONS = /^\s*# AGENTS\.md instructions/;

/** Lists the folder's sessions from both tools, newest first. */
export async function listTerminalSessions(input: {
  readonly roots: TerminalSessionRoots;
  readonly folder: string;
}): Promise<ReadonlyArray<TerminalSessionListing>> {
  const [claude, codex] = await Promise.all([
    listClaudeSessions(input.roots, input.folder),
    listCodexSessions(input.roots, input.folder),
  ]);
  return [...claude, ...codex]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_TERMINAL_SESSIONS_LISTED);
}

/**
 * Reads one session's conversation, refusing one that was not started in the
 * folder: the import is offered per folder, and a session id alone must not
 * reach another Project's history.
 */
export async function readTerminalSession(input: {
  readonly roots: TerminalSessionRoots;
  readonly folder: string;
  readonly provider: TerminalSessionProvider;
  readonly sessionId: string;
}): Promise<TerminalSessionRead> {
  if (!SESSION_ID.test(input.sessionId)) return { status: "refused", reason: "not-found" };
  const file =
    input.provider === "claude"
      ? join(input.roots.claudeProjects, claudeFolderName(input.folder), `${input.sessionId}.jsonl`)
      : (await codexSessionFiles(input.roots.codexSessions)).find(
          (candidate) => candidate.sessionId === input.sessionId,
        )?.path;
  if (file === undefined) return { status: "refused", reason: "not-found" };
  let read: FileSlices;
  try {
    read = await readSlices(file, READ_TAIL_BYTES);
  } catch {
    return { status: "refused", reason: "not-found" };
  }
  const parsed = input.provider === "claude" ? parseClaude(read, true) : parseCodex(read, true);
  if (parsed.cwd === undefined || !(await sameFolder(parsed.cwd, input.folder))) {
    return { status: "refused", reason: "other-folder" };
  }
  const bounded = boundEntries(parsed.entries);
  if (bounded.entries.length === 0) return { status: "refused", reason: "empty" };
  const title =
    (input.provider === "codex"
      ? (await codexSessionNames(input.roots.codexSessionIndex)).get(input.sessionId)
      : undefined) ??
    parsed.title ??
    "Untitled session";
  return {
    status: "read",
    transcript: {
      provider: input.provider,
      sessionId: input.sessionId,
      title: titleOf(title),
      updatedAt: read.modifiedAt,
      entries: bounded.entries,
      truncated: read.tailOnly || bounded.truncated,
    },
  };
}

/**
 * The folder name Claude Code files a working directory's sessions under:
 * every character that is not a letter or digit becomes a dash.
 */
export function claudeFolderName(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, "-");
}

async function listClaudeSessions(
  roots: TerminalSessionRoots,
  folder: string,
): Promise<ReadonlyArray<TerminalSessionListing>> {
  const directory = join(roots.claudeProjects, claudeFolderName(folder));
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files = await newestFiles(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ sessionId: name.slice(0, -".jsonl".length), path: join(directory, name) }))
      .filter((file) => SESSION_ID.test(file.sessionId)),
  );
  const listed: TerminalSessionListing[] = [];
  for (const file of files) {
    if (listed.length >= MAX_TERMINAL_SESSIONS_LISTED) break;
    const summary = await summarize(file, "claude", folder, undefined);
    if (summary !== undefined) listed.push(summary);
  }
  return listed;
}

async function listCodexSessions(
  roots: TerminalSessionRoots,
  folder: string,
): Promise<ReadonlyArray<TerminalSessionListing>> {
  const files = await newestFiles(await codexSessionFiles(roots.codexSessions));
  const names = await codexSessionNames(roots.codexSessionIndex);
  const listed: TerminalSessionListing[] = [];
  for (const file of files) {
    if (listed.length >= MAX_TERMINAL_SESSIONS_LISTED) break;
    const summary = await summarize(file, "codex", folder, names.get(file.sessionId));
    if (summary !== undefined) listed.push(summary);
  }
  return listed;
}

async function summarize(
  file: SessionFile,
  provider: TerminalSessionProvider,
  folder: string,
  indexedTitle: string | undefined,
): Promise<TerminalSessionListing | undefined> {
  let read: FileSlices;
  try {
    read = await readSlices(file.path, LIST_TAIL_BYTES);
  } catch {
    return undefined;
  }
  const parsed = provider === "claude" ? parseClaude(read, false) : parseCodex(read, false);
  if (parsed.cwd === undefined || !(await sameFolder(parsed.cwd, folder))) return undefined;
  const title = indexedTitle ?? parsed.title;
  // A session with nothing the person asked (a tool that opened and closed)
  // has nothing to continue.
  if (title === undefined) return undefined;
  return {
    provider,
    sessionId: file.sessionId,
    title: titleOf(title),
    updatedAt: read.modifiedAt,
  };
}

interface SessionFile {
  readonly sessionId: string;
  readonly path: string;
}

/** Codex files sessions under year, month and day; the walk goes newest day first. */
async function codexSessionFiles(root: string): Promise<ReadonlyArray<SessionFile>> {
  const files: SessionFile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    if (depth < 3) {
      for (const name of names
        .filter((entry) => DATE_PART.test(entry))
        .sort()
        .reverse()) {
        if (files.length >= MAX_CODEX_FILES_SCANNED) return;
        await walk(join(directory, name), depth + 1);
      }
      return;
    }
    for (const name of names.sort().reverse()) {
      if (files.length >= MAX_CODEX_FILES_SCANNED) return;
      const match = CODEX_FILE.exec(name);
      if (match?.[1] !== undefined)
        files.push({ sessionId: match[1], path: join(directory, name) });
    }
  };
  await walk(root, 0);
  return files;
}

/** The names a person gave Codex threads, latest per id, from the index's tail. */
async function codexSessionNames(index: string | undefined): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  if (index === undefined) return names;
  let read: FileSlices;
  try {
    read = await readSlices(index, INDEX_TAIL_BYTES);
  } catch {
    return names;
  }
  // A short index is all head; a long one is read from its tail, where the newest names are.
  for (const record of records(read.tailOnly ? read.tail : read.head)) {
    const id = stringField(record, "id");
    const name = stringField(record, "thread_name");
    if (id !== undefined && name !== undefined && cleanText(name) !== "") {
      names.set(id, cleanText(name));
    }
  }
  return names;
}

async function newestFiles(
  files: ReadonlyArray<SessionFile>,
): Promise<ReadonlyArray<SessionFile & { readonly modifiedMs: number }>> {
  const stamped = await Promise.all(
    files.map(async (file) => {
      try {
        const info = await stat(file.path);
        return info.isFile() ? { ...file, modifiedMs: info.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return stamped
    .filter((file): file is SessionFile & { readonly modifiedMs: number } => file !== undefined)
    .sort((left, right) => right.modifiedMs - left.modifiedMs);
}

interface FileSlices {
  readonly head: string;
  /** Everything after the head, or the last `tailBytes` of it. */
  readonly tail: string;
  /** The head and tail do not meet: the middle of the file was not read. */
  readonly tailOnly: boolean;
  readonly modifiedAt: string;
}

async function readSlices(path: string, tailBytes: number): Promise<FileSlices> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a file");
    const size = info.size;
    const headLength = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    const tailStart = Math.max(headLength, size - tailBytes);
    const tail = Buffer.alloc(size - tailStart);
    await handle.read(tail, 0, tail.length, tailStart);
    const tailOnly = tailStart > headLength;
    const modifiedAt = info.mtime.toISOString();
    // A whole file is one text, so no record is cut at the seam. Otherwise a
    // slice edge inside a line leaves a partial record that `records` drops.
    if (!tailOnly)
      return { head: Buffer.concat([head, tail]).toString("utf8"), tail: "", tailOnly, modifiedAt };
    return {
      head: head.toString("utf8"),
      tail: tail.toString("utf8").replace(/^[^\n]*\n/, ""),
      tailOnly,
      modifiedAt,
    };
  } finally {
    await handle.close();
  }
}

function* records(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) yield value;
    } catch {
      // A partial line at a slice edge, or a line the tool wrote half of.
    }
  }
}

interface ParsedSession {
  readonly cwd: string | undefined;
  readonly title: string | undefined;
  readonly entries: ReadonlyArray<ImportedTerminalEntry>;
}

function parseClaude(read: FileSlices, withEntries: boolean): ParsedSession {
  let cwd: string | undefined;
  let firstPrompt: string | undefined;
  let named: string | undefined;
  const entries: ImportedTerminalEntry[] = [];
  const visit = (record: Record<string, unknown>, collect: boolean): void => {
    const type = record.type;
    if (type === "custom-title") named = stringField(record, "customTitle") ?? named;
    if (type === "summary") named ??= stringField(record, "summary");
    if (type !== "user" && type !== "assistant") return;
    cwd ??= stringField(record, "cwd");
    if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true)
      return;
    const message = record.message;
    if (!isRecord(message)) return;
    const text = claudeText(message.content);
    if (text === undefined) return;
    if (type === "user") firstPrompt ??= text;
    if (collect) entries.push({ role: type, text });
  };
  for (const record of records(read.head)) visit(record, withEntries);
  for (const record of records(read.tail)) visit(record, withEntries);
  return {
    cwd,
    title: named === undefined || cleanText(named) === "" ? firstPrompt : cleanText(named),
    entries: mergeTurns(entries),
  };
}

/** The person's or the model's words; tool calls, results and thinking are left out. */
function claudeText(content: unknown): string | undefined {
  const parts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content
            .filter(isRecord)
            .filter((block) => block.type === "text")
            .map((block) => (typeof block.text === "string" ? block.text : ""))
        : [];
  return spokenText(parts);
}

function parseCodex(read: FileSlices, withEntries: boolean): ParsedSession {
  let cwd: string | undefined;
  let firstPrompt: string | undefined;
  const entries: ImportedTerminalEntry[] = [];
  const visit = (record: Record<string, unknown>, collect: boolean): void => {
    const payload = record.payload;
    if (!isRecord(payload)) return;
    if (record.type === "session_meta") cwd ??= stringField(payload, "cwd");
    if (record.type !== "response_item" || payload.type !== "message") return;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return;
    const content = payload.content;
    const text = spokenText(
      Array.isArray(content)
        ? content
            .filter(isRecord)
            .filter((block) => block.type === "input_text" || block.type === "output_text")
            .map((block) => (typeof block.text === "string" ? block.text : ""))
        : [],
    );
    if (text === undefined) return;
    if (role === "user") firstPrompt ??= text;
    if (collect) entries.push({ role, text });
  };
  for (const record of records(read.head)) visit(record, withEntries);
  for (const record of records(read.tail)) visit(record, withEntries);
  return { cwd, title: firstPrompt, entries: mergeTurns(entries) };
}

function spokenText(parts: ReadonlyArray<string>): string | undefined {
  const spoken = parts
    .filter((part) => !TOOL_WRAPPED.test(part) && !INJECTED_INSTRUCTIONS.test(part))
    .map(cleanText)
    .filter((part) => part !== "");
  return spoken.length === 0 ? undefined : spoken.join("\n\n");
}

/**
 * One entry per turn: the tools write a reply as several records (one per
 * block, with tool calls between), and the history reads as the conversation
 * the person saw.
 */
function mergeTurns(entries: ReadonlyArray<ImportedTerminalEntry>): ImportedTerminalEntry[] {
  const merged: ImportedTerminalEntry[] = [];
  for (const entry of entries) {
    const last = merged.at(-1);
    if (last?.role === entry.role) {
      merged[merged.length - 1] = { role: entry.role, text: `${last.text}\n\n${entry.text}` };
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

/** Keeps the most recent turns within the import's bounds. */
function boundEntries(entries: ReadonlyArray<ImportedTerminalEntry>): {
  readonly entries: ReadonlyArray<ImportedTerminalEntry>;
  readonly truncated: boolean;
} {
  const kept: ImportedTerminalEntry[] = [];
  let length = 0;
  let truncated = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (kept.length >= MAX_IMPORTED_TERMINAL_ENTRIES) {
      truncated = true;
      break;
    }
    let text = entry.text;
    if (text.length > MAX_IMPORTED_TERMINAL_ENTRY_LENGTH) {
      text = `${text.slice(0, MAX_IMPORTED_TERMINAL_ENTRY_LENGTH - 1)}…`;
      truncated = true;
    }
    if (length + text.length > MAX_IMPORTED_TERMINAL_TEXT_LENGTH) {
      truncated = true;
      break;
    }
    length += text.length;
    kept.unshift({ role: entry.role, text });
  }
  return { entries: kept, truncated };
}

async function sameFolder(cwd: string, folder: string): Promise<boolean> {
  if (cwd === folder) return true;
  try {
    return (await realpath(cwd)) === folder;
  } catch {
    return false;
  }
}

function titleOf(text: string): string {
  const line = cleanText(text).split("\n")[0]?.trim() ?? "";
  if (line === "") return "Untitled session";
  return line.length > MAX_TERMINAL_SESSION_TITLE_LENGTH
    ? `${line.slice(0, MAX_TERMINAL_SESSION_TITLE_LENGTH - 1)}…`
    : line;
}

/** Control characters other than line breaks and tabs never reach a model or a page. */
function cleanText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- C0 and DEL other than tab and newline.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
