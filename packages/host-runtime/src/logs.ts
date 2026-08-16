import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactHostRuntimeValue, redactHostRuntimeText } from "./redaction";

const MAX_LOG_BYTES = 1_048_576;
const MAX_LOG_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 8_192;
const LOG_CURSOR_SEPARATOR = "#";

export type HostLogLevel = "debug" | "info" | "warn" | "error";

export interface HostLogEntry {
  readonly timestamp: string;
  readonly level: HostLogLevel;
  readonly event: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface HostLogReadOptions {
  readonly since?: string;
  readonly limit?: number;
  readonly follow?: boolean;
}

export interface HostLogReadResult {
  readonly entries: ReadonlyArray<HostLogEntry>;
  readonly follow: boolean;
  readonly nextSince?: string;
}

export class HostLogStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostLogStoreError";
  }
}

export interface BoundedHostLogStoreOptions {
  readonly path: string;
  readonly uid?: number;
}

interface StoredHostLogEntry extends HostLogEntry {
  readonly sequence: number;
}

export class BoundedHostLogStore {
  readonly #path: string;
  readonly #uid: number;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: BoundedHostLogStoreOptions) {
    if (!isAbsolute(options.path) || options.path.trim() !== options.path) {
      throw new HostLogStoreError("Log path must be absolute.");
    }
    this.#path = options.path;
    this.#uid = options.uid ?? process.getuid?.() ?? 0;
  }

  get path(): string {
    return this.#path;
  }

  async append(input: Omit<HostLogEntry, "message"> & { readonly message: string }): Promise<void> {
    const write = this.#writeChain.then(() => this.#append(input));
    this.#writeChain = write.catch(() => undefined);
    await write;
  }

  async #append(
    input: Omit<HostLogEntry, "message"> & { readonly message: string },
  ): Promise<void> {
    const existing = await this.#readEntries();
    const entry = normalizeEntry(input, (existing.at(-1)?.sequence ?? -1) + 1);
    const entries = [...existing, entry].slice(-MAX_LOG_ENTRIES);
    const lines = entries.map((item) => JSON.stringify(item)).join("\n");
    const bounded = Buffer.byteLength(lines) > MAX_LOG_BYTES ? trimBytes(entries) : lines;
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertOwnerOnlyDirectory(directory, this.#uid);
    await assertExistingLogSafe(this.#path, this.#uid);
    const temporary = join(directory, `.service-log-${randomUUID()}.tmp`);
    await writeFile(temporary, bounded === "" ? "" : `${bounded}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
  }

  async read(options: HostLogReadOptions = {}): Promise<HostLogReadResult> {
    const since = options.since === undefined ? undefined : decodeLogCursor(options.since);
    const limit = clampLimit(options.limit);
    const entries = (await this.#readEntries()).filter((entry) => isAfterCursor(entry, since));
    const boundedEntries = entries.slice(-limit);
    const last = boundedEntries.at(-1);
    return last === undefined
      ? { entries: boundedEntries.map(stripSequence), follow: options.follow === true }
      : {
          entries: boundedEntries.map(stripSequence),
          follow: options.follow === true,
          nextSince: encodeLogCursor(last),
        };
  }

  async #readEntries(): Promise<StoredHostLogEntry[]> {
    let raw: string;
    try {
      const metadata = await lstat(this.#path);
      if (!metadata.isFile() || metadata.uid !== this.#uid || (metadata.mode & 0o077) !== 0) {
        throw new HostLogStoreError("Service log is not an owner-only file.");
      }
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      if (error instanceof HostLogStoreError) throw error;
      throw new HostLogStoreError("Service log could not be read.");
    }
    if (Buffer.byteLength(raw) > MAX_LOG_BYTES) raw = raw.slice(-MAX_LOG_BYTES);
    const entries: StoredHostLogEntry[] = [];
    let nextSequence = 0;
    for (const line of raw.split("\n").slice(-MAX_LOG_ENTRIES)) {
      if (line.trim() === "") continue;
      try {
        const value = JSON.parse(line) as unknown;
        const entry = decodeEntry(value, nextSequence);
        if (entry !== undefined) {
          const sequence = Math.max(nextSequence, entry.sequence);
          entries.push({ ...entry, sequence });
          nextSequence = sequence + 1;
        }
      } catch {
        // A partial or malformed log line is unavailable, not an excuse to
        // expose unbounded/raw service output to a caller.
      }
    }
    return entries;
  }
}

function normalizeEntry(
  input: Omit<HostLogEntry, "message"> & { readonly message: string },
  sequence: number,
): StoredHostLogEntry {
  const sensitiveEvent = /(?:prompt|content|payload|credential|secret|token)/i.test(input.event);
  const message = sensitiveEvent
    ? "[REDACTED]"
    : redactHostRuntimeText(input.message).slice(0, MAX_ENTRY_BYTES);
  const base = {
    timestamp: boundedTimestamp(input.timestamp),
    level: input.level,
    event: sensitiveEvent ? "redacted.event" : boundedText(input.event, 96),
    message,
    sequence,
  } satisfies StoredHostLogEntry;
  const details = input.details === undefined ? undefined : redactHostRuntimeValue(input.details);
  return details === undefined
    ? base
    : { ...base, details: details as Readonly<Record<string, unknown>> };
}

function decodeEntry(value: unknown, fallbackSequence: number): StoredHostLogEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.timestamp !== "string" ||
    typeof record.event !== "string" ||
    typeof record.message !== "string" ||
    !isLevel(record.level) ||
    Number.isNaN(Date.parse(record.timestamp))
  ) {
    return undefined;
  }
  const details = record.details;
  const sequence =
    typeof record.sequence === "number" &&
    Number.isSafeInteger(record.sequence) &&
    record.sequence >= 0
      ? record.sequence
      : fallbackSequence;
  return normalizeEntry(
    {
      timestamp: record.timestamp,
      level: record.level,
      event: record.event,
      message: record.message,
      ...(details !== undefined &&
      typeof details === "object" &&
      details !== null &&
      !Array.isArray(details)
        ? { details: details as Readonly<Record<string, unknown>> }
        : {}),
    },
    sequence,
  );
}

function stripSequence(entry: StoredHostLogEntry): HostLogEntry {
  const { sequence: _sequence, ...publicEntry } = entry;
  return publicEntry;
}

function encodeLogCursor(entry: StoredHostLogEntry): string {
  return `${entry.timestamp}${LOG_CURSOR_SEPARATOR}${entry.sequence}`;
}

function decodeLogCursor(value: string): {
  readonly timestamp: number;
  readonly sequence?: number;
} {
  const separator = value.lastIndexOf(LOG_CURSOR_SEPARATOR);
  if (separator > 0) {
    const timestamp = Date.parse(value.slice(0, separator));
    const sequence = Number(value.slice(separator + 1));
    if (!Number.isNaN(timestamp) && Number.isSafeInteger(sequence) && sequence >= 0) {
      return { timestamp, sequence };
    }
  }
  return { timestamp: Date.parse(value) };
}

function isAfterCursor(
  entry: StoredHostLogEntry,
  cursor: { readonly timestamp: number; readonly sequence?: number } | undefined,
): boolean {
  if (cursor === undefined || Number.isNaN(cursor.timestamp)) return true;
  const timestamp = Date.parse(entry.timestamp);
  if (timestamp !== cursor.timestamp) return timestamp > cursor.timestamp;
  return cursor.sequence === undefined ? false : entry.sequence > cursor.sequence;
}

function boundedTimestamp(value: string): string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value))
    ? value
    : new Date(0).toISOString();
}

function boundedText(value: string, max: number): string {
  return value.trim().slice(0, max) || "unknown";
}

function isLevel(value: unknown): value is HostLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function clampLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined) return 100;
  return Math.max(1, Math.min(1000, value));
}

function trimBytes(entries: ReadonlyArray<StoredHostLogEntry>): string {
  const kept: string[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = JSON.stringify(entries[index]);
    const lineBytes = Buffer.byteLength(line) + (kept.length === 0 ? 0 : 1);
    if (bytes + lineBytes > MAX_LOG_BYTES) break;
    kept.unshift(line);
    bytes += lineBytes;
  }
  return kept.join("\n");
}

async function assertOwnerOnlyDirectory(path: string, uid: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    throw new HostLogStoreError("Service log directory is not owner-only.");
  }
}

async function assertExistingLogSafe(path: string, uid: number): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
      throw new HostLogStoreError("Service log is not an owner-only file.");
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
