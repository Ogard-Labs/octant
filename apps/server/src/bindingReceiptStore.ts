import { randomBytes } from "node:crypto";
import {
  decodeBindingReceiptId,
  type BindingReceiptId,
  type CanonicalProjectBinding,
  type ProjectType,
  type WindowId,
} from "@octant/contracts";
import { isCanonical256BitToken } from "./windowAuthorityStore";
import type { SqliteConnection, SqliteStatement } from "./persistence/sqlitePort";

export const BINDING_RECEIPT_TTL_MS = 60_000;
type BoundProjectType = Exclude<ProjectType, "chat">;

export class BindingReceiptError extends Error {
  readonly category: "unauthorized" | "unavailable";

  constructor(category: BindingReceiptError["category"], message: string) {
    super(message);
    this.name = "BindingReceiptError";
    this.category = category;
  }
}

interface BindingReceiptRecord {
  readonly windowId: WindowId;
  readonly projectType: BoundProjectType;
  readonly canonicalBinding: CanonicalProjectBinding;
  readonly expiresAt: number;
}

export interface BindingReceipt {
  readonly receiptId: BindingReceiptId;
  readonly projectType: BoundProjectType;
  readonly expiresAt: number;
}

/**
 * Structural port for binding receipt stores. Both the in-memory
 * {@link BindingReceiptStore} and the durable {@link DurableBindingReceiptStore}
 * implement this port so callers depend on the issue/consume surface, not the
 * storage mechanism.
 */
export interface BindingReceiptStorePort {
  issue(input: {
    readonly windowId: WindowId;
    readonly projectType: BoundProjectType;
    readonly canonicalBinding: CanonicalProjectBinding;
    readonly now: number;
  }): BindingReceipt;
  consume(input: {
    readonly receiptId: string;
    readonly authenticatedWindowId: WindowId;
    readonly projectType: BoundProjectType;
    readonly now: number;
  }): CanonicalProjectBinding;
}

export class BindingReceiptStore {
  readonly #records = new Map<BindingReceiptId, BindingReceiptRecord>();
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(random: (size: number) => Uint8Array = randomBytes) {
    this.#randomBytes = random;
  }

