import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeFileChangeNotice,
  CodeFileId,
  CodeRelativePath,
  CodeThread,
  CodeThreadId,
  ProjectId,
  WindowId,
} from "@octant/contracts";
import {
  MAX_CODE_LANGUAGE_DOCUMENT_TEXT_LENGTH,
  type CodeLanguageApprovalRequest,
  type CodeLanguageApprovalResult,
  type CodeLanguageDocumentRequest,
  type CodeLanguageDocumentResult,
  type CodeLanguagePosition,
  type CodeLanguageReadRequest,
  type CodeLanguageReadResult,
  type CodeLanguageRefusalReason,
  type CodeLanguageUnavailableReason,
} from "@octant/contracts/code-language";
import type { ExtensionLanguageServerClass } from "@octant/contracts/extensions";
import {
  decideLanguageServerLaunch,
  type LanguageServerHostPlatform,
  type PrincipalKind,
} from "@octant/domain";
import { readConfinedCodeFile } from "./codeConfinedFileRead";
import { liveCodeTestSourcePort, type CodeTestSourcePort } from "./codeDirectoryPort";
import { joinCodePath, resolveContainedPath } from "./codePathConfinement";
import { pathInResolvedRoot, type CodeFolderRootResolution } from "./codeProjectFolderRoot";
import {
  LANGUAGE_SERVER_FRAME_CAP_BYTES,
  LanguageServerConnection,
  type LanguageServerResponse,
} from "./languageServerConnection";
import type {
  LanguageServerLaunchInput,
  LanguageServerLaunchOutcome,
  LanguageServerProcess,
} from "./languageServerProcess";
import { toDefinitionTargets, toDiagnostics } from "./languageServerResults";

/**
 * Language reads for Code threads, answered by confined language servers the
 * host starts on demand. Canonical: docs/design/language-services.md.
 *
 * Every request is authorized when it runs, and every authority check runs
 * before the launch decision is consulted, so a refused request never starts
 * a server. One server serves one checkout for one component and class;
 * threads on that checkout share it and are each checked on their own. A
 * server starts when an authorized caller opens a document in a language an
 * effective component declares, and stops when nothing has used it for the
 * idle period, when its checkout or last active thread goes, when its
 * component stops being effective, or when the host stops.
 */

export const LANGUAGE_REQUEST_DEADLINE_MS = 10_000;
export const LANGUAGE_SERVER_IDLE_MS = 10 * 60 * 1_000;
/** The extension supervisor's crash budget: two restarts a minute. */
const MAX_CRASH_RESTARTS = 2;
const CRASH_WINDOW_MS = 60_000;
const STOP_GRACE_MS = 2_000;
const SWEEP_INTERVAL_MS = 60_000;
/** Room for the JSON-RPC envelope around a document's text. */
const FRAME_ENVELOPE_BYTES = 64 * 1024;

/**
 * Octant's own table from file name to Language Server Protocol language.
 * Repository configuration never changes which language a file is, so it
 * never chooses which server reads it. The identifiers are the ones the
 * protocol's specification lists, so a server a person adds declares the same
 * names. A `.h` header reads as C.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".go": "go",
  ".html": "html",
  ".java": "java",
  ".json": "json",
  ".lua": "lua",
  ".md": "markdown",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".php": "php",
  ".py": "python",
  ".pyi": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scala": "scala",
  ".scss": "scss",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".sql": "sql",
  ".swift": "swift",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/** An effective `language-server` component, resolved by the host. */
export interface CodeLanguageServerComponent {
  /** Names the component across restarts: its extension and component ids. */
  readonly componentKey: string;
  /**
   * Names the reviewed package state a shell-command approval covers: the
   * component with its package digest and lifecycle version. Any later change
   * to the package gives it a new key, so an approval never carries over to
   * an update, a switch turned back on, or trust given again.
   */
  readonly approvalKey: string;
  readonly languages: ReadonlyArray<string>;
  readonly launchClass: ExtensionLanguageServerClass;
  /**
   * The absolute path of the binary to run, resolved at every start. An
   * installed server's resolves only once its stored package still matches
   * the digest the person reviewed; undefined means it does not, and the
   * start fails without running anything.
   */
  readonly executable: () => Promise<string | undefined>;
  readonly args: ReadonlyArray<string>;
  readonly installRoot: string;
  /** The diagnostic source label used when the server's own label is unusable. */
  readonly sourceLabel: string;
}

export interface CodeLanguageAuthority {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readThreads: () => ReadonlyArray<CodeThread>;
  readonly readCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  /**
   * The canonical real path of the folder a thread's checkout is, read on the
   * host with no window; undefined when it cannot be told.
   */
  readonly readThreadFolder: (thread: CodeThread) => string | undefined;
  /** Reach: a local window's Project binding, or a paired device's Code reach. */
  readonly canAccessProject: (scopeId: WindowId, projectId: ProjectId) => boolean;
  readonly effectiveThread: (scopeId: WindowId, thread: CodeThread) => CodeThread;
  readonly resolveRoot: (
    scopeId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    relativePath: CodeRelativePath,
  ) => Promise<CodeFolderRootResolution | undefined> | CodeFolderRootResolution | undefined;
}

export interface CodeLanguageCaller {
  readonly scopeId: WindowId;
  readonly principal: PrincipalKind;
}

/** The shell-command approvals `repo-tooling` servers need, journaled per Project. */
export interface CodeLanguageApprovals {
  readonly holds: (subject: {
    readonly projectId: ProjectId;
    readonly checkoutId: CodeCheckoutId;
    readonly component: string;
  }) => boolean;
  readonly record: (subject: {
    readonly projectId: ProjectId;
    readonly checkoutId: CodeCheckoutId;
    readonly component: string;
    readonly scope: CodeLanguageApprovalRequest["scope"];
  }) => "recorded" | "not-recorded";
}

