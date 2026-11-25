import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CANVAS_PUBLIC_SHARE_TOMBSTONE_DAYS,
  type CanvasPublicShareDocument,
  type CanvasPublicShareReportReason,
  decodeCanvasPublicShareDocument,
} from "./shareKit.ts";
import { type CarriedImage, documentImages, encodeShareFile, withShareHead } from "./shareFile.ts";

const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 3_600_000;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** A share write that stopped before its rename. */
const UNFINISHED_SHARE_PATTERN = /^[A-Za-z0-9_-]{22}\.json\.[0-9a-f]{12}\.tmp$/;

export type RandomBytes = (size: number) => Uint8Array;
export type Clock = () => number;

export interface StoredShare {
  readonly document: CanvasPublicShareDocument;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly byteLength: number;
  readonly passwordHash: string | null;
  /** SHA-256 hex of the owner secret; the secret itself is never stored. */
  readonly ownerSecretHash: string;
  /** Bumps on every update, which voids view grants and frame addresses. */
  readonly revision: number;
  readonly viewCount: number;
  /** Keyed request digest and original receipt; never plaintext password terms. */
  readonly creation?: { readonly requestDigest: string; readonly expiresAt: string | null };
}

export type TombstoneReason = "revoked" | "expired" | "taken-down";

export interface Tombstone {
  readonly ownerSecretHash?: string;
  readonly goneAt: string;
  readonly reason: TombstoneReason;
}

export type ShareLookup =
  | { readonly status: "active"; readonly share: StoredShare }
  | { readonly status: "gone"; readonly tombstone: Tombstone }
  | { readonly status: "missing" };

/** What an image request needs of a live share: the terms that admit it, and its images. */
export interface ShareImages {
  readonly passwordHash: string | null;
  readonly revision: number;
  readonly images: ReadonlyArray<CarriedImage>;
}

export type CreateOutcome =
  | { readonly status: "created" }
  | { readonly status: "unavailable" }
  | { readonly status: "id-taken" };

export type ReplaceOutcome =
  | { readonly status: "replaced"; readonly share: StoredShare }
  | { readonly status: "unavailable" }
  | { readonly status: "missing" };

export interface ShareStoreOptions {
  readonly clock?: Clock;
  readonly randomBytes?: RandomBytes;
  readonly maxTotalBytes: number;
}

export function isShareId(value: string): boolean {
  return SHARE_ID_PATTERN.test(value);
}

export function hashOwnerSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time comparison of two equal-length hex digests. */
export function digestsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored share's terms: all of it but the document. */
function readShareTerms(parsed: unknown): Omit<StoredShare, "document"> | undefined {
  if (!isRecord(parsed)) return undefined;
  const { createdAt, updatedAt, expiresAt, byteLength, passwordHash, ownerSecretHash } = parsed;
  const { revision, viewCount } = parsed;
  if (
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    (expiresAt !== null && typeof expiresAt !== "string") ||
    typeof byteLength !== "number" ||
    (passwordHash !== null && typeof passwordHash !== "string") ||
    typeof ownerSecretHash !== "string" ||
    typeof revision !== "number" ||
    typeof viewCount !== "number"
  ) {
    return undefined;
  }
  const creation = parsed.creation;
  if (
    creation !== undefined &&
    (!isRecord(creation) ||
      typeof creation.requestDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(creation.requestDigest) ||
      (creation.expiresAt !== null && typeof creation.expiresAt !== "string"))
  )
    return undefined;
  return {
    ...(isRecord(creation) &&
    typeof creation.requestDigest === "string" &&
    (creation.expiresAt === null || typeof creation.expiresAt === "string")
      ? { creation: { requestDigest: creation.requestDigest, expiresAt: creation.expiresAt } }
      : {}),
    createdAt,
    updatedAt,
    expiresAt,
    byteLength,
    passwordHash,
    ownerSecretHash,
    revision,
    viewCount,
  };
}