  issue(input: {
    readonly windowId: WindowId;
    readonly projectType: BoundProjectType;
    readonly canonicalBinding: CanonicalProjectBinding;
    readonly now: number;
  }): BindingReceipt {
    this.#removeExpired(input.now);
    let receiptId: BindingReceiptId;
    do {
      receiptId = decodeBindingReceiptId(Buffer.from(this.#randomBytes(32)).toString("base64url"));
    } while (this.#records.has(receiptId));
    const expiresAt = input.now + BINDING_RECEIPT_TTL_MS;
    this.#records.set(receiptId, { ...input, expiresAt });
    return { receiptId, projectType: input.projectType, expiresAt };
  }

  consume(input: {
    readonly receiptId: string;
    readonly authenticatedWindowId: WindowId;
    readonly projectType: BoundProjectType;
    readonly now: number;
  }): CanonicalProjectBinding {
    if (!isCanonical256BitToken(input.receiptId)) {
      throw new BindingReceiptError("unauthorized", "Project binding receipt is invalid.");
    }
    const receiptId = decodeBindingReceiptId(input.receiptId);
    const record = this.#records.get(receiptId);
    if (record === undefined) {
      throw new BindingReceiptError("unauthorized", "Project binding receipt is invalid.");
    }
    if (input.now >= record.expiresAt) {
      this.#records.delete(receiptId);
      throw new BindingReceiptError("unavailable", "Project binding receipt has expired.");
    }
    if (
      record.windowId !== input.authenticatedWindowId ||
      record.projectType !== input.projectType
    ) {
      throw new BindingReceiptError("unauthorized", "Project binding receipt is invalid.");
    }
    this.#records.delete(receiptId);
    return record.canonicalBinding;
  }

  #removeExpired(now: number): void {
    for (const [receiptId, record] of this.#records) {
      if (now >= record.expiresAt) this.#records.delete(receiptId);
    }
  }
}

interface DurableReceiptRow {
  readonly window_id: string;
  readonly project_type: BoundProjectType;
  readonly canonical_root: string;
  readonly expires_at: number;
  readonly consumed: number;
}

/**
 * Durable binding receipt store backed by SQLite. Preserves one-time-use
 * receipts across server restart so a receipt issued before a restart can be
 * consumed after recovery, and a consumed receipt stays consumed. Expired
 * receipts are removed lazily on issue and consume. The in-memory store
 * remains the default for tests that do not need durability.
 */
export class DurableBindingReceiptStore {
  readonly #connection: SqliteConnection;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #insert: SqliteStatement;
  readonly #select: SqliteStatement;
  readonly #markConsumed: SqliteStatement;
  readonly #deleteExpired: SqliteStatement;

  constructor(connection: SqliteConnection, random: (size: number) => Uint8Array = randomBytes) {
    this.#connection = connection;
    this.#randomBytes = random;
    this.#insert = connection.prepare(`
      INSERT INTO binding_receipt_store (
        receipt_id, window_id, project_type, canonical_root, expires_at, consumed
      ) VALUES (?, ?, ?, ?, ?, 0)
    `);
    this.#select = connection.prepare(`
      SELECT window_id, project_type, canonical_root, expires_at, consumed
      FROM binding_receipt_store
      WHERE receipt_id = ?
    `);
    this.#markConsumed = connection.prepare(`
      UPDATE binding_receipt_store SET consumed = 1 WHERE receipt_id = ?
    `);
    this.#deleteExpired = connection.prepare(`
      DELETE FROM binding_receipt_store WHERE consumed = 0 AND expires_at <= ?
    `);
  }

  issue(input: {
    readonly windowId: WindowId;
    readonly projectType: BoundProjectType;
    readonly canonicalBinding: CanonicalProjectBinding;
    readonly now: number;
  }): BindingReceipt {
    this.#removeExpired(input.now);
    let receiptId: BindingReceiptId;
    do {
      receiptId = decodeBindingReceiptId(Buffer.from(this.#randomBytes(32)).toString("base64url"));
    } while (this.#select.get(receiptId) !== undefined);
    const expiresAt = input.now + BINDING_RECEIPT_TTL_MS;
    this.#insert.run(
      receiptId,
      input.windowId,
      input.projectType,
      input.canonicalBinding.canonicalRoot,
      expiresAt,
    );
    return { receiptId, projectType: input.projectType, expiresAt };
  }

  consume(input: {
    readonly receiptId: string;
    readonly authenticatedWindowId: WindowId;
    readonly projectType: BoundProjectType;
    readonly now: number;
  }): CanonicalProjectBinding {
    if (!isCanonical256BitToken(input.receiptId)) {
      throw new BindingReceiptError("unauthorized", "Project binding receipt is invalid.");
    }
    const receiptId = decodeBindingReceiptId(input.receiptId);
    const row = this.#select.get(receiptId) as DurableReceiptRow | undefined;
    if (row === undefined) {
      throw new BindingReceiptError("unauthorized", "Project binding receipt is invalid.");
    }
    if (input.now >= row.expires_at) {
      this.#deleteExpired.run(input.now);
      throw new BindingReceiptError("unavailable", "Project binding receipt has expired.");
    }
    if (row.consumed === 1) {
      throw new BindingReceiptError("unauthorized", "Project binding receipt is invalid.");
    }
    if (row.window_id !== input.authenticatedWindowId || row.project_type !== input.projectType) {
      throw new BindingReceiptError("unauthorized", "Project binding receipt is invalid.");
    }
    this.#markConsumed.run(receiptId);
    return { canonicalRoot: row.canonical_root };
  }

  #removeExpired(now: number): void {
    this.#deleteExpired.run(now);
  }
}
