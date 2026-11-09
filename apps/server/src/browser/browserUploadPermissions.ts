import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { browserProfileKey } from "@octant/domain";
import {
  decodeCodeRelativePath,
  decodeUtcTimestamp,
  sameToolActionAuthority,
  type AutomationId,
  type StoredBrowserProfile,
  type WindowId,
  type ApprovedWorkingFolder,
  type ProjectWorkingFolderId,
} from "@octant/contracts";
import {
  decodeBrowserUploadPermissionId,
  decodeBrowserUploadReviewId,
  type BrowserUploadPermission,
  type BrowserUploadPermissionChanged,
  type BrowserUploadPermissionsCommand,
  type BrowserUploadPermissionsResult,
} from "@octant/contracts/browser-upload-permissions";
import type { BrowserSessionTarget } from "@octant/contracts/browser-session-grants";
import { prepareBrowserUpload, type BrowserUploadFile } from "./browserUploadFiles";
import type { CurrentBrowserSessionTarget } from "./browserSessionGrants";
import { secretGuardRefusal } from "../process/secretGuard";

export interface BrowserUploadRecipient {
  readonly recipient: CurrentBrowserSessionTarget;
  readonly folders: ReadonlyArray<ApprovedWorkingFolder>;
  readonly rootFor: (folderId: ProjectWorkingFolderId) => string | undefined;
}
interface PermissionRow {
  readonly permission: BrowserUploadPermission;
  readonly revision: string;
  readonly rootSource: string;
  readonly root: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly files: ReadonlyArray<BrowserUploadFile>;
  readonly stop: AbortController;
  remainingFiles: number;
  remainingBytes: number;
}
interface PendingReview {
  readonly row: PermissionRow;
  readonly windowId: WindowId;
  readonly expires: number;
}
interface Options {
  readonly now: () => number;
  readonly uuid: () => string;
  readonly isLocalWindow: (id: WindowId) => boolean;
  readonly canReview: (id: WindowId, target: BrowserSessionTarget) => boolean;
  readonly targets: () => ReadonlyArray<BrowserUploadRecipient>;
  readonly current: (id: AutomationId) => BrowserUploadRecipient | undefined;
  readonly record: (event: BrowserUploadPermissionChanged) => void;
}
const refused = (reason: string, message: string): BrowserUploadPermissionsResult => ({
  kind: "upload-permission-refused",
  reason,
  message,
});
const sameTarget = (a: BrowserSessionTarget, b: BrowserSessionTarget) =>
  JSON.stringify(a.grantee) === JSON.stringify(b.grantee) &&
  a.modelId === b.modelId &&
  sameToolActionAuthority(a.authority, b.authority);

