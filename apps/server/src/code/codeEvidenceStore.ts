import { createHash, randomUUID } from "node:crypto";
import {
  MAX_CODE_OPERATION_EVIDENCE_BYTES,
  decodeCodeEvidenceReference,
  type CodeEvidenceReference,
} from "@octant/contracts";
import type { SqliteConnection } from "../persistence/sqlitePort";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_MAX_STORED_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;

export class CodeEvidenceCapacityExceeded extends Error {
  readonly category = "capacity" as const;
  override readonly name = "CodeEvidenceCapacityExceeded";

  constructor() {
    super("Code evidence storage capacity is exhausted.");
  }
}

export class CodeEvidenceStore {
  readonly #connection: SqliteConnection;
  readonly #newContentId: () => string;
  readonly #clock: () => string;
  readonly #maxStoredBytes: number;
  readonly #maxEntries: number;
  #storedBytes: number;
  #entryCount: number;

  constructor(options: {
    readonly connection: SqliteConnection;
    readonly newContentId?: () => string;
    readonly clock?: () => string;
    readonly maxStoredBytes?: number;
    readonly maxEntries?: number;
  }) {
    this.#connection = options.connection;
    this.#newContentId = options.newContentId ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#maxStoredBytes = options.maxStoredBytes ?? DEFAULT_MAX_STORED_BYTES;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const capacity = this.#connection
      .prepare(
        `SELECT COUNT(*) AS entry_count, COALESCE(SUM(byte_length), 0) AS stored_bytes
         FROM code_evidence_content_store`,
      )
      .get() as { readonly entry_count: number; readonly stored_bytes: number };
    this.#entryCount = capacity.entry_count;
    this.#storedBytes = capacity.stored_bytes;
  }

  put(content: string, metadata?: { readonly truncated?: boolean }): CodeEvidenceReference {
    const bytes = encoder.encode(content);
    if (bytes.byteLength > MAX_CODE_OPERATION_EVIDENCE_BYTES) {
      throw new Error("Code evidence exceeds the bounded content limit.");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existing = this.#connection
      .prepare(
        `SELECT content_id, body_text, byte_length
         FROM code_evidence_content_store
         WHERE digest = ?
         LIMIT 1`,
      )
      .get(digest) as
      | { readonly content_id: string; readonly body_text: string; readonly byte_length: number }
      | undefined;
    if (existing !== undefined) {
      const existingBytes = encoder.encode(existing.body_text);
      if (
        existing.byte_length !== bytes.byteLength ||
        existingBytes.byteLength !== bytes.byteLength ||
        existing.body_text !== content
      ) {
        throw new Error("Code evidence digest collision was rejected.");
      }
      return decodeCodeEvidenceReference({
        contentId: existing.content_id,
        digest,
        byteLength: bytes.byteLength,
        ...(metadata?.truncated === true ? { truncated: true } : {}),
      });
    }
    if (
      this.#entryCount >= this.#maxEntries ||
      this.#storedBytes + bytes.byteLength > this.#maxStoredBytes
    ) {
      throw new CodeEvidenceCapacityExceeded();
    }
    const reference = decodeCodeEvidenceReference({
      contentId: this.#newContentId(),
      digest,
      byteLength: bytes.byteLength,
      ...(metadata?.truncated === true ? { truncated: true } : {}),
    });
    this.#connection
      .prepare(
        `INSERT INTO code_evidence_content_store
          (content_id, body_text, digest, byte_length, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(reference.contentId, content, reference.digest, reference.byteLength, this.#clock());
    this.#entryCount += 1;
    this.#storedBytes += bytes.byteLength;
    return reference;
  }

  read(reference: CodeEvidenceReference): string | undefined {
    const row = this.#connection
      .prepare(
        `SELECT body_text, digest, byte_length
         FROM code_evidence_content_store
         WHERE content_id = ?`,
      )
      .get(reference.contentId) as
      | { readonly body_text: string; readonly digest: string; readonly byte_length: number }
      | undefined;
    if (row === undefined) return undefined;
    try {
      const bytes = encoder.encode(row.body_text);
      if (
        row.byte_length !== reference.byteLength ||
        row.digest !== reference.digest ||
        bytes.byteLength !== reference.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== reference.digest
      ) {
        return undefined;
      }
      return decoder.decode(bytes);
    } catch {
      return undefined;
    }
  }
}
