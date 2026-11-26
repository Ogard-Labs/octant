import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AcpAgentAuthentication,
  ProviderInstanceId,
  ProviderRateLimitWindow,
  ProviderServiceLimits,
  UtcTimestamp,
} from "@octant/contracts";
import { planUsageWindowStatus } from "@octant/domain";
import type {
  ProviderContextFactsSource,
  ProviderLimitsCaptureCapability,
  ProviderLimitsCaptureRefreshResult,
  ProviderLimitsCaptureStatus,
} from "@octant/provider-sdk/context-facts";
import { Effect } from "effect";
import { accountUsageFailure, accountWindowLimits, isRecord } from "./accountUsageEndpoint";

const MAX_FILE_BYTES = 1_048_576;
const MAX_BUCKETS = 32;
const DEFAULT_SETTINGS_SUBDIR = join(".gemini", "antigravity-cli");
const BRIDGE_SCRIPT_NAME = "antigravity-statusline-bridge.mjs";
const READING_FILE_NAME = "antigravity-statusline-reading.json";
const METADATA_FILE_NAME = "antigravity-statusline-metadata.json";
const WATCH_INTERVAL_MS = 2_000;

export interface AntigravityQuotaBucket {
  readonly id: string;
  readonly remainingFraction?: number;
  readonly remainingAmount?: number;
  readonly resetsAt?: UtcTimestamp;
}

export interface AntigravityStatusLineReading {
  readonly recordedAt: UtcTimestamp;
  readonly planTier?: string;
  readonly buckets: ReadonlyArray<AntigravityQuotaBucket>;
}

export interface AntigravityStatusLineStatus {
  readonly connected: boolean;
  readonly recordedAt?: UtcTimestamp;
  readonly planTier?: string;
}

interface BridgeMetadata {
  readonly installedCommand: string;
  readonly originalStatusLine: Record<string, unknown> | null;
  readonly addedStackWithDefault: boolean;
  readonly settingsPath: string;
}

export interface AntigravityStatusLineBridgeOptions {
  readonly dataDirectory: string;
  readonly configDirectory?: string;
  readonly nodeExecutable?: string;
  readonly homeDirectory?: string;
  readonly clock?: () => string;
}

function shellQuotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitizedPlanTier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  if (/[\0-\x1f\x7f]/u.test(trimmed)) return undefined;
  return trimmed;
}

function parseIsoTimestamp(value: unknown): UtcTimestamp | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString() as UtcTimestamp;
}

function bucketSortKey(id: string): readonly [number, number, string] {
  const lower = id.toLowerCase();
  const group = lower.startsWith("gemini")
    ? 0
    : lower.startsWith("3p") || lower.includes("claude") || lower.includes("gpt")
      ? 1
      : 2;
  const period =
    lower.includes("5h") || lower.includes("5hr")
      ? 0
      : lower.includes("day") || lower.includes("daily") || lower.includes("24h")
        ? 1
        : lower.includes("week") || lower.includes("7d")
          ? 2
          : lower.includes("month") || lower.includes("30d")
            ? 3
            : 4;
  return [group, period, lower];
}

function compareBucketIds(left: string, right: string): number {
  const a = bucketSortKey(left);
  const b = bucketSortKey(right);
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2].localeCompare(b[2]);
}

/**
 * Maps a documented Antigravity CLI `statusLine` bucket ID (such as
 * `gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly`) onto Octant's
 * `scope:window` naming convention so Provider Limits, the sidebar rail, and
 * composer meters label and order windows consistently.
 */
export function canonicalAntigravityWindowId(bucketId: string): string {
  const rawParts = bucketId
    .trim()
    .toLowerCase()
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0);
  if (rawParts.length === 0) return "quota";

  const periodMap: Readonly<Record<string, string>> = {
    "5h": "five_hour",
    "5hr": "five_hour",
    "5hours": "five_hour",
    "1h": "one_hour",
    hourly: "one_hour",
    daily: "one_day",
    day: "one_day",
    "24h": "one_day",
    weekly: "seven_day",
    week: "seven_day",
    "7d": "seven_day",
    monthly: "monthly",
    month: "monthly",
    "30d": "monthly",
  };

  const last = rawParts[rawParts.length - 1] ?? "";
  const period = periodMap[last];
  const scopeParts = period !== undefined ? rawParts.slice(0, -1) : rawParts;
  const rawScope = scopeParts.join("_");
  const normalizedScope =
    rawScope === "3p" || rawScope === "third_party" || rawScope === "claude_gpt"
      ? "claude_gpt"
      : rawScope.replaceAll(/[^a-z0-9_]+/gu, "_").replaceAll(/^_+|_+$/gu, "");

  if (period !== undefined && normalizedScope.length > 0) {
    return `${normalizedScope}:${period}`;
  }
  if (period !== undefined) return period;
  return normalizedScope.length > 0 ? normalizedScope : "quota";
}

