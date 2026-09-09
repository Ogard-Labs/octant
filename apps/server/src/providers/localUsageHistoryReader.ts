import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  decodeLocalUsageHistoryRecord,
  decodeLocalUsageHistoryCoverage,
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
const MAX_CACHED_RECORDS = 100_000;

/** In-process resumable cursors keep bounded refreshes progressing through long files. */
const scanOffsets = new Map<string, { readonly offset: number; readonly size: number }>();
const fileCursors = new Map<string, string>();
const fileSeen = new Map<string, Set<string>>();
/** Bounded records let a later refresh aggregate chunks already scanned this process. */
const recordCaches = new Map<string, Map<string, LocalUsageHistoryRecord>>();
const recordCacheTruncated = new Set<string>();

export interface LocalUsageHistoryReaderOptions {
  readonly sourceKind: LocalUsageHistorySourceKind;
  readonly providerKey: string;
  readonly root: string;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxRecords?: number;
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
export async function readLocalUsageHistory(
  options: LocalUsageHistoryReaderOptions,
  request: LocalUsageHistoryRequest,
  parse: LocalUsageHistoryLineParser,
  signal?: AbortSignal,
): Promise<{
  readonly records: ReadonlyArray<LocalUsageHistoryRecord>;
  readonly coverage: LocalUsageHistoryCoverage;
}> {
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
        "The provider history directory is unavailable.",
      ),
    };
  }

  const sourceInstallationId = installationId(options.sourceKind, root);
  const collected = await collectFiles(root, MAX_DISCOVERED_FILES);
  const files = collected.files;
  const previousFile = fileCursors.get(sourceInstallationId);
  const previousIndex = previousFile === undefined ? -1 : files.indexOf(previousFile);
  const startIndex =
    previousIndex < 0 || files.length === 0 ? 0 : (previousIndex + 1) % files.length;
  const rotatedFiles = files.slice(startIndex).concat(files.slice(0, startIndex));
  const selected = rotatedFiles.slice(0, maxFiles);
  const seen = fileSeen.get(sourceInstallationId) ?? new Set<string>();
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
      if (fileSize === 0) continue;
      const cursorKey = `${sourceInstallationId}\0${resolvedFilePath}`;
      const previous = scanOffsets.get(cursorKey);
      const startOffset =
        previous === undefined || fileSize < previous.size || previous.offset >= fileSize
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
          if (records.length >= maxRecords) {
            omittedRecordCount += 1;
            truncated = true;
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
        if (nextOffset >= fileSize) scanOffsets.delete(cursorKey);
        else {
          truncated = true;
          scanOffsets.set(cursorKey, { offset: nextOffset, size: fileSize });
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
  const recordCache = recordCaches.get(sourceInstallationId) ?? new Map();
  recordCaches.set(sourceInstallationId, recordCache);
  for (const record of records) {
    recordCache.set(`${record.sourceSessionId}\0${record.sourceEventId}`, record);
  }
  while (recordCache.size > MAX_CACHED_RECORDS) {
    const oldest = recordCache.keys().next().value;
    if (oldest === undefined) break;
    recordCache.delete(oldest);
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
      failed
        ? "Some provider history files could not be read."
        : truncated
          ? "Bounded provider history scan is partial; the next refresh resumes its cursor."
          : "Provider accounting history was scanned.",
      range,
    ),
  };
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
    ...(range.from === undefined ? {} : { coveredFrom: range.from }),
    ...(range.to === undefined ? {} : { coveredTo: range.to }),
    truncated,
    detail,
  });
}
