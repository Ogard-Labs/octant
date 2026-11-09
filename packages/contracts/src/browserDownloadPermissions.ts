import { Schema } from "effect";
import { AutomationId } from "./automation";
import { StoredBrowserProfile } from "./browserProfiles";
import { BrowserSessionTarget } from "./browserSessionGrants";
import {
  ApprovedWorkingFolder,
  ProjectWorkingFolderId,
  ThreadWorkingDirectory,
} from "./workingDirectory";
import { UtcTimestamp } from "./events";
import { WindowId } from "./shell";
import { MAX_BROWSER_DOWNLOAD_FILE_BYTES } from "./browserDownload";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Recipient = BrowserSessionTarget.pipe(
  Schema.filter((target) => target.grantee.kind === "routine" && target.authority.mode !== "chat"),
);
const Origin = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(2048),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }),
);
const Origins = Schema.Array(Origin).pipe(
  Schema.minItems(1),
  Schema.maxItems(32),
  Schema.filter((values) => new Set(values).size === values.length),
);
export const BrowserDownloadPermissionMediaType = Schema.Literal(
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/zip",
  "application/gzip",
  "text/html",
  "application/xml",
);
const MediaTypes = Schema.Array(BrowserDownloadPermissionMediaType).pipe(
  Schema.minItems(1),
  Schema.maxItems(10),
  Schema.filter((values) => new Set(values).size === values.length),
);
export const MAX_BROWSER_DOWNLOAD_PERMISSION_FILES = 100;
export const MAX_BROWSER_DOWNLOAD_PERMISSION_BYTES = 10 * MAX_BROWSER_DOWNLOAD_FILE_BYTES;
export const BrowserDownloadPermissionId = Schema.UUID.pipe(
  Schema.brand("BrowserDownloadPermissionId"),
);
export const BrowserDownloadReviewId = Schema.UUID.pipe(Schema.brand("BrowserDownloadReviewId"));
const limits = {
  maxFiles: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_DOWNLOAD_PERMISSION_FILES)),
  maxBytes: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_DOWNLOAD_PERMISSION_BYTES)),
};
const selection = {
  profile: StoredBrowserProfile,
  origin: Origin,
  sourceOrigins: Origins,
  directory: ThreadWorkingDirectory,
  mediaTypes: MediaTypes,
  ...limits,
};
export const BrowserDownloadPermission = Schema.Struct({
  permissionId: BrowserDownloadPermissionId,
  target: Recipient,
  recipientRevisionDigest: Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/)),
  ...selection,
  folder: ApprovedWorkingFolder,
  grantedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type BrowserDownloadPermission = typeof BrowserDownloadPermission.Type;
export const BrowserDownloadPermissionsCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("targets") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("review"),
    routineId: AutomationId,
    folderId: ProjectWorkingFolderId,
    ...selection,
    durationMinutes: Schema.Int.pipe(Schema.between(1, 30 * 24 * 60)),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("grant"), reviewId: BrowserDownloadReviewId }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    permissionId: BrowserDownloadPermissionId,
  }).annotations(strict),
);
export type BrowserDownloadPermissionsCommand = typeof BrowserDownloadPermissionsCommand.Type;
export const BrowserDownloadPermissionsResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("download-permission-targets"),
    targets: Schema.Array(
      Schema.Struct({
        target: Recipient,
        folders: Schema.Array(ApprovedWorkingFolder).pipe(Schema.maxItems(17)),
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("download-permissions"),
    permissions: Schema.Array(
      Schema.Struct({
        permission: BrowserDownloadPermission,
        remainingFiles: Schema.Int.pipe(Schema.nonNegative()),
        remainingBytes: Schema.Int.pipe(Schema.nonNegative()),
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("download-permission-review"),
    reviewId: BrowserDownloadReviewId,
    permission: BrowserDownloadPermission,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("download-permission-granted"),
    permission: BrowserDownloadPermission,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("download-permission-revoked"),
    permissionId: BrowserDownloadPermissionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("download-permission-refused"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type BrowserDownloadPermissionsResult = typeof BrowserDownloadPermissionsResult.Type;
export const BROWSER_DOWNLOAD_PERMISSION_EVENT = "browser.download-permission-changed@1";
export const BrowserDownloadPermissionChanged = Schema.Struct({
  kind: Schema.Literal("granted", "consumed", "revoked", "expired", "changed"),
  permission: BrowserDownloadPermission,
  remainingFiles: Schema.Int.pipe(Schema.nonNegative()),
  remainingBytes: Schema.Int.pipe(Schema.nonNegative()),
  windowId: Schema.optional(WindowId),
}).annotations(strict);
export type BrowserDownloadPermissionChanged = typeof BrowserDownloadPermissionChanged.Type;
export const decodeBrowserDownloadPermissionId = Schema.decodeUnknownSync(
  BrowserDownloadPermissionId,
);
export const decodeBrowserDownloadReviewId = Schema.decodeUnknownSync(BrowserDownloadReviewId);
export const decodeBrowserDownloadPermissionsCommand = Schema.decodeUnknownSync(
  BrowserDownloadPermissionsCommand,
);
export const decodeBrowserDownloadPermissionsResult = Schema.decodeUnknownSync(
  BrowserDownloadPermissionsResult,
);
