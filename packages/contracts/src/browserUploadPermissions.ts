import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AutomationId } from "./automation";
import { CodeRelativePath } from "./code";
import { StoredBrowserProfile } from "./browserProfiles";
import { BrowserSessionTarget } from "./browserSessionGrants";
import { ApprovedWorkingFolder, ProjectWorkingFolderId } from "./workingDirectory";
import { UtcTimestamp } from "./events";
import { WindowId } from "./shell";
import { MAX_BROWSER_UPLOAD_FILE_BYTES } from "./browserAutomation";

const UploadRecipient = BrowserSessionTarget.check(
  Schema.makeFilter(
    (target) => target.grantee.kind === "routine" && target.authority.mode !== "chat",
  ),
);
export const MAX_BROWSER_UPLOAD_PERMISSION_FILES = 100;
export const MAX_BROWSER_UPLOAD_PERMISSION_BYTES = 10 * MAX_BROWSER_UPLOAD_FILE_BYTES;
export const BrowserUploadPermissionId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserUploadPermissionId"),
);
export const BrowserUploadReviewId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserUploadReviewId"),
);
export const BrowserUploadManifestFile = Schema.Struct({
  path: CodeRelativePath,
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_BROWSER_UPLOAD_FILE_BYTES }),
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  fileType: Schema.String.check(Schema.isMaxLength(32)),
});
export const BrowserUploadPermission = Schema.Struct({
  permissionId: BrowserUploadPermissionId,
  target: UploadRecipient,
  recipientRevisionDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  profile: StoredBrowserProfile,
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  folder: ApprovedWorkingFolder,
  files: Schema.Array(BrowserUploadManifestFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  maxFiles: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_UPLOAD_PERMISSION_FILES }),
  ),
  maxBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_UPLOAD_PERMISSION_BYTES }),
  ),
  grantedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
export type BrowserUploadPermission = typeof BrowserUploadPermission.Type;
export const BrowserUploadPermissionsCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("targets") }),
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    routineId: AutomationId,
    profile: StoredBrowserProfile,
    origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    folderId: ProjectWorkingFolderId,
    files: Schema.Array(CodeRelativePath).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
    maxFiles: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_UPLOAD_PERMISSION_FILES }),
    ),
    maxBytes: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_UPLOAD_PERMISSION_BYTES }),
    ),
    durationMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 * 24 * 60 })),
  }),
  Schema.Struct({ kind: Schema.Literal("grant"), reviewId: BrowserUploadReviewId }),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    permissionId: BrowserUploadPermissionId,
  }),
]);
export type BrowserUploadPermissionsCommand = typeof BrowserUploadPermissionsCommand.Type;
export const BrowserUploadPermissionsResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("upload-permission-targets"),
    targets: Schema.Array(
      Schema.Struct({
        target: UploadRecipient,
        folders: Schema.Array(ApprovedWorkingFolder).check(Schema.isMaxLength(17)),
      }),
    ).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("upload-permissions"),
    permissions: Schema.Array(
      Schema.Struct({
        permission: BrowserUploadPermission,
        remainingFiles: NonNegativeInt,
        remainingBytes: NonNegativeInt,
      }),
    ).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-review"),
    reviewId: BrowserUploadReviewId,
    permission: BrowserUploadPermission,
  }),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-granted"),
    permission: BrowserUploadPermission,
  }),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-revoked"),
    permissionId: BrowserUploadPermissionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("upload-permission-refused"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type BrowserUploadPermissionsResult = typeof BrowserUploadPermissionsResult.Type;
export const BROWSER_UPLOAD_PERMISSION_EVENT = "browser.upload-permission-changed@1";
export const BrowserUploadPermissionChanged = Schema.Struct({
  kind: Schema.Literals(["granted", "consumed", "revoked", "expired", "changed"]),
  permission: BrowserUploadPermission,
  remainingFiles: NonNegativeInt,
  remainingBytes: NonNegativeInt,
  transferredFiles: Schema.optional(
    Schema.Array(CodeRelativePath).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  ),
  windowId: Schema.optional(WindowId),
});
export type BrowserUploadPermissionChanged = typeof BrowserUploadPermissionChanged.Type;
export const decodeBrowserUploadPermissionId = Schema.decodeUnknownSync(
  BrowserUploadPermissionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserUploadReviewId = Schema.decodeUnknownSync(
  BrowserUploadReviewId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserUploadPermissionsCommand = Schema.decodeUnknownSync(
  BrowserUploadPermissionsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserUploadPermissionsResult = Schema.decodeUnknownSync(
  BrowserUploadPermissionsResult,
  STRICT_DECODE_OPTIONS,
);
