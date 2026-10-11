import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  decodeProviderServiceLimits,
  type ProviderInstanceId,
  type ProviderRateLimitWindow,
  type ProviderRuntimeEvent,
  type ProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  accountPlanUsageKey,
  type ProviderAccountPlanUsageSnapshot,
  type ProviderPlanUsageSource,
} from "@octant/domain";
import { canonicalRateLimitWindowId } from "./rateLimitWindowIdentity";

const SCHEMA_VERSION = 1;
const MAX_ACCOUNTS = 128;
const MAX_WINDOWS = 32;

interface PersistedFile {
  readonly version: typeof SCHEMA_VERSION;
  readonly entries: ReadonlyArray<ProviderAccountPlanUsageSnapshot>;
}

/**
 * Latest plan-usage snapshot per account, keyed by instance and the state
 * directory that session ran under. Lives in Octant's host data directory.
 * The file holds only normalized windows — never tokens or credential paths.
 */
export class ProviderAccountPlanUsageStore {
  readonly #filePath: string;
  readonly #entries = new Map<string, ProviderAccountPlanUsageSnapshot>();
  #loaded = false;

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
    for (const entry of file.entries) {
      if (!isSnapshot(entry)) continue;
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

  snapshot(
    instanceId: ProviderInstanceId,
    stateDirectory: string,
  ): ProviderAccountPlanUsageSnapshot | undefined {
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
      updatedAt: snapshot.observedAt as UtcTimestamp,
      rateLimitWindows: windows as ReadonlyArray<ProviderRateLimitWindow>,
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
    windows.set(windowId, {
      window: windowId,
      status: event.status,
      ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
      ...(event.resetsAt === undefined && previousWindow?.resetsAt === undefined
        ? {}
        : { resetsAt: event.resetsAt ?? previousWindow?.resetsAt }),
      observedAt: event.occurredAt,
      ...(event.overage === undefined && previousWindow?.overage === undefined
        ? {}
        : { overage: event.overage ?? previousWindow?.overage }),
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
    const body = JSON.stringify({
      version: SCHEMA_VERSION,
      entries: [...this.#entries.values()],
    } satisfies PersistedFile);
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, this.#filePath);
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

function isSnapshot(value: unknown): value is ProviderAccountPlanUsageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as ProviderAccountPlanUsageSnapshot;
  return (
    typeof entry.instanceId === "string" &&
    typeof entry.stateDirectory === "string" &&
    typeof entry.available === "boolean" &&
    (entry.source === "session-event" || entry.source === "process-refresh") &&
    typeof entry.observedAt === "string" &&
    Array.isArray(entry.windows)
  );
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}
