import { MAX_BROWSER_DOWNLOAD_FILE_BYTES } from "@octant/contracts/browser-download";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { browserProfileKey } from "@octant/domain";
import {
  decodeUtcTimestamp,
  sameToolActionAuthority,
  type AutomationId,
  type StoredBrowserProfile,
  type WindowId,
  type ApprovedWorkingFolder,
  type ProjectWorkingFolderId,
} from "@octant/contracts";
import {
  decodeBrowserDownloadPermissionId,
  decodeBrowserDownloadReviewId,
  type BrowserDownloadPermission,
  type BrowserDownloadPermissionChanged,
  type BrowserDownloadPermissionsCommand,
  type BrowserDownloadPermissionsResult,
} from "@octant/contracts/browser-download-permissions";
import type { BrowserSessionTarget } from "@octant/contracts/browser-session-grants";
import type { CurrentBrowserSessionTarget } from "./browserSessionGrants";
import type {
  BrowserDownloadFacts,
  BrowserDownloadDirectoryIdentity,
  BrowserDownloadDestination,
  BrowserDownloadSaveDecision,
} from "./browserDownloadSave";
import { secretGuardRefusal } from "../process/secretGuard";

export interface BrowserDownloadRecipient {
  readonly recipient: CurrentBrowserSessionTarget;
  readonly folders: ReadonlyArray<ApprovedWorkingFolder>;
  readonly rootFor: (id: ProjectWorkingFolderId) => string | undefined;
}
interface Row {
  readonly permission: BrowserDownloadPermission;
  readonly revision: string;
  readonly rootSource: string;
  readonly root: string;
  readonly rootIdentity: BrowserDownloadDirectoryIdentity;
  readonly directoryIdentity: BrowserDownloadDirectoryIdentity;
  readonly stop: AbortController;
  remainingFiles: number;
  remainingBytes: number;
}
interface Options {
  readonly now: () => number;
  readonly uuid: () => string;
  readonly isLocalWindow: (id: WindowId) => boolean;
  readonly canReview: (id: WindowId, target: BrowserSessionTarget) => boolean;
  readonly current: (id: AutomationId) => BrowserDownloadRecipient | undefined;
  readonly targets: () => ReadonlyArray<BrowserDownloadRecipient>;
  readonly record: (event: BrowserDownloadPermissionChanged) => void;
}
const refused = (reason: string, message: string): BrowserDownloadPermissionsResult => ({
  kind: "download-permission-refused",
  reason,
  message,
});
const sameTarget = (a: BrowserSessionTarget, b: BrowserSessionTarget) =>
  JSON.stringify(a.grantee) === JSON.stringify(b.grantee) &&
  a.modelId === b.modelId &&
  sameToolActionAuthority(a.authority, b.authority);
const sameIdentity = (a: BrowserDownloadDirectoryIdentity, b: BrowserDownloadDirectoryIdentity) =>
  a.device === b.device && a.inode === b.inode;

export interface BrowserDownloadPermissionUse {
  readonly destination: BrowserDownloadDestination;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly inspect: (facts: BrowserDownloadFacts, origin: string) => BrowserDownloadSaveDecision;
  readonly reserve: (facts: BrowserDownloadFacts, origin: string) => BrowserDownloadSaveDecision;
}

