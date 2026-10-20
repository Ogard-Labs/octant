import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderInstanceId, ProviderRateLimitWindow, UtcTimestamp } from "@octant/contracts";
import type { ProviderContextFactsSource } from "@octant/provider-sdk/context-facts";
import { Effect } from "effect";
import { openReadOnlySqlite } from "../persistence/sqlitePort";
import {
  accountUsageFailure,
  accountWindowLimits,
  type AccountUsageFetch,
  isRecord,
  numberField,
  requestAccountUsage,
  resetTimestamp,
  usedPercentWindow,
} from "./accountUsageEndpoint";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GO_INTEGRATION = "opencode-go";

const CREDENTIAL_TABLE_SQL =
  "SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'credential'";
const GO_KEY_SQL = `SELECT json_extract(value, '$.key') AS key FROM credential
  WHERE integration_id = '${GO_INTEGRATION}' AND (active IS NULL OR active = 1)
  ORDER BY active DESC, time_updated DESC, id DESC LIMIT 1`;

export interface OpenCodeGoUsageOptions {
  readonly instanceId: ProviderInstanceId;
  /** OpenCode's own data directory, which its CLI writes and Octant only reads. */
  readonly dataDirectory: string;
  readonly fetch?: AccountUsageFetch;
  readonly clock?: () => string;
  readonly readDatabase?: (path: string, sql: string) => ReadonlyArray<unknown>;
}

/** Where the key was found, or why none applies. */
export type OpenCodeGoKey =
  | { readonly status: "found"; readonly key: string }
  | { readonly status: "no-plan" }
  | { readonly status: "not-signed-in" };

function readOnlyRows(path: string, sql: string): ReadonlyArray<unknown> {
  const database = openReadOnlySqlite(path);
  try {
    return database.all(sql);
  } finally {
    database.close();
  }
}

/**
 * OpenCode 2 keeps sign-ins in each release channel's database `credential`
 * table and leaves the `auth.json` it imported from behind, so that file is
 * stale once any database has the table. `opencode.db` is the default channel
 * and answers first; the others follow in name order.
 */
export async function readOpenCodeGoKey(
  dataDirectory: string,
  readDatabase: (path: string, sql: string) => ReadonlyArray<unknown> = readOnlyRows,
): Promise<OpenCodeGoKey> {
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(dataDirectory);
  } catch {
    return { status: "not-signed-in" };
  }
  const channels = names
    .filter((name) => name.startsWith("opencode") && name.endsWith(".db") && name !== "opencode.db")
    .sort();
  const databases = [...(names.includes("opencode.db") ? ["opencode.db"] : []), ...channels];
  let anyCredentialTable = false;
  for (const name of databases) {
    const path = join(dataDirectory, name);
    let present: unknown;
    try {
      present = readDatabase(path, CREDENTIAL_TABLE_SQL)[0];
    } catch {
      continue;
    }
    if (!isRecord(present) || numberField(present.present) !== 1) continue;
    anyCredentialTable = true;
    let row: unknown;
    try {
      row = readDatabase(path, GO_KEY_SQL)[0];
    } catch {
      continue;
    }
    if (isRecord(row) && typeof row.key === "string" && row.key.length > 0) {
      return { status: "found", key: row.key };
    }
    if (name === "opencode.db") return { status: "no-plan" };
  }
  if (anyCredentialTable) return { status: "no-plan" };
  let auth: unknown;
  try {
    auth = JSON.parse(await readFile(join(dataDirectory, "auth.json"), "utf8")) as unknown;
  } catch {
    return { status: "not-signed-in" };
  }
  const entry = isRecord(auth) ? auth[GO_INTEGRATION] : undefined;
  if (!isRecord(entry)) return { status: "no-plan" };
  const key = entry.key ?? entry.access ?? entry.token;
  return typeof key === "string" && key.length > 0
    ? { status: "found", key }
    : { status: "no-plan" };
}

const GO_WINDOWS = [
  ["rolling", "five_hour"],
  ["weekly", "seven_day"],
  ["monthly", "monthly"],
] as const;

/** The 5-hour, weekly, and monthly windows, each as the percent already used. */
export function openCodeGoUsageWindows(
  body: unknown,
  observedAt: UtcTimestamp,
): ReadonlyArray<ProviderRateLimitWindow> | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const windows: ProviderRateLimitWindow[] = [];
  for (const [field, window] of GO_WINDOWS) {
    const bucket = body.usage[field];
    if (bucket === undefined || bucket === null) continue;
    if (!isRecord(bucket)) return undefined;
    const used =
      numberField(bucket.used_percent) ??
      numberField(bucket.utilization) ??
      numberField(bucket.percent);
    if (used === undefined) return undefined;
    const parsed = usedPercentWindow(window, used, resetTimestamp(bucket.resetsAt), observedAt);
    if (parsed === undefined) return undefined;
    windows.push(parsed);
  }
  return windows;
}

export function makeOpenCodeGoUsageFacts(
  options: OpenCodeGoUsageOptions,
): ProviderContextFactsSource {
  const fetch = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    observeModelLimits: () => Effect.succeed([]),
    observeServiceLimits: ({ instanceId }) =>
      Effect.gen(function* () {
        if (String(instanceId) !== String(options.instanceId)) {
          return yield* Effect.fail(
            accountUsageFailure("invalid-configuration", "Provider instance does not match."),
          );
        }
        const found = yield* Effect.promise(() =>
          readOpenCodeGoKey(options.dataDirectory, options.readDatabase),
        );
        // Plan windows belong to an OpenCode Go subscription. A sign-in to
        // any other OpenCode provider has none to show.
        if (found.status === "no-plan") {
          return yield* Effect.fail(
            accountUsageFailure("unsupported", "No OpenCode Go plan is signed in."),
          );
        }
        if (found.status === "not-signed-in") {
          return yield* Effect.fail(
            accountUsageFailure("unavailable", "OpenCode is not signed in."),
          );
        }
        const body = yield* requestAccountUsage(
          fetch,
          "OpenCode Go",
          USAGE_URL,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${found.key}`, Accept: "application/json" },
          },
          () => Date.parse(clock()),
        );
        const observedAt = new Date(clock()).toISOString() as UtcTimestamp;
        const windows = openCodeGoUsageWindows(body, observedAt);
        if (windows === undefined || windows.length === 0) {
          return yield* Effect.fail(
            accountUsageFailure("protocol", "OpenCode Go returned usage Octant cannot read."),
          );
        }
        return accountWindowLimits(options.instanceId, windows, observedAt);
      }),
  };
}
