import { randomUUID } from "node:crypto";
import {
  ManagedRootGrantId,
  type BindingRevisionId,
  type CodeRepositoryId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { FileSystemIdentity } from "./repositoryIdentity";

export const MANAGED_ROOT_GRANT_TTL_MS = 60_000;

const decodeManagedRootGrantId = Schema.decodeUnknownSync(ManagedRootGrantId);

export class ManagedRootGrantError extends Error {
  readonly category: "unauthorized" | "unavailable";

  constructor(category: ManagedRootGrantError["category"], message: string) {
    super(message);
    this.name = "ManagedRootGrantError";
    this.category = category;
  }
}

export interface ManagedRootParent {
  readonly canonicalPath: string;
  readonly identity: FileSystemIdentity;
}

interface ManagedRootGrantRecord {
  readonly windowId: WindowId;
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly repositoryId: CodeRepositoryId;
  readonly parent: ManagedRootParent;
  readonly targetPath: string;
  readonly expiresAt: number;
}

export interface ManagedRootGrant {
  readonly grantId: ManagedRootGrantId;
  readonly expiresAt: number;
}

export interface ManagedRootGrantBinding {
  readonly parent: ManagedRootParent;
  readonly targetPath: string;
}

export class ManagedRootGrantStore {
  readonly #records = new Map<ManagedRootGrantId, ManagedRootGrantRecord>();
  readonly #uuid: () => string;
  readonly #clampNow: (wallClockMs: number) => number;
  readonly #clockPosture: () => "ok" | "recovery-required";

  /**
   * `clampNow` clamps every caller-supplied wall-clock reading
   * against a shared, server-owned monotonic bound (see `LocalAuthorityClock`)
   * before it is used for expiry math, so a host wall-clock rollback cannot
   * revive an expired managed-root grant. Defaults to the identity function.
   */
  constructor(
    uuid: () => string = randomUUID,
    clampNow?: (wallClockMs: number) => number,
    clockPosture?: () => "ok" | "recovery-required",
  ) {
    this.#uuid = uuid;
    this.#clampNow = clampNow ?? ((wallClockMs) => wallClockMs);
    this.#clockPosture = clockPosture ?? (() => "ok");
  }

  issue(input: {
    readonly windowId: WindowId;
    readonly projectId: ProjectId;
    readonly bindingRevisionId: BindingRevisionId;
    readonly repositoryId: CodeRepositoryId;
    readonly parent: ManagedRootParent;
    readonly targetPath: string;
    readonly now: number;
  }): ManagedRootGrant {
    const now = this.#clampNow(input.now);
    if (this.#clockPosture() === "recovery-required") {
      throw new ManagedRootGrantError(
        "unavailable",
        "Managed-root grant issuance is unavailable while host time recovery is required.",
      );
    }
    this.#removeExpired(now);
    let grantId: ManagedRootGrantId;
    do {
      grantId = decodeManagedRootGrantId(this.#uuid());
    } while (this.#records.has(grantId));
    const expiresAt = now + MANAGED_ROOT_GRANT_TTL_MS;
    this.#records.set(grantId, { ...input, expiresAt });
    return { grantId, expiresAt };
  }

  consume(input: {
    readonly grantId: string;
    readonly authenticatedWindowId: WindowId;
    readonly projectId: ProjectId;
    readonly bindingRevisionId: BindingRevisionId;
    readonly repositoryId: CodeRepositoryId;
    readonly parent: ManagedRootParent;
    readonly targetPath: string;
    readonly now: number;
  }): ManagedRootGrantBinding {
    let grantId: ManagedRootGrantId;
    try {
      grantId = decodeManagedRootGrantId(input.grantId);
    } catch {
      throw new ManagedRootGrantError("unauthorized", "Managed-root grant is invalid.");
    }
    const record = this.#records.get(grantId);
    if (record === undefined) {
      throw new ManagedRootGrantError("unauthorized", "Managed-root grant is invalid.");
    }
    const now = this.#clampNow(input.now);
    if (now >= record.expiresAt) {
      this.#records.delete(grantId);
      throw new ManagedRootGrantError("unavailable", "Managed-root grant has expired.");
    }
    if (
      record.windowId !== input.authenticatedWindowId ||
      record.projectId !== input.projectId ||
      record.bindingRevisionId !== input.bindingRevisionId ||
      record.repositoryId !== input.repositoryId ||
      !sameParent(record.parent, input.parent) ||
      record.targetPath !== input.targetPath
    ) {
      throw new ManagedRootGrantError("unauthorized", "Managed-root grant is invalid.");
    }
    this.#records.delete(grantId);
    return { parent: record.parent, targetPath: record.targetPath };
  }

  revokeWindow(windowId: WindowId): void {
    for (const [grantId, record] of this.#records) {
      if (record.windowId === windowId) this.#records.delete(grantId);
    }
  }

  revokeProjectBinding(projectId: ProjectId, bindingRevisionId: BindingRevisionId): void {
    for (const [grantId, record] of this.#records) {
      if (record.projectId === projectId && record.bindingRevisionId === bindingRevisionId) {
        this.#records.delete(grantId);
      }
    }
  }

  #removeExpired(now: number): void {
    for (const [grantId, record] of this.#records) {
      if (now >= record.expiresAt) this.#records.delete(grantId);
    }
  }
}

function sameParent(left: ManagedRootParent, right: ManagedRootParent): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.identity.device === right.identity.device &&
    left.identity.inode === right.identity.inode
  );
}