/**
 * An agent's read, for a turn on a window. It names the file by its
 * checkout-relative path: an agent holds no editor document, so it has no file
 * reference to name.
 */
export type CodeLanguageAgentRead =
  | {
      readonly kind: "diagnostics";
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly path: CodeRelativePath;
    }
  | {
      readonly kind: "definition";
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly path: CodeRelativePath;
      readonly position: CodeLanguagePosition;
    };

/**
 * What an agent's read answers: a language read, or one of two answers only
 * an agent gets. `too-large` is a saved file past the server's frame.
 * `unsaved-edits` is a file an editor holds with text other than the saved
 * file's, which the agent's read never replaces and never answers from.
 */
export type CodeLanguageAgentReadResult =
  | CodeLanguageReadResult
  | { readonly status: "too-large" }
  | { readonly status: "unsaved-edits" };

/**
 * Marks a document hold as an agent's, beside the editor's file references
 * (which are UUIDs), so a hold can tell whether an editor still has the text.
 */
const AGENT_HOLDER_PREFIX = "agent:";

export interface CodeLanguageServiceOptions {
  readonly authority: CodeLanguageAuthority;
  /**
   * Absent on a host that records no approvals: every `repo-tooling` server
   * there is refused `approval-required`, and an approval is not recorded.
   */
  readonly approvals?: CodeLanguageApprovals;
  /**
   * Whether a thread has taken in outside content. A `repo-tooling` server's
   * Project rules are suspended while any active thread that can write its
   * folder has; absent, or a read that throws, counts as tainted.
   */
  readonly threadTainted?: (threadId: CodeThreadId) => boolean;
  /** The `language-server` components effective in Code right now. */
  readonly components: () => ReadonlyArray<CodeLanguageServerComponent>;
  /**
   * Components that would serve Code but that the person turned off in
   * Settings › Code. They contribute nothing; a file only they would read is
   * answered `turned-off` so the editor can say where the switch is.
   */
  readonly turnedOffComponents?: () => ReadonlyArray<CodeLanguageServerComponent>;
  readonly processes: {
    readonly launch: (input: LanguageServerLaunchInput) => Promise<LanguageServerLaunchOutcome>;
  };
  readonly platform: LanguageServerHostPlatform;
  /** Parent directory of every server's private cache. */
  readonly cacheRoot: string;
  /** Confines every path, and reads the saved file an agent's read names. */
  readonly files?: CodeTestSourcePort;
  /** Feeds `workspace/didChangeWatchedFiles` to servers that register for it. */
  readonly watcher?: {
    readonly watch: (request: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly rootPath: string;
      readonly signal?: AbortSignal;
    }) => AsyncIterable<CodeFileChangeNotice>;
  };
  readonly now?: () => number;
  readonly limits?: Partial<{
    readonly requestDeadlineMs: number;
    readonly idleMs: number;
    readonly maxCrashRestarts: number;
    readonly crashWindowMs: number;
    readonly stopGraceMs: number;
  }>;
}

type ServerState = "stopped" | "starting" | "ready" | "crashed";
type StartOutcome = "ready" | "crashed" | "confinement-unavailable";

interface OpenDocument {
  readonly uri: string;
  /** The path as the request named it: absolute for a file in an extra folder. */
  readonly path: CodeRelativePath;
  /** The path inside the server's root, which `path` is unless the file is in an extra folder. */
  readonly local: CodeRelativePath;
  readonly languageId: string;
  text: string;
  version: number;
  /** The file references holding it open; threads on one checkout share it. */
  readonly holders: Set<string>;
  lastTouched: number;
}

interface ServerRecord {
  readonly key: string;
  readonly checkoutId: CodeCheckoutId;
  readonly projectId: ProjectId;
  readonly component: CodeLanguageServerComponent;
  readonly rootPath: string;
  /** Whether the root is an extra folder: it has no checkout to watch, and its own server. */
  readonly extraFolder: boolean;
  /** A thread on the checkout, to label the file watch the server is fed from. */
  readonly watchThreadId: CodeThreadId;
  state: ServerState;
  generation: number;
  starting: Promise<StartOutcome> | undefined;
  process: LanguageServerProcess | undefined;
  connection: LanguageServerConnection | undefined;
  pullsDiagnostics: boolean;
  watch: AbortController | undefined;
  readonly documents: Map<string, OpenDocument>;
  readonly pushed: Map<string, ReadonlyArray<unknown>>;
  crashTimes: number[];
  lastActivity: number;
}

interface DocumentReference {
  readonly serverKey: string;
  readonly uri: string;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
}

type Authorized =
  | {
      readonly status: "authorized";
      readonly thread: CodeThread;
      readonly checkout: CodeCheckoutIdentity;
    }
  | { readonly status: "refused"; readonly reason: CodeLanguageRefusalReason };

type Served =
  | { readonly status: "served"; readonly record: ServerRecord }
  | { readonly status: "refused"; readonly reason: CodeLanguageRefusalReason }
  | { readonly status: "unavailable"; readonly reason: CodeLanguageUnavailableReason };

