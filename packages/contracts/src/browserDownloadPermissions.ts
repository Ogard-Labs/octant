import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

const Recipient = BrowserSessionTarget.check(
  Schema.makeFilter(
    (target) => target.grantee.kind === "routine" && target.authority.mode !== "chat",
  ),
);
const Origin = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
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
const Origins = Schema.Array(Origin).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
export const BrowserDownloadPermissionMediaType = Schema.Literals([
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
]);
const MediaTypes = Schema.Array(BrowserDownloadPermissionMediaType).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(10),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
export const MAX_BROWSER_DOWNLOAD_PERMISSION_FILES = 100;
export const MAX_BROWSER_DOWNLOAD_PERMISSION_BYTES = 10 * MAX_BROWSER_DOWNLOAD_FILE_BYTES;
export const BrowserDownloadPermissionId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserDownloadPermissionId"),
);
export const BrowserDownloadReviewId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserDownloadReviewId"),
);
const limits = {
  maxFiles: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_DOWNLOAD_PERMISSION_FILES }),
  ),
  maxBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_DOWNLOAD_PERMISSION_BYTES }),
  ),
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
  recipientRevisionDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  ...selection,
  folder: ApprovedWorkingFolder,
  grantedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
export type BrowserDownloadPermission = typeof BrowserDownloadPermission.Type;
export const BrowserDownloadPermissionsCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("targets") }),
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    routineId: AutomationId,
    folderId: ProjectWorkingFolderId,
    ...selection,
    durationMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 * 24 * 60 })),
  }),
  Schema.Struct({ kind: Schema.Literal("grant"), reviewId: BrowserDownloadReviewId }),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    permissionId: BrowserDownloadPermissionId,
  }),
]);
export type BrowserDownloadPermissionsCommand = typeof BrowserDownloadPermissionsCommand.Type;
export const BrowserDownloadPermissionsResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("download-permission-targets"),
    targets: Schema.Array(
      Schema.Struct({
        target: Recipient,
        folders: Schema.Array(ApprovedWorkingFolder).check(Schema.isMaxLength(17)),
      }),
    ).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("download-permissions"),
    permissions: Schema.Array(
      Schema.Struct({
        permission: BrowserDownloadPermission,
        remainingFiles: NonNegativeInt,
        remainingBytes: NonNegativeInt,
      }),
    ).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("download-permission-review"),
    reviewId: BrowserDownloadReviewId,
    permission: BrowserDownloadPermission,
  }),
  Schema.Struct({
    kind: Schema.Literal("download-permission-granted"),
    permission: BrowserDownloadPermission,
  }),
  Schema.Struct({
    kind: Schema.Literal("download-permission-revoked"),
    permissionId: BrowserDownloadPermissionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("download-permission-refused"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type BrowserDownloadPermissionsResult = typeof BrowserDownloadPermissionsResult.Type;
export const BROWSER_DOWNLOAD_PERMISSION_EVENT = "browser.download-permission-changed@1";
export const BrowserDownloadPermissionChanged = Schema.Struct({
  kind: Schema.Literals(["granted", "consumed", "revoked", "expired", "changed"]),
  permission: BrowserDownloadPermission,
  remainingFiles: NonNegativeInt,
  remainingBytes: NonNegativeInt,
  windowId: Schema.optional(WindowId),
});
export type BrowserDownloadPermissionChanged = typeof BrowserDownloadPermissionChanged.Type;
export const decodeBrowserDownloadPermissionId = Schema.decodeUnknownSync(
  BrowserDownloadPermissionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserDownloadReviewId = Schema.decodeUnknownSync(
  BrowserDownloadReviewId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserDownloadPermissionsCommand = Schema.decodeUnknownSync(
  BrowserDownloadPermissionsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserDownloadPermissionsResult = Schema.decodeUnknownSync(
  BrowserDownloadPermissionsResult,
  STRICT_DECODE_OPTIONS,
);
