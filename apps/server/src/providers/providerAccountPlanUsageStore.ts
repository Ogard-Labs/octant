import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  decodeProviderServiceLimits,
  ProviderRateLimitWindow,
  UtcTimestamp,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderServiceLimits,
} from "@octant/contracts";
import { Either, Schema } from "effect";
import { accountPlanUsageKey, type ProviderPlanUsageSource } from "@octant/domain";
import { canonicalRateLimitWindowId } from "./rateLimitWindowIdentity";

const SCHEMA_VERSION = 1;
const MAX_ACCOUNTS = 128;
const MAX_WINDOWS = 32;

interface PersistedSnapshot {
  readonly instanceId: string;
  readonly stateDirectory: string;
  readonly available: boolean;
  readonly source: ProviderPlanUsageSource;
  readonly observedAt: UtcTimestamp;
  readonly windows: ReadonlyArray<ProviderRateLimitWindow>;
}

interface PersistedFile {
  readonly version: typeof SCHEMA_VERSION;
  readonly entries: ReadonlyArray<PersistedSnapshot>;
}

/**
 * Latest plan-usage snapshot per account, keyed by instance and the state
 * directory that session ran under. Lives in Octant's host data directory.
 * The file holds only normalized windows — never tokens or credential paths.
 */
export class ProviderAccountPlanUsageStore {
  readonly #filePath: string;
  readonly #entries = new Map<string, PersistedSnapshot>();
  #loaded = false;
  #persistTail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const file = parsed as Partial<PersistedFile>;
    if (file.version !== SCHEMA_VERSION || !Array.isArray(file.entries)) return;
    for (const candidate of file.entries) {
      const entry = readSnapshot(candidate);
      if (entry === undefined) continue;
      this.#entries.set(
        accountPlanUsageKey({
          instanceId: entry.instanceId,
          stateDirectory: entry.stateDirectory,
        }),
        entry,
      );
      if (this.#entries.size >= MAX_ACCOUNTS) break;
    }
  }

  /** Drops every snapshot of an account that no longer exists. */
  async forget(instanceId: ProviderInstanceId): Promise<void> {
    await this.load();
    let forgotten = false;
    for (const [key, entry] of this.#entries) {
      if (entry.instanceId !== String(instanceId)) continue;
      this.#entries.delete(key);
      forgotten = true;
    }
    if (forgotten) await this.#persist();
  }

  snapshot(instanceId: ProviderInstanceId, stateDirectory: string): PersistedSnapshot | undefined {
    return this.#entries.get(
      accountPlanUsageKey({ instanceId: String(instanceId), stateDirectory }),
    );
  }

  serviceLimits(
    instanceId: ProviderInstanceId,
    stateDirectory: string,
    now: UtcTimestamp,
  ): ProviderServiceLimits | undefined {
    const snapshot = this.snapshot(instanceId, stateDirectory);
    if (snapshot === undefined || !snapshot.available || snapshot.windows.length === 0) {
      return undefined;
    }
    const windows = snapshot.windows.filter(
      (window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > Date.parse(now),
    );
    if (windows.length === 0) return undefined;
    return decodeProviderServiceLimits({
      providerInstanceId: instanceId,
      scope: "account",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: windows.some((window) => window.status === "exhausted") ? "exhausted" : "available",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: snapshot.observedAt,
      rateLimitWindows: windows,
    });
  }

  async replace(input: {
    readonly instanceId: ProviderInstanceId;
    readonly stateDirectory: string;
    readonly source: ProviderPlanUsageSource;
    readonly observedAt: UtcTimestamp;
    readonly available: boolean;
    readonly windows?: ReadonlyArray<ProviderRateLimitWindow>;
  }): Promise<void> {
    await this.load();
    const key = accountPlanUsageKey({
      instanceId: String(input.instanceId),
      stateDirectory: input.stateDirectory,
    });
    this.#entries.set(key, {
      instanceId: String(input.instanceId),
      stateDirectory: stripTrailingSlashes(input.stateDirectory.trim()),
      available: input.available,
      source: input.source,
      observedAt: input.observedAt,
      windows: input.available ? (input.windows ?? []).slice(0, MAX_WINDOWS) : [],
    });
    this.#bound();
    await this.#persist();
  }

  async recordWindow(
    event: Extract<ProviderRuntimeEvent, { readonly kind: "rate-limit-window" }>,
    stateDirectory: string,
  ): Promise<void> {
    await this.load();
    const key = accountPlanUsageKey({
      instanceId: String(event.instanceId),
      stateDirectory,
    });
    const previous = this.#entries.get(key);
    const windows = new Map(
      (previous?.windows ?? []).map((window) => [
        canonicalRateLimitWindowId(window.window),
        window,
      ]),
    );
    const windowId = canonicalRateLimitWindowId(event.window);
    const previousWindow = windows.get(windowId);
    if (
      previousWindow !== undefined &&
      Date.parse(previousWindow.observedAt) > Date.parse(event.occurredAt)
    ) {
      return;
    }
    const resetsAt = event.resetsAt ?? previousWindow?.resetsAt;
    const overage = event.overage ?? previousWindow?.overage;
    windows.set(windowId, {
      window: windowId,
      status: event.status,
      observedAt: event.occurredAt,
      ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(overage === undefined ? {} : { overage }),
    });
    this.#entries.set(key, {
      instanceId: String(event.instanceId),
      stateDirectory: stripTrailingSlashes(stateDirectory.trim()),
      available: true,
      source: "session-event",
      observedAt: event.occurredAt,
      windows: [...windows.values()]
        .sort((left, right) => left.window.localeCompare(right.window))
        .slice(0, MAX_WINDOWS),
    });
    this.#bound();
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const next = this.#persistTail.then(async () => {
      const body = JSON.stringify({
        version: SCHEMA_VERSION,
        entries: [...this.#entries.values()],
      } satisfies PersistedFile);
      await mkdir(dirname(this.#filePath), { recursive: true });
      // The file says which accounts exist and how much of each plan is
      // used, so only its owner may read it. The temporary file is new on
      // every write, which is what lets the mode apply.
      const temporary = `${this.#filePath}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#filePath);
    });
    this.#persistTail = next.catch(() => undefined);
    await next;
  }

  #bound(): void {
    while (this.#entries.size > MAX_ACCOUNTS) {
      const oldest = [...this.#entries.entries()].sort(
        (left, right) => Date.parse(left[1].observedAt) - Date.parse(right[1].observedAt),
      )[0];
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
    }
  }
}

const decodeStoredWindow = Schema.decodeUnknownEither(ProviderRateLimitWindow);
const isStoredTimestamp = Schema.is(UtcTimestamp);

/**
 * One stored snapshot, or nothing when it cannot be read. A window that no
 * longer decodes is left out and the rest are kept: serving one undecodable
 * window used to fail the limits answer for every provider.
 */
function readSnapshot(value: unknown): PersistedSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Partial<Record<keyof PersistedSnapshot, unknown>>;
  if (
    typeof entry.instanceId !== "string" ||
    typeof entry.stateDirectory !== "string" ||
    typeof entry.available !== "boolean" ||
    (entry.source !== "session-event" && entry.source !== "process-refresh") ||
    !isStoredTimestamp(entry.observedAt) ||
    !Array.isArray(entry.windows)
  ) {
    return undefined;
  }
  return {
    instanceId: entry.instanceId,
    stateDirectory: entry.stateDirectory,
    available: entry.available,
    source: entry.source,
    observedAt: entry.observedAt,
    windows: entry.windows.slice(0, MAX_WINDOWS).flatMap((window) => {
      const decoded = decodeStoredWindow(window);
      return Either.isRight(decoded) ? [decoded.right] : [];
    }),
  };
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}
