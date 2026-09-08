import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
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
const DEFAULT_MAX_RECORDS = 20_000;

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
  const sourceInstallationId = installationId(options.sourceKind, options.root);
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
        sourceInstallationId,
        "unavailable",
        0,
        0,
        0,
        false,
        "The provider history directory is unavailable.",
      ),
    };
  }

  const files = await collectFiles(root, maxFiles + 1);
  const truncated = files.length > maxFiles;
  const selected = files.slice(0, maxFiles);
  const records: LocalUsageHistoryRecord[] = [];
  let scannedFileCount = 0;
  let omittedRecordCount = truncated ? 1 : 0;
  let scannedBytes = 0;
  let failed = false;
  for (const filePath of selected) {
    let fileSize: number;
    try {
      fileSize = (await stat(filePath)).size;
    } catch {
      omittedRecordCount += 1;
      failed = true;
      continue;
    }
    if (
      !Number.isSafeInteger(fileSize) ||
      fileSize > maxFileBytes ||
      scannedBytes + fileSize > maxTotalBytes
    ) {
      omittedRecordCount += 1;
      failed = true;
      continue;
    }
    scannedBytes += fileSize;
    scannedFileCount += 1;
    const relativePath = relative(root, filePath);
    const sessionHint = sessionHintForPath(relativePath);
    let lineNumber = 0;
    try {
      const stream = createReadStream(filePath, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        lineNumber += 1;
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
          break;
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
          const from = Date.parse(String(request.from));
          const to = Date.parse(String(request.to));
          if (observedAt < from || observedAt > to) continue;
          records.push(decodeLocalUsageHistoryRecord(record));
        } catch {
          omittedRecordCount += 1;
        }
      }
      lines.close();
    } catch {
      omittedRecordCount += 1;
      failed = true;
    }
  }
  const status = failed ? "failed" : omittedRecordCount > 0 ? "partial" : "ready";
  const range = records.reduce<{ from?: string; to?: string }>(
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
    records,
    coverage: coverage(
      options,
      sourceInstallationId,
      status,
      scannedFileCount,
      records.length,
      omittedRecordCount,
      truncated,
      failed
        ? "Some provider history files could not be read."
        : "Provider accounting history was scanned.",
      range,
    ),
  };
}

async function collectFiles(root: string, limit: number): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const candidate = join(directory, entry.name);
      let entryStat;
      try {
        entryStat = await lstat(candidate);
      } catch {
        continue;
      }
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        await visit(candidate);
      } else if (entryStat.isFile() && candidate.endsWith(".jsonl")) {
        files.push(candidate);
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
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