export class CodeLanguageService {
  readonly #authority: CodeLanguageAuthority;
  readonly #approvals: CodeLanguageApprovals | undefined;
  readonly #threadTainted: (threadId: CodeThreadId) => boolean;
  readonly #components: () => ReadonlyArray<CodeLanguageServerComponent>;
  readonly #turnedOffComponents: () => ReadonlyArray<CodeLanguageServerComponent>;
  readonly #processes: CodeLanguageServiceOptions["processes"];
  readonly #platform: LanguageServerHostPlatform;
  readonly #cacheRoot: string;
  readonly #files: CodeTestSourcePort;
  readonly #watcher: CodeLanguageServiceOptions["watcher"];
  readonly #now: () => number;
  readonly #requestDeadlineMs: number;
  readonly #idleMs: number;
  readonly #maxCrashRestarts: number;
  readonly #crashWindowMs: number;
  readonly #stopGraceMs: number;
  readonly #servers = new Map<string, ServerRecord>();
  readonly #documents = new Map<string, DocumentReference>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: CodeLanguageServiceOptions) {
    this.#authority = options.authority;
    this.#approvals = options.approvals;
    this.#threadTainted = options.threadTainted ?? (() => true);
    this.#components = options.components;
    this.#turnedOffComponents = options.turnedOffComponents ?? (() => []);
    this.#processes = options.processes;
    this.#platform = options.platform;
    this.#cacheRoot = options.cacheRoot;
    this.#files = options.files ?? liveCodeTestSourcePort;
    this.#watcher = options.watcher;
    this.#now = options.now ?? Date.now;
    this.#requestDeadlineMs = options.limits?.requestDeadlineMs ?? LANGUAGE_REQUEST_DEADLINE_MS;
    this.#idleMs = options.limits?.idleMs ?? LANGUAGE_SERVER_IDLE_MS;
    this.#maxCrashRestarts = options.limits?.maxCrashRestarts ?? MAX_CRASH_RESTARTS;
    this.#crashWindowMs = options.limits?.crashWindowMs ?? CRASH_WINDOW_MS;
    this.#stopGraceMs = options.limits?.stopGraceMs ?? STOP_GRACE_MS;
  }

  /** Runs {@link sweep} on a timer until {@link close}. */
  startSweeping(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.#sweepTimer !== undefined) return;
    this.#sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), intervalMs);
    this.#sweepTimer.unref?.();
  }

  async syncDocument(
    caller: CodeLanguageCaller,
    request: CodeLanguageDocumentRequest,
  ): Promise<CodeLanguageDocumentResult> {
    const authorized = this.#authorize(caller, request.threadId, request.checkoutId);
    if (authorized.status === "refused") return authorized;
    if (request.kind === "open") return this.#open(caller, authorized, request);

    const reference = this.#documentReference(request);
    if (reference === undefined) return { status: "refused", reason: "file-outside-thread" };
    const scope = {
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      fileId: request.fileId,
    };
    const record = this.#servers.get(reference.serverKey);
    const document = record?.documents.get(reference.uri);
    if (record === undefined || document === undefined) {
      this.#documents.delete(String(request.fileId));
      return { status: "refused", reason: "file-outside-thread" };
    }
    if (request.kind === "close") {
      this.#release(record, document, String(request.fileId));
      return { status: "synced", ...scope };
    }
    const served = await this.#serve(caller, authorized, document.path, "existing");
    if (served.status !== "served") return served;
    if (!fitsFrame(request.text)) return { status: "too-large", ...scope };
    document.text = request.text;
    document.version += 1;
    document.lastTouched = this.#now();
    served.record.connection?.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges: [{ text: document.text }],
    });
    return { status: "synced", ...scope };
  }

  async read(
    caller: CodeLanguageCaller,
    request: CodeLanguageReadRequest,
  ): Promise<CodeLanguageReadResult> {
    const authorized = this.#authorize(caller, request.threadId, request.checkoutId);
    if (authorized.status === "refused") return authorized;
    const reference = this.#documentReference(request);
    const document =
      reference === undefined
        ? undefined
        : this.#servers.get(reference.serverKey)?.documents.get(reference.uri);
    if (document === undefined) return { status: "refused", reason: "file-outside-thread" };
    // Containment is judged again now: the file the document names may have
    // been replaced by a link out of the checkout since it was opened.
    const contained = await this.#containedRoot(caller, authorized, document.path);
    if (contained.status === "refused") return contained;
    const served = await this.#serve(caller, authorized, document.path, "existing", contained.root);
    if (served.status !== "served") return served;
    const { record } = served;
    // A server replaced while this read waited holds none of the old documents.
    if (record.documents.get(document.uri) !== document) {
      return { status: "refused", reason: "file-outside-thread" };
    }
    return this.#answer(record, document, request, {
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      fileId: request.fileId,
    });
  }

  /**
   * A read for an agent's tool call, answered for the file as saved, so its
   * lines match what the agent's own file reads show. Every authority check
   * an editor's read passes runs first, and in the same order.
   *
   * It opens the saved text under the agent's own hold when no one holds the
   * file, and brings a file only agents hold up to the saved text. It never
   * changes the text an editor holds: when that differs from the saved file
   * it answers `unsaved-edits`, so the person's draft is neither replaced nor
   * read out to a provider.
   *
   * The launch decision is asked, on every read, as a request the person at
   * the machine did not make, as a paired device's is: an agent can start a
   * `static` server and never starts or reads through one that runs
   * repository tooling, even one already running under a person's approval.
   * It never resets the crash budget either; reopening in the editor stays
   * the person's retry.
   */
  async readForAgent(
    scopeId: WindowId,
    request: CodeLanguageAgentRead,
  ): Promise<CodeLanguageAgentReadResult> {
    const caller: CodeLanguageCaller = { scopeId, principal: "remote-device" };
    const authorized = this.#authorize(caller, request.threadId, request.checkoutId);
    if (authorized.status === "refused") return authorized;
    const contained = await this.#containedRoot(caller, authorized, request.path);
    if (contained.status === "refused") return contained;
    const { root } = contained;
    const saved = await readConfinedCodeFile({
      port: this.#files,
      canonicalRoot: root.rootPath,
      relativePath: pathInResolvedRoot(root, request.path),
      maximumBytes: LANGUAGE_SERVER_FRAME_CAP_BYTES,
    });
    if (saved.status === "refused") {
      return saved.reason === "too-large"
        ? { status: "too-large" }
        : { status: "refused", reason: "path-outside-checkout" };
    }
    const text = Buffer.from(saved.bytes).toString("utf8");
    if (text.length > MAX_CODE_LANGUAGE_DOCUMENT_TEXT_LENGTH || !fitsFrame(text)) {
      return { status: "too-large" };
    }
    const local = pathInResolvedRoot(root, request.path);
    const served = await this.#serve(caller, authorized, request.path, "existing", root);
    if (served.status !== "served") return served;
    const { record } = served;
    const uri = pathToFileURL(join(record.rootPath, local)).href;
    const holder = `${AGENT_HOLDER_PREFIX}${String(request.threadId)}`;
    const now = this.#now();
    record.lastActivity = now;
    let document = record.documents.get(uri);
    if (document === undefined) {
      document = {
        uri,
        path: request.path,
        local,
        languageId: languageOf(request.path) ?? "plaintext",
        text,
        version: 1,
        holders: new Set([holder]),
        lastTouched: now,
      };
      record.documents.set(uri, document);
      record.pushed.delete(uri);
      record.connection?.notify("textDocument/didOpen", { textDocument: documentItem(document) });
    } else {
      if (document.text !== text) {
        if (editorHolds(document)) return { status: "unsaved-edits" };
        document.text = text;
        document.version += 1;
        // What the server pushed was for the old text.
        record.pushed.delete(uri);
        record.connection?.notify("textDocument/didChange", {
          textDocument: { uri, version: document.version },
          contentChanges: [{ text }],
        });
      }
      document.holders.add(holder);
      document.lastTouched = now;
    }
    const version = document.version;
    const answer = await this.#answer(record, document, request, {
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      fileId: root.fileId,
    });
    // An editor that changed the text while the server answered may have had
    // the answer computed from its draft; that answer never reaches the agent.
    if (document.version !== version && editorHolds(document)) {
      return { status: "unsaved-edits" };
    }
    return answer;
  }

  /** Asks a ready server one read about a document it holds. */
  async #answer(
    record: ServerRecord,
    document: OpenDocument,
    request:
      | { readonly kind: "diagnostics" }
      | { readonly kind: "definition"; readonly position: CodeLanguagePosition },
    scope: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutId;
      readonly fileId: CodeFileId;
    },
  ): Promise<CodeLanguageReadResult> {
    const connection = record.connection;
    if (connection === undefined) return { status: "unavailable", reason: "starting" };
    document.lastTouched = this.#now();
    record.lastActivity = this.#now();

    if (request.kind === "diagnostics") {
      let items: ReadonlyArray<unknown>;
      if (record.pullsDiagnostics) {
        const response = await connection.request("textDocument/diagnostic", {
          textDocument: { uri: document.uri },
        });
        if (response.status !== "answered") return unavailable(response);
        items =
          isRecord(response.result) && Array.isArray(response.result.items)
            ? response.result.items
            : [];
      } else {
        const pushed = record.pushed.get(document.uri);
        if (pushed === undefined) return { status: "unavailable", reason: "starting" };
        items = pushed;
      }
      const mapped = toDiagnostics({
        items,
        path: document.path,
        checkoutRoot: record.rootPath,
        defaultSource: record.component.sourceLabel,
      });
      return { status: "diagnostics", ...scope, ...mapped };
    }

    const response = await connection.request("textDocument/definition", {
      textDocument: { uri: document.uri },
      position: request.position,
    });
    if (response.status !== "answered") return unavailable(response);
    const targets = await toDefinitionTargets({
      result: response.result,
      roots: { checkoutRoot: record.rootPath, installRoot: record.component.installRoot },
      realpath: (path) => realpath(path),
    });
    return { status: "definition", ...scope, targets };
  }

  /**
   * Stops what should no longer run: documents and servers idle past the idle
   * period, servers whose checkout is unavailable or has no active thread
   * left, and servers whose component is no longer effective.
   */
  async sweep(): Promise<void> {
    const now = this.#now();
    const effective = new Map(
      this.#components().map((component) => [component.componentKey, component]),
    );
    const threads = this.#authority.readThreads();
    const stops: Promise<void>[] = [];
    for (const record of this.#servers.values()) {
      for (const document of record.documents.values()) {
        if (now - document.lastTouched < this.#idleMs) continue;
        for (const holder of document.holders) {
          this.#release(record, document, holder, document.lastTouched);
        }
      }
      const checkout = this.#authority.readCheckout(record.checkoutId);
      const current = effective.get(record.component.componentKey);
      const live =
        checkout?.availability === "available" &&
        threads.some(
          (thread) =>
            String(thread.checkoutId) === String(record.checkoutId) && isActiveThread(thread),
        ) &&
        current !== undefined &&
        // A `repo-tooling` server runs only while an approval covers the
        // package state it runs as now.
        (current.launchClass === "static" ||
          this.#approvalHolds(record.projectId, record.checkoutId, current));
      const idle = record.documents.size === 0 && now - record.lastActivity >= this.#idleMs;
      if (!live || idle) stops.push(this.#retire(record));
    }
    await Promise.all(stops);
  }

  /**
   * The person at a local window approves the `repo-tooling` server that
   * would read this file, for its checkout or for every checkout of its Code
   * Project. Only the person at the machine may: a paired device is refused
   * before anything is read. Every other check a read makes runs first, and
   * Plan refuses, so an approval is never recorded for a server the thread
   * could not start.
   */
  async approve(
    caller: CodeLanguageCaller,
    request: CodeLanguageApprovalRequest,
  ): Promise<CodeLanguageApprovalResult> {
    if (caller.principal !== "local-window") {
      return { status: "refused", reason: "local-host-required" };
    }
    const authorized = this.#authorize(caller, request.threadId, request.checkoutId);
    if (authorized.status === "refused") return authorized;
    const contained = await this.#containedRoot(caller, authorized, request.path);
    if (contained.status === "refused") return contained;
    const chosen = this.#componentFor(request.path);
    if (chosen.status === "refused") return chosen;
    const { component } = chosen;
    if (component.launchClass === "static") return { status: "not-required" };
    const decision = decideLanguageServerLaunch({
      launchClass: component.launchClass,
      posture: authorized.thread.executionPolicy,
      platform: this.#platform,
      startedBy: caller.principal,
      shellCommandApproval: "granted",
    });
    if (decision.status === "refused") return decision;
    const recorded =
      this.#approvals?.record({
        projectId: authorized.thread.projectId,
        checkoutId: authorized.checkout.id,
        component: component.approvalKey,
        scope: request.scope,
      }) ?? "not-recorded";
    if (recorded !== "recorded") return { status: "not-recorded" };
    return {
      status: "approved",
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      scope: request.scope,
    };
  }

  /** Stops every server, for host shutdown. */
  async close(): Promise<void> {
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    await Promise.all([...this.#servers.values()].map((record) => this.#retire(record)));
  }

  #authorize(
    caller: CodeLanguageCaller,
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
  ): Authorized {
    const thread = this.#authority.readThread(threadId);
    // A thread the caller cannot reach reads the same as one that does not
    // exist, so a refusal never says which threads are on this host.
    if (
      thread === undefined ||
      !this.#authority.canAccessProject(caller.scopeId, thread.projectId)
    ) {
      return { status: "refused", reason: "no-reach" };
    }
    if (!isActiveThread(thread)) {
      return { status: "refused", reason: "thread-inactive" };
    }
    const effective = this.#authority.effectiveThread(caller.scopeId, thread);
    if (String(effective.checkoutId) !== String(checkoutId)) {
      return { status: "refused", reason: "checkout-mismatch" };
    }
    const checkout = this.#authority.readCheckout(checkoutId);
    if (
      checkout === undefined ||
      String(checkout.repositoryId) !== String(thread.repositoryId) ||
      checkout.availability !== "available"
    ) {
      return { status: "refused", reason: "checkout-unavailable" };
    }
    return { status: "authorized", thread: effective, checkout };
  }

  async #containedRoot(
    caller: CodeLanguageCaller,
    authorized: Extract<Authorized, { status: "authorized" }>,
    path: CodeRelativePath,
  ): Promise<
    | { readonly status: "contained"; readonly root: CodeFolderRootResolution }
    | { readonly status: "refused"; readonly reason: CodeLanguageRefusalReason }
  > {
    let root: CodeFolderRootResolution | undefined;
    try {
      root = await this.#authority.resolveRoot(
        caller.scopeId,
        authorized.thread,
        authorized.checkout,
        path,
      );
    } catch {
      root = undefined;
    }
    if (root === undefined) return { status: "refused", reason: "checkout-unavailable" };
    const resolved = await resolveContainedPath(
      this.#files,
      root.rootPath,
      joinCodePath(root.rootPath, pathInResolvedRoot(root, path)),
    );
    if (resolved === undefined || !resolved.stat.isFile) {
      return { status: "refused", reason: "path-outside-checkout" };
    }
    return { status: "contained", root };
  }

  async #open(
    caller: CodeLanguageCaller,
    authorized: Extract<Authorized, { status: "authorized" }>,
    request: Extract<CodeLanguageDocumentRequest, { kind: "open" }>,
  ): Promise<CodeLanguageDocumentResult> {
    const contained = await this.#containedRoot(caller, authorized, request.path);
    if (contained.status === "refused") return contained;
    const { root } = contained;
    const scope = {
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      fileId: root.fileId,
    };
    // Opening is how a person retries a server that used up its crash budget.
    const local = pathInResolvedRoot(root, request.path);
    const served = await this.#serve(caller, authorized, request.path, "open", root);
    if (served.status !== "served") return served;
    if (!fitsFrame(request.text)) return { status: "too-large", ...scope };
    const { record } = served;
    const uri = pathToFileURL(join(record.rootPath, local)).href;
    const fileKey = String(root.fileId);
    const existing = record.documents.get(uri);
    const now = this.#now();
    record.lastActivity = now;
    if (existing === undefined) {
      const document: OpenDocument = {
        uri,
        path: request.path,
        local,
        languageId: languageOf(request.path) ?? "plaintext",
        text: request.text,
        version: 1,
        holders: new Set([fileKey]),
        lastTouched: now,
      };
      record.documents.set(uri, document);
      record.pushed.delete(uri);
      record.connection?.notify("textDocument/didOpen", { textDocument: documentItem(document) });
    } else {
      existing.holders.add(fileKey);
      existing.lastTouched = now;
      if (existing.text !== request.text) {
        existing.text = request.text;
        existing.version += 1;
        record.connection?.notify("textDocument/didChange", {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text: existing.text }],
        });
      }
    }
    this.#documents.set(fileKey, {
      serverKey: record.key,
      uri,
      threadId: request.threadId,
      checkoutId: request.checkoutId,
    });
    return { status: "synced", ...scope };
  }

  /**
   * The component, launch decision, and running server for one file. The
   * caller's authority over the thread and checkout is already checked.
   */
  async #serve(
    caller: CodeLanguageCaller,
    authorized: Extract<Authorized, { status: "authorized" }>,
    path: CodeRelativePath,
    intent: "open" | "existing",
    resolved?: CodeFolderRootResolution,
  ): Promise<Served> {
    const rootPath = resolved?.rootPath;
    const extraFolder = resolved?.relativePath !== undefined;
    const chosen = this.#componentFor(path);
    if (chosen.status === "refused") return chosen;
    const { component } = chosen;
    // Decided on every request, not only at the start: a paired device, an
    // agent's read, or a Plan thread is refused a running `repo-tooling`
    // server too, because what it opens is what the server then runs the
    // repository's tooling on.
    const decision = decideLanguageServerLaunch({
      launchClass: component.launchClass,
      posture: authorized.thread.executionPolicy,
      platform: this.#platform,
      startedBy: caller.principal,
      shellCommandApproval:
        component.launchClass === "repo-tooling" &&
        this.#approvalHolds(authorized.thread.projectId, authorized.checkout.id, component)
          ? "granted"
          : "absent",
    });
    if (decision.status === "refused") return decision;

    const key = serverKey(authorized.checkout.id, component, extraFolder ? rootPath : undefined);
    let record = this.#servers.get(key);
    if (record !== undefined && rootPath !== undefined && record.rootPath !== rootPath) {
      // The checkout now resolves somewhere else; the old server reads the
      // old place and must not serve this one.
      await this.#retire(record);
      record = undefined;
    }
    if (record === undefined) {
      if (rootPath === undefined) return { status: "refused", reason: "file-outside-thread" };
      record = {
        key,
        checkoutId: authorized.checkout.id,
        projectId: authorized.thread.projectId,
        component,
        rootPath,
        extraFolder,
        watchThreadId: authorized.thread.id,
        state: "stopped",
        generation: 0,
        starting: undefined,
        process: undefined,
        connection: undefined,
        pullsDiagnostics: false,
        watch: undefined,
        documents: new Map(),
        pushed: new Map(),
        crashTimes: [],
        lastActivity: this.#now(),
      };
      this.#servers.set(key, record);
    }
    // A server whose output has ended is gone even before its exit is
    // reported; counting that now keeps a request from being served by the
    // dead connection (observed as an editor retry swallowed in that window).
    if (record.state === "ready" && record.connection?.closed !== false) {
      void this.#crash(record, record.generation);
    }
    if (record.state === "crashed") {
      if (intent !== "open") return { status: "unavailable", reason: "crashed" };
      record.crashTimes = [];
      record.state = "stopped";
    }
    if (record.state === "ready") return { status: "served", record };
    const outcome = await this.#ensureStarted(record);
    if (outcome === "confinement-unavailable") {
      return { status: "refused", reason: "confinement-unavailable" };
    }
    if (outcome === "crashed") return { status: "unavailable", reason: "crashed" };
    return { status: "served", record };
  }

  /** The effective component that reads this file, or why none does. */
  #componentFor(
    path: CodeRelativePath,
  ):
    | { readonly status: "chosen"; readonly component: CodeLanguageServerComponent }
    | { readonly status: "refused"; readonly reason: CodeLanguageRefusalReason } {
    const languageId = languageOf(path);
    const component =
      languageId === undefined
        ? undefined
        : this.#components().find((candidate) => candidate.languages.includes(languageId));
    if (component !== undefined) return { status: "chosen", component };
    const turnedOff =
      languageId !== undefined &&
      this.#turnedOffComponents().some((candidate) => candidate.languages.includes(languageId));
    return { status: "refused", reason: turnedOff ? "turned-off" : "no-language-server" };
  }

  #approvalHolds(
    projectId: ProjectId,
    checkoutId: CodeCheckoutId,
    component: CodeLanguageServerComponent,
  ): boolean {
    try {
      return (
        this.#approvals?.holds({ projectId, checkoutId, component: component.approvalKey }) === true
      );
    } catch {
      return false;
    }
  }

  /**
   * Whether this server may start now: a `repo-tooling` one only while an
   * approval covers its package state as it is now, not as it was when the
   * record was made.
   */
  #startCovered(record: ServerRecord): boolean {
    if (record.component.launchClass === "static") return true;
    const current = this.#components().find(
      (component) => component.componentKey === record.component.componentKey,
    );
    return (
      current !== undefined && this.#approvalHolds(record.projectId, record.checkoutId, current)
    );
  }

  /**
   * Whether any active thread that can write the server's folder has taken in
   * outside content. That is every thread on the checkout, and every thread
   * of any Project whose folder is the server's, holds it, or lies inside it:
   * two Projects bound to one folder have different checkout ids, and a
   * tainted thread in either may have written the tooling the server runs.
   */
  #checkoutTainted(record: ServerRecord): boolean {
    return this.#authority
      .readThreads()
      .some(
        (thread) =>
          isActiveThread(thread) &&
          this.#threadTaintedSafely(thread.id) &&
          this.#writesFolder(thread, record),
      );
  }

  /** A thread whose folder cannot be told counts as writing the server's. */
  #writesFolder(thread: CodeThread, record: ServerRecord): boolean {
    if (String(thread.checkoutId) === String(record.checkoutId)) return true;
    let folder: string | undefined;
    try {
      folder = this.#authority.readThreadFolder(thread);
    } catch {
      return true;
    }
    return (
      folder === undefined ||
      folderHolds(record.rootPath, folder) ||
      folderHolds(folder, record.rootPath)
    );
  }

  #threadTaintedSafely(threadId: CodeThreadId): boolean {
    try {
      return this.#threadTainted(threadId);
    } catch {
      return true;
    }
  }

  #ensureStarted(record: ServerRecord): Promise<StartOutcome> {
    if (record.state === "ready") return Promise.resolve("ready");
    if (record.starting !== undefined) return record.starting;
    const starting = this.#start(record).finally(() => {
      if (record.starting === starting) record.starting = undefined;
    });
    record.starting = starting;
    return starting;
  }

  async #start(record: ServerRecord): Promise<StartOutcome> {
    const generation = ++record.generation;
    record.state = "starting";
    // A crash restart has no caller whose request was decided, and the
    // package may have changed since: without this, a server that ended
    // between such a change and the sweep came back with no approval.
    if (!this.#startCovered(record)) {
      record.state = "stopped";
      return "crashed";
    }
    const executable = await record.component.executable().catch(() => undefined);
    if (record.generation !== generation) return "crashed";
    if (executable === undefined) return this.#crash(record, generation);
    const outcome = await this.#processes.launch({
      ownerId: record.key,
      launchClass: record.component.launchClass,
      ...(record.component.launchClass === "repo-tooling"
        ? {
            egress: {
              projectId: String(record.projectId),
              threadId: String(record.watchThreadId),
              checkoutTainted: () => this.#checkoutTainted(record),
            },
          }
        : {}),
      executable,
      args: record.component.args,
      installRoot: record.component.installRoot,
      checkoutRoot: record.rootPath,
      cacheDirectory: join(this.#cacheRoot, record.key),
      cacheRoot: this.#cacheRoot,
    });
    if (record.generation !== generation) {
      if (outcome.status === "launched") await outcome.process.kill();
      return "crashed";
    }
    if (outcome.status === "confinement-unavailable") {
      record.state = "stopped";
      return "confinement-unavailable";
    }
    if (outcome.status === "failed") return this.#crash(record, generation);

    const child = outcome.process;
    record.process = child;
    const connection = new LanguageServerConnection({
      input: child.stdout,
      output: child.stdin,
      requestDeadlineMs: this.#requestDeadlineMs,
      // A frame over the cap, or one that is not a frame, ends the server.
      onViolation: () => void this.#crash(record, generation),
      onPublishedDiagnostics: (uri, diagnostics) => {
        const document = [...record.documents.values()].find((entry) => sameUri(entry.uri, uri));
        if (document !== undefined) record.pushed.set(document.uri, diagnostics);
      },
    });
    record.connection = connection;
    void child.exited.then(() => {
      connection.close();
      void this.#crash(record, generation);
    });

    const initialized = await connection.request("initialize", initializeParams(record.rootPath));
    if (record.generation !== generation) return "crashed";
    if (initialized.status !== "answered") return this.#crash(record, generation);
    const capabilities =
      isRecord(initialized.result) && isRecord(initialized.result.capabilities)
        ? initialized.result.capabilities
        : {};
    record.pullsDiagnostics =
      capabilities.diagnosticProvider !== undefined && capabilities.diagnosticProvider !== null;
    connection.notify("initialized", {});
    // A restart after a crash reopens what the editor still holds.
    for (const document of record.documents.values()) {
      connection.notify("textDocument/didOpen", { textDocument: documentItem(document) });
    }
    record.state = "ready";
    this.#watch(record, connection, generation);
    return "ready";
  }

  /**
   * Counts an unexpected end against the crash budget and restarts within it.
   * Idempotent per start: the first report of a start's end wins. The state
   * changes before anything is awaited, so a request arriving meanwhile waits
   * for the restart instead of finding a server with no connection.
   */
  #crash(record: ServerRecord, generation: number): Promise<StartOutcome> {
    if (
      record.generation !== generation ||
      record.state === "stopped" ||
      this.#servers.get(record.key) !== record
    ) {
      return Promise.resolve("crashed");
    }
    record.generation += 1;
    record.connection?.close();
    record.connection = undefined;
    record.watch?.abort();
    record.watch = undefined;
    const child = record.process;
    record.process = undefined;
    const now = this.#now();
    record.crashTimes = [
      ...record.crashTimes.filter((time) => now - time <= this.#crashWindowMs),
      now,
    ];
    const exhausted = record.crashTimes.length > this.#maxCrashRestarts;
    record.state = exhausted ? "crashed" : "starting";
    const restart = (async (): Promise<StartOutcome> => {
      await child?.kill().catch(() => undefined);
      if (exhausted || record.state !== "starting" || this.#servers.get(record.key) !== record) {
        return "crashed";
      }
      return this.#start(record).catch((): StartOutcome => "crashed");
    })();
    if (!exhausted) {
      record.starting = restart;
      void restart.finally(() => {
        if (record.starting === restart) record.starting = undefined;
      });
    }
    return restart;
  }

  /** Stops a server on purpose and forgets it and its documents. */
  async #retire(record: ServerRecord): Promise<void> {
    if (this.#servers.get(record.key) === record) this.#servers.delete(record.key);
    for (const [fileKey, reference] of this.#documents) {
      if (reference.serverKey === record.key) this.#documents.delete(fileKey);
    }
    record.documents.clear();
    record.generation += 1;
    record.state = "stopped";
    record.watch?.abort();
    record.watch = undefined;
    const connection = record.connection;
    const child = record.process;
    record.connection = undefined;
    record.process = undefined;
    if (child === undefined) return;
    if (connection !== undefined && !connection.closed) {
      // Drain, then stop: a server that honours shutdown exits on its own.
      await connection.request("shutdown", undefined, this.#stopGraceMs);
      connection.notify("exit");
      await Promise.race([
        child.exited,
        new Promise((resolve) => setTimeout(resolve, this.#stopGraceMs).unref?.()),
      ]);
      connection.close();
    }
    await child.kill().catch(() => undefined);
  }

  /** `at` is when the server was last used for this document. */
  #release(record: ServerRecord, document: OpenDocument, fileKey: string, at = this.#now()): void {
    document.holders.delete(fileKey);
    this.#documents.delete(fileKey);
    // The text an editor leaves behind may be a draft the person is
    // discarding. Kept open for an agent's hold, the server would go on
    // reading it for the agent's reads of other files, so the document closes
    // and an agent's next read of it reopens the saved file.
    if (!isAgentHolder(fileKey) && [...document.holders].every(isAgentHolder)) {
      document.holders.clear();
    }
    if (document.holders.size > 0) return;
    record.documents.delete(document.uri);
    record.pushed.delete(document.uri);
    record.lastActivity = Math.max(record.lastActivity, at);
    // A server still starting never saw this document; a restart opens only
    // what is still held.
    if (record.state === "ready") {
      record.connection?.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
    }
  }

  #documentReference(request: {
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly fileId: CodeFileId;
  }): DocumentReference | undefined {
    const reference = this.#documents.get(String(request.fileId));
    if (
      reference === undefined ||
      String(reference.threadId) !== String(request.threadId) ||
      String(reference.checkoutId) !== String(request.checkoutId)
    ) {
      return undefined;
    }
    return reference;
  }

  #watch(record: ServerRecord, connection: LanguageServerConnection, generation: number): void {
    const watcher = this.#watcher;
    if (watcher === undefined || record.extraFolder) return;
    const controller = new AbortController();
    record.watch = controller;
    void (async () => {
      try {
        for await (const notice of watcher.watch({
          threadId: record.watchThreadId,
          checkoutId: record.checkoutId,
          rootPath: record.rootPath,
          signal: controller.signal,
        })) {
          if (record.generation !== generation || controller.signal.aborted) return;
          if (!connection.registered("workspace/didChangeWatchedFiles")) continue;
          connection.notify("workspace/didChangeWatchedFiles", {
            changes: notice.paths.map((path) => ({
              uri: pathToFileURL(join(record.rootPath, path)).href,
              type: 2,
            })),
          });
        }
      } catch {
        // A watch that fails leaves the server reading files as it finds them.
      }
    })();
  }
}

