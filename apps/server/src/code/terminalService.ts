import type { TerminalLaunchInput, TerminalProcessHandle } from "./terminalProcessPort";

export const MAX_TERMINAL_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_TERMINAL_OUTPUT_CHUNK_BYTES = 64 * 1024;

const TRUNCATION_MARKER = "[Octant terminal output truncated]\n";
const MAX_LIVE_TERMINAL_TRANSCRIPT_CHARACTERS = 64 * 1024;
// Every emission the record path (the journal observer) receives is written
// synchronously to the evidence store and the journal, and the store holds at
// most 100,000 entries before it refuses a write and the live shell is closed.
// At 50 ms a flooding terminal reaches that ceiling in about 83 minutes. That
// window belongs to the record path alone: a window reading live output asks
// for its own, shorter one, so latency never moves the write rate.
const OUTPUT_PUBLISH_DELAY_MS = 50;
const INHERITED_ENVIRONMENT_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
]);

export interface TerminalCredentialReference {
  readonly environmentName: string;
  readonly reference: string;
}

/**
 * The `octant` command a packaged desktop app ships for a terminal with a
 * Browser grant (`octant mcp` only). A terminal started with it finds the
 * command first on its `PATH`, and its confinement may read what the command
 * needs to start and nothing more.
 */
export interface TerminalLauncher {
  /** Holds the `octant` command and nothing else. */
  readonly directory: string;
  /** Read-only: the directory itself and the runtime the command runs with. */
  readonly readRoots: ReadonlyArray<string>;
}

export interface TerminalLaunchRequest {
  readonly terminalId: string;
  readonly shell: string;
  readonly cwd: string;
  /** Authority this shell's persisted state belongs to; see TerminalLaunchInput. */
  readonly stateScope: string;
  readonly columns: number;
  readonly rows: number;
  readonly credentialReferences: readonly TerminalCredentialReference[];
  /** Only for a terminal started with a Browser grant; see {@link TerminalLauncher}. */
  readonly launcher?: TerminalLauncher;
  readonly executionPolicy?: TerminalLaunchInput["executionPolicy"];
}

export interface RestoredTerminalRecord {
  readonly terminalId: string;
  readonly transcript: readonly string[];
  readonly exitCode?: number;
}

export interface TerminalSnapshot {
  readonly terminalId: string;
  readonly status: "running" | "exited" | "interrupted";
  readonly canRerun: boolean;
  readonly exitCode?: number;
  readonly transcript: {
    readonly chunks: readonly string[];
    readonly byteLength: number;
    readonly truncated: boolean;
    /**
     * Absolute offset one past the last character this snapshot carries. A
     * caller that hands the snapshot to a surface resumes that surface's output
     * from here, so nothing printed between taking the snapshot and observing
     * is either lost or sent twice.
     */
    readonly characters: number;
  };
}

export interface TerminalOutputEmission {
  readonly text: string;
  readonly replace: boolean;
  /**
   * Absolute offset one past the last character this emission accounts for. It
   * stops short of a credential prefix still being withheld, so a reader that
   * resumes from it is sent that tail once it can be redacted.
   */
  readonly characters: number;
  readonly snapshot: TerminalSnapshot;
}

/**
 * How one observer wants to follow a terminal.
 *
 * `windowMs` is that observer's own coalescing window; the default is the
 * record path's. `maxDeltaCharacters` bounds one emission for a reader that
 * cannot take an unbounded chunk: past it the observer is sent the live window
 * as a replace, the same answer a reader that fell behind gets.
 */
export interface TerminalObserveOptions {
  readonly afterCharacters?: number;
  readonly windowMs?: number;
  readonly maxDeltaCharacters?: number;
}

interface TerminalProcessStarter {
  start(input: TerminalLaunchInput): TerminalProcessHandle;
}

interface TerminalCredentialResolver {
  resolve(reference: string): Promise<string>;
}

interface TerminalServiceOptions {
  readonly port: TerminalProcessStarter;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly credentials: TerminalCredentialResolver;
  readonly restored?: readonly RestoredTerminalRecord[];
}

interface TerminalRecord {
  readonly terminalId: string;
  readonly transcript: TranscriptBuffer;
  readonly process?: TerminalProcessHandle;
  readonly secrets: readonly string[];
  readonly observers: Set<OutputObserver>;
  /**
   * Where an observer that names no position starts, and the state it is
   * assumed to have already been told: what the launch (or the restore) had
   * already reported.
   */
  readonly baseline: {
    characters: number;
    status: TerminalSnapshot["status"];
    exitCode: number | undefined;
  };
  status: TerminalSnapshot["status"];
  exitCode?: number;
  pendingResize: { columns: number; rows: number } | undefined;
  resizeScheduled: boolean;
}

