import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ProviderProjectFolderDiscoveryContext,
  ProviderProjectFolderDiscoveryPort,
  ProviderProjectFolderDiscoveryResult,
} from "@octant/provider-sdk";
import { openReadOnlySqlite } from "../persistence/sqlitePort";

const SESSION_HEAD_BYTES = 64 * 1024;
const OPENCODE_JSON_MAX_BYTES = 256 * 1024;
const DATE_SEGMENT = /^\d{2,4}$/;
const CODEX_ROLLOUT_FILE = /^rollout-.+\.jsonl$/;

/**
 * Built-in read-only folder discovery adapter for Claude Code homes
 * (`~/.claude`, `CLAUDE_CONFIG_DIR`, `~/.claude-accounts/*`, and registered
 * Claude instance `configDirectory` folders).
 */
export const claudeProjectFolderDiscoveryPort: ProviderProjectFolderDiscoveryPort = {
  providerId: "claude",
  discoverFolders: async (context): Promise<ProviderProjectFolderDiscoveryResult> => {
    const rawHomes: string[] = [join(context.homeDirectory, ".claude")];
    if (isAbsoluteNonEmpty(context.env.CLAUDE_CONFIG_DIR)) {
      rawHomes.push(context.env.CLAUDE_CONFIG_DIR);
    }
    rawHomes.push(...(await listSubdirectories(join(context.homeDirectory, ".claude-accounts"))));
    for (const instance of context.providerInstances) {
      if (
        instance.driverKind === "claude" &&
        isAbsoluteNonEmpty(instance.configuration.configDirectory)
      ) {
        rawHomes.push(instance.configuration.configDirectory);
      }
    }

    const homes = await uniqueExistingDirectories(rawHomes);
    for (const claudeHome of homes) {
      if (context.isCancelled()) return { status: "cancelled" };
      const projectsDir = join(claudeHome, "projects");
      const folders = await safeReaddirWithTypes(projectsDir);
      for (const folder of folders) {
        if (context.isCancelled()) return { status: "cancelled" };
        if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
        const folderPath = join(projectsDir, folder.name);
        const entries = await safeReaddirWithTypes(folderPath);
        for (const entry of entries) {
          if (context.isCancelled()) return { status: "cancelled" };
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
          if (!context.consumeItemBudget()) {
            return { status: "stopped", reason: "file-limit" };
          }
          const filePath = join(folderPath, entry.name);
          const read = await readFileHead(filePath, SESSION_HEAD_BYTES);
          if (read === undefined) continue;
          const cwd = extractClaudeCwd(read.text);
          if (cwd === undefined) continue;
          const sessionKey = entry.name.slice(0, -".jsonl".length);
          if (
            !context.observe({
              workingDirectory: cwd,
              sessionKey,
              lastActivityMs: read.mtimeMs,
            })
          ) {
            return { status: "stopped", reason: "entry-limit" };
          }
        }
      }
    }
    return { status: "completed" };
  },
};

/**
 * Built-in read-only folder discovery adapter for Codex homes (`~/.codex`,
 * `CODEX_HOME`, `~/.codex-accounts/*`, and registered Codex instance
 * `codexHome` folders), reading both active `sessions` and `archived_sessions`.
 */
