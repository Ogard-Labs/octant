import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The built-in groups of secret files Octant keeps out of every runtime's
 * reach, at every guardrail level. Each id names one group a person can
 * remove (after confirming) and restore in Settings › Permissions › Protected
 * files; the paths inside a group are the host's to decide per platform.
 */
export const BuiltInProtectedFilesId = Schema.Literal(
  "ssh-private-keys",
  "cloud-credentials",
  "cluster-configuration",
  "container-registry-sign-in",
  "package-registry-tokens",
  "git-credential-files",
  "forge-cli-sign-in",
  "keychains-and-vaults",
  "browser-cookies-and-logins",
  "octant-credentials",
  "provider-sign-ins",
);
export type BuiltInProtectedFilesId = typeof BuiltInProtectedFilesId.Type;

/**
 * The way to do the work a protected file would otherwise serve. A refused
 * read names it so the person (and the agent) knows what to use instead.
 */
export const ProtectedFilesChannel = Schema.Literal(
  "ssh-agent",
  "git-credential-helper",
  "credential-broker",
  "keychain-api",
  "provider-sign-in",
  "none",
);
export type ProtectedFilesChannel = typeof ProtectedFilesChannel.Type;

/**
 * A path the person added: absolute, or starting with `~/` for the home
 * folder. A trailing slash is not part of the path; a folder protects
 * everything beneath it.
 */
export const ProtectedPath = Schema.String.pipe(
  Schema.maxLength(1024),
  Schema.filter(
    (value) =>
      (value.startsWith("/") || value.startsWith("~/")) &&
      value !== "/" &&
      value !== "~/" &&
      !value.includes("\0") &&
      !value.split("/").some((segment) => segment === ".." || segment === "."),
    {
      message: () =>
        "A protected path is absolute or starts with ~/, names a file or folder below the root, and has no . or .. segments.",
    },
  ),
);
export type ProtectedPath = typeof ProtectedPath.Type;

export const BuiltInProtectedFiles = Schema.Struct({
  id: BuiltInProtectedFilesId,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(96)),
  /** The paths this group covers on this host, home-relative where they are. */
  paths: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))).pipe(
    Schema.maxItems(64),
  ),
  channel: ProtectedFilesChannel,
  removed: Schema.Boolean,
}).annotations(strict);
export type BuiltInProtectedFiles = typeof BuiltInProtectedFiles.Type;

export const ProtectedFilesSettings = Schema.Struct({
  kind: Schema.Literal("protected-files-settings"),
  builtIns: Schema.Array(BuiltInProtectedFiles),
  added: Schema.Array(ProtectedPath).pipe(Schema.maxItems(256)),
  version: AggregateVersion,
  updatedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ProtectedFilesSettings = typeof ProtectedFilesSettings.Type;

/**
 * One change to the protected list, made from the version the person read.
 * Removing a built-in group carries `confirmed: true`: the window asks first,
 * and a command without the confirmation is not representable.
 */
export const ProtectedFilesCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("add-protected-path"),
    path: ProtectedPath,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-protected-path"),
    path: ProtectedPath,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-built-in-protected-files"),
    id: BuiltInProtectedFilesId,
    confirmed: Schema.Literal(true),
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("restore-built-in-protected-files"),
    id: BuiltInProtectedFilesId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type ProtectedFilesCommand = typeof ProtectedFilesCommand.Type;

export const ProtectedFilesResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("protected-files-settings"),
    settings: ProtectedFilesSettings,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("protected-files-refused"),
    reason: Schema.Literal("malformed", "stale-version", "unauthorized", "no-change"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ProtectedFilesResult = typeof ProtectedFilesResult.Type;

export const PROTECTED_FILES_AGGREGATE_TYPE = "protected-files";
export const PROTECTED_PATH_ADDED = "protected-files.path-added@1";
export const PROTECTED_PATH_REMOVED = "protected-files.path-removed@1";
export const BUILT_IN_PROTECTED_FILES_REMOVED = "protected-files.built-in-removed@1";
export const BUILT_IN_PROTECTED_FILES_RESTORED = "protected-files.built-in-restored@1";

export const ProtectedPathAdded = Schema.Struct({ path: ProtectedPath }).annotations(strict);
export const ProtectedPathRemoved = Schema.Struct({ path: ProtectedPath }).annotations(strict);
/** Journaled with the confirmation, so the record shows the person was asked. */
export const BuiltInProtectedFilesRemoved = Schema.Struct({
  id: BuiltInProtectedFilesId,
  confirmed: Schema.Literal(true),
}).annotations(strict);
export const BuiltInProtectedFilesRestored = Schema.Struct({
  id: BuiltInProtectedFilesId,
}).annotations(strict);

export const decodeProtectedFilesSettings = Schema.decodeUnknownSync(ProtectedFilesSettings);
export const decodeProtectedFilesCommand = Schema.decodeUnknownSync(ProtectedFilesCommand);
export const decodeProtectedFilesResult = Schema.decodeUnknownSync(ProtectedFilesResult);