/**
 * One reader of a terminal's output, with its own position and window.
 *
 * The journal and a window reading live output follow the same shell at
 * different cadences, so each keeps its own place and its own timer.
 */
interface OutputObserver {
  readonly listener: (emission: TerminalOutputEmission) => void;
  readonly windowMs: number;
  readonly maxDeltaCharacters: number | undefined;
  /**
   * How far into this terminal's output the observer has been caught up, as an
   * absolute character offset in the stream the PTY has produced. A string
   * cursor was compared against the whole retained transcript on every publish,
   * and stopped matching the moment the ceiling began sliding that window — so
   * every line after the ceiling published as a full replace.
   */
  publishedCharacters: number;
  publishedStatus: TerminalSnapshot["status"];
  publishedExitCode: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * When this observer last published, so a quiet terminal can publish the
   * next chunk at once instead of holding it for the coalescing window.
   */
  lastPublishedAt: number;
}

export class TerminalService {
  readonly #options: TerminalServiceOptions;
  readonly #terminals = new Map<string, TerminalRecord>();

  constructor(options: TerminalServiceOptions) {
    this.#options = options;
    for (const restored of options.restored ?? []) {
      const transcript = new TranscriptBuffer();
      for (const chunk of restored.transcript) transcript.append(chunk);
      this.#terminals.set(restored.terminalId, {
        terminalId: restored.terminalId,
        transcript,
        secrets: [],
        observers: new Set(),
        baseline: { characters: 0, status: "interrupted", exitCode: restored.exitCode },
        status: "interrupted",
        ...(restored.exitCode === undefined ? {} : { exitCode: restored.exitCode }),
        pendingResize: undefined,
        resizeScheduled: false,
      });
    }
  }

  async launch(request: TerminalLaunchRequest): Promise<TerminalSnapshot> {
    const previous = this.#terminals.get(request.terminalId);
    if (previous?.status === "running") throw new Error("Terminal identifier is already in use.");
    validateTerminalId(request.terminalId);

    const environment = sanitizeInheritedEnvironment(this.#options.inheritedEnvironment);
    const secrets: string[] = [];
    for (const credential of request.credentialReferences) {
      validateEnvironmentName(credential.environmentName);
      if (environment[credential.environmentName] !== undefined) {
        throw new Error("Terminal credential environment name is duplicated.");
      }
      const value = await this.#options.credentials.resolve(credential.reference);
      if (value.includes("\0")) throw new Error("Terminal credential is invalid.");
      environment[credential.environmentName] = value;
      if (value.length > 0) secrets.push(value);
    }
    if (request.launcher !== undefined) {
      // First, so a CLI configured with a bare `octant mcp` reaches this one
      // rather than another `octant` on PATH; the person's own rc files run
      // after this and can still put theirs ahead.
      environment.PATH =
        environment.PATH === undefined || environment.PATH === ""
          ? request.launcher.directory
          : `${request.launcher.directory}:${environment.PATH}`;
    }

    const process = this.#options.port.start({
      shell: request.shell,
      cwd: request.cwd,
      stateScope: request.stateScope,
      environment,
      columns: request.columns,
      rows: request.rows,
      ...(request.launcher === undefined
        ? {}
        : { additionalReadRoots: request.launcher.readRoots }),
      ...(request.executionPolicy === undefined
        ? {}
        : { executionPolicy: request.executionPolicy }),
    });
    const record: TerminalRecord = {
      terminalId: request.terminalId,
      transcript: new TranscriptBuffer(),
      process,
      secrets,
      observers: new Set(),
      baseline: { characters: 0, status: "running", exitCode: undefined },
      status: "running",
      pendingResize: undefined,
      resizeScheduled: false,
    };
    for (const observer of previous?.observers ?? []) clearObserverTimer(observer);
    this.#terminals.set(request.terminalId, record);
    process.onData((data) => {
      process.pause();
      try {
        record.transcript.append(data);
        record.transcript.redact(record.secrets);
        this.#scheduleOutput(record);
      } finally {
        process.resume();
      }
    });
    process.onExit(({ exitCode }) => {
      record.status = "exited";
      record.exitCode = exitCode;
      this.#scheduleOutput(record, true);
    });
    try {
      await process.receiptReady;
    } catch (error) {
      if (previous === undefined) this.#terminals.delete(request.terminalId);
      else this.#terminals.set(request.terminalId, previous);
      await process.close().catch(() => undefined);
      throw error;
    }
    const snapshot = this.#snapshot(record);
    record.baseline.characters = publishableEnd(record);
    record.baseline.status = record.status;
    record.baseline.exitCode = record.exitCode;
    return snapshot;
  }

  attach(terminalId: string): TerminalSnapshot {
    return this.#snapshot(this.#require(terminalId));
  }

  /**
   * What the terminal printed after an absolute offset, for a reader that
   * polls instead of observing. It leaves the observer's position alone, so a
   * terminal can have one of each without either skipping output.
   */
  readSince(
    terminalId: string,
    afterCharacters: number,
  ): {
    readonly text: string;
    readonly replace: boolean;
    readonly characters: number;
    readonly snapshot: TerminalSnapshot;
  } {
    const record = this.#require(terminalId);
    const end = publishableEnd(record);
    const replace = afterCharacters < record.transcript.retainedFrom() || afterCharacters > end;
    const behind = end - afterCharacters > MAX_LIVE_TERMINAL_TRANSCRIPT_CHARACTERS;
    return {
      text:
        replace || behind
          ? liveWindow(record, end)
          : record.transcript.textBetween(afterCharacters, end),
      replace: replace || behind,
      characters: end,
      snapshot: this.#snapshot(record),
    };
  }

  /**
   * Follow a terminal's output. Each observer keeps its own position and its
   * own coalescing window, so a reader that wants frame-rate output does not
   * change how often the journal's observer is called.
   */
  observe(
    terminalId: string,
    listener: (emission: TerminalOutputEmission) => void,
    options?: TerminalObserveOptions,
  ): () => void {
    const record = this.#require(terminalId);
    const observer: OutputObserver = {
      listener,
      windowMs: options?.windowMs ?? OUTPUT_PUBLISH_DELAY_MS,
      maxDeltaCharacters: options?.maxDeltaCharacters,
      publishedCharacters: options?.afterCharacters ?? record.baseline.characters,
      publishedStatus: record.baseline.status,
      publishedExitCode: record.baseline.exitCode,
      timer: undefined,
      lastPublishedAt: 0,
    };
    record.observers.add(observer);
    this.#publishObserver(record, observer);
    return () => {
      clearObserverTimer(observer);
      record.observers.delete(observer);
    };
  }

  write(terminalId: string, data: string): void {
    this.#requireRunning(terminalId).process!.write(data);
  }

  resize(terminalId: string, columns: number, rows: number): void {
    const record = this.#requireRunning(terminalId);
    record.pendingResize = { columns, rows };
    if (record.resizeScheduled) return;
    record.resizeScheduled = true;
    queueMicrotask(() => {
      record.resizeScheduled = false;
      const resize = record.pendingResize;
      record.pendingResize = undefined;
      if (resize && record.status === "running") {
        try {
          record.process!.resize(resize.columns, resize.rows);
        } catch {
          // The native PTY can exit between the status check and its queued
          // resize. Its exit callback owns the authoritative terminal state.
        }
      }
    });
  }

  async terminate(terminalId: string): Promise<TerminalSnapshot> {
    const record = this.#require(terminalId);
    if (record.status === "running") {
      await record.process!.close();
      if (record.status === "running") record.status = "interrupted";
    }
    this.#publishOutput(record);
    return this.#snapshot(record);
  }

  async closeAll(): Promise<void> {
    const live = [...this.#terminals.values()].filter((record) => record.status === "running");
    const results = await Promise.allSettled(
      live.map(async (record) => {
        await record.process!.close();
        if (record.status === "running") record.status = "interrupted";
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  #require(terminalId: string): TerminalRecord {
    const record = this.#terminals.get(terminalId);
    if (!record) throw new Error("Terminal does not exist.");
    return record;
  }

  #requireRunning(terminalId: string): TerminalRecord {
    const record = this.#require(terminalId);
    if (record.status !== "running" || !record.process) throw new Error("Terminal is not running.");
    return record;
  }

  #snapshot(record: TerminalRecord): TerminalSnapshot {
    return {
      terminalId: record.terminalId,
      status: record.status,
      canRerun: record.status !== "running",
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      transcript: record.transcript.snapshot(),
    };
  }

  /**
   * Coalescing only pays for itself while a terminal is actually flooding. Held
   * on the trailing edge, every publish waited the full window — including the
   * echo of a single keypress on an idle terminal, which is the one case where
   * the delay is the whole perceived latency of typing. An observer whose
   * terminal has been quiet for a window is told at once, and one still inside
   * its window batches until the window closes.
   *
   * `settled` marks the shell's own exit rather than something it printed.
   * That emission is what tells a listener nothing is journaling this terminal
   * any more, and callers act on it — so it keeps the window it has always had
   * instead of arriving a command earlier than every existing caller expects.
   * Perceived speed is about printed output; the exit costs the reader nothing.
   */
  #scheduleOutput(record: TerminalRecord, settled = false): void {
    for (const observer of Array.from(record.observers)) {
      if (observer.timer !== undefined) continue;
      const sinceLastPublish = Date.now() - observer.lastPublishedAt;
      if (!settled && sinceLastPublish >= observer.windowMs) {
        this.#publishObserver(record, observer);
        continue;
      }
      observer.timer = setTimeout(
        () => {
          observer.timer = undefined;
          this.#publishObserver(record, observer);
        },
        settled ? observer.windowMs : observer.windowMs - sinceLastPublish,
      );
    }
  }

  /** Tell every observer now, as a stop or a terminate must. */
  #publishOutput(record: TerminalRecord): void {
    for (const observer of Array.from(record.observers)) this.#publishObserver(record, observer);
  }

  #publishObserver(record: TerminalRecord, observer: OutputObserver): void {
    clearObserverTimer(observer);
    // An earlier observer's listener may have ended this one.
    if (!record.observers.has(observer)) return;
    const snapshot = this.#snapshot(record);
    const end = publishableEnd(record);
    // A reader is only sent the whole window when its position is no longer in
    // the transcript: either the ceiling discarded it, or redaction rewrote the
    // stream behind it. Otherwise the delta costs what the terminal printed,
    // not what it has ever printed.
    let replace =
      observer.publishedCharacters < record.transcript.retainedFrom() ||
      observer.publishedCharacters > end;
    let text = replace
      ? liveWindow(record, end)
      : record.transcript.textBetween(observer.publishedCharacters, end);
    if (
      !replace &&
      observer.maxDeltaCharacters !== undefined &&
      text.length > observer.maxDeltaCharacters
    ) {
      replace = true;
      text = liveWindow(record, end);
    }
    const stateChanged =
      observer.publishedStatus !== snapshot.status ||
      observer.publishedExitCode !== snapshot.exitCode;
    observer.publishedCharacters = end;
    observer.publishedStatus = snapshot.status;
    observer.publishedExitCode = snapshot.exitCode;
    if (text.length === 0 && !stateChanged) return;
    // Only a publish that actually sent something opens a coalescing window.
    // Stamped on entry, the empty publish a new observer triggers would make
    // that observer's first real chunk wait the full window.
    observer.lastPublishedAt = Date.now();
    observer.listener({ text, replace, characters: end, snapshot });
  }
}