export const codexProjectFolderDiscoveryPort: ProviderProjectFolderDiscoveryPort = {
  providerId: "codex",
  discoverFolders: async (context): Promise<ProviderProjectFolderDiscoveryResult> => {
    const rawHomes: string[] = [join(context.homeDirectory, ".codex")];
    if (isAbsoluteNonEmpty(context.env.CODEX_HOME)) {
      rawHomes.push(context.env.CODEX_HOME);
    }
    rawHomes.push(...(await listSubdirectories(join(context.homeDirectory, ".codex-accounts"))));
    for (const instance of context.providerInstances) {
      if (instance.driverKind === "codex" && isAbsoluteNonEmpty(instance.configuration.codexHome)) {
        rawHomes.push(instance.configuration.codexHome);
      }
    }

    let stoppedReason: "file-limit" | "entry-limit" | undefined;
    const visitRollout = async (filePath: string, fileName: string): Promise<boolean> => {
      if (context.isCancelled()) return false;
      if (!context.consumeItemBudget()) {
        stoppedReason = "file-limit";
        return false;
      }
      const read = await readFileHead(filePath, SESSION_HEAD_BYTES);
      if (read === undefined) return true;
      const meta = extractCodexMeta(read.text);
      if (meta === undefined) return true;
      const lastActivityMs = Math.max(read.mtimeMs, meta.timestampMs ?? 0);
      const keepGoing = context.observe({
        workingDirectory: meta.cwd,
        sessionKey: meta.sessionId ?? fileName,
        lastActivityMs,
      });
      if (!keepGoing) stoppedReason = "entry-limit";
      return keepGoing;
    };

    const homes = await uniqueExistingDirectories(rawHomes);
    for (const codexHome of homes) {
      if (context.isCancelled()) return { status: "cancelled" };
      const keepGoingSessions = await walkCodexDateTree(
        join(codexHome, "sessions"),
        0,
        context,
        visitRollout,
      );
      if (!keepGoingSessions) {
        return stoppedReason === undefined
          ? { status: "cancelled" }
          : { status: "stopped", reason: stoppedReason };
      }
      if (context.isCancelled()) return { status: "cancelled" };
      const keepGoingArchive = await walkCodexArchiveTree(
        join(codexHome, "archived_sessions"),
        0,
        context,
        visitRollout,
      );
      if (!keepGoingArchive) {
        return stoppedReason === undefined
          ? { status: "cancelled" }
          : { status: "stopped", reason: stoppedReason };
      }
    }
    return context.isCancelled() ? { status: "cancelled" } : { status: "completed" };
  },
};

/**
 * Built-in read-only folder discovery adapter for OpenCode data directories
 * (`OPENCODE_DATA`, `$XDG_DATA_HOME/opencode`, `$LOCALAPPDATA/opencode`,
 * `~/.local/share/opencode`), reading SQLite session databases and legacy JSON.
 */
export const opencodeProjectFolderDiscoveryPort: ProviderProjectFolderDiscoveryPort = {
  providerId: "opencode",
  discoverFolders: async (context): Promise<ProviderProjectFolderDiscoveryResult> => {
    const rawHomes: string[] = [];
    if (isAbsoluteNonEmpty(context.env.OPENCODE_DATA)) {
      rawHomes.push(context.env.OPENCODE_DATA);
    }
    if (isAbsoluteNonEmpty(context.env.XDG_DATA_HOME)) {
      rawHomes.push(join(context.env.XDG_DATA_HOME, "opencode"));
    }
    if (isAbsoluteNonEmpty(context.env.LOCALAPPDATA)) {
      rawHomes.push(join(context.env.LOCALAPPDATA, "opencode"));
    }
    rawHomes.push(join(context.homeDirectory, ".local", "share", "opencode"));

    const homes = await uniqueExistingDirectories(rawHomes);
    for (const dataDir of homes) {
      if (context.isCancelled()) return { status: "cancelled" };
      const names = await safeReaddir(dataDir);
      const channelDbs = names
        .filter(
          (name) => name.startsWith("opencode") && name.endsWith(".db") && name !== "opencode.db",
        )
        .sort();
      const dbNames = [...(names.includes("opencode.db") ? ["opencode.db"] : []), ...channelDbs];
      for (const dbName of dbNames) {
        if (context.isCancelled()) return { status: "cancelled" };
        const dbPath = join(dataDir, dbName);
        if (!(await isRegularFile(dbPath))) continue;
        const sqliteResult = scanOpenCodeSqlite(dbPath, context);
        if (sqliteResult.status !== "completed") return sqliteResult;
      }

      if (context.isCancelled()) return { status: "cancelled" };
      const legacyResult = await scanOpenCodeLegacyJson(
        join(dataDir, "storage", "session"),
        context,
      );
      if (legacyResult.status !== "completed") return legacyResult;
    }
    return context.isCancelled() ? { status: "cancelled" } : { status: "completed" };
  },
};