function readStoredShare(text: string): StoredShare | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const terms = readShareTerms(parsed);
    if (terms === undefined || !isRecord(parsed)) return undefined;
    return { ...terms, document: decodeCanvasPublicShareDocument(parsed["document"]) };
  } catch {
    return undefined;
  }
}

function readTombstone(text: string): Tombstone | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const { goneAt, reason } = parsed;
    if (typeof goneAt !== "string") return undefined;
    if (reason !== "revoked" && reason !== "expired" && reason !== "taken-down") return undefined;
    const ownerSecretHash = parsed.ownerSecretHash;
    if (
      ownerSecretHash !== undefined &&
      (typeof ownerSecretHash !== "string" || !/^[a-f0-9]{64}$/.test(ownerSecretHash))
    )
      return undefined;
    return { goneAt, reason, ...(typeof ownerSecretHash === "string" ? { ownerSecretHash } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * File-system storage for the service. Synchronous on purpose: the service is
 * one Bun process, and a read-modify-write that cannot be interleaved needs
 * no lock. That holds only while the serving process is the one writer, so
 * operator takedown goes through its loopback listener, not a second store.
 */
export class ShareStore {
  readonly #root: string;
  readonly #clock: Clock;
  readonly #randomBytes: RandomBytes;
  readonly #maxTotalBytes: number;
  #totalBytes = 0;
  #frameKey: Buffer | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(dataDir: string, options: ShareStoreOptions) {
    this.#root = dataDir;
    this.#clock = options.clock ?? Date.now;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#maxTotalBytes = options.maxTotalBytes;
    for (const directory of [dataDir, this.#directory("shares"), this.#directory("tombstones")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    mkdirSync(this.#directory("reports"), { recursive: true, mode: 0o700 });
    mkdirSync(this.#directory("views"), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.#directory("shares"))) {
      // The serving process is the one writer, so a temporary file found at
      // start is a write a stop cut short, holding a document no link shows.
      if (UNFINISHED_SHARE_PATTERN.test(name)) {
        rmSync(join(this.#directory("shares"), name), { force: true });
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      // Reconcile a crash that left a payload beside its tombstone.
      if (this.#hasTombstone(id)) {
        rmSync(this.#sharePath(id), { force: true });
        continue;
      }
      const share = this.#readShare(id);
      if (share !== undefined) this.#totalBytes += share.byteLength;
    }
  }

  now(): number {
    return this.#clock();
  }

  /** A fresh 22-character id from 16 random bytes. */
  newId(): string {
    return Buffer.from(this.#randomBytes(16)).toString("base64url");
  }

  /** A fresh 43-character owner secret from 32 random bytes. */
  newOwnerSecret(): string {
    return Buffer.from(this.#randomBytes(32)).toString("base64url");
  }

  iso(timestamp: number = this.#clock()): string {
    return new Date(timestamp).toISOString();
  }

  /** Runs the sweep now and then hourly; the timer never keeps the process alive. */
  startSweeping(): void {
    this.sweep();
    this.#timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  stopSweeping(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  lookup(id: string): ShareLookup {
    if (!isShareId(id)) return { status: "missing" };
    if (this.#hasTombstone(id)) {
      // A stop between the tombstone write and the payload delete can leave
      // both files; the tombstone is final, so a surviving payload goes now.
      rmSync(this.#sharePath(id), { force: true });
      return this.#lookupTombstone(id);
    }
    const share = this.#readShare(id);
    if (share !== undefined) {
      if (this.#hasExpired(share)) {
        this.#remove(id, share, "expired");
        return this.#lookupTombstone(id);
      }
      return { status: "active", share };
    }
    return this.#lookupTombstone(id);
  }

  /**
   * Answers for a live share's images, reading only its terms, its image
   * index and the images `answer` reads. A share with no such index is read
   * whole. Undefined when no live share has this id. Images are readable only
   * inside `answer`.
   */
  withImages<T>(id: string, answer: (share: ShareImages) => T): T | undefined {
    if (isShareId(id) && !this.#hasTombstone(id)) {
      const head = withShareHead(this.#sharePath(id), ({ terms: stored, images }) => {
        const terms = readShareTerms(stored);
        // An expired or unreadable share is left to the whole lookup below.
        if (terms === undefined || this.#hasExpired(terms)) return undefined;
        const { passwordHash, revision } = terms;
        return { answer: answer({ passwordHash, revision, images }) };
      });
      if (head.status === "read" && head.value !== undefined) return head.value.answer;
    }
    const lookup = this.lookup(id);
    if (lookup.status !== "active") return undefined;
    const { document, passwordHash, revision } = lookup.share;
    return answer({ passwordHash, revision, images: documentImages(document) });
  }

  create(id: string, share: StoredShare): CreateOutcome {
    if (existsSync(this.#sharePath(id)) || existsSync(this.#tombstonePath(id))) {
      return { status: "id-taken" };
    }
    if (this.#totalBytes + share.byteLength > this.#maxTotalBytes) return { status: "unavailable" };
    this.#writeShare(id, share);
    this.#totalBytes += share.byteLength;
    return { status: "created" };
  }

  replace(id: string, change: (current: StoredShare) => StoredShare): ReplaceOutcome {
    const current = this.#readShare(id);
    if (current === undefined || this.#hasTombstone(id)) return { status: "missing" };
    const next = change(current);
    if (this.#totalBytes - current.byteLength + next.byteLength > this.#maxTotalBytes) {
      return { status: "unavailable" };
    }
    this.#writeShare(id, next);
    this.#totalBytes += next.byteLength - current.byteLength;
    return { status: "replaced", share: next };
  }

  // A view counts in a small file beside the share rather than rewriting the
  // share: with a share's images a payload is megabytes, and rewriting it on
  // every view would cost a full write per reader.
  recordView(id: string): void {
    const current = this.#readShare(id);
    if (current === undefined || this.#hasTombstone(id)) return;
    this.#writeAtomic(this.#viewsPath(id), String(current.viewCount + 1));
  }

  /** Only the API calls this after verifying a nonexistent id is bound to its bearer proof. */
  cancelOwned(id: string, ownerSecretHash: string): boolean {
    if (
      !isShareId(id) ||
      !/^[a-f0-9]{64}$/.test(ownerSecretHash) ||
      existsSync(this.#sharePath(id)) ||
      existsSync(this.#tombstonePath(id))
    )
      return false;
    this.#writeAtomic(
      this.#tombstonePath(id),
      JSON.stringify({
        goneAt: this.iso(),
        reason: "revoked",
        ownerSecretHash,
      } satisfies Tombstone),
    );
    return true;
  }

  /** Deletes the payload and leaves a content-free tombstone. False when no payload exists. */
  remove(id: string, reason: TombstoneReason): boolean {
    const share = this.#readShare(id);
    if (share === undefined) return false;
    this.#remove(id, share, reason);
    return true;
  }

  addReport(report: {
    readonly shareId: string;
    readonly reason: CanvasPublicShareReportReason;
    readonly detail: string | undefined;
  }): void {
    // The record holds what was reported and why, never who reported it.
    const name = Buffer.from(this.#randomBytes(12)).toString("base64url");
    this.#writeAtomic(
      join(this.#directory("reports"), `${name}.json`),
      JSON.stringify({
        shareId: report.shareId,
        reason: report.reason,
        ...(report.detail === undefined || report.detail === "" ? {} : { detail: report.detail }),
        createdAt: this.iso(),
      }),
    );
  }

  /** The key that signs view grants and frame addresses, generated on first use. */
  frameKey(): Buffer {
    if (this.#frameKey !== undefined) return this.#frameKey;
    const path = join(this.#root, "frame-key");
    if (!existsSync(path)) {
      try {
        writeFileSync(path, Buffer.from(this.#randomBytes(32)).toString("base64url"), {
          mode: 0o600,
          flag: "wx",
        });
      } catch {
        // Another start created it first; the file read below is the key.
      }
    }
    this.#frameKey = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    return this.#frameKey;
  }

  /** Deletes expired payloads, leaving "expired" tombstones, and tombstones past their retention. */
  sweep(): void {
    const now = this.#clock();
    for (const name of readdirSync(this.#directory("shares"))) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const share = this.#readShare(id);
      if (share?.expiresAt != null && Date.parse(share.expiresAt) <= now) {
        this.#remove(id, share, "expired");
      }
    }
    for (const name of readdirSync(this.#directory("tombstones"))) {
      if (!name.endsWith(".json")) continue;
      const tombstone = this.#readTombstoneFile(name.slice(0, -".json".length));
      if (tombstone === undefined || this.#tombstoneExpired(tombstone, now)) {
        rmSync(join(this.#directory("tombstones"), name), { force: true });
      }
    }
  }

  #hasExpired(terms: Pick<StoredShare, "expiresAt">): boolean {
    return terms.expiresAt !== null && Date.parse(terms.expiresAt) <= this.#clock();
  }

  #directory(name: string): string {
    return join(this.#root, name);
  }

  #sharePath(id: string): string {
    return join(this.#directory("shares"), `${id}.json`);
  }

  #tombstonePath(id: string): string {
    return join(this.#directory("tombstones"), `${id}.json`);
  }

  #viewsPath(id: string): string {
    return join(this.#directory("views"), `${id}.count`);
  }

  #readShare(id: string): StoredShare | undefined {
    let share: StoredShare | undefined;
    try {
      share = readStoredShare(readFileSync(this.#sharePath(id), "utf8"));
    } catch {
      return undefined;
    }
    if (share === undefined) return undefined;
    let counted = 0;
    try {
      const value = Number(readFileSync(this.#viewsPath(id), "utf8"));
      if (Number.isSafeInteger(value) && value >= 0) counted = value;
    } catch {
      // No view has been counted beside the share yet.
    }
    return counted > share.viewCount ? { ...share, viewCount: counted } : share;
  }

  /** A tombstone is final: no later view or update writes the payload it replaced. */
  #hasTombstone(id: string): boolean {
    return existsSync(this.#tombstonePath(id));
  }

  #readTombstoneFile(id: string): Tombstone | undefined {
    try {
      return readTombstone(readFileSync(this.#tombstonePath(id), "utf8"));
    } catch {
      return undefined;
    }
  }

  #tombstoneExpired(tombstone: Tombstone, now: number): boolean {
    return Date.parse(tombstone.goneAt) + CANVAS_PUBLIC_SHARE_TOMBSTONE_DAYS * DAY_MS <= now;
  }

  #lookupTombstone(id: string): ShareLookup {
    const tombstone = this.#readTombstoneFile(id);
    if (tombstone === undefined) return { status: "missing" };
    if (this.#tombstoneExpired(tombstone, this.#clock())) {
      rmSync(this.#tombstonePath(id), { force: true });
      return { status: "missing" };
    }
    return { status: "gone", tombstone };
  }

  #remove(id: string, share: StoredShare, reason: TombstoneReason): void {
    this.#writeAtomic(
      this.#tombstonePath(id),
      JSON.stringify({
        goneAt: this.iso(),
        reason,
        ...(share.creation === undefined ? {} : { ownerSecretHash: share.ownerSecretHash }),
      } satisfies Tombstone),
    );
    rmSync(this.#sharePath(id), { force: true });
    rmSync(this.#viewsPath(id), { force: true });
    this.#totalBytes = Math.max(0, this.#totalBytes - share.byteLength);
  }

  #writeShare(id: string, share: StoredShare): void {
    this.#writeAtomic(this.#sharePath(id), encodeShareFile(share));
  }

  #writeAtomic(path: string, content: string): void {
    const temporary = `${path}.${Buffer.from(this.#randomBytes(6)).toString("hex")}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
