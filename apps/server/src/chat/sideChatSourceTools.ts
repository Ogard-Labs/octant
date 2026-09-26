import {
  MAX_SIDE_CHAT_TOOL_LIST_ENTRIES,
  MAX_SIDE_CHAT_TOOL_READ_CHARACTERS,
  MAX_SIDE_CHAT_TOOL_READ_LINES,
  MAX_SIDE_CHAT_TOOL_SEARCH_MATCHES,
  SIDE_CHAT_LIST_FILES_TOOL_NAME,
  SIDE_CHAT_READ_FILE_TOOL_NAME,
  SIDE_CHAT_SEARCH_FILES_TOOL_NAME,
  decodeCodeRelativePath,
  type CodeCheckoutId,
  type CodeFileListingResult,
  type CodeFileOpenResultEnvelope,
  type CodeRelativePath,
  type CodeSearchResult,
  type CodeSearchScope,
  type CodeThreadId,
  type ProviderToolDefinition,
  type WorkFileListingResult,
  type WorkThreadId,
} from "@octant/contracts";
import { canonicalizeWorkRelativePath, WorkConfinementRejected } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { readConfinedWorkFile } from "../work/workConfinedRead";
import type { WorkFilesystemPort } from "../work/workFilesystemPort";
import { joinWorkPath, resolveContainedWorkPath } from "../work/workPathConfinement";

/**
 * Host reads over a Code source thread's checkout, each taking the source
 * thread id and resolving the checkout itself. Every one is a Code service read
 * that re-authorizes the caller's window against the thread's Project, binding
 * revision, and checkout on its own, so the sidecar holds no grant between
 * calls; it only names which thread it is asking about.
 */
export interface SideChatCodeSourceReads {
  readonly checkoutOf: (threadId: CodeThreadId) => Promise<CodeCheckoutId>;
  readonly listFiles: (input: {
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly directory?: CodeRelativePath;
    readonly signal?: AbortSignal;
  }) => Promise<CodeFileListingResult>;
  readonly searchFiles: (input: {
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly scope: CodeSearchScope;
    readonly query: string;
    readonly signal?: AbortSignal;
  }) => Promise<CodeSearchResult>;
  readonly openFile: (input: {
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly relativePath: CodeRelativePath;
    readonly signal?: AbortSignal;
  }) => Promise<CodeFileOpenResultEnvelope>;
  readonly readContent: (contentId: string) => Promise<{ readonly bytes: Uint8Array }>;
}

/**
 * Host reads over a Work source thread's Project folder. `listFiles` is the Work
 * folder listing; `readFile` answers `undefined` for anything it refuses.
 */
export interface SideChatWorkSourceReads {
  readonly listFiles: (input: {
    readonly threadId: WorkThreadId;
    readonly directory?: string;
    readonly signal?: AbortSignal;
  }) => Promise<WorkFileListingResult>;
  readonly readFile: (input: {
    readonly threadId: WorkThreadId;
    readonly relativePath: string;
  }) => Promise<SideChatWorkFileRead>;
}

export type SideChatWorkFileRead =
  | { readonly status: "read"; readonly bytes: Uint8Array }
  | { readonly status: "refused"; readonly message: string };

export type SideChatFileSource =
  | {
      readonly mode: "code";
      readonly threadId: CodeThreadId;
      readonly reads: SideChatCodeSourceReads;
    }
  | {
      readonly mode: "work";
      readonly threadId: WorkThreadId;
      readonly reads: SideChatWorkSourceReads;
    };

/**
 * Read-only file tools for one Side Chat turn about a Work or Code thread.
 *
 * These exist so a Side Chat can answer "what does that file say now" without
 * holding any of the source thread's authority. They reach the source through
 * the same host reads the Files panel uses, never through the provider's own
 * filesystem or the native harness file port, which shares its handle with
 * edit and write. There is no write, shell, Git, or network tool here, and the
 * set is fixed when the turn starts, so a call cannot name one into existence.
 *
 * `authorize` runs before every call. It re-checks that this Side Chat is still
 * linked to the source and that the window may still Open it; a refusal there
 * ends the call before any path reaches the host. The host read then
 * re-authorizes the window against the source's root on its own.
 */
export function createSideChatSourceTools(input: {
  readonly source: SideChatFileSource;
  readonly authorize: () => Promise<boolean>;
}): AppManagedToolSet {
  const definitions = sideChatSourceToolDefinitions(input.source.mode);
  return {
    definitions,
    execute: async ({ name, inputJson, signal }) => {
      if (!definitions.some((definition) => definition.name === name)) {
        return refused("That Side Chat tool is not available.");
      }
      if (signal?.aborted === true) return refused("The turn was cancelled.");
      let args: ReadonlyMap<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(inputJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return refused("The tool input must be a JSON object.");
        }
        args = new Map(Object.entries(parsed));
      } catch {
        return refused("The tool input is not valid JSON.");
      }
      let allowed: boolean;
      try {
        allowed = await input.authorize();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return refused("The thread this Side Chat is about can no longer be read.");
      }
      const source = input.source;
      try {
        if (source.mode === "code") return await executeCode(source, name, args, signal);
        return await executeWork(source, name, args, signal);
      } catch {
        return refused("The thread's files could not be read.");
      }
    },
  };
}

