import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  decodeLocalUsageHistoryRecord,
  decodeLocalUsageHistoryCoverage,
  decodeLocalUsageHistoryRequest,
  type LocalUsageHistoryCoverage,
  type LocalUsageHistoryRecord,
  type LocalUsageHistoryRequest,
  type LocalUsageHistorySourceKind,
} from "@octant/contracts";

const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
const MAX_DISCOVERED_FILES = 100_000;
const MAX_TRACKED_SOURCES = 32;
const MAX_CACHED_RECORDS = 100_000;

/** In-process resumable cursors keep bounded refreshes progressing through long files. */
const scanOffsets = new Map<
  string,
  {
    readonly offset: number;
    readonly size: number;
    readonly dev: number;
    readonly ino: number;
    readonly prefixRevision: string;
  }
>();
const fileIdentities = new Map<
  string,
  {
    readonly offset: number;
    readonly size: number;
    readonly dev: number;
    readonly ino: number;
    readonly prefixRevision: string;
  }
>();
const fileCursors = new Map<string, string>();
const fileSeen = new Map<string, Set<string>>();
/** Bounded records let a later refresh aggregate chunks already scanned this process. */
const recordCaches = new Map<string, Map<string, LocalUsageHistoryRecord>>();
const recordCacheTruncated = new Set<string>();
interface ActiveRead {
  readonly operation: Promise<LocalUsageHistoryReadResult>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

const activeReads = new Map<string, ActiveRead>();
const sourceLocks = new Map<string, Promise<LocalUsageHistoryReadResult>>();

interface LocalUsageHistoryReadResult {
  readonly records: ReadonlyArray<LocalUsageHistoryRecord>;
  readonly coverage: LocalUsageHistoryCoverage;
}

export interface LocalUsageHistoryReaderOptions {
  readonly sourceKind: LocalUsageHistorySourceKind;
  readonly providerKey: string;
  readonly root: string;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxRecords?: number;
  readonly onSourceInvalidated?: () => void;
}

export type LocalUsageHistoryLineParser = (input: {
  readonly line: string;
  readonly sourceInstallationId: string;
  readonly sourceSessionIdHint: string;
  readonly relativePath: string;
  readonly lineNumber: number;
}) => LocalUsageHistoryRecord | undefined;

/**
 * Bounded metadata-only JSONL reader shared by local provider adapters.
 * Symlinked children are skipped, paths never leave the configured root, and
 * only parser-returned accounting records survive. Raw lines and paths never
 * leave this function.
 */
export function readLocalUsageHistory(
  options: LocalUsageHistoryReaderOptions,
  request: LocalUsageHistoryRequest,
  parse: LocalUsageHistoryLineParser,
  signal?: AbortSignal,
): Promise<LocalUsageHistoryReadResult> {
  const key = [
    options.sourceKind,
    options.root,
    request.from,
    request.to,
    request.timeZone,
    options.maxFiles ?? "",
    options.maxTotalBytes ?? "",
    options.maxFileBytes ?? "",
    options.maxRecordBytes ?? "",
    options.maxRecords ?? "",
  ].join("\0");
  const active = activeReads.get(key);
  if (active !== undefined) {
    active.waiters += 1;
    return waitForRead(active, signal);
  }
  const sourceKey = `${options.sourceKind}\0${options.root}`;
  const previous = sourceLocks.get(sourceKey);
  const previousDone =
    previous === undefined
      ? Promise.resolve()
      : previous.then(
          () => undefined,
          () => undefined,
        );
  const controller = new AbortController();
  const operation = previousDone.then(() =>
    readLocalUsageHistoryImpl(options, request, parse, controller.signal),
  );
  const entry: ActiveRead = { operation, controller, waiters: 0, settled: false };
  activeReads.set(key, entry);
  sourceLocks.set(sourceKey, operation);
  const cleanup = () => {
    entry.settled = true;
    if (activeReads.get(key) === entry) activeReads.delete(key);
    if (sourceLocks.get(sourceKey) === operation) sourceLocks.delete(sourceKey);
  };
  void operation.then(cleanup, cleanup);
  void operation.catch(() => undefined);
  entry.waiters += 1;
  return waitForRead(entry, signal);
}

function waitForRead(
  entry: ActiveRead,
  signal: AbortSignal | undefined,
): Promise<LocalUsageHistoryReadResult> {
  if (signal?.aborted) {
    releaseRead(entry);
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("Local usage history read aborted."),
    );
  }
  if (signal === undefined) {
    return entry.operation.finally(() => releaseRead(entry));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      releaseRead(entry);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Local usage history read aborted."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    entry.operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        releaseRead(entry);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        releaseRead(entry);
        reject(error);
      },
    );
  });
}

