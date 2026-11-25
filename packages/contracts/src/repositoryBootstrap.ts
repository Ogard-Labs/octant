import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { BindingReceiptId, ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

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

export const RepositoryCloneTransport = Schema.Literal("ssh", "https");
export type RepositoryCloneTransport = typeof RepositoryCloneTransport.Type;

export const RepositoryBootstrapFailureCode = Schema.Literal(
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
);
export type RepositoryBootstrapFailureCode = typeof RepositoryBootstrapFailureCode.Type;

export const RepositoryBootstrapCaps = Schema.Struct({
  maxFiles: Schema.Int.pipe(Schema.positive()),
  maxFileBytes: Schema.Int.pipe(Schema.positive()),
  maxTotalBytes: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type RepositoryBootstrapCaps = typeof RepositoryBootstrapCaps.Type;

export const RepositoryBootstrapRemoteSet = Schema.Struct({
  originUrl: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
  sshUrl: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
  httpsUrl: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
  defaultTransport: Schema.optional(RepositoryCloneTransport),
  unavailableReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type RepositoryBootstrapRemoteSet = typeof RepositoryBootstrapRemoteSet.Type;

export const RepositoryBootstrapIgnoredFile = Schema.Struct({
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  bytes: Schema.Int.pipe(Schema.nonNegative()),
  secretGuardMatched: Schema.Boolean,
}).annotations(strict);
export type RepositoryBootstrapIgnoredFile = typeof RepositoryBootstrapIgnoredFile.Type;

export const RepositoryBootstrapInspectRequest = Schema.Struct({
  projectId: ProjectId,
}).annotations(strict);
export type RepositoryBootstrapInspectRequest = typeof RepositoryBootstrapInspectRequest.Type;

export const RepositoryBootstrapInspectResult = Schema.Struct({
  projectId: ProjectId,
  projectName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  sourcePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  repositoryName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  defaultDestinationPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  remotes: RepositoryBootstrapRemoteSet,
  ignoredFiles: Schema.Array(RepositoryBootstrapIgnoredFile).pipe(
    Schema.maxItems(REPOSITORY_BOOTSTRAP_MAX_IGNORED_FILES),
  ),
  truncated: Schema.Boolean,
  omittedCount: Schema.Int.pipe(Schema.nonNegative()),
  omittedOversizedCount: Schema.Int.pipe(Schema.nonNegative()),
  caps: RepositoryBootstrapCaps,
}).annotations(strict);
export type RepositoryBootstrapInspectResult = typeof RepositoryBootstrapInspectResult.Type;

export const RepositoryBootstrapReadFileRequest = Schema.Struct({
  projectId: ProjectId,
  relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
}).annotations(strict);
export type RepositoryBootstrapReadFileRequest = typeof RepositoryBootstrapReadFileRequest.Type;

export const RepositoryBootstrapReadFileResult = Schema.Struct({
  relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  bytes: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES),
  ),
  sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  mode: Schema.Int.pipe(Schema.between(0, 0o777)),
  contentBase64: Schema.String,
}).annotations(strict);
export type RepositoryBootstrapReadFileResult = typeof RepositoryBootstrapReadFileResult.Type;

export const RepositoryBootstrapStartCloneRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
  remoteUrl: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  transport: RepositoryCloneTransport,
  destinationPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  projectName: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
}).annotations(strict);
export type RepositoryBootstrapStartCloneRequest = typeof RepositoryBootstrapStartCloneRequest.Type;

export const RepositoryBootstrapCloneStatusRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
}).annotations(strict);
export type RepositoryBootstrapCloneStatusRequest =
  typeof RepositoryBootstrapCloneStatusRequest.Type;

export const RepositoryBootstrapCancelCloneRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
}).annotations(strict);
export type RepositoryBootstrapCancelCloneRequest =
  typeof RepositoryBootstrapCancelCloneRequest.Type;