/**
 * Parses and sanitizes Antigravity CLI's documented `statusLine` stdin payload.
 * Retains only `recordedAt`, `planTier`, and non-disabled `quota` buckets —
 * never `cwd`, conversation IDs, email, transcripts, or prompts.
 */
export function parseAntigravityStatusLinePayload(
  rawText: string,
  now: Date = new Date(),
): AntigravityStatusLineReading | undefined {
  if (Buffer.byteLength(rawText, "utf8") > MAX_FILE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const rawQuota = parsed.quota;
  if (!isRecord(rawQuota)) return undefined;
  const keys = Object.keys(rawQuota);
  if (keys.length === 0 || keys.length > MAX_BUCKETS) return undefined;

  const buckets: AntigravityQuotaBucket[] = [];
  for (const id of [...keys].sort(compareBucketIds)) {
    const raw = rawQuota[id];
    if (!isRecord(raw)) return undefined;
    if (raw.disabled === true) continue;
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || Buffer.byteLength(trimmedId, "utf8") > 128) return undefined;

    const rawFraction = raw.remaining_fraction;
    if (
      rawFraction !== undefined &&
      rawFraction !== null &&
      (typeof rawFraction !== "number" ||
        !Number.isFinite(rawFraction) ||
        rawFraction < 0 ||
        rawFraction > 1)
    ) {
      return undefined;
    }

    const rawAmount = raw.remaining_amount;
    if (
      rawAmount !== undefined &&
      rawAmount !== null &&
      (typeof rawAmount !== "number" || !Number.isFinite(rawAmount) || rawAmount < 0)
    ) {
      return undefined;
    }

    const rawResetSeconds = raw.reset_in_seconds;
    if (
      rawResetSeconds !== undefined &&
      rawResetSeconds !== null &&
      (typeof rawResetSeconds !== "number" ||
        !Number.isFinite(rawResetSeconds) ||
        rawResetSeconds < 0)
    ) {
      return undefined;
    }

    // Antigravity emits Unix epoch 0 ("1970-01-01T00:00:00Z") for untouched
    // buckets whose reset window has not started yet.
    let resetsAt: UtcTimestamp | undefined;
    const parsedResetTime = parseIsoTimestamp(raw.reset_time);
    if (parsedResetTime !== undefined) {
      resetsAt = Date.parse(parsedResetTime) > 0 ? parsedResetTime : undefined;
    } else if (typeof rawResetSeconds === "number") {
      resetsAt =
        rawResetSeconds === 0 && rawFraction === 1
          ? undefined
          : (new Date(now.getTime() + rawResetSeconds * 1000).toISOString() as UtcTimestamp);
    }

    // Go/proto3 JSON may omit a zero remaining_fraction when a bucket is exhausted.
    const remainingFraction =
      typeof rawFraction === "number"
        ? rawFraction
        : rawAmount === undefined && resetsAt !== undefined
          ? 0
          : undefined;
    const remainingAmount = typeof rawAmount === "number" ? rawAmount : undefined;
    if (remainingFraction === undefined && remainingAmount === undefined) continue;

    buckets.push({
      id: trimmedId,
      ...(remainingFraction === undefined ? {} : { remainingFraction }),
      ...(remainingAmount === undefined ? {} : { remainingAmount }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }

  if (buckets.length === 0) return undefined;
  const planTier = sanitizedPlanTier(parsed.plan_tier);
  return {
    recordedAt: now.toISOString() as UtcTimestamp,
    ...(planTier === undefined ? {} : { planTier }),
    buckets,
  };
}

export function decodeStoredAntigravityReading(
  rawText: string,
): AntigravityStatusLineReading | undefined {
  if (Buffer.byteLength(rawText, "utf8") > MAX_FILE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const recordedAt = parseIsoTimestamp(parsed.recordedAt);
  if (recordedAt === undefined || !Array.isArray(parsed.buckets)) return undefined;
  if (parsed.buckets.length === 0 || parsed.buckets.length > MAX_BUCKETS) return undefined;

  const buckets: AntigravityQuotaBucket[] = [];
  for (const item of parsed.buckets) {
    if (!isRecord(item) || typeof item.id !== "string") return undefined;
    const id = item.id.trim();
    if (id.length === 0 || Buffer.byteLength(id, "utf8") > 128) return undefined;
    const remainingFraction = item.remainingFraction;
    if (
      remainingFraction !== undefined &&
      (typeof remainingFraction !== "number" ||
        !Number.isFinite(remainingFraction) ||
        remainingFraction < 0 ||
        remainingFraction > 1)
    ) {
      return undefined;
    }
    const remainingAmount = item.remainingAmount;
    if (
      remainingAmount !== undefined &&
      (typeof remainingAmount !== "number" ||
        !Number.isFinite(remainingAmount) ||
        remainingAmount < 0)
    ) {
      return undefined;
    }
    if (remainingFraction === undefined && remainingAmount === undefined) return undefined;
    const rawReset = parseIsoTimestamp(item.resetsAt);
    const resetsAt = rawReset !== undefined && Date.parse(rawReset) > 0 ? rawReset : undefined;
    buckets.push({
      id,
      ...(remainingFraction === undefined ? {} : { remainingFraction }),
      ...(remainingAmount === undefined ? {} : { remainingAmount }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }

  const planTier = sanitizedPlanTier(parsed.planTier);
  return {
    recordedAt,
    ...(planTier === undefined ? {} : { planTier }),
    buckets,
  };
}

/**
 * Normalizes a sanitized Antigravity `statusLine` reading into Octant's
 * `ProviderServiceLimits`. Drops windows whose reset has already passed so
 * stale pre-reset readings never misstate current capacity.
 */
export function antigravityStatusLineLimits(
  instanceId: ProviderInstanceId,
  reading: AntigravityStatusLineReading,
  now: UtcTimestamp,
): ProviderServiceLimits | undefined {
  const nowMs = Date.parse(now);
  const recordedMs = Date.parse(reading.recordedAt);
  if (!Number.isFinite(recordedMs) || recordedMs > nowMs + 60_000) return undefined;

  const windows: ProviderRateLimitWindow[] = [];
  const seenWindowIds = new Set<string>();
  for (const bucket of [...reading.buckets].sort((left, right) =>
    compareBucketIds(left.id, right.id),
  )) {
    if (bucket.remainingFraction === undefined) continue;
    if (bucket.resetsAt !== undefined && Date.parse(bucket.resetsAt) <= nowMs) continue;
    const windowId = canonicalAntigravityWindowId(bucket.id);
    if (seenWindowIds.has(windowId)) continue;
    seenWindowIds.add(windowId);
    const utilization = Math.min(1, Math.max(0, 1 - bucket.remainingFraction));
    windows.push({
      window: windowId,
      status: planUsageWindowStatus(utilization),
      utilization,
      ...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt }),
      observedAt: reading.recordedAt,
    });
  }

  if (windows.length === 0) return undefined;
  return accountWindowLimits(instanceId, windows, reading.recordedAt);
}

/**
 * Self-contained ESM helper executed by Antigravity CLI's documented
 * `statusLine` hook. Sanitizes stdin to only `quota` + `plan_tier`, writes the
 * local reading atomically (0600), and forwards stdin/stdout to any previously
 * configured `statusLine.command` within 4.5s.
 */
function buildBridgeScriptSource(readingPath: string, metadataPath: string): string {
  return `#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const READING_PATH = ${JSON.stringify(readingPath)};
const METADATA_PATH = ${JSON.stringify(metadataPath)};
const MAX_BYTES = ${String(MAX_FILE_BYTES)};
const MAX_BUCKETS = ${String(MAX_BUCKETS)};

function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  try {
    const data = readFileSync(0);
    if (data.length <= MAX_BYTES) return data;
    return data.subarray(0, MAX_BYTES);
  } catch {
    return Buffer.alloc(0);
  }
}

function parseReading(rawText, now) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rawQuota = parsed.quota;
  if (!rawQuota || typeof rawQuota !== "object" || Array.isArray(rawQuota)) return null;
  const keys = Object.keys(rawQuota);
  if (keys.length === 0 || keys.length > MAX_BUCKETS) return null;
  const buckets = [];
  for (const id of keys) {
    const raw = rawQuota[id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.disabled === true) continue;
    const trimmedId = id.trim();
    if (!trimmedId || Buffer.byteLength(trimmedId, "utf8") > 128) return null;
    const rf = raw.remaining_fraction;
    if (rf !== undefined && rf !== null && (typeof rf !== "number" || !Number.isFinite(rf) || rf < 0 || rf > 1)) return null;
    const ra = raw.remaining_amount;
    if (ra !== undefined && ra !== null && (typeof ra !== "number" || !Number.isFinite(ra) || ra < 0)) return null;
    const rs = raw.reset_in_seconds;
    if (rs !== undefined && rs !== null && (typeof rs !== "number" || !Number.isFinite(rs) || rs < 0)) return null;
    let resetsAt;
    if (typeof raw.reset_time === "string" && raw.reset_time.trim().length > 0) {
      const ms = Date.parse(raw.reset_time.trim());
      if (Number.isFinite(ms) && ms > 0) resetsAt = new Date(ms).toISOString();
    } else if (typeof rs === "number") {
      if (!(rs === 0 && rf === 1)) resetsAt = new Date(now.getTime() + rs * 1000).toISOString();
    }
    const remainingFraction = typeof rf === "number" ? rf : (ra === undefined && resetsAt !== undefined ? 0 : undefined);
    const remainingAmount = typeof ra === "number" ? ra : undefined;
    if (remainingFraction === undefined && remainingAmount === undefined) continue;
    buckets.push({
      id: trimmedId,
      ...(remainingFraction === undefined ? {} : { remainingFraction }),
      ...(remainingAmount === undefined ? {} : { remainingAmount }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  if (buckets.length === 0) return null;
  const planTier = typeof parsed.plan_tier === "string" && parsed.plan_tier.trim().length > 0 && parsed.plan_tier.trim().length <= 128 && !/[\\0-\\x1f\\x7f]/.test(parsed.plan_tier.trim())
    ? parsed.plan_tier.trim()
    : undefined;
  return {
    recordedAt: now.toISOString(),
    ...(planTier === undefined ? {} : { planTier }),
    buckets,
  };
}

function originalCommand() {
  try {
    const meta = JSON.parse(readFileSync(METADATA_PATH, "utf8"));
    const orig = meta?.originalStatusLine;
    if (orig && typeof orig === "object" && orig.enabled !== false && typeof orig.command === "string" && orig.command.trim().length > 0) {
      return orig.command;
    }
  } catch {}
  return null;
}

const input = readBoundedStdin();
const reading = parseReading(input.toString("utf8"), new Date());
if (reading !== null) {
  try {
    mkdirSync(dirname(READING_PATH), { recursive: true, mode: 0o700 });
    const tmp = READING_PATH + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(reading), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, READING_PATH);
  } catch {}
}

const chained = originalCommand();
if (chained !== null) {
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", chained], { input, timeout: 4500, encoding: "buffer" })
    : spawnSync("/bin/sh", ["-c", chained], { input, timeout: 4500, encoding: "buffer" });
  if (result.stdout && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
}
`;
}

function writeAtomicPrivate(filePath: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(temp, content, { encoding: "utf8", mode });
  chmodSync(temp, mode);
  renameSync(temp, filePath);
}

function readBoundedFile(filePath: string): string {
  const info = statSync(filePath);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error("Antigravity status-line file exceeds size limit.");
  }
  return readFileSync(filePath, "utf8");
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class AntigravityStatusLineBridge {
  readonly #dataDirectory: string;
  readonly #configDirectory: string;
  readonly #nodeExecutable: string;
  readonly #clock: () => string;

  constructor(options: AntigravityStatusLineBridgeOptions) {
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#configDirectory = resolve(
      options.configDirectory ?? join(options.homeDirectory ?? homedir(), DEFAULT_SETTINGS_SUBDIR),
    );
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  get readingPath(): string {
    return join(this.#dataDirectory, READING_FILE_NAME);
  }

  get metadataPath(): string {
    return join(this.#dataDirectory, METADATA_FILE_NAME);
  }

  get scriptPath(): string {
    return join(this.#dataDirectory, BRIDGE_SCRIPT_NAME);
  }

  get settingsPath(): string {
    return join(this.#configDirectory, "settings.json");
  }

  #installedCommand(): string {
    // Packaged desktop builds run the server through the Electron executable
    // with ELECTRON_RUN_AS_NODE=1; preserve Node mode explicitly so interactive
    // `agy` executes the helper script instead of launching the desktop app.
    if (process.platform === "win32") {
      return `set ELECTRON_RUN_AS_NODE=1&& "${this.#nodeExecutable}" "${this.scriptPath}"`;
    }
    return `env ELECTRON_RUN_AS_NODE=1 ${shellQuotePosix(this.#nodeExecutable)} ${shellQuotePosix(this.scriptPath)}`;
  }

  #readMetadata(): BridgeMetadata | undefined {
    try {
      const parsed: unknown = JSON.parse(readBoundedFile(this.metadataPath));
      if (!isRecord(parsed)) return undefined;
      if (
        typeof parsed.installedCommand !== "string" ||
        typeof parsed.addedStackWithDefault !== "boolean" ||
        typeof parsed.settingsPath !== "string"
      ) {
        return undefined;
      }
      const orig = parsed.originalStatusLine;
      if (orig !== null && !isRecord(orig)) return undefined;
      return {
        installedCommand: parsed.installedCommand,
        originalStatusLine: orig === null ? null : { ...orig },
        addedStackWithDefault: parsed.addedStackWithDefault,
        settingsPath: parsed.settingsPath,
      };
    } catch {
      return undefined;
    }
  }

  readReading(): AntigravityStatusLineReading | undefined {
    try {
      return decodeStoredAntigravityReading(readBoundedFile(this.readingPath));
    } catch {
      return undefined;
    }
  }

  status(): AntigravityStatusLineStatus {
    const metadata = this.#readMetadata();
    let connected = false;
    if (metadata !== undefined) {
      try {
        const settings: unknown = JSON.parse(readBoundedFile(metadata.settingsPath));
        if (
          isRecord(settings) &&
          isRecord(settings.statusLine) &&
          settings.statusLine.command === metadata.installedCommand &&
          settings.statusLine.enabled !== false
        ) {
          connected = true;
        }
      } catch {
        connected = false;
      }
    }
    const reading = this.readReading();
    return {
      connected,
      ...(reading === undefined
        ? {}
        : {
            recordedAt: reading.recordedAt,
            ...(reading.planTier === undefined ? {} : { planTier: reading.planTier }),
          }),
    };
  }

  /**
   * Reversibly installs Octant's status-line capture command in Antigravity
   * CLI's `settings.json`, chaining any active prior `statusLine.command`
   * and preserving all unrelated keys.
   */
  connect(): AntigravityStatusLineStatus {
    mkdirSync(this.#configDirectory, { recursive: true, mode: 0o700 });
    let settings: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readBoundedFile(this.settingsPath));
      if (!isRecord(parsed)) {
        throw new Error("Antigravity CLI settings.json must be a JSON object.");
      }
      settings = { ...parsed };
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }

    const command = this.#installedCommand();
    const existingMetadata = this.#readMetadata();
    const currentStatusLine = settings.statusLine;

    if (currentStatusLine !== undefined && !isRecord(currentStatusLine)) {
      throw new Error("Antigravity CLI statusLine setting has an unsupported format.");
    }
    if (
      isRecord(currentStatusLine) &&
      currentStatusLine.type !== undefined &&
      currentStatusLine.type !== "command"
    ) {
      throw new Error("Antigravity CLI statusLine type is not supported.");
    }

    // Write the self-contained helper script before editing settings.json.
    writeAtomicPrivate(
      this.scriptPath,
      buildBridgeScriptSource(this.readingPath, this.metadataPath),
      0o700,
    );

    // Already installed: keep existing originalStatusLine metadata intact.
    if (
      existingMetadata !== undefined &&
      isRecord(currentStatusLine) &&
      currentStatusLine.command === existingMetadata.installedCommand
    ) {
      if (existingMetadata.installedCommand !== command || currentStatusLine.enabled === false) {
        const updatedMetadata: BridgeMetadata = {
          ...existingMetadata,
          installedCommand: command,
          settingsPath: this.settingsPath,
        };
        writeAtomicPrivate(this.metadataPath, JSON.stringify(updatedMetadata, null, 2), 0o600);
        const nextStatusLine: Record<string, unknown> = {
          ...currentStatusLine,
          type: "command",
          command,
          enabled: true,
        };
        settings.statusLine = nextStatusLine;
        writeAtomicPrivate(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
      }
      return this.status();
    }

    const originalStatusLine = isRecord(currentStatusLine) ? { ...currentStatusLine } : null;
    const hadActiveCommand =
      originalStatusLine !== null &&
      originalStatusLine.enabled !== false &&
      typeof originalStatusLine.command === "string" &&
      originalStatusLine.command.trim().length > 0;
    const addedStackWithDefault =
      !hadActiveCommand && originalStatusLine?.stack_with_default === undefined;

    const metadata: BridgeMetadata = {
      installedCommand: command,
      originalStatusLine,
      addedStackWithDefault,
      settingsPath: this.settingsPath,
    };
    writeAtomicPrivate(this.metadataPath, JSON.stringify(metadata, null, 2), 0o600);

    const nextStatusLine: Record<string, unknown> = {
      ...(originalStatusLine ?? {}),
      type: "command",
      command,
      enabled: true,
      ...(hadActiveCommand ? {} : { stack_with_default: true }),
    };
    settings.statusLine = nextStatusLine;
    writeAtomicPrivate(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
    return this.status();
  }

  /**
   * Reversibly removes Octant's status-line hook. Only edits `settings.json`
   * when `statusLine.command` still matches what Octant installed. Preserves
   * metadata if the config folder is temporarily inaccessible (`EACCES`).
   */
  disconnect(): { readonly restored: boolean; readonly status: AntigravityStatusLineStatus } {
    const metadata = this.#readMetadata();
    if (metadata === undefined) {
      return { restored: false, status: this.status() };
    }

    try {
      lstatSync(dirname(metadata.settingsPath));
    } catch (error) {
      if (isEnoent(error)) {
        rmSync(this.metadataPath, { force: true });
        return { restored: false, status: this.status() };
      }
      throw error;
    }

    let restored = false;
    try {
      const parsed: unknown = JSON.parse(readBoundedFile(metadata.settingsPath));
      if (
        isRecord(parsed) &&
        isRecord(parsed.statusLine) &&
        parsed.statusLine.command === metadata.installedCommand
      ) {
        const nextSettings: Record<string, unknown> = { ...parsed };
        if (metadata.originalStatusLine === null) {
          delete nextSettings.statusLine;
        } else {
          nextSettings.statusLine = { ...metadata.originalStatusLine };
        }
        writeAtomicPrivate(
          metadata.settingsPath,
          `${JSON.stringify(nextSettings, null, 2)}\n`,
          0o600,
        );
        restored = true;
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }

    rmSync(this.metadataPath, { force: true });
    return { restored, status: this.status() };
  }

  /**
   * Watches the local sanitized reading file for modification-time changes so
   * newly captured interactive `agy` snapshots surface within seconds.
   */
  watchReading(onChange: () => void, intervalMs = WATCH_INTERVAL_MS): () => void {
    let lastMtimeMs: number | undefined;
    try {
      lastMtimeMs = statSync(this.readingPath).mtimeMs;
    } catch {
      lastMtimeMs = undefined;
    }
    const timer = setInterval(() => {
      let currentMtimeMs: number | undefined;
      try {
        currentMtimeMs = statSync(this.readingPath).mtimeMs;
      } catch {
        currentMtimeMs = undefined;
      }
      if (currentMtimeMs !== undefined && currentMtimeMs !== lastMtimeMs) {
        lastMtimeMs = currentMtimeMs;
        onChange();
      }
    }, intervalMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
    };
  }

  now(): UtcTimestamp {
    return new Date(this.#clock()).toISOString() as UtcTimestamp;
  }
}

function toCaptureStatus(status: AntigravityStatusLineStatus): ProviderLimitsCaptureStatus {
  return {
    connected: status.connected,
    ...(status.recordedAt === undefined ? {} : { recordedAt: status.recordedAt }),
    ...(status.planTier === undefined ? {} : { planTier: status.planTier }),
    summary: "Antigravity CLI status line · shared Google AI quota",
    disconnectedHint:
      "Connect Antigravity CLI's official statusLine hook to read remaining quota when interactive agy runs.",
    connectedHint: "Connected · open interactive agy in a terminal to capture remaining quota.",
    connectLabel: "Connect status line",
    refreshActionLabel: "Open agy in terminal",
  };
}

export function makeAntigravityStatusLineUsageFacts(options: {
  readonly instanceId: ProviderInstanceId;
  readonly authentication?: AcpAgentAuthentication;
  readonly binaryPath?: string;
  readonly bridge: AntigravityStatusLineBridge;
  readonly clock?: () => string;
}): ProviderContextFactsSource {
  const clock = options.clock ?? (() => options.bridge.now());
  const isPersonalSignIn =
    options.authentication !== "api-key" && options.authentication !== "agent-platform";
  const limitsCapture: ProviderLimitsCaptureCapability | undefined = isPersonalSignIn
    ? {
        status: () => toCaptureStatus(options.bridge.status()),
        connect: async () => toCaptureStatus(options.bridge.connect()),
        disconnect: async () => {
          const result = options.bridge.disconnect();
          return { restored: result.restored, status: toCaptureStatus(result.status) };
        },
        triggerRefresh: async (): Promise<ProviderLimitsCaptureRefreshResult> => {
          const launched = openAntigravityInteractiveTerminal(options.binaryPath ?? "agy");
          return {
            launched: launched.opened,
            ...(launched.message === undefined ? {} : { message: launched.message }),
          };
        },
      }
    : undefined;
  return {
    observeModelLimits: () => Effect.succeed([]),
    observeServiceLimits: ({ instanceId }) => {
      if (String(instanceId) !== String(options.instanceId)) {
        return Effect.fail(
          accountUsageFailure("invalid-configuration", "Provider instance does not match."),
        );
      }
      if (!isPersonalSignIn) {
        return Effect.fail(
          accountUsageFailure(
            "unsupported",
            "Plan limits do not apply to Gemini API key or Agent Platform sign-ins.",
          ),
        );
      }
      const reading = options.bridge.readReading();
      if (reading === undefined) {
        return Effect.fail(
          accountUsageFailure(
            "unavailable",
            "No Antigravity status-line reading yet. Connect the status line and open interactive agy in a terminal.",
          ),
        );
      }
      const observedNow = new Date(clock()).toISOString() as UtcTimestamp;
      const limits = antigravityStatusLineLimits(options.instanceId, reading, observedNow);
      if (limits === undefined) {
        return Effect.fail(
          accountUsageFailure(
            "unavailable",
            "Antigravity status-line reading has expired. Open interactive agy in a terminal to refresh.",
          ),
        );
      }
      return Effect.succeed(limits);
    },
    ...(limitsCapture === undefined ? {} : { limitsCapture }),
  };
}

/**
 * Builds a self-cleaning interactive Terminal launch script for `agy` on macOS.
 * Never passes headless `-p` / `--print` flags.
 */
export function buildInteractiveAgyLaunchScript(binaryPath: string): string {
  const command =
    binaryPath.startsWith("/") && !binaryPath.includes("\0")
      ? shellQuotePosix(binaryPath)
      : `"\${SHELL:-/bin/zsh}" -lc 'exec agy'`;
  return `#!/bin/sh\nrm -f -- "$0"\nexec ${command}\n`;
}

/**
 * Opens interactive `agy` in the host's terminal so its documented `statusLine`
 * hook emits a fresh quota reading within seconds. Never runs headless `agy -p`.
 */
export function openAntigravityInteractiveTerminal(binaryPath: string): {
  readonly opened: boolean;
  readonly message?: string;
} {
  if (process.platform !== "darwin") {
    return {
      opened: false,
      message:
        "Run interactive `agy` in a terminal (or use Open Google Antigravity terminal in a thread) to capture a fresh status-line reading.",
    };
  }
  const scriptPath = join(tmpdir(), `octant-agy-${randomUUID()}.command`);
  try {
    writeFileSync(scriptPath, buildInteractiveAgyLaunchScript(binaryPath), {
      encoding: "utf8",
      mode: 0o700,
    });
    chmodSync(scriptPath, 0o700);
    const child = spawn("open", ["-a", "Terminal", scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { opened: true };
  } catch {
    try {
      unlinkSync(scriptPath);
    } catch {}
    return {
      opened: false,
      message: "Could not open Terminal. Run interactive `agy` in your terminal to refresh quota.",
    };
  }
}
