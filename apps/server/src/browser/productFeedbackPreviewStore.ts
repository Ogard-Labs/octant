import {
  MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS,
  decodeProductFeedbackPreview,
  type ProductFeedbackPreview,
  type WindowId,
} from "@octant/contracts";

const MAX_HOST_PREVIEWS = 32;
const MAX_SCOPE_PREVIEWS = 8;
const MAX_METADATA_BYTES = 16 * 1_024;
const MAX_HOST_BYTES = 8 * 1_024 * 1_024;
const RESERVED_BYTES = MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS + MAX_METADATA_BYTES + 32;
const LIFETIME_MS = 10 * 60_000;
const encoder = new TextEncoder();

interface Entry {
  readonly windowId: WindowId;
  readonly threadId: string;
  readonly current: () => boolean;
  readonly expiresAt: number;
  readonly bytes: number;
  readonly json?: string;
}

/** Host-owned memory only; reservations count before an asynchronous capture starts. */
export class ProductFeedbackPreviewStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  #closed = false;

  constructor(now: () => number) {
    this.#now = now;
  }

  reserve(input: {
    readonly id: string;
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly current: () => boolean;
  }): number | undefined {
    this.#prune();
    const entries = [...this.#entries.values()];
    if (
      this.#closed ||
      !input.current() ||
      this.#entries.has(input.id) ||
      entries.length >= MAX_HOST_PREVIEWS ||
      entries.filter(
        (entry) => entry.windowId === input.windowId && entry.threadId === input.threadId,
      ).length >= MAX_SCOPE_PREVIEWS ||
      entries.reduce((sum, entry) => sum + entry.bytes, 0) + RESERVED_BYTES > MAX_HOST_BYTES
    )
      return undefined;
    const expiresAt = this.#now() + LIFETIME_MS;
    if (!Number.isFinite(expiresAt)) return undefined;
    this.#entries.set(input.id, { ...input, expiresAt, bytes: RESERVED_BYTES });
    return expiresAt;
  }

  put(id: string, preview: ProductFeedbackPreview): boolean {
    this.#prune();
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.json !== undefined) return false;
    const { cropDataUrl: _crop, ...metadata } = preview;
    const json = JSON.stringify(preview);
    const bytes = encoder.encode(json).byteLength;
    if (
      preview.id !== id ||
      preview.threadId !== entry.threadId ||
      encoder.encode(JSON.stringify(metadata)).byteLength > MAX_METADATA_BYTES ||
      bytes > entry.bytes
    )
      return false;
    this.#entries.set(id, { ...entry, bytes, json });
    return true;
  }

  read(id: string, windowId: WindowId, threadId: string): ProductFeedbackPreview | undefined {
    this.#prune();
    const entry = this.#entries.get(id);
    if (entry?.windowId !== windowId || entry.threadId !== threadId || entry.json === undefined)
      return undefined;
    // The response and the later committed note never share a mutable object.
    return decodeProductFeedbackPreview(JSON.parse(entry.json));
  }

  release(id: string): void {
    this.#entries.delete(id);
  }

  revokeWindow(windowId: WindowId): void {
    for (const [id, entry] of this.#entries)
      if (entry.windowId === windowId) this.#entries.delete(id);
  }

  purgeThread(threadId: string): void {
    for (const [id, entry] of this.#entries)
      if (entry.threadId === threadId) this.#entries.delete(id);
  }

  close(): void {
    this.#closed = true;
    this.#entries.clear();
  }

  revalidate(): void {
    this.#prune();
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries)
      if (entry.expiresAt <= now || !entry.current()) this.#entries.delete(id);
  }
}