function releaseRead(entry: ActiveRead): void {
  entry.waiters -= 1;
  if (entry.waiters <= 0 && !entry.settled) entry.controller.abort();
}

async function readLocalUsageHistoryImpl(
  options: LocalUsageHistoryReaderOptions,
  request: LocalUsageHistoryRequest,
  parse: LocalUsageHistoryLineParser,
  signal?: AbortSignal,
): Promise<LocalUsageHistoryReadResult> {
  decodeLocalUsageHistoryRequest(request);
  const maxFiles = boundedPositive(options.maxFiles ?? DEFAULT_MAX_FILES, DEFAULT_MAX_FILES);
  const maxTotalBytes = boundedPositive(
    options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    DEFAULT_MAX_TOTAL_BYTES,
  );
  const maxFileBytes = boundedPositive(
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxRecordBytes = boundedPositive(
    options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
    DEFAULT_MAX_RECORD_BYTES,
  );
  const maxRecords = boundedPositive(
    options.maxRecords ?? DEFAULT_MAX_RECORDS,
    DEFAULT_MAX_RECORDS,
  );
  const cacheCapacity = Math.min(MAX_CACHED_RECORDS, maxRecords);
  const requestedInstallationId = installationId(options.sourceKind, options.root);
  let root: string;
  try {
    root = await realpath(options.root);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new Error("history root is not a directory");
  } catch {
    return {
      records: [],
      coverage: coverage(
        options,
        requestedInstallationId,
        "unavailable",
        0,
        0,
        0,
        false,
        false,
        "The provider history directory is unavailable.",
      ),
    };
  }

  const sourceInstallationId = installationId(options.sourceKind, root);
  trackSource(sourceInstallationId);
  const collected = await collectFiles(root, MAX_DISCOVERED_FILES);
  const files = collected.files;
  const previousFile = fileCursors.get(sourceInstallationId);
  const previousIndex = previousFile === undefined ? -1 : files.indexOf(previousFile);
  const startIndex =
    previousIndex < 0 || files.length === 0 ? 0 : (previousIndex + 1) % files.length;
  const rotatedFiles = files.slice(startIndex).concat(files.slice(0, startIndex));
  const selected = rotatedFiles.slice(0, maxFiles);
  const seen = fileSeen.get(sourceInstallationId) ?? new Set<string>();
  let cacheInvalidated = [...seen].some((file) => !files.includes(file));
  let parserInvalidated = false;
  if (cacheInvalidated) {
    parserInvalidated = true;
    options.onSourceInvalidated?.();
    seen.clear();
    fileCursors.delete(sourceInstallationId);
    recordCaches.delete(sourceInstallationId);
    recordCacheTruncated.delete(sourceInstallationId);
    clearScanOffsets(sourceInstallationId);
  }
  fileSeen.set(sourceInstallationId, seen);
  for (const file of selected) seen.add(file);
  if (selected.length > 0) fileCursors.set(sourceInstallationId, selected[selected.length - 1]!);
  let truncated = collected.truncated || files.some((file) => !seen.has(file));
  const records: LocalUsageHistoryRecord[] = [];
  let scannedFileCount = 0;
  let omittedRecordCount = truncated ? 1 : 0;
  let scannedBytes = 0;
  let failed = collected.failed;
  for (const filePath of selected) {
    throwIfAborted(signal);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const resolvedFilePath = await realpath(filePath);
      if (!isWithinRoot(root, resolvedFilePath)) {
        throw new Error("history file escaped its configured root");
      }
      if (typeof constants.O_NOFOLLOW !== "number") {
        throw new Error("platform cannot enforce no-follow file opens");
      }
      handle = await open(resolvedFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) throw new Error("history path is not a regular file");
      const fileSize = fileStat.size;
      if (!Number.isSafeInteger(fileSize)) {
        omittedRecordCount += 1;
        failed = true;
        continue;
      }
      const cursorKey = `${sourceInstallationId}\0${resolvedFilePath}`;
      const prefixRevision = await filePrefixRevision(handle, fileSize);
      const previous = scanOffsets.get(cursorKey) ?? fileIdentities.get(cursorKey);
      const replaced =
        previous !== undefined &&
        (fileSize < previous.size ||
          previous.dev !== fileStat.dev ||
          previous.ino !== fileStat.ino ||
          previous.prefixRevision !== prefixRevision);
      if (replaced) {
        cacheInvalidated = true;
        if (!parserInvalidated) {
          parserInvalidated = true;
          options.onSourceInvalidated?.();
        }
        scanOffsets.delete(cursorKey);
        recordCaches.delete(sourceInstallationId);
        recordCacheTruncated.delete(sourceInstallationId);
      }
      if (fileSize === 0) {
        fileIdentities.set(cursorKey, {
          offset: 0,
          size: 0,
          dev: fileStat.dev,
          ino: fileStat.ino,
          prefixRevision,
        });
        continue;
      }
      const startOffset =
        previous === undefined ||
        replaced ||
        fileSize < previous.size ||
        previous.offset >= fileSize
          ? 0
          : previous.offset;
      const availableBytes = maxTotalBytes - scannedBytes;
      if (availableBytes <= 0) {
        truncated = true;
        break;
      }
      const reservedTrailerBytes = Math.min(maxRecordBytes, Math.max(0, availableBytes - 1));
      const chunkBudget = Math.max(1, availableBytes - reservedTrailerBytes);
      const chunkLength = Math.min(fileSize - startOffset, maxFileBytes, chunkBudget);
      if (chunkLength <= 0) {
        truncated = true;
        break;
      }
      const endOffset = startOffset + chunkLength - 1;
      const streamEndOffset = await extendToLineBoundary(
        handle,
        endOffset,
        fileSize,
        Math.min(maxRecordBytes, Math.max(0, availableBytes - chunkLength)),
      );
      const startsMidLine = startOffset > 0 && !(await byteIsLineBreak(handle, startOffset - 1));
      scannedBytes += streamEndOffset - startOffset + 1;
      scannedFileCount += 1;
      const relativePath = relative(root, resolvedFilePath);
      const sessionHint = sessionHintForPath(relativePath);
      let lineNumber = 0;
      const stream = createReadStream(resolvedFilePath, {
        encoding: "utf8",
        fd: handle.fd,
        autoClose: false,
        start: startOffset,
        end: streamEndOffset,
        ...(signal === undefined ? {} : { signal }),
      });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let bytesRead = 0;
      try {
        for await (const line of lines) {
          throwIfAborted(signal);
          lineNumber += 1;
          if (startsMidLine && lineNumber === 1) continue;
          if (Buffer.byteLength(line, "utf8") > maxRecordBytes) {
            omittedRecordCount += 1;
            continue;
          }
          try {
            JSON.parse(line);
          } catch {
            omittedRecordCount += 1;
            continue;
          }
          try {
            const record = parse({
              line,
              sourceInstallationId,
              sourceSessionIdHint: sessionHint,
              relativePath,
              lineNumber,
            });
            if (record === undefined) continue;
            const observedAt = Date.parse(String(record.observedAt));
            if (!Number.isFinite(observedAt)) {
              omittedRecordCount += 1;
              continue;
            }
            records.push(decodeLocalUsageHistoryRecord(record));
          } catch {
            omittedRecordCount += 1;
          }
        }
      } finally {
        bytesRead = stream.bytesRead;
        lines.close();
        stream.destroy();
      }
      if (!signal?.aborted) {
        const nextOffset = startOffset + bytesRead;
        const identity = {
          offset: nextOffset >= fileSize ? 0 : nextOffset,
          size: fileSize,
          dev: fileStat.dev,
          ino: fileStat.ino,
          prefixRevision,
        };
        fileIdentities.set(cursorKey, identity);
        if (nextOffset >= fileSize) scanOffsets.delete(cursorKey);
        else {
          truncated = true;
          scanOffsets.set(cursorKey, identity);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      omittedRecordCount += 1;
      failed = true;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }
  if (cacheInvalidated) {
    truncated = true;
    seen.clear();
    for (const file of selected) seen.add(file);
  }
  const recordCache = recordCaches.get(sourceInstallationId) ?? new Map();
  recordCaches.set(sourceInstallationId, recordCache);
  for (const record of records) {
    recordCache.set(`${record.sourceSessionId}\0${record.sourceEventId}`, record);
  }
  if (recordCache.size > cacheCapacity) {
    const newest = [...recordCache.entries()]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          Date.parse(String(right.observedAt)) - Date.parse(String(left.observedAt)) ||
          leftKey.localeCompare(rightKey),
      )
      .slice(0, cacheCapacity);
    recordCache.clear();
    for (const [key, record] of newest) recordCache.set(key, record);
    recordCacheTruncated.add(sourceInstallationId);
  }
  const from = Date.parse(String(request.from));
  const to = Date.parse(String(request.to));
  const cachedRecords = [...recordCache.values()].filter((record) => {
    const observedAt = Date.parse(String(record.observedAt));
    return observedAt >= from && observedAt <= to;
  });
  const responseRecords = cachedRecords;
  if (recordCacheTruncated.has(sourceInstallationId)) {
    truncated = true;
  }
  const hasPendingFiles = files.some((file) => !seen.has(file));
  const hasPendingChunks = [...scanOffsets.keys()].some((key) =>
    key.startsWith(`${sourceInstallationId}\0`),
  );
  const hasMore =
    !failed &&
    !collected.truncated &&
    !recordCacheTruncated.has(sourceInstallationId) &&
    (hasPendingFiles || hasPendingChunks);
  const status =
    failed && responseRecords.length === 0
      ? "failed"
      : omittedRecordCount > 0 || truncated || failed
        ? "partial"
        : "ready";
  const range = responseRecords.reduce<{ from?: string; to?: string }>(
    (current, record) => ({
      from:
        current.from === undefined || record.observedAt < current.from
          ? record.observedAt
          : current.from,
      to:
        current.to === undefined || record.observedAt > current.to ? record.observedAt : current.to,
    }),
    {},
  );
  return {
    records: responseRecords,
    coverage: coverage(
      options,
      sourceInstallationId,
      status,
      scannedFileCount,
      responseRecords.length,
      omittedRecordCount,
      truncated,
      hasMore,
      failed
        ? "Some provider history files could not be read."
        : truncated
          ? "Bounded provider history scan is partial; the next refresh resumes its cursor."
          : "Provider accounting history was scanned.",
      range,
    ),
  };
}

async function filePrefixRevision(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<string> {
  const length = Math.min(fileSize, 4096);
  const buffer = Buffer.allocUnsafe(length);
  const result = await handle.read(buffer, 0, length, 0);
  return createHash("sha256").update(buffer.subarray(0, result.bytesRead)).digest("hex");
}

function clearScanOffsets(sourceInstallationId: string): void {
  const prefix = `${sourceInstallationId}\0`;
  for (const key of scanOffsets.keys()) {
    if (key.startsWith(prefix)) {
      scanOffsets.delete(key);
      fileIdentities.delete(key);
    }
  }
}

function trackSource(sourceInstallationId: string): void {
  if (fileSeen.has(sourceInstallationId)) return;
  if (fileSeen.size >= MAX_TRACKED_SOURCES) {
    const oldest = fileSeen.keys().next().value;
    if (oldest !== undefined) {
      fileSeen.delete(oldest);
      fileCursors.delete(oldest);
      recordCaches.delete(oldest);
      recordCacheTruncated.delete(oldest);
      const prefix = `${oldest}\0`;
      for (const key of scanOffsets.keys()) {
        if (key.startsWith(prefix)) scanOffsets.delete(key);
      }
      for (const key of fileIdentities.keys()) {
        if (key.startsWith(prefix)) fileIdentities.delete(key);
      }
    }
  }
  fileSeen.set(sourceInstallationId, new Set());
}

async function extendToLineBoundary(
  handle: Awaited<ReturnType<typeof open>>,
  endOffset: number,
  fileSize: number,
  maxExtensionBytes: number,
): Promise<number> {
  if (maxExtensionBytes <= 0 || (await byteIsLineBreak(handle, endOffset))) return endOffset;
  const limit = Math.min(fileSize - 1, endOffset + maxExtensionBytes);
  for (let offset = endOffset + 1; offset <= limit; offset += 1) {
    if (await byteIsLineBreak(handle, offset)) return offset;
  }
  return endOffset;
}

async function byteIsLineBreak(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<boolean> {
  const buffer = Buffer.allocUnsafe(1);
  const result = await handle.read(buffer, 0, 1, offset);
  return result.bytesRead === 1 && (buffer[0] === 10 || buffer[0] === 13);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Local usage history scan aborted.");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep))
  );
}

async function collectFiles(
  root: string,
  limit: number,
): Promise<{
  readonly files: ReadonlyArray<string>;
  readonly failed: boolean;
  readonly truncated: boolean;
}> {
  const files: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
  let failed = false;
  let truncated = false;
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      failed = true;
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const candidate = join(directory, entry.name);
      let entryStat;
      try {
        entryStat = await lstat(candidate);
      } catch {
        failed = true;
        continue;
      }
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        await visit(candidate);
      } else if (entryStat.isFile() && candidate.endsWith(".jsonl")) {
        files.push({ path: candidate, mtimeMs: entryStat.mtimeMs });
      }
    }
  };
  await visit(root);
  return {
    files: files
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
      .map((entry) => entry.path),
    failed,
    truncated,
  };
}

