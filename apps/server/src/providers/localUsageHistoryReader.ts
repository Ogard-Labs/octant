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
const DEFAULT_MAX_RECORDS = 250_000;
const DEFAULT_MAX_DIRECTORIES = 4096;
const MAX_DISCOVERED_FILES = 100_000;
const MAX_TRACKED_SOURCES = 32;
const MAX_CACHED_RECORDS = 250_000;

/** In-process resumable cursors keep bounded refreshes progressing through long files. */
const scanOffsets = new Map<
  string,
  {
    readonly offset: number;
    readonly size: number;
    readonly dev: number;
    readonly ino: number;
    readonly prefixRevision: string;
    readonly prefixLength: number;
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
    readonly prefixLength: number;
  }
>();
const fileCursors = new Map<string, string>();
const fileSeen = new Map<string, Set<string>>();
/** Bounded records let a later refresh aggregate chunks already scanned this process. */
const recordCaches = new Map<string, Map<string, LocalUsageHistoryRecord>>();
const recordOwners = new Map<string, Map<string, Set<string>>>();
const recordCacheTruncated = new Set<string>();
interface ActiveRead {
  readonly operation: Promise<LocalUsageHistoryReadResult>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

const activeReads = new Map<string, ActiveRead>();
const sourceLocks = new Map<string, Promise<LocalUsageHistoryReadResult>>();
const parserIds = new WeakMap<LocalUsageHistoryLineParser, number>();
let nextParserId = 1;

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
  readonly maxDirectories?: number;
  readonly allowedRelativeRoots?: ReadonlyArray<string>;
  readonly onSourceInvalidated?: () => void;
}

