import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_MAXIMUM_CODE_CONTENT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAXIMUM_CODE_CONTENT_ENTRIES = 128;

export interface CodeContentReference {
  readonly contentId: string;
  readonly byteLength: number;
  readonly digest: string;
}

export interface CodeContentStoreOptions {
  readonly maximumBytes?: number;
  readonly maximumEntries?: number;
  readonly newContentId?: () => string;
}

export class CodeContentStoreError extends Error {
  override readonly name = "CodeContentStoreError";

  constructor(readonly code: "capacity" | "duplicate" | "invalid" | "not-found") {
    super(code);
  }
}

interface StoredContent {
  readonly bytes: Uint8Array;
  readonly reference: CodeContentReference;
}

/**
 * Process-local, explicitly purgeable storage for file and search bytes.
 * References and digests may be journaled; the bytes themselves must not be.
 */
export class CodeContentStore {
  readonly #maximumBytes: number;
  readonly #maximumEntries: number;
  readonly #newContentId: () => string;
  readonly #entries = new Map<string, StoredContent>();
  #totalBytes = 0;

  constructor(options: CodeContentStoreOptions = {}) {
    this.#maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_CODE_CONTENT_BYTES;
    this.#maximumEntries = options.maximumEntries ?? DEFAULT_MAXIMUM_CODE_CONTENT_ENTRIES;
    this.#newContentId = options.newContentId ?? randomUUID;
    if (!positiveSafeInteger(this.#maximumBytes) || !positiveSafeInteger(this.#maximumEntries)) {
      throw new CodeContentStoreError("invalid");
    }
  }

  put(bytes: Uint8Array): CodeContentReference {
    if (!(bytes instanceof Uint8Array)) throw new CodeContentStoreError("invalid");
    if (
      this.#entries.size >= this.#maximumEntries ||
      bytes.byteLength > this.#maximumBytes - this.#totalBytes
    ) {
      throw new CodeContentStoreError("capacity");
    }
    const contentId = this.#newContentId();
    if (!validContentId(contentId)) throw new CodeContentStoreError("invalid");
    if (this.#entries.has(contentId)) throw new CodeContentStoreError("duplicate");

    const owned = Uint8Array.from(bytes);
    const reference = Object.freeze({
      contentId,
      byteLength: owned.byteLength,
      digest: createHash("sha256").update(owned).digest("hex"),
    });
    this.#entries.set(contentId, { bytes: owned, reference });
    this.#totalBytes += owned.byteLength;
    return reference;
  }

  get(contentId: string): Uint8Array {
    const entry = this.#entries.get(contentId);
    if (entry === undefined) throw new CodeContentStoreError("not-found");
    return Uint8Array.from(entry.bytes);
  }

  purge(contentId: string): boolean {
    const entry = this.#entries.get(contentId);
    if (entry === undefined) return false;
    this.#entries.delete(contentId);
    this.#totalBytes -= entry.reference.byteLength;
    return true;
  }

  purgeAll(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
  }

  stats(): Readonly<{ entryCount: number; totalBytes: number }> {
    return { entryCount: this.#entries.size, totalBytes: this.#totalBytes };
  }
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validContentId(value: string): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\0")
  );
}