/** A reviewed destination and finite file budget; account permission stays separate. */
export class BrowserDownloadPermissions {
  readonly #options: Options;
  readonly #permissions = new Map<string, Row>();
  readonly #reviews = new Map<
    string,
    { readonly row: Row; readonly windowId: WindowId; readonly expires: number }
  >();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(options: Options) {
    this.#options = options;
  }
  async execute(
    windowId: WindowId,
    command: BrowserDownloadPermissionsCommand,
  ): Promise<BrowserDownloadPermissionsResult> {
    if (!this.#options.isLocalWindow(windowId))
      return refused("not-local", "Download manifests are reviewed only on the execution host.");
    this.revalidate();
    if (command.kind === "targets")
      return {
        kind: "download-permission-targets",
        targets: this.#options
          .targets()
          .filter((row) => this.#options.canReview(windowId, row.recipient.target))
          .slice(0, 256)
          .map((row) => ({ target: row.recipient.target, folders: folderChoices(row) })),
      };
    if (command.kind === "list")
      return {
        kind: "download-permissions",
        permissions: [...this.#permissions.values()]
          .filter((row) => this.#options.canReview(windowId, row.permission.target))
          .map((row) => ({
            permission: row.permission,
            remainingFiles: row.remainingFiles,
            remainingBytes: row.remainingBytes,
          })),
      };
    if (command.kind === "revoke") {
      const row = this.#permissions.get(command.permissionId);
      if (row === undefined || !this.#options.canReview(windowId, row.permission.target))
        return refused("stale", "That download permission is no longer available.");
      this.#remove(row, "revoked", windowId);
      return { kind: "download-permission-revoked", permissionId: command.permissionId };
    }
    if (command.kind === "review") {
      if (this.#reviews.size >= 256)
        return refused("limit", "Finish an existing download review first.");
      const current = this.#options.current(command.routineId);
      const rootSource = current?.rootFor(command.folderId);
      const folder =
        current === undefined
          ? undefined
          : folderChoices(current).find((item) => String(item.id) === String(command.folderId));
      if (
        current === undefined ||
        current.recipient.target.grantee.kind !== "routine" ||
        current.recipient.target.authority.mode === "chat" ||
        rootSource === undefined ||
        folder === undefined ||
        !this.#options.canReview(windowId, current.recipient.target)
      )
        return refused("unavailable", "Choose a current routine and one of its approved folders.");
      if (
        command.profile.kind === "project" &&
        String(command.profile.projectId) !== String(current.recipient.target.authority.projectId)
      )
        return refused("invalid", "Choose a profile belonging to this routine's Project.");
      try {
        const proof = await destinationProof(rootSource, command.directory);
        if (proof === undefined)
          return refused(
            "folder-unavailable",
            "Choose an existing permitted directory inside the approved folder, without links.",
          );
        const refreshed = this.#options.current(command.routineId);
        if (
          !this.#options.isLocalWindow(windowId) ||
          refreshed === undefined ||
          refreshed.recipient.revision !== current.recipient.revision ||
          !sameTarget(refreshed.recipient.target, current.recipient.target) ||
          refreshed.rootFor(command.folderId) !== rootSource ||
          !this.#options.canReview(windowId, refreshed.recipient.target)
        )
          return refused("stale", "The routine or approved folder changed. Review again.");
        const now = this.#options.now();
        const {
          kind: _kind,
          routineId: _routineId,
          folderId: _folderId,
          durationMinutes,
          ...selection
        } = command;
        const row: Row = {
          permission: {
            ...selection,
            permissionId: decodeBrowserDownloadPermissionId(this.#options.uuid()),
            target: current.recipient.target,
            folder,
            recipientRevisionDigest: `sha256:${createHash("sha256").update(current.recipient.revision).digest("hex")}`,
            grantedAt: decodeUtcTimestamp(new Date(now).toISOString()),
            expiresAt: decodeUtcTimestamp(new Date(now + durationMinutes * 60_000).toISOString()),
          },
          revision: current.recipient.revision,
          rootSource,
          ...proof,
          stop: new AbortController(),
          remainingFiles: command.maxFiles,
          remainingBytes: command.maxBytes,
        };
        const reviewId = decodeBrowserDownloadReviewId(this.#options.uuid());
        this.#reviews.set(reviewId, { row, windowId, expires: now + 120_000 });
        return { kind: "download-permission-review", reviewId, permission: row.permission };
      } catch {
        return refused(
          "folder-unavailable",
          "Choose an existing permitted directory inside the approved folder, without links.",
        );
      }
    }
    const review = this.#reviews.get(command.reviewId);
    if (review === undefined || String(review.windowId) !== String(windowId))
      return refused("stale", "That download review ended or belongs to another window.");
    const current = await this.#destinationCurrent(review.row);
    if (this.#reviews.get(command.reviewId) === review) this.#reviews.delete(command.reviewId);
    else return refused("stale", "The review changed. Review again.");
    if (
      !current ||
      review.expires <= this.#options.now() ||
      !this.#current(review.row) ||
      !this.#options.isLocalWindow(windowId) ||
      !this.#options.canReview(windowId, review.row.permission.target) ||
      this.#permissions.size >= 256
    )
      return refused("stale", "The destination, review or authority changed. Review again.");
    try {
      this.#record(review.row, "granted", windowId);
    } catch {
      return refused("record-failed", "The permission could not be recorded. Nothing was granted.");
    }
    this.#permissions.set(review.row.permission.permissionId, review.row);
    this.#schedule(review.row);
    return { kind: "download-permission-granted", permission: review.row.permission };
  }
  choices(target: BrowserSessionTarget, profile: StoredBrowserProfile) {
    this.revalidate();
    return [...this.#permissions.values()]
      .filter(
        (row) =>
          sameTarget(row.permission.target, target) &&
          browserProfileKey(row.permission.profile) === browserProfileKey(profile),
      )
      .map((row) => ({
        permissionId: row.permission.permissionId,
        origin: row.permission.origin,
        sourceOrigins: row.permission.sourceOrigins,
        folder: row.permission.folder,
        directory: row.permission.directory,
        mediaTypes: row.permission.mediaTypes,
        remainingFiles: row.remainingFiles,
        remainingBytes: row.remainingBytes,
        expiresAt: row.permission.expiresAt,
      }));
  }
  async prepare(input: {
    readonly permissionId: string;
    readonly target: BrowserSessionTarget;
    readonly profile: StoredBrowserProfile;
    readonly callerIsCurrent: () => boolean;
  }): Promise<BrowserDownloadPermissionUse | undefined> {
    this.revalidate();
    const row = this.#permissions.get(input.permissionId);
    if (
      row === undefined ||
      !sameTarget(row.permission.target, input.target) ||
      browserProfileKey(row.permission.profile) !== browserProfileKey(input.profile) ||
      !input.callerIsCurrent()
    )
      return undefined;
    if (!(await this.#destinationCurrent(row))) {
      this.#remove(row, "changed");
      return undefined;
    }
    const isCurrent = () =>
      this.#permissions.get(input.permissionId) === row &&
      this.#current(row) &&
      input.callerIsCurrent();
    if (!isCurrent()) return undefined;
    const inspect = (facts: BrowserDownloadFacts, origin: string): "approved" | "denied" =>
      isCurrent() &&
      origin === row.permission.origin &&
      facts.source?.kind === "https-origin-chain" &&
      facts.source.origins.length > 0 &&
      facts.source.origins.every((value) => row.permission.sourceOrigins.includes(value)) &&
      row.permission.mediaTypes.some((type) => type === facts.mediaType) &&
      Number.isSafeInteger(facts.sizeBytes) &&
      facts.sizeBytes >= 0 &&
      facts.sizeBytes <= MAX_BROWSER_DOWNLOAD_FILE_BYTES &&
      row.remainingFiles > 0 &&
      facts.sizeBytes <= row.remainingBytes
        ? "approved"
        : "denied";
    return {
      destination: {
        folder: row.permission.folder,
        canonicalRoot: row.root,
        directory: row.permission.directory,
        reviewedRoot: row.rootIdentity,
        reviewedDirectory: row.directoryIdentity,
        current: isCurrent,
      },
      signal: row.stop.signal,
      isCurrent,
      inspect,
      reserve: (facts: BrowserDownloadFacts, origin: string) => {
        if (inspect(facts, origin) !== "approved") return "denied" as const;
        // A synchronous durable reservation precedes native dispatch. An unknown
        // effect is not refunded and cannot silently dispatch a second copy.
        const files = row.remainingFiles;
        const bytes = row.remainingBytes;
        row.remainingFiles -= 1;
        row.remainingBytes -= facts.sizeBytes;
        try {
          this.#record(row, "consumed");
        } catch {
          row.remainingFiles = files;
          row.remainingBytes = bytes;
          return "denied" as const;
        }
        return "approved" as const;
      },
    };
  }
  revalidate(): void {
    for (const [id, review] of this.#reviews)
      if (review.expires <= this.#options.now() || !this.#current(review.row))
        this.#reviews.delete(id);
    for (const row of this.#permissions.values())
      if (!this.#current(row))
        this.#remove(
          row,
          Date.parse(row.permission.expiresAt) <= this.#options.now() ? "expired" : "changed",
        );
  }
  revokeWindow(windowId: WindowId): void {
    for (const [id, review] of this.#reviews)
      if (String(review.windowId) === String(windowId)) this.#reviews.delete(id);
  }
  invalidateProfile(profile: StoredBrowserProfile): void {
    for (const [id, review] of this.#reviews)
      if (browserProfileKey(review.row.permission.profile) === browserProfileKey(profile))
        this.#reviews.delete(id);
    for (const row of this.#permissions.values())
      if (browserProfileKey(row.permission.profile) === browserProfileKey(profile))
        this.#remove(row, "changed");
  }
  forgetProject(projectId: string): void {
    for (const [id, review] of this.#reviews)
      if (String(review.row.permission.target.authority.projectId) === projectId)
        this.#reviews.delete(id);
    for (const row of this.#permissions.values())
      if (String(row.permission.target.authority.projectId) === projectId) {
        this.#permissions.delete(row.permission.permissionId);
        row.stop.abort();
        clearTimeout(this.#timers.get(row.permission.permissionId));
        this.#timers.delete(row.permission.permissionId);
      }
  }
  close(): void {
    this.#reviews.clear();
    for (const row of this.#permissions.values()) this.#remove(row, "revoked");
  }
  #current(row: Row): boolean {
    const grantee = row.permission.target.grantee;
    const current =
      grantee.kind === "routine" ? this.#options.current(grantee.routineId) : undefined;
    return (
      !row.stop.signal.aborted &&
      Date.parse(row.permission.expiresAt) > this.#options.now() &&
      current !== undefined &&
      current.recipient.revision === row.revision &&
      sameTarget(current.recipient.target, row.permission.target) &&
      current.rootFor(row.permission.folder.id) === row.rootSource
    );
  }
  async #destinationCurrent(row: Row): Promise<boolean> {
    try {
      const proof = await destinationProof(row.rootSource, row.permission.directory);
      return (
        proof !== undefined &&
        proof.root === row.root &&
        sameIdentity(proof.rootIdentity, row.rootIdentity) &&
        sameIdentity(proof.directoryIdentity, row.directoryIdentity)
      );
    } catch {
      return false;
    }
  }
  #record(row: Row, kind: BrowserDownloadPermissionChanged["kind"], windowId?: WindowId): void {
    this.#options.record({
      kind,
      permission: row.permission,
      remainingFiles: row.remainingFiles,
      remainingBytes: row.remainingBytes,
      ...(windowId === undefined ? {} : { windowId }),
    });
  }
  #remove(row: Row, kind: "revoked" | "expired" | "changed", windowId?: WindowId): void {
    if (this.#permissions.get(row.permission.permissionId) !== row) return;
    this.#permissions.delete(row.permission.permissionId);
    row.stop.abort();
    clearTimeout(this.#timers.get(row.permission.permissionId));
    this.#timers.delete(row.permission.permissionId);
    try {
      this.#record(row, kind, windowId);
    } catch {
      /* Revocation wins over audit failure; restart restores no permission. */
    }
  }
  #schedule(row: Row): void {
    const remaining = Date.parse(row.permission.expiresAt) - this.#options.now();
    if (remaining <= 0) {
      this.#remove(row, "expired");
      return;
    }
    const timer = setTimeout(
      () => {
        this.#timers.delete(row.permission.permissionId);
        this.revalidate();
        if (this.#permissions.get(row.permission.permissionId) === row) this.#schedule(row);
      },
      Math.min(remaining, 2_147_483_647),
    );
    timer.unref?.();
    this.#timers.set(row.permission.permissionId, timer);
  }
}
async function destinationProof(source: string, directory: string) {
  try {
    const root = await realpath(source);
    if (secretGuardRefusal(root) !== undefined) return undefined;
    const rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory()) return undefined;
    let path = root;
    for (const component of directory === "." ? [] : directory.split("/")) {
      if (component === "" || component === "." || component === ".." || component.includes("\\"))
        return undefined;
      path = join(path, component);
      if (secretGuardRefusal(path) !== undefined) return undefined;
      const status = await lstat(path);
      if (!status.isDirectory() || status.isSymbolicLink()) return undefined;
    }
    const actual = await realpath(path);
    if (actual !== path) return undefined;
    const stat = await lstat(path, { bigint: true });
    return {
      root,
      rootIdentity: { device: rootStat.dev.toString(), inode: rootStat.ino.toString() },
      directoryIdentity: { device: stat.dev.toString(), inode: stat.ino.toString() },
    };
  } catch {
    return undefined;
  }
}
function folderChoices(current: BrowserDownloadRecipient): ReadonlyArray<ApprovedWorkingFolder> {
  let extra = 0;
  return current.folders.map((folder) =>
    folder.kind === "main"
      ? { ...folder, label: "Main folder" }
      : {
          ...folder,
          label: `Extra folder ${++extra}: ${basename(current.rootFor(folder.id) ?? "Unavailable").slice(0, 200) || "Root"}`,
        },
  );
}
