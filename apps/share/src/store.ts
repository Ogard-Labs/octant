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
  decodeCanvasPublicShareDocument,
  type CanvasPublicShareDocument,
  type CanvasPublicShareReportReason,
} from "@octant/contracts/canvas-public-share";

const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 3_600_000;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

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
}

export type TombstoneReason = "revoked" | "expired" | "taken-down";

export interface Tombstone {
  readonly goneAt: string;
  readonly reason: TombstoneReason;
}

export type ShareLookup =
  | { readonly status: "active"; readonly share: StoredShare }
  | { readonly status: "gone"; readonly tombstone: Tombstone }
  | { readonly status: "missing" };

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

function readStoredShare(text: string): StoredShare | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
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
    return {
      document: decodeCanvasPublicShareDocument(parsed["document"]),
      createdAt,
      updatedAt,
      expiresAt,
      byteLength,
      passwordHash,
      ownerSecretHash,
      revision,
      viewCount,
    };
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
    return { goneAt, reason };
  } catch {
    return undefined;
  }
}

/**
 * File-system storage for the service. Synchronous on purpose: the service is
 * one Bun process, and a read-modify-write that cannot be interleaved needs
 * no lock.
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
    for (const name of readdirSync(this.#directory("shares"))) {
      if (!name.endsWith(".json")) continue;
      const share = this.#readShare(name.slice(0, -".json".length));
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
    const share = this.#readShare(id);
    if (share !== undefined) {
      if (share.expiresAt !== null && Date.parse(share.expiresAt) <= this.#clock()) {
        this.#remove(id, share, "expired");
        return this.#lookupTombstone(id);
      }
      return { status: "active", share };
    }
    return this.#lookupTombstone(id);
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
    if (current === undefined) return { status: "missing" };
    const next = change(current);
    if (this.#totalBytes - current.byteLength + next.byteLength > this.#maxTotalBytes) {
      return { status: "unavailable" };
    }
    this.#writeShare(id, next);
    this.#totalBytes += next.byteLength - current.byteLength;
    return { status: "replaced", share: next };
  }

  recordView(id: string): void {
    const current = this.#readShare(id);
    if (current === undefined) return;
    this.#writeShare(id, { ...current, viewCount: current.viewCount + 1 });
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

  #directory(name: string): string {
    return join(this.#root, name);
  }

  #sharePath(id: string): string {
    return join(this.#directory("shares"), `${id}.json`);
  }

  #tombstonePath(id: string): string {
    return join(this.#directory("tombstones"), `${id}.json`);
  }

  #readShare(id: string): StoredShare | undefined {
    try {
      return readStoredShare(readFileSync(this.#sharePath(id), "utf8"));
    } catch {
      return undefined;
    }
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
      JSON.stringify({ goneAt: this.iso(), reason } satisfies Tombstone),
    );
    rmSync(this.#sharePath(id), { force: true });
    this.#totalBytes = Math.max(0, this.#totalBytes - share.byteLength);
  }

  #writeShare(id: string, share: StoredShare): void {
    this.#writeAtomic(this.#sharePath(id), JSON.stringify(share));
  }

  #writeAtomic(path: string, content: string): void {
    const temporary = `${path}.${Buffer.from(this.#randomBytes(6)).toString("hex")}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
