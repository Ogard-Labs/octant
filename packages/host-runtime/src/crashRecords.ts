import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactHostRuntimeText } from "./redaction";

/**
 * Local crash records: one small owner-only JSON file per unexpected host
 * exit, kept in the host's data directory. They stay on this machine and
 * leave it only inside a support bundle the person saves themselves.
 *
 * The record is written by the process that watched the host die (the
 * desktop app), so a host that crashed hard still gets one. Every text is
 * redacted on write: secrets go, and the home folder becomes `~`.
 */
export type HostCrashProcess = "host";

export interface HostCrashRecord {
  readonly recordedAt: string;
  readonly process: HostCrashProcess;
  /** `exit code 1`, `signal SIGKILL`, or the host's own refusal category. */
  readonly exitReason: string;
  readonly lastLines: ReadonlyArray<string>;
}

export type HostCrashRecordOutcome =
  | { readonly status: "recorded" }
  | { readonly status: "failed"; readonly reason: string };

/** Newest records kept; older ones are removed when a new one is written. */
export const HOST_CRASH_RECORD_LIMIT = 20;
export const HOST_CRASH_RECORD_LINE_LIMIT = 20;
const LINE_CHARACTER_LIMIT = 400;
const REASON_CHARACTER_LIMIT = 120;
const RECORD_FILE = /^crash-[0-9TZ-]+-[0-9a-f-]{36}\.json$/;

export function hostCrashRecordsDirectory(dataDirectory: string): string {
  return join(dataDirectory, "crash-records");
}

function sweep(text: string, homeDirectory: string | undefined, limit: number): string {
  const home = homeDirectory?.replace(/\/+$/, "");
  const local = home === undefined || home.length < 2 ? text : text.split(home).join("~");
  // Redact the whole line before cutting it, so a cut cannot strip the
  // `token=` prefix the redaction recognizes a value by.
  return redactHostRuntimeText(local).slice(0, limit);
}

export async function recordHostCrash(
  dataDirectory: string,
  input: {
    readonly recordedAt: string;
    readonly process: HostCrashProcess;
    readonly exitReason: string;
    readonly lastLines: ReadonlyArray<string>;
    readonly homeDirectory?: string;
  },
): Promise<HostCrashRecordOutcome> {
  const record: HostCrashRecord = {
    recordedAt: input.recordedAt,
    process: input.process,
    exitReason: sweep(input.exitReason, input.homeDirectory, REASON_CHARACTER_LIMIT),
    lastLines: input.lastLines
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(-HOST_CRASH_RECORD_LINE_LIMIT)
      .map((line) => sweep(line, input.homeDirectory, LINE_CHARACTER_LIMIT)),
  };
  const directory = hostCrashRecordsDirectory(dataDirectory);
  const stamp = input.recordedAt.replace(/[^0-9TZ]/g, "-");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, `crash-${stamp}-${randomUUID()}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const names = (await readdir(directory)).filter((name) => RECORD_FILE.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - HOST_CRASH_RECORD_LIMIT))) {
      await rm(join(directory, name), { force: true });
    }
    return { status: "recorded" };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? redactHostRuntimeText(error.message) : "unknown",
    };
  }
}

/**
 * What a host starting after an unclean exit keeps. A watching desktop may
 * already have written a richer record for the same exit (any record at or
 * after the dead process's last reading); that one is reused. Otherwise the
 * host writes its own, which is the only record a background-service host or
 * an unwatched native host ever gets: no process saw it die.
 */
export async function keepUncleanStopCrashRecord(
  dataDirectory: string,
  input: {
    readonly lastSeenAt: string;
    readonly recordedAt: string;
    readonly lastLines: ReadonlyArray<string>;
    readonly homeDirectory?: string;
  },
): Promise<HostCrashRecord | undefined> {
  const existing = (await readHostCrashRecords(dataDirectory)).find(
    (record) => record.recordedAt >= input.lastSeenAt,
  );
  if (existing !== undefined) return existing;
  const outcome = await recordHostCrash(dataDirectory, {
    recordedAt: input.recordedAt,
    process: "host",
    exitReason: "stopped without a clean exit",
    lastLines: input.lastLines,
    ...(input.homeDirectory === undefined ? {} : { homeDirectory: input.homeDirectory }),
  });
  if (outcome.status === "failed") return undefined;
  return (await readHostCrashRecords(dataDirectory)).find(
    (record) => record.recordedAt === input.recordedAt,
  );
}

function decodeRecord(value: unknown): HostCrashRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.recordedAt !== "string" || record.process !== "host") return undefined;
  if (typeof record.exitReason !== "string" || !Array.isArray(record.lastLines)) return undefined;
  const lastLines = record.lastLines.filter((line): line is string => typeof line === "string");
  return {
    recordedAt: record.recordedAt,
    process: "host",
    exitReason: record.exitReason,
    lastLines,
  };
}

/** Newest first. A missing folder or an unreadable file reads as no record. */
export async function readHostCrashRecords(
  dataDirectory: string,
): Promise<ReadonlyArray<HostCrashRecord>> {
  const directory = hostCrashRecordsDirectory(dataDirectory);
  let names: ReadonlyArray<string>;
  try {
    names = (await readdir(directory)).filter((name) => RECORD_FILE.test(name));
  } catch {
    return [];
  }
  const records: HostCrashRecord[] = [];
  for (const name of [...names].sort().reverse().slice(0, HOST_CRASH_RECORD_LIMIT)) {
    try {
      const record = decodeRecord(JSON.parse(await readFile(join(directory, name), "utf8")));
      if (record !== undefined) records.push(record);
    } catch {
      // A half-written or foreign file is skipped, not reported as a crash.
    }
  }
  return records;
}