function isAgentHolder(holder: string): boolean {
  return holder.startsWith(AGENT_HOLDER_PREFIX);
}

function editorHolds(document: OpenDocument): boolean {
  return [...document.holders].some((holder) => !isAgentHolder(holder));
}

function isActiveThread(thread: CodeThread): boolean {
  return thread.lifecycle === "active" && thread.completedAt === undefined;
}

function languageOf(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

function serverKey(
  checkoutId: CodeCheckoutId,
  component: CodeLanguageServerComponent,
  extraFolder?: string,
): string {
  return createHash("sha256")
    .update("octant.language-server.v1\0")
    .update(String(checkoutId))
    .update(extraFolder === undefined ? "" : `\0folder:${extraFolder}`)
    .update("\0")
    .update(component.componentKey)
    .update("\0")
    .update(component.launchClass)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Judged on the text as the frame carries it: JSON escaping can double a
 * quote-heavy file, and a frame past the cap is never written, so text that
 * fit only before escaping was reported synced while the server never saw it.
 */
function fitsFrame(text: string): boolean {
  return (
    Buffer.byteLength(JSON.stringify(text), "utf8") + FRAME_ENVELOPE_BYTES <=
    LANGUAGE_SERVER_FRAME_CAP_BYTES
  );
}

function documentItem(document: OpenDocument) {
  return {
    uri: document.uri,
    languageId: document.languageId,
    version: document.version,
    text: document.text,
  };
}

/**
 * Whether a folder is the directory or lies inside it. Only a `..` segment
 * leaves it: a child named `..cache` is inside, and a test on the `..` prefix
 * alone would let a tainted thread bound there keep the server's rules.
 */
function folderHolds(directory: string, folder: string): boolean {
  const path = relative(resolve(directory), resolve(folder));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function initializeParams(rootPath: string) {
  const rootUri = pathToFileURL(rootPath).href;
  return {
    processId: null,
    clientInfo: { name: "Octant" },
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "checkout" }],
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false },
        diagnostic: { dynamicRegistration: false },
        publishDiagnostics: {},
        definition: { dynamicRegistration: false, linkSupport: true },
      },
      workspace: {
        configuration: true,
        didChangeWatchedFiles: { dynamicRegistration: true },
      },
      window: { workDoneProgress: true },
    },
  };
}

function sameUri(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return new URL(left).pathname === new URL(right).pathname;
  } catch {
    return false;
  }
}

function unavailable(
  response: Exclude<LanguageServerResponse, { status: "answered" }>,
): CodeLanguageReadResult {
  // A server that answered with an error, or did not answer in time, produced
  // no result within the deadline; retrying is the remedy for both.
  return {
    status: "unavailable",
    reason: response.status === "closed" ? "crashed" : "timed-out",
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