/** The read-only tools a Side Chat about a thread of this mode is offered. */
export function sideChatSourceToolDefinitions(
  mode: "code" | "work",
): ReadonlyArray<ProviderToolDefinition> {
  const list: ProviderToolDefinition = {
    name: SIDE_CHAT_LIST_FILES_TOOL_NAME,
    description:
      "List files and folders in the thread this Side Chat is about. Read-only. Paths are relative to that thread's folder.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Folder to list, relative to the thread's folder. Omit for the top level.",
        },
      },
      additionalProperties: false,
    },
  };
  const read: ProviderToolDefinition = {
    name: SIDE_CHAT_READ_FILE_TOOL_NAME,
    description: `Read a text file in the thread this Side Chat is about. Read-only. Returns up to ${MAX_SIDE_CHAT_TOOL_READ_LINES} lines; pass startLine to read further.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the thread's folder." },
        startLine: { type: "integer", minimum: 1, description: "First line to return, from 1." },
        lineCount: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SIDE_CHAT_TOOL_READ_LINES,
          description: "How many lines to return.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
  if (mode === "work") return [list, read];
  const search: ProviderToolDefinition = {
    name: SIDE_CHAT_SEARCH_FILES_TOOL_NAME,
    description:
      "Search the thread this Side Chat is about, by file name or by text inside files. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "Text to look for." },
        scope: {
          type: "string",
          enum: ["content", "path"],
          description: '"content" searches inside files (default); "path" matches file names.',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
  return [list, search, read];
}

async function executeCode(
  source: Extract<SideChatFileSource, { mode: "code" }>,
  name: string,
  args: ReadonlyMap<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  if (name === SIDE_CHAT_LIST_FILES_TOOL_NAME) {
    const directory = optionalString(args, "directory");
    const relative = directory === undefined ? undefined : codePath(directory);
    if (relative === "refused") return outsideRoot();
    const checkoutId = await source.reads.checkoutOf(source.threadId);
    const result = await source.reads.listFiles({
      threadId: source.threadId,
      checkoutId,
      ...(relative === undefined ? {} : { directory: relative }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status === "failed") return refused(result.failure.message);
    const entries = result.listing.entries.slice(0, MAX_SIDE_CHAT_TOOL_LIST_ENTRIES);
    return {
      result: {
        status: "listed",
        entries: entries.map((entry) =>
          entry.kind === "directory"
            ? { kind: "directory", path: entry.path }
            : { kind: "file", path: entry.path, byteLength: entry.byteLength },
        ),
        truncated: result.listing.truncated || entries.length < result.listing.entries.length,
      },
    };
  }
  if (name === SIDE_CHAT_SEARCH_FILES_TOOL_NAME) {
    const query = optionalString(args, "query")?.trim() ?? "";
    if (query.length === 0 || query.length > 200) {
      return refused("A search needs a query of 1 to 200 characters.");
    }
    const scopeArg = args.get("scope");
    const scope: CodeSearchScope = scopeArg === "path" ? "path" : "content";
    const checkoutId = await source.reads.checkoutOf(source.threadId);
    const result = await source.reads.searchFiles({
      threadId: source.threadId,
      checkoutId,
      scope,
      query,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status === "failed") return refused(result.failure.message);
    const matches = result.search.matches.slice(0, MAX_SIDE_CHAT_TOOL_SEARCH_MATCHES);
    return {
      result: {
        status: "searched",
        matches: matches.map((match) =>
          match.scope === "path"
            ? { path: match.path }
            : { path: match.path, line: match.line, preview: match.preview },
        ),
        truncated: result.search.truncated || matches.length < result.search.matches.length,
      },
    };
  }
  const requested = optionalString(args, "path");
  if (requested === undefined) return refused("Name the file to read.");
  const relative = codePath(requested);
  if (relative === "refused") return outsideRoot();
  const checkoutId = await source.reads.checkoutOf(source.threadId);
  const opened = await source.reads.openFile({
    threadId: source.threadId,
    checkoutId,
    relativePath: relative,
    ...(signal === undefined ? {} : { signal }),
  });
  const result = opened.result;
  if (result.status === "read-only") {
    return refused(
      result.reason === "binary"
        ? "That file is binary, so it cannot be read as text."
        : "That file is too large to read here.",
    );
  }
  if (result.status === "interrupted") return refused("The file changed while it was read.");
  if (result.status === "failed") return refused("That file could not be opened.");
  const content = await source.reads.readContent(String(result.content.contentId));
  return textWindow(relative, content.bytes, args);
}

async function executeWork(
  source: Extract<SideChatFileSource, { mode: "work" }>,
  name: string,
  args: ReadonlyMap<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  if (name === SIDE_CHAT_LIST_FILES_TOOL_NAME) {
    const directory = optionalString(args, "directory");
    const relative = directory === undefined ? undefined : workPath(directory);
    if (relative === "refused") return outsideRoot();
    const result = await source.reads.listFiles({
      threadId: source.threadId,
      ...(relative === undefined ? {} : { directory: relative }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status === "failed") return refused(result.failure.message);
    const entries = result.listing.entries.slice(0, MAX_SIDE_CHAT_TOOL_LIST_ENTRIES);
    return {
      result: {
        status: "listed",
        entries: entries.map((entry) =>
          entry.kind === "directory"
            ? { kind: "directory", path: entry.path }
            : { kind: "file", path: entry.path, byteLength: entry.byteLength },
        ),
        truncated: result.listing.truncated || entries.length < result.listing.entries.length,
      },
    };
  }
  const requested = optionalString(args, "path");
  if (requested === undefined) return refused("Name the file to read.");
  const relative = workPath(requested);
  if (relative === "refused") return outsideRoot();
  const read = await source.reads.readFile({ threadId: source.threadId, relativePath: relative });
  if (read.status === "refused") return refused(read.message);
  return textWindow(relative, read.bytes, args);
}

/**
 * A bounded window of a file's text. Binary content is refused rather than
 * decoded into noise, and the window states where it stopped so the model can
 * ask for the next lines instead of assuming it saw the end.
 */
function textWindow(
  path: string,
  bytes: Uint8Array,
  args: ReadonlyMap<string, unknown>,
): ToolOutcome {
  if (bytes.subarray(0, 8_192).includes(0)) {
    return refused("That file is binary, so it cannot be read as text.");
  }
  const lines = new TextDecoder().decode(bytes).split("\n");
  const startLine = positiveInteger(args.get("startLine")) ?? 1;
  const lineCount = Math.min(
    positiveInteger(args.get("lineCount")) ?? MAX_SIDE_CHAT_TOOL_READ_LINES,
    MAX_SIDE_CHAT_TOOL_READ_LINES,
  );
  if (startLine > lines.length) {
    return refused(`That file has ${lines.length} lines.`);
  }
  const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
  let text = selected.join("\n");
  let clipped = false;
  if (text.length > MAX_SIDE_CHAT_TOOL_READ_CHARACTERS) {
    text = text.slice(0, MAX_SIDE_CHAT_TOOL_READ_CHARACTERS);
    clipped = true;
  }
  const endLine = clipped
    ? startLine - 1 + text.split("\n").length
    : startLine - 1 + selected.length;
  return {
    result: {
      status: "read",
      path,
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: clipped || endLine < lines.length,
      text,
    },
  };
}

/**
 * The confined read behind a Work Side Chat's file tool: the path is
 * canonicalized, resolved inside the Project folder with symlinks followed only
 * while they stay inside it, and then read from one handle that must be the
 * object that resolution saw. `resolveRoot` re-derives the folder from the
 * window's current Project access on every call.
 */
export function createSideChatWorkFileReader(input: {
  readonly filesystem: WorkFilesystemPort;
  readonly resolveRoot: (threadId: WorkThreadId) => Promise<string | undefined>;
  readonly maximumBytes: number;
}): SideChatWorkSourceReads["readFile"] {
  return async ({ threadId, relativePath }) => {
    const root = await input.resolveRoot(threadId);
    if (root === undefined) {
      return { status: "refused", message: "This Project's folder is not available." };
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await input.filesystem.realpath(root);
    } catch {
      return { status: "refused", message: "This Project's folder could not be read." };
    }
    const relative = workPath(relativePath);
    if (relative === "refused") {
      return { status: "refused", message: "That path is outside the thread's folder." };
    }
    const resolved = await resolveContainedWorkPath(
      input.filesystem,
      canonicalRoot,
      joinWorkPath(canonicalRoot, relative),
    );
    if (resolved === undefined) {
      return { status: "refused", message: "That file is not inside the thread's folder." };
    }
    if (!resolved.stat.isFile) return { status: "refused", message: "That path is not a file." };
    if (resolved.stat.size > input.maximumBytes) {
      return { status: "refused", message: "That file is too large to read here." };
    }
    const bytes = await readConfinedWorkFile({
      filesystem: input.filesystem,
      canonicalPath: resolved.canonical,
      expected: resolved.stat,
      maximumBytes: input.maximumBytes,
    });
    return bytes === undefined
      ? { status: "refused", message: "That file could not be read." }
      : { status: "read", bytes };
  };
}

type ToolOutcome = { readonly result: unknown; readonly isError?: boolean };

function refused(message: string): ToolOutcome {
  return { result: { status: "refused", message }, isError: true };
}

function outsideRoot(): ToolOutcome {
  return refused("That path is outside the thread's folder. Use a path relative to it.");
}

function codePath(raw: string): CodeRelativePath | "refused" {
  const trimmed = raw.trim().replace(/^\.\/+/, "");
  try {
    return decodeCodeRelativePath(trimmed);
  } catch {
    return "refused";
  }
}

function workPath(raw: string): string | "refused" {
  try {
    return canonicalizeWorkRelativePath(raw.trim());
  } catch (error) {
    if (error instanceof WorkConfinementRejected) return "refused";
    throw error;
  }
}

function optionalString(args: ReadonlyMap<string, unknown>, key: string): string | undefined {
  const value = args.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