/** Separate, finite file authority. Account permission alone never satisfies it. */
export class BrowserUploadPermissions {
  readonly #options: Options;
  readonly #permissions = new Map<string, PermissionRow>();
  readonly #reviews = new Map<string, PendingReview>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(options: Options) {
    this.#options = options;
  }

  async execute(
    windowId: WindowId,
    command: BrowserUploadPermissionsCommand,
  ): Promise<BrowserUploadPermissionsResult> {
    if (!this.#options.isLocalWindow(windowId))
      return refused("not-local", "Upload manifests are reviewed only on the execution host.");
    this.revalidate();
    if (command.kind === "targets")
      return {
        kind: "upload-permission-targets",
        targets: this.#options
          .targets()
          .filter((row) => this.#options.canReview(windowId, row.recipient.target))
          .slice(0, 256)
          .map((row) => ({ target: row.recipient.target, folders: uploadFolderChoices(row) })),
      };
    if (command.kind === "list")
      return {
        kind: "upload-permissions",
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
        return refused("stale", "That upload permission is no longer available.");
      this.#remove(row, "revoked", windowId);
      return { kind: "upload-permission-revoked", permissionId: command.permissionId };
    }
    if (command.kind === "review") {
      if (this.#reviews.size >= 256)
        return refused("limit", "Finish an existing upload review first.");
      const current = this.#options.current(command.routineId);
      const rootSource = current?.rootFor(command.folderId);
      const folder =
        current === undefined
          ? undefined
          : uploadFolderChoices(current).find((row) => String(row.id) === String(command.folderId));
      if (
        current === undefined ||
        current.recipient.target.grantee.kind !== "routine" ||
        current.recipient.target.authority.mode === "chat" ||
        rootSource === undefined ||
        folder === undefined ||
        !this.#options.canReview(windowId, current.recipient.target)
      )
        return refused("unavailable", "Choose a current routine and one of its approved folders.");
      let origin: URL;
      try {
        origin = new URL(command.origin);
      } catch {
        return refused("invalid", "Choose one exact HTTPS origin.");
      }
      if (
        origin.protocol !== "https:" ||
        origin.origin !== command.origin ||
        origin.username !== "" ||
        origin.password !== "" ||
        (command.profile.kind === "project" &&
          String(command.profile.projectId) !==
            String(current.recipient.target.authority.projectId))
      )
        return refused("invalid", "Choose this routine's profile and one exact HTTPS origin.");
      if (
        new Set(command.files).size !== command.files.length ||
        command.files.some((path) => secretGuardRefusal(resolve(rootSource, path)) !== undefined)
      )
        return refused("invalid", "Choose distinct permitted files from the approved folder.");
      const prepared = await prepareBrowserUpload({
        workspaceRoot: rootSource,
        files: command.files,
      });
      if (prepared.status !== "prepared")
        return refused("files-unavailable", "The selected files could not be safely prepared.");
      try {
        const root = await realpath(rootSource);
        const rootStat = await lstat(root, { bigint: true });
        const refreshed = this.#options.current(command.routineId);
        if (
          !this.#options.isLocalWindow(windowId) ||
          refreshed === undefined ||
          refreshed.recipient.revision !== current.recipient.revision ||
          refreshed.rootFor(command.folderId) !== rootSource ||
          !this.#options.canReview(windowId, refreshed.recipient.target) ||
          !rootStat.isDirectory() ||
          prepared.files.some((file) => file.linkCount !== 1)
        )
          return refused("stale", "The routine, folder or file identity changed. Review again.");
        const files = prepared.files.map((file) => ({
          path: decodeCodeRelativePath(relative(root, file.path).split(sep).join("/")),
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          fileType: extname(file.name).toLowerCase(),
        }));
        if (
          files.reduce((sum, file) => sum + file.sizeBytes, 0) > command.maxBytes ||
          files.length > command.maxFiles
        )
          return refused("quota", "The manifest's files exceed its reviewed byte or count limit.");
        if (files.some((file) => file.fileType.length > 32))
          return refused("invalid", "Choose files with an extension of at most 32 characters.");
        const now = this.#options.now();
        const row: PermissionRow = {
          permission: {
            permissionId: decodeBrowserUploadPermissionId(this.#options.uuid()),
            target: current.recipient.target,
            recipientRevisionDigest: `sha256:${createHash("sha256").update(current.recipient.revision).digest("hex")}`,
            profile: command.profile,
            origin: command.origin,
            folder,
            files,
            maxFiles: command.maxFiles,
            maxBytes: command.maxBytes,
            grantedAt: decodeUtcTimestamp(new Date(now).toISOString()),
            expiresAt: decodeUtcTimestamp(
              new Date(now + command.durationMinutes * 60_000).toISOString(),
            ),
          },
          revision: current.recipient.revision,
          rootSource,
          root,
          rootDevice: rootStat.dev.toString(),
          rootInode: rootStat.ino.toString(),
          files: prepared.files,
          stop: new AbortController(),
          remainingFiles: command.maxFiles,
          remainingBytes: command.maxBytes,
        };
        const reviewId = decodeBrowserUploadReviewId(this.#options.uuid());
        this.#reviews.set(reviewId, { row, windowId, expires: now + 2 * 60_000 });
        return { kind: "upload-permission-review", reviewId, permission: row.permission };
      } catch {
        return refused("files-unavailable", "The selected folder or files changed during review.");
      } finally {
        await prepared.release();
      }
    }
    const review = this.#reviews.get(command.reviewId);
    if (review === undefined || String(review.windowId) !== String(windowId))
      return refused("stale", "That upload review has ended or belongs to another window.");
    if (
      review.expires <= this.#options.now() ||
      !this.#current(review.row) ||
      !this.#options.canReview(windowId, review.row.permission.target) ||
      this.#permissions.size >= 256
    )
      return refused("stale", "The upload review expired or its authority changed.");
    const rootCurrent = await this.#rootCurrent(review.row);
    const retained = this.#reviews.get(command.reviewId) === review;
    if (retained) this.#reviews.delete(command.reviewId);
    if (
      !rootCurrent ||
      !retained ||
      review.expires <= this.#options.now() ||
      !this.#options.isLocalWindow(windowId) ||
      !this.#options.canReview(windowId, review.row.permission.target) ||
      !this.#current(review.row)
    )
      return refused("stale", "The selected folder or review changed. Review again.");
    try {
      this.#record(review.row, "granted", windowId);
    } catch {
      return refused("record-failed", "The permission could not be recorded. Nothing was granted.");
    }
    this.#permissions.set(review.row.permission.permissionId, review.row);
    this.#schedule(review.row);
    return { kind: "upload-permission-granted", permission: review.row.permission };
  }

  choices(target: BrowserSessionTarget, profile: StoredBrowserProfile, origin: string) {
    this.revalidate();
    return [...this.#permissions.values()]
      .filter(
        (row) =>
          sameTarget(row.permission.target, target) &&
          browserProfileKey(row.permission.profile) === browserProfileKey(profile) &&
          row.permission.origin === origin,
      )
      .map((row) => ({
        permissionId: row.permission.permissionId,
        folder: row.permission.folder,
        files: row.permission.files.map((file) => file.path),
        remainingFiles: row.remainingFiles,
        remainingBytes: row.remainingBytes,
        expiresAt: row.permission.expiresAt,
      }));
  }

  prepare(input: {
    readonly permissionId: string;
    readonly target: BrowserSessionTarget;
    readonly profile: StoredBrowserProfile;
    readonly origin: string;
    readonly files: ReadonlyArray<string>;
    readonly callerIsCurrent: () => boolean;
  }) {
    this.revalidate();
    const row = this.#permissions.get(input.permissionId);
    if (
      row === undefined ||
      !sameTarget(row.permission.target, input.target) ||
      browserProfileKey(row.permission.profile) !== browserProfileKey(input.profile) ||
      row.permission.origin !== input.origin ||
      !input.callerIsCurrent() ||
      new Set(input.files).size !== input.files.length ||
      !input.files.every((path) => row.permission.files.some((file) => String(file.path) === path))
    )
      return undefined;
    return {
      workspaceRoot: row.root,
      signal: row.stop.signal,
      isCurrent: () =>
        this.#permissions.get(input.permissionId) === row &&
        this.#current(row) &&
        input.callerIsCurrent(),
      approve: async (files: ReadonlyArray<BrowserUploadFile>) => {
        if (!(await this.#rootCurrent(row))) {
          this.#remove(row, "changed");
          return "denied" as const;
        }
        if (
          this.#permissions.get(input.permissionId) !== row ||
          !this.#current(row) ||
          !input.callerIsCurrent() ||
          files.length !== input.files.length ||
          files.length === 0
        )
          return "denied" as const;
        const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
        if (files.length > row.remainingFiles || bytes > row.remainingBytes)
          return "denied" as const;
        if (
          files.some((file) => {
            const expected = row.files.find((candidate) => candidate.path === file.path);
            return (
              !input.files.includes(relative(row.root, file.path).split(sep).join("/")) ||
              expected === undefined ||
              file.device !== expected.device ||
              file.inode !== expected.inode ||
              file.linkCount !== 1 ||
              file.sizeBytes !== expected.sizeBytes ||
              file.sha256 === undefined ||
              file.sha256 !== expected.sha256
            );
          })
        ) {
          this.#remove(row, "changed");
          return "denied" as const;
        }
        // Synchronous journal-before-effect reservation makes concurrent uploads
        // share one remaining budget. Unknown/dispatched effects are never refunded.
        const beforeFiles = row.remainingFiles;
        const beforeBytes = row.remainingBytes;
        row.remainingFiles -= files.length;
        row.remainingBytes -= bytes;
        try {
          this.#record(
            row,
            "consumed",
            undefined,
            input.files.map((path) => decodeCodeRelativePath(path)),
          );
        } catch {
          row.remainingFiles = beforeFiles;
          row.remainingBytes = beforeBytes;
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
  /** Project erase must neither retain this authority nor recreate its erased audit. */
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
  #current(row: PermissionRow): boolean {
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
  async #rootCurrent(row: PermissionRow): Promise<boolean> {
    try {
      const root = await realpath(row.rootSource);
      const stat = await lstat(root, { bigint: true });
      return (
        root === row.root &&
        stat.isDirectory() &&
        stat.dev.toString() === row.rootDevice &&
        stat.ino.toString() === row.rootInode
      );
    } catch {
      return false;
    }
  }
  #record(
    row: PermissionRow,
    kind: BrowserUploadPermissionChanged["kind"],
    windowId?: WindowId,
    transferredFiles?: BrowserUploadPermissionChanged["transferredFiles"],
  ) {
    this.#options.record({
      kind,
      ...(transferredFiles === undefined ? {} : { transferredFiles }),
      permission: row.permission,
      remainingFiles: row.remainingFiles,
      remainingBytes: row.remainingBytes,
      ...(windowId === undefined ? {} : { windowId }),
    });
  }
  #remove(row: PermissionRow, kind: "revoked" | "expired" | "changed", windowId?: WindowId) {
    if (this.#permissions.get(row.permission.permissionId) !== row) return;
    this.#permissions.delete(row.permission.permissionId);
    row.stop.abort();
    clearTimeout(this.#timers.get(row.permission.permissionId));
    this.#timers.delete(row.permission.permissionId);
    try {
      this.#record(row, kind, windowId);
    } catch {
      /* Authority ended even if its audit write failed; restart restores none. */
    }
  }
  #schedule(row: PermissionRow) {
    const remaining = Date.parse(row.permission.expiresAt) - this.#options.now();
    if (remaining <= 0) {
      this.#remove(row, "expired");
      return;
    }
    const timer = setTimeout(
      () => {
        this.#timers.delete(row.permission.permissionId);
        if (this.#permissions.get(row.permission.permissionId) !== row) return;
        this.revalidate();
        if (this.#permissions.get(row.permission.permissionId) === row) this.#schedule(row);
      },
      Math.min(remaining, 2_147_483_647),
    );
    timer.unref?.();
    this.#timers.set(row.permission.permissionId, timer);
  }
}

/** Existing folder-picker labels may be absolute when basenames collide. */
function uploadFolderChoices(
  current: BrowserUploadRecipient,
): ReadonlyArray<ApprovedWorkingFolder> {
  let extra = 0;
  return current.folders.map((folder) => {
    if (folder.kind === "main") return { ...folder, label: "Main folder" };
    extra += 1;
    const root = current.rootFor(folder.id);
    return {
      ...folder,
      label: `Extra folder ${extra}: ${root === undefined ? "Unavailable" : basename(root).slice(0, 200) || "Root"}`,
    };
  });
}