export const RepositoryBootstrapOperation = Schema.Union(
  Schema.Struct({
    state: Schema.Literal("cloning"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
    progressMessage: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
    updatedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    state: Schema.Literal("cloned"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
    canonicalDestination: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
    receiptId: BindingReceiptId,
    projectName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
    updatedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    state: Schema.Literal("failed"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
    code: RepositoryBootstrapFailureCode,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
    updatedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    state: Schema.Literal("cancelled"),
    operationId: RepositoryBootstrapOperationId,
    transport: RepositoryCloneTransport,
    destinationPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
    updatedAt: UtcTimestamp,
  }).annotations(strict),
);
export type RepositoryBootstrapOperation = typeof RepositoryBootstrapOperation.Type;

export const RepositoryBootstrapOperationResponse = Schema.Struct({
  operation: RepositoryBootstrapOperation,
}).annotations(strict);
export type RepositoryBootstrapOperationResponse = typeof RepositoryBootstrapOperationResponse.Type;

export const RepositoryBootstrapFilePayload = Schema.Struct({
  relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  bytes: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES),
  ),
  sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  mode: Schema.Int.pipe(Schema.between(0, 0o777)),
  contentBase64: Schema.String,
}).annotations(strict);
export type RepositoryBootstrapFilePayload = typeof RepositoryBootstrapFilePayload.Type;

export const RepositoryBootstrapLandFilesRequest = Schema.Struct({
  operationId: RepositoryBootstrapOperationId,
  files: Schema.Array(RepositoryBootstrapFilePayload).pipe(
    Schema.maxItems(REPOSITORY_BOOTSTRAP_MAX_IGNORED_FILES),
  ),
}).annotations(strict);
export type RepositoryBootstrapLandFilesRequest = typeof RepositoryBootstrapLandFilesRequest.Type;

export const RepositoryBootstrapLandFileFailureReason = Schema.Literal(
  "invalid-path",
  "symlink-refused",
  "git-internal-refused",
  "size-exceeded",
  "hash-mismatch",
  "write-failed",
);
export type RepositoryBootstrapLandFileFailureReason =
  typeof RepositoryBootstrapLandFileFailureReason.Type;

export const RepositoryBootstrapLandFileFailure = Schema.Struct({
  relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  reason: RepositoryBootstrapLandFileFailureReason,
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);
export type RepositoryBootstrapLandFileFailure = typeof RepositoryBootstrapLandFileFailure.Type;

export const RepositoryBootstrapLandFilesResult = Schema.Struct({
  status: Schema.Literal("landed", "partial-copy"),
  landed: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  failed: Schema.Array(RepositoryBootstrapLandFileFailure),
}).annotations(strict);
export type RepositoryBootstrapLandFilesResult = typeof RepositoryBootstrapLandFilesResult.Type;

export const RepositoryBootstrapFailure = Schema.Struct({
  code: RepositoryBootstrapFailureCode,
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);
export type RepositoryBootstrapFailure = typeof RepositoryBootstrapFailure.Type;

export const decodeRepositoryBootstrapOperationId = Schema.decodeUnknownSync(
  RepositoryBootstrapOperationId,
);
export const decodeRepositoryBootstrapInspectRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapInspectRequest,
);
export const decodeRepositoryBootstrapInspectResult = Schema.decodeUnknownSync(
  RepositoryBootstrapInspectResult,
);
export const decodeRepositoryBootstrapReadFileRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapReadFileRequest,
);
export const decodeRepositoryBootstrapReadFileResult = Schema.decodeUnknownSync(
  RepositoryBootstrapReadFileResult,
);
export const decodeRepositoryBootstrapStartCloneRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapStartCloneRequest,
);
export const decodeRepositoryBootstrapCloneStatusRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapCloneStatusRequest,
);
export const decodeRepositoryBootstrapCancelCloneRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapCancelCloneRequest,
);
export const decodeRepositoryBootstrapOperationResponse = Schema.decodeUnknownSync(
  RepositoryBootstrapOperationResponse,
);
export const decodeRepositoryBootstrapLandFilesRequest = Schema.decodeUnknownSync(
  RepositoryBootstrapLandFilesRequest,
);
export const decodeRepositoryBootstrapLandFilesResult = Schema.decodeUnknownSync(
  RepositoryBootstrapLandFilesResult,
);
export const decodeRepositoryBootstrapFailure = Schema.decodeUnknownSync(
  RepositoryBootstrapFailure,
);