/**
 * Built-in read-only folder discovery adapter for Pi session directories
 * (`PI_CODING_AGENT_SESSION_DIR`, `$PI_CODING_AGENT_DIR/sessions`,
 * `~/.pi/agent/sessions`).
 */
export const piProjectFolderDiscoveryPort: ProviderProjectFolderDiscoveryPort = {
  providerId: "pi",
  discoverFolders: async (context): Promise<ProviderProjectFolderDiscoveryResult> => {
    const rawDirs: string[] = [];
    if (isAbsoluteNonEmpty(context.env.PI_CODING_AGENT_SESSION_DIR)) {
      rawDirs.push(context.env.PI_CODING_AGENT_SESSION_DIR);
    }
    if (isAbsoluteNonEmpty(context.env.PI_CODING_AGENT_DIR)) {
      rawDirs.push(join(context.env.PI_CODING_AGENT_DIR, "sessions"));
    }
    rawDirs.push(join(context.homeDirectory, ".pi", "agent", "sessions"));

    const sessionDirs = await uniqueExistingDirectories(rawDirs);
    for (const sessionsDir of sessionDirs) {
      if (context.isCancelled()) return { status: "cancelled" };
      const folders = await safeReaddirWithTypes(sessionsDir);
      for (const folder of folders) {
        if (context.isCancelled()) return { status: "cancelled" };
        if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
        const folderPath = join(sessionsDir, folder.name);
        const entries = await safeReaddirWithTypes(folderPath);
        for (const entry of entries) {
          if (context.isCancelled()) return { status: "cancelled" };
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
          if (!context.consumeItemBudget()) {
            return { status: "stopped", reason: "file-limit" };
          }
          const filePath = join(folderPath, entry.name);
          const read = await readFileHead(filePath, SESSION_HEAD_BYTES);
          if (read === undefined) continue;
          const header = extractPiHeader(read.text);
          if (header === undefined) continue;
          const lastActivityMs = Math.max(read.mtimeMs, header.timestampMs ?? 0);
          if (
            !context.observe({
              workingDirectory: header.cwd,
              sessionKey: header.id,
              lastActivityMs,
            })
          ) {
            return { status: "stopped", reason: "entry-limit" };
          }
        }
      }
    }
    return { status: "completed" };
  },
};

export const BUILTIN_PROVIDER_FOLDER_DISCOVERY_PORTS: ReadonlyArray<ProviderProjectFolderDiscoveryPort> =
  [
    claudeProjectFolderDiscoveryPort,
    codexProjectFolderDiscoveryPort,
    opencodeProjectFolderDiscoveryPort,
    piProjectFolderDiscoveryPort,
  ];

async function walkCodexDateTree(
  directory: string,
  depth: number,
  context: ProviderProjectFolderDiscoveryContext,
  visit: (filePath: string, fileName: string) => Promise<boolean>,
): Promise<boolean> {
  if (context.isCancelled()) return false;
  const entries = await safeReaddirWithTypes(directory);
  if (depth < 3) {
    const dirs = entries
      .filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink() && DATE_SEGMENT.test(entry.name),
      )
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const dir of dirs) {
      if (context.isCancelled()) return false;
      const keepGoing = await walkCodexDateTree(
        join(directory, dir.name),
        depth + 1,
        context,
        visit,
      );
      if (!keepGoing) return false;
    }
    return true;
  }
  const files = entries
    .filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink() && CODEX_ROLLOUT_FILE.test(entry.name),
    )
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const file of files) {
    if (context.isCancelled()) return false;
    const keepGoing = await visit(join(directory, file.name), file.name);
    if (!keepGoing) return false;
  }
  return true;
}

/**
 * Walks Codex's `archived_sessions` folder, which may hold flat `rollout-*.jsonl`
 * files or dated subdirectories up to depth 3, newest first.
 */