export type LocalUsageHistoryLineParser = (input: {
  readonly line: string;
  readonly sourceInstallationId: string;
  readonly sourceSessionIdHint: string;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly byteOffset: number;
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
    options.maxDirectories ?? "",
    ...(options.allowedRelativeRoots ?? []),
    parserId(parse),
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

function parserId(parse: LocalUsageHistoryLineParser): number {
  const existing = parserIds.get(parse);
  if (existing !== undefined) return existing;
  const assigned = nextParserId;
  nextParserId += 1;
  parserIds.set(parse, assigned);
  return assigned;
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
  const maxDirectories = boundedPositive(
    options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    DEFAULT_MAX_DIRECTORIES,
  );
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
  const collected = await collectFiles(
    root,
    MAX_DISCOVERED_FILES,
    maxDirectories,
    options.allowedRelativeRoots,
  );
  const files = collected.files;
  const previousFile = fileCursors.get(sourceInstallationId);
  const previousIndex = previousFile === undefined ? -1 : files.indexOf(previousFile);
  const startIndex =
    previousIndex < 0 || files.length === 0 ? 0 : (previousIndex + 1) % files.length;
  const rotatedFiles = files.slice(startIndex).concat(files.slice(0, startIndex));
  const pendingFiles = rotatedFiles.filter((file) =>
    scanOffsets.has(`${sourceInstallationId}\0${file}`),
  );
  const pendingSet = new Set(pendingFiles);
  const scanOrder = pendingFiles.concat(rotatedFiles.filter((file) => !pendingSet.has(file)));
  const selected = scanOrder.slice(0, maxFiles);
  const seen = fileSeen.get(sourceInstallationId) ?? new Set<string>();
  const deletedFiles = [...seen].filter((file) => !files.includes(file));
  let cacheInvalidated = deletedFiles.length > 0;
  let parserInvalidated = false;
  if (cacheInvalidated) {
    parserInvalidated = true;
    options.onSourceInvalidated?.();
    for (const file of deletedFiles) {
      seen.delete(file);
      removeFileRecords(sourceInstallationId, file);
      clearScanOffsetForFile(sourceInstallationId, file);
    }
    if (
      fileCursors.get(sourceInstallationId) !== undefined &&
      deletedFiles.includes(fileCursors.get(sourceInstallationId)!)
    )
      fileCursors.delete(sourceInstallationId);
  }
  fileSeen.set(sourceInstallationId, seen);
  let truncated = collected.truncated;
  const records: LocalUsageHistoryRecord[] = [];
  const recordPaths = new Map<string, Set<string>>();
  const processedPaths = new Set<string>();
  let scannedFileCount = 0;
  let omittedRecordCount = collected.truncated ? 1 : 0;
  let scannedBytes = 0;
  let failed = collected.failed;
  for (const filePath of selected) {
    throwIfAborted(signal);
    let processedFile = false;
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
        processedFile = true;
        omittedRecordCount += 1;
        failed = true;
        continue;
      }
      const cursorKey = `${sourceInstallationId}\0${resolvedFilePath}`;
      const previous = scanOffsets.get(cursorKey) ?? fileIdentities.get(cursorKey);
      const prefixLength = Math.min(previous?.size ?? fileSize, 4096);
      const prefixRevision = await filePrefixRevision(handle, fileSize, prefixLength);
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
        removeFileRecords(sourceInstallationId, resolvedFilePath);
      }
      if (fileSize === 0) {
        processedFile = true;
        fileIdentities.set(cursorKey, {
          offset: 0,
          size: 0,
          dev: fileStat.dev,
          ino: fileStat.ino,
          prefixRevision,
          prefixLength,
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
        signal,
      );
      const startsMidLine = startOffset > 0 && !(await byteIsLineBreak(handle, startOffset - 1));
      scannedBytes += streamEndOffset - startOffset + 1;
      scannedFileCount += 1;
      const relativePath = relative(root, resolvedFilePath);
      const sessionHint = sessionHintForPath(relativePath);
      let lineNumber = 0;
      let lineOffset = startOffset;
      processedFile = true;
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
          const byteOffset = lineOffset;
          lineOffset += Buffer.byteLength(line, "utf8") + 1;
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
              byteOffset,
            });
            if (record === undefined) continue;
            const observedAt = Date.parse(String(record.observedAt));
            if (!Number.isFinite(observedAt)) {
              omittedRecordCount += 1;
              continue;
            }
            const decodedRecord = decodeLocalUsageHistoryRecord(record);
            records.push(decodedRecord);
            const decodedKey = recordKey(decodedRecord);
            const paths = recordPaths.get(decodedKey) ?? new Set<string>();
            paths.add(resolvedFilePath);
            recordPaths.set(decodedKey, paths);
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
          prefixLength,
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
      processedFile = true;
      omittedRecordCount += 1;
      failed = true;
    } finally {
      if (processedFile) {
        processedPaths.add(filePath);
        seen.add(filePath);
        fileCursors.set(sourceInstallationId, filePath);
      }
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }
  const hasPendingFiles = files.some((file) => !seen.has(file));
  const hasPendingChunks = [...scanOffsets.keys()].some((key) =>
    key.startsWith(`${sourceInstallationId}\0`),
  );
  truncated = collected.truncated || hasPendingFiles || hasPendingChunks;
  if (cacheInvalidated) truncated = true;
  const recordCache = recordCaches.get(sourceInstallationId) ?? new Map();
  recordCaches.set(sourceInstallationId, recordCache);
  const owners = recordOwners.get(sourceInstallationId) ?? new Map<string, Set<string>>();
  recordOwners.set(sourceInstallationId, owners);
  for (const record of records) {
    const key = recordKey(record);
    recordCache.set(key, record);
    const paths = recordPaths.get(key);
    if (paths !== undefined) {
      for (const path of paths) {
        const keys = owners.get(path) ?? new Set<string>();
        keys.add(key);
        owners.set(path, keys);
      }
    }
  }
  if (recordCache.size > cacheCapacity) {
    const newest = [...recordCache.entries()]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          Date.parse(String(right.observedAt)) - Date.parse(String(left.observedAt)) ||
          leftKey.localeCompare(rightKey),
      )
      .slice(0, cacheCapacity);
    const retained = new Set(newest.map(([key]) => key));
    recordCache.clear();
    for (const [key, record] of newest) recordCache.set(key, record);
    for (const [path, keys] of owners) {
      for (const key of keys) if (!retained.has(key)) keys.delete(key);
      if (keys.size === 0) owners.delete(path);
    }
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
  const hasMore =
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
  prefixLength: number,
): Promise<string> {
  const length = Math.min(fileSize, prefixLength);
  const buffer = Buffer.allocUnsafe(length);
  const result = await handle.read(buffer, 0, length, 0);
  return createHash("sha256").update(buffer.subarray(0, result.bytesRead)).digest("hex");
}

