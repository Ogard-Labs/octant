import { randomBytes as secureRandomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_RECEIPTS = 128;

interface LocalPluginImportReceipt {
  readonly windowId: string;
  readonly absolutePath: string;
  readonly expiresAt: number;
}

export class LocalPluginImportReceiptStore {
  readonly #receipts = new Map<string, LocalPluginImportReceipt>();
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxReceipts: number;

  constructor(
    options: {
      readonly randomBytes?: (size: number) => Uint8Array;
      readonly ttlMs?: number;
      readonly maxReceipts?: number;
    } = {},
  ) {
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
  }

  issue(input: {
    readonly windowId: string;
    readonly absolutePath: string;
    readonly now: number;
  }): Readonly<{ receiptId: string; expiresAt: number }> {
    this.#prune(input.now);
    if (this.#receipts.size >= this.#maxReceipts) {
      throw new Error("Local plugin import receipt capacity is unavailable.");
    }
    const receiptId = this.#uniqueReceiptId();
    const expiresAt = input.now + this.#ttlMs;
    this.#receipts.set(receiptId, {
      windowId: input.windowId,
      absolutePath: input.absolutePath,
      expiresAt,
    });
    return Object.freeze({ receiptId, expiresAt });
  }

  consume(input: {
    readonly receiptId: string;
    readonly windowId: string;
    readonly now: number;
  }): string | undefined {
    const receipt = this.#receipts.get(input.receiptId);
    if (
      receipt === undefined ||
      receipt.windowId !== input.windowId ||
      receipt.expiresAt <= input.now
    ) {
      if (receipt !== undefined && receipt.expiresAt <= input.now) {
        this.#receipts.delete(input.receiptId);
      }
      return undefined;
    }
    this.#receipts.delete(input.receiptId);
    return receipt.absolutePath;
  }

  #prune(now: number): void {
    for (const [receiptId, receipt] of this.#receipts) {
      if (receipt.expiresAt <= now) this.#receipts.delete(receiptId);
    }
  }

  #uniqueReceiptId(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const receiptId = Buffer.from(this.#randomBytes(32)).toString("base64url");
      if (/^[A-Za-z0-9_-]{43}$/.test(receiptId) && !this.#receipts.has(receiptId)) {
        return receiptId;
      }
    }
    throw new Error("Local plugin import receipt could not be generated.");
  }
}
