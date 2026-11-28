import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { BindingReceiptId, ProjectId } from "./projects";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

/** Maximum number of copyable gitignored files returned and transferable per bootstrap. */
export const REPOSITORY_BOOTSTRAP_MAX_IGNORED_FILES = 200;
/** Maximum byte size of a single copyable gitignored file (2 MiB). */
export const REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Maximum combined byte size of all gitignored files copied in one bootstrap (20 MiB). */
export const REPOSITORY_BOOTSTRAP_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Maximum HTTP request body size for landing copied ignored files (4 MiB). */
export const REPOSITORY_BOOTSTRAP_LAND_FILES_MAX_BODY_BYTES = 4 * 1024 * 1024;

export const RepositoryBootstrapOperationId = brandedUuid("RepositoryBootstrapOperationId");
export type RepositoryBootstrapOperationId = typeof RepositoryBootstrapOperationId.Type;

export const RepositoryCloneTransport = Schema.Literals(["ssh", "https"]);
export type RepositoryCloneTransport = typeof RepositoryCloneTransport.Type;

export const RepositoryBootstrapFailureCode = Schema.Literals([
  "unauthorized",
  "destination-not-empty",
  "invalid-url",
  "auth-failed",
  "host-key-unverified",
  "clone-failed",
  "partial-copy",
  "cancelled",
  "not-found",
  "invalid",
  "unavailable",
]);
export type RepositoryBootstrapFailureCode = typeof RepositoryBootstrapFailureCode.Type;

export const RepositoryBootstrapCaps = Schema.Struct({
  maxFiles: PositiveInt,
  maxFileBytes: PositiveInt,
  maxTotalBytes: PositiveInt,
});
export type RepositoryBootstrapCaps = typeof RepositoryBootstrapCaps.Type;

export const RepositoryBootstrapRemoteSet = Schema.Struct({
  originUrl: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048))),
  sshUrl: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048))),
  httpsUrl: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048))),
  defaultTransport: Schema.optional(RepositoryCloneTransport),
  unavailableReason: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  ),
});
export type RepositoryBootstrapRemoteSet = typeof RepositoryBootstrapRemoteSet.Type;

export const RepositoryBootstrapIgnoredFile = Schema.Struct({
  path: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  bytes: NonNegativeInt,
  secretGuardMatched: Schema.Boolean,
});
export type RepositoryBootstrapIgnoredFile = typeof RepositoryBootstrapIgnoredFile.Type;

export const RepositoryBootstrapInspectRequest = Schema.Struct({
  projectId: ProjectId,
});
export type RepositoryBootstrapInspectRequest = typeof RepositoryBootstrapInspectRequest.Type;

export const RepositoryBootstrapInspectResult = Schema.Struct({
  projectId: ProjectId,
  projectName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  sourcePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  repositoryName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  defaultDestinationPath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  remotes: RepositoryBootstrapRemoteSet,
  ignoredFiles: Schema.Array(RepositoryBootstrapIgnoredFile).check(
    Schema.isMaxLength(REPOSITORY_BOOTSTRAP_MAX_IGNORED_FILES),
  ),
  truncated: Schema.Boolean,
  omittedCount: NonNegativeInt,
  omittedOversizedCount: NonNegativeInt,
  caps: RepositoryBootstrapCaps,
});
export type RepositoryBootstrapInspectResult = typeof RepositoryBootstrapInspectResult.Type;

export const RepositoryBootstrapReadFileRequest = Schema.Struct({
  projectId: ProjectId,
  relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
});
export type RepositoryBootstrapReadFileRequest = typeof RepositoryBootstrapReadFileRequest.Type;

export const RepositoryBootstrapReadFileResult = Schema.Struct({
  relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  bytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES),
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0o777 })),
  contentBase64: Schema.String,
});
export type RepositoryBootstrapReadFileResult = typeof RepositoryBootstrapReadFileResult.Type;

export const RepositoryBootstrapStartCloneRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
  remoteUrl: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  transport: RepositoryCloneTransport,
  destinationPath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  projectName: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
});
export type RepositoryBootstrapStartCloneRequest = typeof RepositoryBootstrapStartCloneRequest.Type;

export const RepositoryBootstrapCloneStatusRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
});
export type RepositoryBootstrapCloneStatusRequest =
  typeof RepositoryBootstrapCloneStatusRequest.Type;

export const RepositoryBootstrapCancelCloneRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
});
export type RepositoryBootstrapCancelCloneRequest =
  typeof RepositoryBootstrapCancelCloneRequest.Type;

export const RepositoryBootstrapOperation = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("cloning"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
    progressMessage: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    ),
    updatedAt: UtcTimestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("cloned"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
    canonicalDestination: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    receiptId: BindingReceiptId,
    projectName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    updatedAt: UtcTimestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
    code: RepositoryBootstrapFailureCode,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
    updatedAt: UtcTimestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("cancelled"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
    updatedAt: UtcTimestamp,
  }),
]);
export type RepositoryBootstrapOperation = typeof RepositoryBootstrapOperation.Type;

export const RepositoryBootstrapOperationResponse = Schema.Struct({
  operation: RepositoryBootstrapOperation,
});
export type RepositoryBootstrapOperationResponse = typeof RepositoryBootstrapOperationResponse.Type;

export const RepositoryBootstrapFilePayload = Schema.Struct({
  relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  bytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES),
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0o777 })),
  contentBase64: Schema.String,
});
export type RepositoryBootstrapFilePayload = typeof RepositoryBootstrapFilePayload.Type;

export const RepositoryBootstrapLandFilesRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
  files: Schema.Array(RepositoryBootstrapFilePayload).check(
    Schema.isMaxLength(REPOSITORY_BOOTSTRAP_MAX_IGNORED_FILES),
  ),
});
export type RepositoryBootstrapLandFilesRequest = typeof RepositoryBootstrapLandFilesRequest.Type;

export const RepositoryBootstrapLandFileFailureReason = Schema.Literals([
  "invalid-path",
  "symlink-refused",
  "git-internal-refused",
  "size-exceeded",
  "hash-mismatch",
  "write-failed",
]);
export type RepositoryBootstrapLandFileFailureReason =
  typeof RepositoryBootstrapLandFileFailureReason.Type;

export const RepositoryBootstrapLandFileFailure = Schema.Struct({
  relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  reason: RepositoryBootstrapLandFileFailureReason,
  message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
});
export type RepositoryBootstrapLandFileFailure = typeof RepositoryBootstrapLandFileFailure.Type;

export const RepositoryBootstrapLandFilesResult = Schema.Struct({
  status: Schema.Literals(["landed", "partial-copy"]),
  landed: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
  failed: Schema.Array(RepositoryBootstrapLandFileFailure),
});
export type RepositoryBootstrapLandFilesResult = typeof RepositoryBootstrapLandFilesResult.Type;

export const RepositoryBootstrapFailure = Schema.Struct({
  code: RepositoryBootstrapFailureCode,
  message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
});
export type RepositoryBootstrapFailure = typeof RepositoryBootstrapFailure.Type;

export const decodeRepositoryBootstrapOperationId = Schema.decodeUnknownSync(
  RepositoryBootstrapOperationId,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapInspectRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapInspectRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapInspectResult = Schema.decodeUnknownSync(
  RepositoryBootstrapInspectResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapReadFileRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapReadFileRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapReadFileResult = Schema.decodeUnknownSync(
  RepositoryBootstrapReadFileResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapStartCloneRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapStartCloneRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapCloneStatusRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapCloneStatusRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapCancelCloneRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapCancelCloneRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapOperationResponse = Schema.decodeUnknownSync(
  RepositoryBootstrapOperationResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapLandFilesRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapLandFilesRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapLandFilesResult = Schema.decodeUnknownSync(
  RepositoryBootstrapLandFilesResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeRepositoryBootstrapFailure = Schema.decodeUnknownSync(
  RepositoryBootstrapFailure,
  STRICT_DECODE_OPTIONS,
);