async function walkCodexArchiveTree(
  directory: string,
  depth: number,
  context: ProviderProjectFolderDiscoveryContext,
  visit: (filePath: string, fileName: string) => Promise<boolean>,
): Promise<boolean> {
  if (context.isCancelled()) return false;
  const entries = await safeReaddirWithTypes(directory);
  const files = entries
    .filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink() && CODEX_ROLLOUT_FILE.test(entry.name),
    )
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const file of files) {
    if (context.isCancelled()) return false;
    const keepGoing = await visit(join(directory, file.name), file.name);
    if (!keepGoing) return false;
  }
  if (depth >= 3) return true;
  const dirs = entries
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && DATE_SEGMENT.test(entry.name),
    )
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const dir of dirs) {
    if (context.isCancelled()) return false;
    const keepGoing = await walkCodexArchiveTree(
      join(directory, dir.name),
      depth + 1,
      context,
      visit,
    );
    if (!keepGoing) return false;
  }
  return true;
}

function scanOpenCodeSqlite(
  dbPath: string,
  context: ProviderProjectFolderDiscoveryContext,
): ProviderProjectFolderDiscoveryResult {
  if (context.isCancelled()) return { status: "cancelled" };
  // Use `remaining + 1` even when `remaining === 0` (`LIMIT 1`) so an unread
  // session row triggers `consumeItemBudget()` and records `file-limit` rather
  // than silently reporting a complete scan.
  const limit = Math.max(0, context.remainingItemBudget()) + 1;
  let db;
  try {
    db = openReadOnlySqlite(dbPath);
  } catch {
    return { status: "completed" };
  }
  try {
    const tableRow = db.all(
      "SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'session'",
    )[0];
    if (!isRecord(tableRow) || tableRow.present !== 1) return { status: "completed" };

    const columns = new Set(
      db
        .all("PRAGMA table_info(session)")
        .filter(isRecord)
        .map((row) => (typeof row.name === "string" ? row.name : "")),
    );
    if (!columns.has("directory")) return { status: "completed" };

    const selectCols = [
      columns.has("id") ? "id" : "rowid AS id",
      "directory",
      columns.has("time_updated") ? "time_updated" : "NULL AS time_updated",
      columns.has("time_created") ? "time_created" : "NULL AS time_created",
    ];
    const whereClauses = ["directory IS NOT NULL", "directory != ''"];
    if (columns.has("parent_id")) {
      whereClauses.push("(parent_id IS NULL OR parent_id = '')");
    }
    const orderClause = columns.has("time_updated") ? "ORDER BY time_updated DESC" : "";
    const rows = db.all(
      `SELECT ${selectCols.join(", ")} FROM session WHERE ${whereClauses.join(" AND ")} ${orderClause} LIMIT ${String(limit)}`,
    );

    let rowIndex = 0;
    for (const row of rows) {
      rowIndex += 1;
      if (context.isCancelled()) return { status: "cancelled" };
      if (!isRecord(row) || typeof row.directory !== "string") continue;
      if (!context.consumeItemBudget()) {
        return { status: "stopped", reason: "file-limit" };
      }
      const id =
        typeof row.id === "string" || typeof row.id === "number"
          ? String(row.id)
          : `${dbPath}:${String(rowIndex)}`;
      const updatedMs =
        normalizeEpochMs(row.time_updated) ?? normalizeEpochMs(row.time_created) ?? 0;
      if (
        !context.observe({
          workingDirectory: row.directory,
          sessionKey: id,
          lastActivityMs: updatedMs,
        })
      ) {
        return { status: "stopped", reason: "entry-limit" };
      }
    }
    return { status: "completed" };
  } catch {
    // An unreadable or locked third-party database is skipped read-only.
    return { status: "completed" };
  } finally {
    db.close();
  }
}