function installationId(sourceKind: LocalUsageHistorySourceKind, root: string): string {
  return createHash("sha256")
    .update("octant.local-usage-installation.v1\0")
    .update(sourceKind)
    .update("\0")
    .update(root)
    .digest("hex");
}

export function stableUsageId(...parts: ReadonlyArray<string>): string {
  return createHash("sha256")
    .update("octant.local-usage-event.v1\0")
    .update(parts.join("\0"))
    .digest("hex");
}

function sessionHintForPath(relativePath: string): string {
  const file = basename(relativePath, ".jsonl");
  return file.length > 0 ? file : "unknown-session";
}

function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, maximum);
}

function coverage(
  options: LocalUsageHistoryReaderOptions,
  sourceInstallationId: string,
  status: "ready" | "partial" | "unavailable" | "failed",
  scannedFileCount: number,
  acceptedRecordCount: number,
  omittedRecordCount: number,
  truncated: boolean,
  hasMore: boolean,
  detail: string,
  range: { readonly from?: string; readonly to?: string } = {},
): LocalUsageHistoryCoverage {
  return decodeLocalUsageHistoryCoverage({
    sourceKind: options.sourceKind,
    sourceInstallationId,
    status,
    scannedFileCount,
    acceptedRecordCount,
    omittedRecordCount,
    hasMore,
    ...(range.from === undefined ? {} : { coveredFrom: range.from }),
    ...(range.to === undefined ? {} : { coveredTo: range.to }),
    truncated,
    detail,
  });
}
