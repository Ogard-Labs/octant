import {
  CodeProjectPullRequestFreshness,
  UtcTimestamp,
  decodeCodeProjectPullRequestRow,
  type CodeProjectPullRequestRow,
  type CodeProjectPullRequestFreshness as PullRequestFreshness,
} from "@octant/contracts";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_FRESHNESS_ENTRIES = 1_000;
const decodeFreshness = Schema.decodeUnknownSync(CodeProjectPullRequestFreshness);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface StoredCodeProjectPullRequestSnapshot {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly lastSuccessfulRefreshAt: string;
  readonly repositoriesTruncated: boolean;
  readonly pullRequestsTruncated: boolean;
  readonly freshness: PullRequestFreshness;
  readonly projectFreshness: ReadonlyArray<{
    readonly key: string;
    readonly freshness: PullRequestFreshness;
  }>;
}

/** Private, bounded cache for GitHub observations; polling never enters the journal. */
export class CodeProjectPullRequestSnapshotStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(): StoredCodeProjectPullRequestSnapshot | undefined {
    try {
      const bytes = readFileSync(this.#path);
      if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return undefined;
      return decodeSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
      return undefined;
    }
  }

  save(snapshot: StoredCodeProjectPullRequestSnapshot): void {
    const validated = decodeSnapshot({ version: 1, ...snapshot });
    const payload = `${JSON.stringify({ version: 1, ...validated })}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new Error("Pull-request snapshot exceeds its private cache bound.");
    }
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.#path);
  }

  clear(): void {
    rmSync(this.#path, { force: true });
  }
}

function decodeSnapshot(value: unknown): StoredCodeProjectPullRequestSnapshot {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid pull-request snapshot.");
  const allowed = new Set([
    "version",
    "rows",
    "lastSuccessfulRefreshAt",
    "repositoriesTruncated",
    "pullRequestsTruncated",
    "freshness",
    "projectFreshness",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Invalid pull-request snapshot.");
  }
  if (
    !Array.isArray(value.rows) ||
    typeof value.lastSuccessfulRefreshAt !== "string" ||
    typeof value.repositoriesTruncated !== "boolean" ||
    typeof value.pullRequestsTruncated !== "boolean" ||
    !Array.isArray(value.projectFreshness) ||
    value.projectFreshness.length > MAX_PROJECT_FRESHNESS_ENTRIES
  ) {
    throw new Error("Invalid pull-request snapshot.");
  }
  const projectFreshness = value.projectFreshness.map((entry) => {
    if (!isRecord(entry) || typeof entry.key !== "string" || entry.key.length > 1_024) {
      throw new Error("Invalid pull-request snapshot.");
    }
    return { key: entry.key, freshness: decodeFreshness(entry.freshness) };
  });
  if (new Set(projectFreshness.map((entry) => entry.key)).size !== projectFreshness.length) {
    throw new Error("Invalid pull-request snapshot.");
  }
  return {
    rows: value.rows.map((row) => decodeCodeProjectPullRequestRow(row)),
    lastSuccessfulRefreshAt: decodeTimestamp(value.lastSuccessfulRefreshAt),
    repositoriesTruncated: value.repositoriesTruncated,
    pullRequestsTruncated: value.pullRequestsTruncated,
    freshness: decodeFreshness(value.freshness),
    projectFreshness,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
