import { Schema } from "effect";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

/**
 * Opaque handle for one discovered provider folder during first run.
 *
 * The host keeps the real directory path behind this token; only safe display
 * labels and opaque IDs travel to the renderer.
 */
export const DiscoveredProviderFolderId = brandedUuid("DiscoveredProviderFolderId");
export type DiscoveredProviderFolderId = typeof DiscoveredProviderFolderId.Type;

/**
 * Safe provider identifier contributed by a built-in or plugin folder
 * discovery adapter (for example `"claude"`, `"codex"`, or a plugin's own
 * slug). Never carries paths or whitespace.
 */
export const DiscoveredFolderProvider = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);
export type DiscoveredFolderProvider = typeof DiscoveredFolderProvider.Type;

/**
 * A single safe directory name for display, never an absolute or multi-segment
 * host path.
 */
export const SafeDiscoveredFolderName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.makeFilter(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0"),
  ),
);
export type SafeDiscoveredFolderName = typeof SafeDiscoveredFolderName.Type;

/**
 * Credential-free `owner/name` repository identifier extracted from a Git
 * remote. Never carries a URL, host, scheme, userinfo, or local path.
 */
export const DiscoveredRepositorySlug = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  Schema.makeFilter((value) => {
    const [owner, name] = value.split("/");
    return (
      owner !== undefined &&
      name !== undefined &&
      owner !== "." &&
      owner !== ".." &&
      name !== "." &&
      name !== ".." &&
      !owner.includes("..") &&
      !name.includes("..")
    );
  }),
);
export type DiscoveredRepositorySlug = typeof DiscoveredRepositorySlug.Type;

export const DiscoveredProviderFolder = Schema.Struct({
  id: DiscoveredProviderFolderId,
  folderName: SafeDiscoveredFolderName,
  providers: Schema.NonEmptyArray(DiscoveredFolderProvider).check(
    Schema.makeFilter((providers) => new Set(providers).size === providers.length),
  ),
  sessionCount: PositiveInt,
  lastActivityAt: UtcTimestamp,
  isGitRepository: Schema.Boolean,
  alreadyImported: Schema.Boolean,
});
export type DiscoveredProviderFolder = typeof DiscoveredProviderFolder.Type;

export const DiscoveredProviderFolderGroup = Schema.Struct({
  repository: Schema.optional(DiscoveredRepositorySlug),
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  providers: Schema.NonEmptyArray(DiscoveredFolderProvider).check(
    Schema.makeFilter((providers) => new Set(providers).size === providers.length),
  ),
  sessionCount: PositiveInt,
  lastActivityAt: UtcTimestamp,
  folders: Schema.NonEmptyArray(DiscoveredProviderFolder),
});
export type DiscoveredProviderFolderGroup = typeof DiscoveredProviderFolderGroup.Type;

export const ProviderFolderScanStopReason = Schema.Literals([
  "file-limit",
  "entry-limit",
  "time-limit",
]);
export type ProviderFolderScanStopReason = typeof ProviderFolderScanStopReason.Type;

export const ProviderFolderScanResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("hidden"),
    reason: Schema.Literal("strict"),
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    groups: Schema.Array(DiscoveredProviderFolderGroup),
    requireGitRepository: Schema.Boolean,
    stoppedEarly: Schema.Boolean,
    stoppedEarlyReason: Schema.optional(ProviderFolderScanStopReason),
    scannedAt: UtcTimestamp,
  }),
]);
export type ProviderFolderScanResult = typeof ProviderFolderScanResult.Type;

export const MAX_IMPORTED_PROVIDER_FOLDERS = 64;

export const ImportProviderFoldersRequest = Schema.Struct({
  folderIds: Schema.NonEmptyArray(DiscoveredProviderFolderId).check(
    Schema.makeFilter(
      (ids) =>
        ids.length <= MAX_IMPORTED_PROVIDER_FOLDERS && new Set(ids.map(String)).size === ids.length,
    ),
  ),
});
export type ImportProviderFoldersRequest = typeof ImportProviderFoldersRequest.Type;

export const ImportedProviderFolderOutcome = Schema.Union([
  Schema.Struct({
    folderId: DiscoveredProviderFolderId,
    status: Schema.Literal("created"),
    projectId: ProjectId,
    name: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    folderId: DiscoveredProviderFolderId,
    status: Schema.Literal("already-imported"),
    projectId: ProjectId,
    name: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    folderId: DiscoveredProviderFolderId,
    status: Schema.Literal("refused"),
    reason: Schema.Literals(["not-found", "unavailable", "excluded", "requires-git", "strict"]),
    message: NonEmptyTrimmedString,
  }),
]);
export type ImportedProviderFolderOutcome = typeof ImportedProviderFolderOutcome.Type;

export const ImportProviderFoldersResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("strict"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    status: Schema.Literal("completed"),
    results: Schema.Array(ImportedProviderFolderOutcome),
  }),
]);
export type ImportProviderFoldersResult = typeof ImportProviderFoldersResult.Type;

export const decodeDiscoveredProviderFolderId = Schema.decodeUnknownSync(
  DiscoveredProviderFolderId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderFolderScanResult = Schema.decodeUnknownSync(
  ProviderFolderScanResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeImportProviderFoldersRequest = Schema.decodeUnknownSync(
  ImportProviderFoldersRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeImportProviderFoldersResult = Schema.decodeUnknownSync(
  ImportProviderFoldersResult,
  STRICT_DECODE_OPTIONS,
);
