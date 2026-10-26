import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { extname, join } from "node:path";
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
import type {
  CodeLanguageDocumentRequest,
  CodeLanguageDocumentResult,
  CodeLanguageReadRequest,
  CodeLanguageReadResult,
  CodeLanguageRefusalReason,
  CodeLanguageUnavailableReason,
} from "@octant/contracts/code-language";
import type { ExtensionLanguageServerClass } from "@octant/contracts/extensions";
import {
  decideLanguageServerLaunch,
  type LanguageServerHostPlatform,
  type PrincipalKind,
} from "@octant/domain";
import { liveCodeDirectoryPort, type CodePathPort } from "./codeDirectoryPort";
import { joinCodePath, resolveContainedPath } from "./codePathConfinement";
import type { CodeFileRootResolution } from "./codeService";
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
 * never chooses which server reads it.
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
};

/** An effective `language-server` component, resolved by the host. */
export interface CodeLanguageServerComponent {
  /** Names the component across restarts: its extension and component ids. */
  readonly componentKey: string;
  readonly languages: ReadonlyArray<string>;
  readonly launchClass: ExtensionLanguageServerClass;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly installRoot: string;
  /** The diagnostic source label used when the server's own label is unusable. */
  readonly sourceLabel: string;
}

export interface CodeLanguageAuthority {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readThreads: () => ReadonlyArray<CodeThread>;
  readonly readCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  /** Reach: a local window's Project binding, or a paired device's Code reach. */
  readonly canAccessProject: (scopeId: WindowId, projectId: ProjectId) => boolean;
  readonly effectiveThread: (scopeId: WindowId, thread: CodeThread) => CodeThread;
  readonly resolveRoot: (
    scopeId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    relativePath: CodeRelativePath,
  ) => Promise<CodeFileRootResolution | undefined> | CodeFileRootResolution | undefined;
}

export interface CodeLanguageCaller {
  readonly scopeId: WindowId;
  readonly principal: PrincipalKind;
}

export interface CodeLanguageServiceOptions {
  readonly authority: CodeLanguageAuthority;
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
  readonly files?: CodePathPort;
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
  readonly path: CodeRelativePath;
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
  readonly component: CodeLanguageServerComponent;
  readonly rootPath: string;
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
  readonly #components: () => ReadonlyArray<CodeLanguageServerComponent>;
  readonly #turnedOffComponents: () => ReadonlyArray<CodeLanguageServerComponent>;
  readonly #processes: CodeLanguageServiceOptions["processes"];
  readonly #platform: LanguageServerHostPlatform;
  readonly #cacheRoot: string;
  readonly #files: CodePathPort;
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
    this.#components = options.components;
    this.#turnedOffComponents = options.turnedOffComponents ?? (() => []);
    this.#processes = options.processes;
    this.#platform = options.platform;
    this.#cacheRoot = options.cacheRoot;
    this.#files = options.files ?? liveCodeDirectoryPort;
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
    const served = await this.#serve(
      caller,
      authorized,
      document.path,
      "existing",
      contained.root.rootPath,
    );
    if (served.status !== "served") return served;
    const { record } = served;
    // A server replaced while this read waited holds none of the old documents.
    if (record.documents.get(document.uri) !== document) {
      return { status: "refused", reason: "file-outside-thread" };
    }
    const connection = record.connection;
    if (connection === undefined) return { status: "unavailable", reason: "starting" };
    document.lastTouched = this.#now();
    record.lastActivity = this.#now();
    const scope = {
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      fileId: request.fileId,
    };

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
    const effective = new Set(this.#components().map((component) => component.componentKey));
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
      const live =
        checkout?.availability === "available" &&
        threads.some(
          (thread) =>
            String(thread.checkoutId) === String(record.checkoutId) && isActiveThread(thread),
        ) &&
        effective.has(record.component.componentKey);
      const idle = record.documents.size === 0 && now - record.lastActivity >= this.#idleMs;
      if (!live || idle) stops.push(this.#retire(record));
    }
    await Promise.all(stops);
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
    | { readonly status: "contained"; readonly root: CodeFileRootResolution }
    | { readonly status: "refused"; readonly reason: CodeLanguageRefusalReason }
  > {
    let root: CodeFileRootResolution | undefined;
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
      joinCodePath(root.rootPath, path),
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
    const served = await this.#serve(caller, authorized, request.path, "open", root.rootPath);
    if (served.status !== "served") return served;
    if (!fitsFrame(request.text)) return { status: "too-large", ...scope };
    const { record } = served;
    const uri = pathToFileURL(join(record.rootPath, request.path)).href;
    const fileKey = String(root.fileId);
    const existing = record.documents.get(uri);
    const now = this.#now();
    record.lastActivity = now;
    if (existing === undefined) {
      const document: OpenDocument = {
        uri,
        path: request.path,
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
    rootPath?: string,
  ): Promise<Served> {
    const languageId = languageOf(path);
    const component =
      languageId === undefined
        ? undefined
        : this.#components().find((candidate) => candidate.languages.includes(languageId));
    if (component === undefined) {
      const turnedOff =
        languageId !== undefined &&
        this.#turnedOffComponents().some((candidate) => candidate.languages.includes(languageId));
      return { status: "refused", reason: turnedOff ? "turned-off" : "no-language-server" };
    }
    const decision = decideLanguageServerLaunch({
      launchClass: component.launchClass,
      posture: authorized.thread.executionPolicy,
      platform: this.#platform,
      startedBy: caller.principal,
      // No approval store exists for language servers yet, so a server that
      // runs repository tooling is never started.
      shellCommandApproval: "absent",
    });
    if (decision.status === "refused") return decision;
    // Only the static launch exists; the class decides confinement, so a
    // class this host cannot confine is never mapped onto a nearby one.
    if (decision.shape.launchClass !== "static") {
      return { status: "refused", reason: "confinement-unavailable" };
    }

    const key = serverKey(authorized.checkout.id, component);
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
        component,
        rootPath,
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
    const outcome = await this.#processes.launch({
      ownerId: record.key,
      executable: record.component.executable,
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
    if (watcher === undefined) return;
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

function isActiveThread(thread: CodeThread): boolean {
  return thread.lifecycle === "active" && thread.completedAt === undefined;
}

function languageOf(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

function serverKey(checkoutId: CodeCheckoutId, component: CodeLanguageServerComponent): string {
  return createHash("sha256")
    .update("octant.language-server.v1\0")
    .update(String(checkoutId))
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