async function scanOpenCodeLegacyJson(
  sessionsRoot: string,
  context: ProviderProjectFolderDiscoveryContext,
): Promise<ProviderProjectFolderDiscoveryResult> {
  const top = await safeReaddirWithTypes(sessionsRoot);
  for (const entry of top) {
    if (context.isCancelled()) return { status: "cancelled" };
    if (entry.isSymbolicLink()) continue;
    const entryPath = join(sessionsRoot, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      if (!context.consumeItemBudget()) {
        return { status: "stopped", reason: "file-limit" };
      }
      const parsed = await readOpenCodeJsonSession(entryPath);
      if (
        parsed !== undefined &&
        !context.observe({
          workingDirectory: parsed.cwd,
          sessionKey: parsed.id,
          lastActivityMs: parsed.activityMs,
        })
      ) {
        return { status: "stopped", reason: "entry-limit" };
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    const nested = await safeReaddirWithTypes(entryPath);
    for (const file of nested) {
      if (context.isCancelled()) return { status: "cancelled" };
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".json")) continue;
      if (!context.consumeItemBudget()) {
        return { status: "stopped", reason: "file-limit" };
      }
      const parsed = await readOpenCodeJsonSession(join(entryPath, file.name));
      if (
        parsed !== undefined &&
        !context.observe({
          workingDirectory: parsed.cwd,
          sessionKey: parsed.id,
          lastActivityMs: parsed.activityMs,
        })
      ) {
        return { status: "stopped", reason: "entry-limit" };
      }
    }
  }
  return { status: "completed" };
}

async function readOpenCodeJsonSession(
  filePath: string,
): Promise<{ readonly id: string; readonly cwd: string; readonly activityMs: number } | undefined> {
  const read = await readSmallFile(filePath, OPENCODE_JSON_MAX_BYTES);
  if (read === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(read.text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.parentID !== undefined || value.parentId !== undefined) return undefined;
  if (typeof value.directory !== "string" || !isAbsolute(value.directory)) return undefined;
  const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : filePath;
  const time = isRecord(value.time) ? value.time : undefined;
  const activityMs =
    normalizeEpochMs(time?.updated) ??
    normalizeEpochMs(value.updated) ??
    normalizeEpochMs(time?.created) ??
    read.mtimeMs;
  return { id, cwd: value.directory, activityMs };
}

function extractClaudeCwd(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.isSidechain === true) continue;
    if (typeof record.cwd === "string" && isAbsolute(record.cwd)) {
      return record.cwd;
    }
  }
  return undefined;
}

function extractCodexMeta(
  text: string,
):
  | { readonly cwd: string; readonly sessionId?: string; readonly timestampMs?: number }
  | undefined {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "session_meta" || !isRecord(record.payload)) continue;
    const payload = record.payload;
    if (typeof payload.parentThreadId === "string" && payload.parentThreadId !== "")
      return undefined;
    if (payload.source === "subagent") return undefined;
    if (typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) return undefined;
    const sessionId = typeof payload.id === "string" && payload.id !== "" ? payload.id : undefined;
    const timestampMs =
      typeof payload.timestamp === "string" ? parseIsoMs(payload.timestamp) : undefined;
    return {
      cwd: payload.cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(timestampMs === undefined ? {} : { timestampMs }),
    };
  }
  return undefined;
}

function extractPiHeader(
  text: string,
): { readonly id: string; readonly cwd: string; readonly timestampMs?: number } | undefined {
  const firstLine = text.split("\n")[0];
  if (firstLine === undefined || firstLine.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(firstLine) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    value.type !== "session" ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd)
  ) {
    return undefined;
  }
  const timestampMs = typeof value.timestamp === "string" ? parseIsoMs(value.timestamp) : undefined;
  return {
    id: value.id,
    cwd: value.cwd,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
}

async function readFileHead(
  path: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function readSmallFile(
  path: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function listSubdirectories(parentDir: string): Promise<ReadonlyArray<string>> {
  const entries = await safeReaddirWithTypes(parentDir);
  return entries
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."),
    )
    .map((entry) => join(parentDir, entry.name))
    .sort();
}

async function uniqueExistingDirectories(
  candidates: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const candidate of candidates) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
      const info = await stat(canonical);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    directories.push(canonical);
  }
  return directories;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function safeReaddir(path: string): Promise<ReadonlyArray<string>> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function safeReaddirWithTypes(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isAbsoluteNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && isAbsolute(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string") return parseIsoMs(value);
  return undefined;
}