function clearObserverTimer(observer: OutputObserver): void {
  if (observer.timer === undefined) return;
  clearTimeout(observer.timer);
  observer.timer = undefined;
}

/**
 * The offset up to which this terminal's output may be published.
 *
 * It stops short of a tail that is still a prefix of a credential, so a secret
 * arriving across two PTY callbacks is never published half-written and then
 * rewritten behind a reader's position.
 */
function publishableEnd(record: TerminalRecord): number {
  const end = record.transcript.characters();
  if (record.secrets.length === 0) return end;
  const longest = record.secrets.reduce((widest, secret) => Math.max(widest, secret.length - 1), 0);
  const tail = record.transcript.textBetween(
    Math.max(record.transcript.retainedFrom(), end - longest),
    end,
  );
  let withheld = 0;
  for (const secret of record.secrets) {
    for (let length = Math.min(secret.length - 1, tail.length); length > withheld; length--) {
      if (tail.endsWith(secret.slice(0, length))) {
        withheld = length;
        break;
      }
    }
  }
  return end - withheld;
}

/** The bounded tail sent to a reader whose position the transcript no longer holds. */
function liveWindow(record: TerminalRecord, end: number): string {
  const from = Math.max(
    record.transcript.retainedFrom(),
    end - (MAX_LIVE_TERMINAL_TRANSCRIPT_CHARACTERS - TRUNCATION_MARKER.length),
  );
  const text = record.transcript.textBetween(from, end);
  return from > 0 && !text.startsWith(TRUNCATION_MARKER) ? `${TRUNCATION_MARKER}${text}` : text;
}

