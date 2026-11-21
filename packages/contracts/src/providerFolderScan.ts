import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/**
 * Opaque handle for one discovered provider folder during first run.
 *
 * The host keeps the real directory path behind this token; only safe display
 * labels and opaque IDs travel to the renderer.
 */
export const DiscoveredProviderFolderId = brandedUuid("DiscoveredProviderFolderId");
export type DiscoveredProviderFolderId = typeof DiscoveredProviderFolderId.Type;

export const DiscoveredFolderProvider = Schema.Literal("claude", "codex", "opencode", "pi");
export type DiscoveredFolderProvider = typeof DiscoveredFolderProvider.Type;

/**
 * A single safe directory name for display, never an absolute or multi-segment
 * host path.
 */
export const SafeDiscoveredFolderName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter(
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
export const DiscoveredRepositorySlug = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(200),
  Schema.pattern(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  Schema.filter((value) => {
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
  providers: Schema.NonEmptyArray(DiscoveredFolderProvider).pipe(
    Schema.filter((providers) => new Set(providers).size === providers.length),
  ),
  sessionCount: Schema.Int.pipe(Schema.positive()),
  lastActivityAt: UtcTimestamp,
  alreadyImported: Schema.Boolean,
}).annotations(strict);
export type DiscoveredProviderFolder = typeof DiscoveredProviderFolder.Type;

export const DiscoveredProviderFolderGroup = Schema.Struct({
  repository: Schema.optional(DiscoveredRepositorySlug),
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200)),
  providers: Schema.NonEmptyArray(DiscoveredFolderProvider).pipe(
    Schema.filter((providers) => new Set(providers).size === providers.length),
  ),
  sessionCount: Schema.Int.pipe(Schema.positive()),
  lastActivityAt: UtcTimestamp,
  folders: Schema.NonEmptyArray(DiscoveredProviderFolder),
}).annotations(strict);
export type DiscoveredProviderFolderGroup = typeof DiscoveredProviderFolderGroup.Type;

export const ProviderFolderScanStopReason = Schema.Literal(
  "file-limit",
  "entry-limit",
  "time-limit",
);
export type ProviderFolderScanStopReason = typeof ProviderFolderScanStopReason.Type;

export const ProviderFolderScanResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("hidden"),
    reason: Schema.Literal("strict"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("ready"),
    groups: Schema.Array(DiscoveredProviderFolderGroup),
    stoppedEarly: Schema.Boolean,
    stoppedEarlyReason: Schema.optional(ProviderFolderScanStopReason),
    scannedAt: UtcTimestamp,
  }).annotations(strict),
);
export type ProviderFolderScanResult = typeof ProviderFolderScanResult.Type;

export const MAX_IMPORTED_PROVIDER_FOLDERS = 64;

export const ImportProviderFoldersRequest = Schema.Struct({
  folderIds: Schema.NonEmptyArray(DiscoveredProviderFolderId).pipe(
    Schema.filter(
      (ids) =>
        ids.length <= MAX_IMPORTED_PROVIDER_FOLDERS && new Set(ids.map(String)).size === ids.length,
    ),
  ),
}).annotations(strict);
export type ImportProviderFoldersRequest = typeof ImportProviderFoldersRequest.Type;

export const ImportedProviderFolderOutcome = Schema.Union(
  Schema.Struct({
    folderId: DiscoveredProviderFolderId,
    status: Schema.Literal("created"),
    projectId: ProjectId,
    name: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    folderId: DiscoveredProviderFolderId,
    status: Schema.Literal("already-imported"),
    projectId: ProjectId,
    name: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    folderId: DiscoveredProviderFolderId,
    status: Schema.Literal("refused"),
    reason: Schema.Literal("not-found", "unavailable", "excluded", "strict"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type ImportedProviderFolderOutcome = typeof ImportedProviderFolderOutcome.Type;

export const ImportProviderFoldersResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("strict"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("completed"),
    results: Schema.Array(ImportedProviderFolderOutcome),
  }).annotations(strict),
);
export type ImportProviderFoldersResult = typeof ImportProviderFoldersResult.Type;

export const decodeDiscoveredProviderFolderId = Schema.decodeUnknownSync(
  DiscoveredProviderFolderId,
);
export const decodeProviderFolderScanResult = Schema.decodeUnknownSync(ProviderFolderScanResult);
export const decodeImportProviderFoldersRequest = Schema.decodeUnknownSync(
  ImportProviderFoldersRequest,
);
export const decodeImportProviderFoldersResult = Schema.decodeUnknownSync(
  ImportProviderFoldersResult,
);
