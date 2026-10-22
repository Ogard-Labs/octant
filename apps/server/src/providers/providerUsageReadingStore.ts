import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProviderUsageLimitsEntry } from "@octant/contracts";
import { Either, Schema } from "effect";

const SCHEMA_VERSION = 1;
const MAX_READINGS = 128;

const decodeEntry = Schema.decodeUnknownEither(ProviderUsageLimitsEntry);

/**
 * The last plan-limit reading of each provider instance, kept in Octant's
 * host data directory so the usage rings have something to show when the host
 * starts, before any turn has reported. The file holds only normalized
 * readings, never a token or a credential path, and only its owner may read
 * it. It is a rebuildable view: a missing or unreadable file means no rings
 * until the next report, never a failure.
 */
export class ProviderUsageReadingStore {
  readonly #filePath: string;
  #persistTail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  /** Every stored reading that still decodes. Never rejects. */
  async load(): Promise<ReadonlyArray<ProviderUsageLimitsEntry>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const file = parsed as { readonly version?: unknown; readonly entries?: unknown };
    if (file.version !== SCHEMA_VERSION || !Array.isArray(file.entries)) return [];
    return file.entries.slice(0, MAX_READINGS).flatMap((candidate) => {
      const decoded = decodeEntry(candidate);
      return Either.isRight(decoded) && decoded.right.status === "available" ? [decoded.right] : [];
    });
  }

  /** Replaces the stored readings. Writes are queued in call order. */
  save(entries: ReadonlyArray<ProviderUsageLimitsEntry>): void {
    const body = JSON.stringify({
      version: SCHEMA_VERSION,
      entries: entries.slice(0, MAX_READINGS),
    });
    this.#persistTail = this.#persistTail
      .then(async () => {
        await mkdir(dirname(this.#filePath), { recursive: true });
        // The temporary file is new on every write, which is what lets the
        // owner-only mode apply.
        const temporary = `${this.#filePath}.tmp`;
        await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.#filePath);
      })
      .catch(() => undefined);
  }

  /** Resolves once every queued write has finished. */
  async flush(): Promise<void> {
    await this.#persistTail;
  }
}