/**
 * The terminal's output, bounded, addressed by absolute character offset.
 *
 * Readers hold an offset rather than a copy of the text, so catching one up
 * costs what the terminal printed since it last looked. `#retainedFrom` is the
 * offset of the first character still held: it only moves when the ceiling
 * discards output, and it is what tells a reader its position is gone.
 */
class TranscriptBuffer {
  #chunks: string[] = [];
  #byteLength = 0;
  #truncated = false;
  #characters = 0;
  #retainedFrom = 0;

  append(value: string): void {
    for (const chunk of splitUtf8(value, MAX_TERMINAL_OUTPUT_CHUNK_BYTES)) {
      this.#chunks.push(chunk);
      this.#byteLength += Buffer.byteLength(chunk, "utf8");
      this.#characters += chunk.length;
    }
    this.#enforceLimit();
  }

  snapshot(): TerminalSnapshot["transcript"] {
    return {
      chunks: [...this.#chunks],
      byteLength: this.#byteLength,
      truncated: this.#truncated,
      characters: this.characters(),
    };
  }

  /** Absolute offset one past the last character held. */
  characters(): number {
    return this.#retainedFrom + this.#characters;
  }

  /** Absolute offset of the first character still held. */
  retainedFrom(): number {
    return this.#retainedFrom;
  }

  /**
   * The text between two absolute offsets, read from the end of the chunk list
   * backwards so the work is the size of the answer rather than the size of the
   * transcript. Offsets outside what is held are clamped.
   */
  textBetween(from: number, to: number): string {
    const start = Math.max(from, this.#retainedFrom);
    const end = Math.min(to, this.characters());
    if (end <= start) return "";
    const pieces: string[] = [];
    let position = this.characters();
    for (let index = this.#chunks.length - 1; index >= 0 && position > start; index--) {
      const chunk = this.#chunks[index]!;
      const chunkStart = position - chunk.length;
      if (chunkStart < end) {
        pieces.push(
          chunk.slice(Math.max(start - chunkStart, 0), Math.min(end - chunkStart, chunk.length)),
        );
      }
      position = chunkStart;
    }
    return pieces.reverse().join("");
  }

  redact(secrets: readonly string[]): void {
    if (secrets.length === 0) return;
    const redacted = redact(this.#chunks.join(""), secrets);
    this.#chunks = splitUtf8(redacted, MAX_TERMINAL_OUTPUT_CHUNK_BYTES);
    this.#byteLength = Buffer.byteLength(redacted, "utf8");
    this.#characters = redacted.length;
    this.#enforceLimit();
  }

  #enforceLimit(): void {
    if (this.#byteLength <= MAX_TERMINAL_TRANSCRIPT_BYTES) return;
    this.#truncated = true;
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    while (
      this.#chunks.length > 0 &&
      this.#byteLength + markerBytes > MAX_TERMINAL_TRANSCRIPT_BYTES
    ) {
      const dropped = this.#chunks.shift();
      if (dropped === undefined) break;
      this.#byteLength -= Buffer.byteLength(dropped, "utf8");
      this.#characters -= dropped.length;
      this.#retainedFrom += dropped.length;
    }
    if (this.#chunks[0] !== TRUNCATION_MARKER) {
      this.#chunks.unshift(TRUNCATION_MARKER);
      this.#byteLength += markerBytes;
      this.#characters += TRUNCATION_MARKER.length;
      // The marker is not something the PTY printed. Backing the retained
      // offset up by its length keeps every real character at the offset it has
      // always had, so a reader's position stays meaningful across truncation.
      this.#retainedFrom -= TRUNCATION_MARKER.length;
    }
  }
}

function sanitizeInheritedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined && !value.includes("\0")) environment[name] = value;
  }
  return environment;
}

function validateTerminalId(terminalId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(terminalId))
    throw new Error("Terminal identifier is invalid.");
}

function validateEnvironmentName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    throw new Error("Terminal credential environment name is invalid.");
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}

function splitUtf8(value: string, maximumBytes: number): string[] {
  const bytes = Buffer.from(value, "utf8");
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += maximumBytes) {
    let end = Math.min(offset + maximumBytes, bytes.length);
    while (end > offset && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    if (end === offset) end = Math.min(offset + maximumBytes, bytes.length);
    chunks.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end - maximumBytes;
  }
  return chunks;
}
