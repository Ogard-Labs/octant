import type { TerminalLaunchInput, TerminalProcessHandle } from "./terminalProcessPort";

export const MAX_TERMINAL_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_TERMINAL_OUTPUT_CHUNK_BYTES = 64 * 1024;

const TRUNCATION_MARKER = "[Octant terminal output truncated]\n";
const MAX_LIVE_TERMINAL_TRANSCRIPT_CHARACTERS = 64 * 1024;
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

export interface TerminalLaunchRequest {
  readonly terminalId: string;
  readonly shell: string;
  readonly cwd: string;
  /** Authority this shell's persisted state belongs to; see TerminalLaunchInput. */
  readonly stateScope: string;
  readonly columns: number;
  readonly rows: number;
  readonly credentialReferences: readonly TerminalCredentialReference[];
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
  };
}

export interface TerminalOutputEmission {
  readonly text: string;
  readonly replace: boolean;
  readonly snapshot: TerminalSnapshot;
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
  readonly outputListeners: Set<(emission: TerminalOutputEmission) => void>;
  publishedTranscript: string;
  publishedStatus: TerminalSnapshot["status"];
  publishedExitCode: number | undefined;
  status: TerminalSnapshot["status"];
  exitCode?: number;
  pendingResize: { columns: number; rows: number } | undefined;
  resizeScheduled: boolean;
  outputTimer: ReturnType<typeof setTimeout> | undefined;
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
        outputListeners: new Set(),
        publishedTranscript: "",
        publishedStatus: "interrupted",
        publishedExitCode: restored.exitCode,
        status: "interrupted",
        ...(restored.exitCode === undefined ? {} : { exitCode: restored.exitCode }),
        pendingResize: undefined,
        resizeScheduled: false,
        outputTimer: undefined,
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

    const process = this.#options.port.start({
      shell: request.shell,
      cwd: request.cwd,
      stateScope: request.stateScope,
      environment,
      columns: request.columns,
      rows: request.rows,
    });
    const record: TerminalRecord = {
      terminalId: request.terminalId,
      transcript: new TranscriptBuffer(),
      process,
      secrets,
      outputListeners: new Set(),
      publishedTranscript: "",
      publishedStatus: "running",
      publishedExitCode: undefined,
      status: "running",
      pendingResize: undefined,
      resizeScheduled: false,
      outputTimer: undefined,
    };
    if (previous?.outputTimer !== undefined) clearTimeout(previous.outputTimer);
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
      this.#scheduleOutput(record);
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
    record.publishedTranscript = publishableTranscript(record);
    record.publishedStatus = record.status;
    record.publishedExitCode = record.exitCode;
    return snapshot;
  }

  attach(terminalId: string): TerminalSnapshot {
    return this.#snapshot(this.#require(terminalId));
  }

  observe(
    terminalId: string,
    listener: (emission: TerminalOutputEmission) => void,
    options?: { readonly afterTranscript: string },
  ): () => void {
    const record = this.#require(terminalId);
    if (options !== undefined) record.publishedTranscript = options.afterTranscript;
    record.outputListeners.add(listener);
    this.#publishOutput(record);
    return () => record.outputListeners.delete(listener);
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

  #scheduleOutput(record: TerminalRecord): void {
    if (record.outputTimer !== undefined) return;
    const delayMs = record.transcript.snapshot().truncated ? 1_000 : 50;
    record.outputTimer = setTimeout(() => {
      record.outputTimer = undefined;
      this.#publishOutput(record);
    }, delayMs);
  }

  #publishOutput(record: TerminalRecord): void {
    if (record.outputTimer !== undefined) {
      clearTimeout(record.outputTimer);
      record.outputTimer = undefined;
    }
    if (record.outputListeners.size === 0) return;
    const snapshot = this.#snapshot(record);
    const publishable = publishableTranscript(record);
    const replace = !publishable.startsWith(record.publishedTranscript);
    const text = replace ? publishable : publishable.slice(record.publishedTranscript.length);
    const stateChanged =
      record.publishedStatus !== snapshot.status || record.publishedExitCode !== snapshot.exitCode;
    record.publishedTranscript = publishable;
    record.publishedStatus = snapshot.status;
    record.publishedExitCode = snapshot.exitCode;
    if (text.length === 0 && !stateChanged) return;
    const emission = { text, replace, snapshot } as const;
    for (const listener of record.outputListeners) listener(emission);
  }
}

function publishableTranscript(record: TerminalRecord): string {
  const snapshot = record.transcript.snapshot();
  let transcript = snapshot.chunks.join("");
  if (snapshot.truncated && transcript.length > MAX_LIVE_TERMINAL_TRANSCRIPT_CHARACTERS) {
    transcript = `${TRUNCATION_MARKER}${transcript.slice(
      -(MAX_LIVE_TERMINAL_TRANSCRIPT_CHARACTERS - TRUNCATION_MARKER.length),
    )}`;
  }
  let withheld = 0;
  for (const secret of record.secrets) {
    for (let length = Math.min(secret.length - 1, transcript.length); length > withheld; length--) {
      if (transcript.endsWith(secret.slice(0, length))) {
        withheld = length;
        break;
      }
    }
  }
  return withheld === 0 ? transcript : transcript.slice(0, -withheld);
}

class TranscriptBuffer {
  #chunks: string[] = [];
  #byteLength = 0;
  #truncated = false;

  append(value: string): void {
    for (const chunk of splitUtf8(value, MAX_TERMINAL_OUTPUT_CHUNK_BYTES)) {
      this.#chunks.push(chunk);
      this.#byteLength += Buffer.byteLength(chunk, "utf8");
    }
    this.#enforceLimit();
  }

  snapshot(): TerminalSnapshot["transcript"] {
    return { chunks: [...this.#chunks], byteLength: this.#byteLength, truncated: this.#truncated };
  }

  redact(secrets: readonly string[]): void {
    if (secrets.length === 0) return;
    const redacted = redact(this.#chunks.join(""), secrets);
    this.#chunks = splitUtf8(redacted, MAX_TERMINAL_OUTPUT_CHUNK_BYTES);
    this.#byteLength = Buffer.byteLength(redacted, "utf8");
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
      this.#byteLength -= Buffer.byteLength(this.#chunks.shift()!, "utf8");
    }
    if (this.#chunks[0] !== TRUNCATION_MARKER) {
      this.#chunks.unshift(TRUNCATION_MARKER);
      this.#byteLength += markerBytes;
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