function recordKey(record: LocalUsageHistoryRecord): string {
  return `${record.sourceSessionId}\0${record.sourceEventId}`;
}

function removeFileRecords(sourceInstallationId: string, filePath: string): void {
  const owners = recordOwners.get(sourceInstallationId);
  const cache = recordCaches.get(sourceInstallationId);
  const keys = owners?.get(filePath);
  if (keys === undefined) return;
  owners?.delete(filePath);
  for (const key of keys) {
    const stillOwned = owners !== undefined && [...owners.values()].some((owned) => owned.has(key));
    if (!stillOwned) cache?.delete(key);
  }
  if (owners?.size === 0) recordOwners.delete(sourceInstallationId);
}

function clearScanOffsetForFile(sourceInstallationId: string, filePath: string): void {
  const key = `${sourceInstallationId}\0${filePath}`;
  scanOffsets.delete(key);
  fileIdentities.delete(key);
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
      recordOwners.delete(oldest);
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
  signal: AbortSignal | undefined,
): Promise<number> {
  if (maxExtensionBytes <= 0 || endOffset >= fileSize - 1) return endOffset;
  const probeLength = Math.min(fileSize - endOffset, maxExtensionBytes + 1);
  const buffer = Buffer.allocUnsafe(probeLength);
  let bytesRead = 0;
  while (bytesRead < probeLength) {
    throwIfAborted(signal);
    const result = await handle.read(
      buffer,
      bytesRead,
      probeLength - bytesRead,
      endOffset + bytesRead,
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  throwIfAborted(signal);
  if (bytesRead === 0 || buffer[0] === 10 || buffer[0] === 13) return endOffset;
  const firstLineBreak = findLineBreak(buffer, 1, bytesRead);
  return firstLineBreak === -1 ? endOffset : endOffset + firstLineBreak;
}

function findLineBreak(buffer: Buffer, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (buffer[index] === 10 || buffer[index] === 13) return index;
  }
  return -1;
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
  maxDirectories: number,
  allowedRelativeRoots: ReadonlyArray<string> | undefined,
): Promise<{
  readonly files: ReadonlyArray<string>;
  readonly failed: boolean;
  readonly truncated: boolean;
}> {
  const files: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
  let failed = false;
  let truncated = false;
  let visitedDirectories = 0;
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    if (visitedDirectories >= maxDirectories) {
      truncated = true;
      return;
    }
    if (!isAllowedPath(root, directory, allowedRelativeRoots)) return;
    visitedDirectories += 1;
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
      } else if (
        entryStat.isFile() &&
        candidate.endsWith(".jsonl") &&
        isAllowedPath(root, candidate, allowedRelativeRoots)
      ) {
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

function isAllowedPath(
  root: string,
  candidate: string,
  allowedRelativeRoots: ReadonlyArray<string> | undefined,
): boolean {
  if (allowedRelativeRoots === undefined || allowedRelativeRoots.length === 0) return true;
  const relativePath = relative(root, candidate);
  if (relativePath === "") return true;
  return allowedRelativeRoots.some(
    (allowedRoot) =>
      relativePath === allowedRoot || relativePath.startsWith(`${allowedRoot}${sep}`),
  );
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
