import { Schema } from "effect";
import { AutomationId } from "./automation";
import { CodeRelativePath } from "./code";
import { StoredBrowserProfile } from "./browserProfiles";
import { BrowserSessionTarget } from "./browserSessionGrants";
import { ApprovedWorkingFolder, ProjectWorkingFolderId } from "./workingDirectory";
import { UtcTimestamp } from "./events";
import { WindowId } from "./shell";
import { MAX_BROWSER_UPLOAD_FILE_BYTES } from "./browserAutomation";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const UploadRecipient = BrowserSessionTarget.pipe(
  Schema.filter((target) => target.grantee.kind === "routine" && target.authority.mode !== "chat"),
);
export const MAX_BROWSER_UPLOAD_PERMISSION_FILES = 100;
export const MAX_BROWSER_UPLOAD_PERMISSION_BYTES = 10 * MAX_BROWSER_UPLOAD_FILE_BYTES;
export const BrowserUploadPermissionId = Schema.UUID.pipe(
  Schema.brand("BrowserUploadPermissionId"),
);
export const BrowserUploadReviewId = Schema.UUID.pipe(Schema.brand("BrowserUploadReviewId"));
export const BrowserUploadManifestFile = Schema.Struct({
  path: CodeRelativePath,
  sizeBytes: Schema.Int.pipe(Schema.between(0, MAX_BROWSER_UPLOAD_FILE_BYTES)),
  sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  fileType: Schema.String.pipe(Schema.maxLength(32)),
}).annotations(strict);
export const BrowserUploadPermission = Schema.Struct({
  permissionId: BrowserUploadPermissionId,
  target: UploadRecipient,
  recipientRevisionDigest: Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/)),
  profile: StoredBrowserProfile,
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  folder: ApprovedWorkingFolder,
  files: Schema.Array(BrowserUploadManifestFile).pipe(Schema.minItems(1), Schema.maxItems(5)),
  maxFiles: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_UPLOAD_PERMISSION_FILES)),
  maxBytes: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_UPLOAD_PERMISSION_BYTES)),
  grantedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type BrowserUploadPermission = typeof BrowserUploadPermission.Type;
export const BrowserUploadPermissionsCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("targets") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("review"),
    routineId: AutomationId,
    profile: StoredBrowserProfile,
    origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
    folderId: ProjectWorkingFolderId,
    files: Schema.Array(CodeRelativePath).pipe(Schema.minItems(1), Schema.maxItems(5)),
    maxFiles: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_UPLOAD_PERMISSION_FILES)),
    maxBytes: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_UPLOAD_PERMISSION_BYTES)),
    durationMinutes: Schema.Int.pipe(Schema.between(1, 30 * 24 * 60)),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("grant"), reviewId: BrowserUploadReviewId }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    permissionId: BrowserUploadPermissionId,
  }).annotations(strict),
);
export type BrowserUploadPermissionsCommand = typeof BrowserUploadPermissionsCommand.Type;
export const BrowserUploadPermissionsResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("upload-permission-targets"),
    targets: Schema.Array(
      Schema.Struct({
        target: UploadRecipient,
        folders: Schema.Array(ApprovedWorkingFolder).pipe(Schema.maxItems(17)),
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("upload-permissions"),
    permissions: Schema.Array(
      Schema.Struct({
        permission: BrowserUploadPermission,
        remainingFiles: Schema.Int.pipe(Schema.nonNegative()),
        remainingBytes: Schema.Int.pipe(Schema.nonNegative()),
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-review"),
    reviewId: BrowserUploadReviewId,
    permission: BrowserUploadPermission,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-granted"),
    permission: BrowserUploadPermission,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-revoked"),
    permissionId: BrowserUploadPermissionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-refused"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type BrowserUploadPermissionsResult = typeof BrowserUploadPermissionsResult.Type;
export const BROWSER_UPLOAD_PERMISSION_EVENT = "browser.upload-permission-changed@1";
export const BrowserUploadPermissionChanged = Schema.Struct({
  kind: Schema.Literal("granted", "consumed", "revoked", "expired", "changed"),
  permission: BrowserUploadPermission,
  remainingFiles: Schema.Int.pipe(Schema.nonNegative()),
  remainingBytes: Schema.Int.pipe(Schema.nonNegative()),
  transferredFiles: Schema.optional(
    Schema.Array(CodeRelativePath).pipe(Schema.minItems(1), Schema.maxItems(5)),
  ),
  windowId: Schema.optional(WindowId),
}).annotations(strict);
export type BrowserUploadPermissionChanged = typeof BrowserUploadPermissionChanged.Type;
export const decodeBrowserUploadPermissionId = Schema.decodeUnknownSync(BrowserUploadPermissionId);
export const decodeBrowserUploadReviewId = Schema.decodeUnknownSync(BrowserUploadReviewId);
export const decodeBrowserUploadPermissionsCommand = Schema.decodeUnknownSync(
  BrowserUploadPermissionsCommand,
);
export const decodeBrowserUploadPermissionsResult = Schema.decodeUnknownSync(
  BrowserUploadPermissionsResult,
);
