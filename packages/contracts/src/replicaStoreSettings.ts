/**
 * Which store this host copies artifact versions to, and whether sync is on.
 *
 * The person chooses a synced folder, an S3-compatible bucket, or none. A
 * folder travels from the renderer only as the host folder browser's opaque
 * candidate id, so the host resolves and judges the path itself. A bucket's
 * settings are not secret; its access key and secret travel once, in the
 * command that saves them, and the host puts them in its credential store
 * (macOS Keychain or freedesktop Secret Service). The settings document holds
 * only an opaque reference to that entry, and its schema refuses any other
 * field, so a key pair cannot be journaled or echoed back by accident.
 */

import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { FolderBrowseMode, FolderCandidateId } from "./folderBrowse";
import { HostId } from "./host";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const REPLICA_STORE_SETTINGS_SCHEMA_VERSION = 1 as const;
export const ReplicaStoreSettingsSchemaVersion = Schema.Literal(
  REPLICA_STORE_SETTINGS_SCHEMA_VERSION,
);

const noWhitespace = (value: string) => !/\s/.test(value);

/** A folder on this machine, as the host canonicalized it. */
export const ReplicaStoreFolder = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => value.startsWith("/") && !value.includes("\0"), {
    message: () => "A sync folder must be an absolute path with no NUL.",
  }),
);
export type ReplicaStoreFolder = typeof ReplicaStoreFolder.Type;

/**
 * Whether a parsed host is link-local: IPv4 169.254.0.0/16 or IPv6 fe80::/10,
 * including an IPv4 address mapped into IPv6. Cloud instance metadata answers
 * there, and no bucket provider does, so a signed request is never sent to it.
 * The URL parser has already turned shorthand forms such as `2852039166` or
 * `0xa9.254.1.1` into dotted quads and compressed IPv6.
 */
function isLinkLocalHost(hostname: string): boolean {
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1).toLowerCase();
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true;
  // `::ffff:169.254.x.y` serializes as `::ffff:a9fe:xxyy`.
  return /^::ffff:a9fe:[0-9a-f]{1,4}$/.test(address);
}

/**
 * Whether an endpoint names its host by IP address. The URL parser has already
 * normalized IPv4 shorthand to a dotted quad and bracketed IPv6.
 */
function isIpAddressEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname;
    return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

function isHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Only authenticated TLS: a plaintext endpoint would carry the signed
  // request, and the access key in it, in the clear. A path, query, or
  // credentials in the address would be dropped or leaked by the request
  // builder, so they are refused rather than ignored. Loopback and private
  // ranges stay allowed: a self-hosted bucket server is a legitimate store.
  return (
    url.protocol === "https:" &&
    url.host.length > 0 &&
    !isLinkLocalHost(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === ""
  );
}

/**
 * The bucket provider's base address. Only `https:` with no path is accepted,
 * and never a link-local address.
 */
export const ReplicaStoreS3Endpoint = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(2_048),
  Schema.filter(isHttpsOrigin, {
    message: () => "The endpoint must be an https address with no path, and not link-local.",
  }),
);
export type ReplicaStoreS3Endpoint = typeof ReplicaStoreS3Endpoint.Type;

/** Path-style (`endpoint/bucket/key`) or virtual-host (`bucket.endpoint/key`). */
export const ReplicaStoreS3Addressing = Schema.Literal("path", "virtual-host");
export type ReplicaStoreS3Addressing = typeof ReplicaStoreS3Addressing.Type;

export const ReplicaStoreS3Region = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
);

export const ReplicaStoreS3Bucket = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(63),
  Schema.filter(
    (value) =>
      noWhitespace(value) && !value.includes("/") && !value.includes("\\") && !value.includes(".."),
  ),
);

function isKeyPrefix(value: string): boolean {
  if (value.includes("\\") || value.includes("\0") || !noWhitespace(value)) return false;
  const trimmed = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return false;
  return trimmed
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** A folder inside the bucket, like `octant/laptop`. */
export const ReplicaStoreS3Prefix = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.filter(isKeyPrefix, {
    message: () => "The prefix must be a relative folder inside the bucket.",
  }),
);

/**
 * Where a bucket is. Nothing here is secret, and nothing secret fits: the
 * struct refuses any field it does not name, so an access key or secret sent
 * as part of the settings is refused rather than stored.
 */
export const ReplicaStoreS3Settings = Schema.Struct({
  endpoint: ReplicaStoreS3Endpoint,
  region: ReplicaStoreS3Region,
  bucket: ReplicaStoreS3Bucket,
  prefix: Schema.optional(ReplicaStoreS3Prefix),
  addressing: ReplicaStoreS3Addressing,
})
  .annotations(strict)
  .pipe(
    // A virtual-host bucket becomes a DNS label in the request host.
    Schema.filter(
      (settings) =>
        settings.addressing === "path" || /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(settings.bucket),
      { message: () => "A virtual-host bucket name must be lowercase and DNS-safe." },
    ),
    // Prefixing an IP address with the bucket gives `bucket.10.0.0.5` or
    // `bucket.[::1]`, which no resolver answers, so Test connection would only
    // say unreachable without naming the addressing choice as the cause.
    Schema.filter(
      (settings) => settings.addressing === "path" || !isIpAddressEndpoint(settings.endpoint),
      {
        message: () =>
          "Virtual-host addressing needs an endpoint with a DNS name, not an IP address.",
      },
    ),
  );
export type ReplicaStoreS3Settings = typeof ReplicaStoreS3Settings.Type;

/**
 * The bucket's key pair, as a person typed it. It is accepted only inside the
 * command that saves it and never appears in settings, a view, or a result.
 */
export const ReplicaStoreS3Credentials = Schema.Struct({
  accessKeyId: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(256),
    Schema.filter(noWhitespace),
  ),
  secretAccessKey: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(1_024),
    Schema.filter(noWhitespace),
  ),
}).annotations(strict);
export type ReplicaStoreS3Credentials = typeof ReplicaStoreS3Credentials.Type;

/** The store a person chose. `none` is the default and makes no store calls. */
export const ReplicaStoreChoice = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("synced-folder"),
    folder: ReplicaStoreFolder,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("s3"),
    settings: ReplicaStoreS3Settings,
    /** The host credential-store entry holding the key pair; an id, not a secret. */
    credentialRef: Schema.UUID,
  }).annotations(strict),
);
export type ReplicaStoreChoice = typeof ReplicaStoreChoice.Type;

/**
 * The host's sync configuration, journaled whole on every change.
 *
 * Sync starts off and cannot be on without a store.
 */
export const ReplicaStoreSettings = Schema.Struct({
  kind: Schema.Literal("replica-store-settings"),
  store: ReplicaStoreChoice,
  syncOn: Schema.Boolean,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter((settings) => !settings.syncOn || settings.store.kind !== "none", {
      message: () => "Sync cannot be on without a store.",
    }),
  );
export type ReplicaStoreSettings = typeof ReplicaStoreSettings.Type;

/**
 * Whether the bucket's key pair is in the host credential store. `unavailable`
 * means the credential store could not be asked, not that the key is gone.
 */
export const ReplicaStoreCredentialState = Schema.Literal("saved", "missing", "unavailable");
export type ReplicaStoreCredentialState = typeof ReplicaStoreCredentialState.Type;

/** The chosen store as Settings shows it: the credential reference stays on the host. */
export const ReplicaStoreChoiceView = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("synced-folder"),
    folder: ReplicaStoreFolder,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("s3"),
    settings: ReplicaStoreS3Settings,
    credentials: ReplicaStoreCredentialState,
  }).annotations(strict),
);
export type ReplicaStoreChoiceView = typeof ReplicaStoreChoiceView.Type;

/**
 * What Settings › Sync reads. `hostId` and `mode` are what the folder browser
 * lists candidates under; the renderer echoes them rather than inventing them.
 * `credentialStore` says whether this host can save a bucket's key pair at all.
 */
export const ReplicaStoreSettingsView = Schema.Struct({
  kind: Schema.Literal("replica-store-settings-view"),
  store: ReplicaStoreChoiceView,
  syncOn: Schema.Boolean,
  version: AggregateVersion,
  hostId: HostId,
  mode: FolderBrowseMode,
  credentialStore: Schema.Literal("available", "unavailable"),
  /**
   * This computer has an identity in a replica in the chosen store. Its store
   * cannot change until leaving a replica is supported; sync on/off and a new
   * key pair for the same bucket still can.
   */
  replicaMember: Schema.Boolean,
}).annotations(strict);
export type ReplicaStoreSettingsView = typeof ReplicaStoreSettingsView.Type;

/**
 * One change a person makes in Settings › Sync, or the Test connection probe.
 *
 * `expectedVersion` is the settings version the client read, so two windows
 * cannot quietly overwrite each other's choice. Choosing or changing the store
 * leaves sync off: the storage provider can read the files, and turning sync
 * on is where the person accepts that for this store.
 */
export const ReplicaStoreSettingsCommand = Schema.Union(
  Schema.Struct({
    schemaVersion: ReplicaStoreSettingsSchemaVersion,
    kind: Schema.Literal("choose-synced-folder"),
    mode: FolderBrowseMode,
    candidateId: FolderCandidateId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    schemaVersion: ReplicaStoreSettingsSchemaVersion,
    kind: Schema.Literal("configure-s3"),
    settings: ReplicaStoreS3Settings,
    /**
     * Absent keeps the key pair already saved for this bucket. A changed
     * endpoint, bucket, or addressing needs a new one.
     */
    credentials: Schema.optional(ReplicaStoreS3Credentials),
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    schemaVersion: ReplicaStoreSettingsSchemaVersion,
    kind: Schema.Literal("clear-store"),
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    schemaVersion: ReplicaStoreSettingsSchemaVersion,
    kind: Schema.Literal("set-sync"),
    syncOn: Schema.Boolean,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    schemaVersion: ReplicaStoreSettingsSchemaVersion,
    kind: Schema.Literal("test-connection"),
  }).annotations(strict),
);
export type ReplicaStoreSettingsCommand = typeof ReplicaStoreSettingsCommand.Type;

export const ReplicaStoreRefusalReason = Schema.Literal(
  "malformed",
  "stale-version",
  "candidate-unavailable",
  "outside-home",
  "credentials-required",
  "credential-store-unavailable",
  "not-configured",
  "member-of-replica",
);
export type ReplicaStoreRefusalReason = typeof ReplicaStoreRefusalReason.Type;

/**
 * What a Test connection found. `reachable` means one probe file was written.
 * `sync-off`, `not-configured`, and `credential-store-unavailable` mean no
 * store was called at all.
 */
export const ReplicaStoreConnectionOutcome = Schema.Literal(
  "reachable",
  "sync-off",
  "not-configured",
  "credential-store-unavailable",
  "not-connected",
  "refused",
  "write-failed",
  "unauthorized",
  "not-found",
  "throttled",
  "unreachable",
);
export type ReplicaStoreConnectionOutcome = typeof ReplicaStoreConnectionOutcome.Type;

const Message = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));

export const ReplicaStoreSettingsResult = Schema.Union(
  ReplicaStoreSettingsView,
  Schema.Struct({
    kind: Schema.Literal("replica-store-refused"),
    reason: ReplicaStoreRefusalReason,
    message: Message,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("replica-store-connection-tested"),
    outcome: ReplicaStoreConnectionOutcome,
    message: Message,
  }).annotations(strict),
);
export type ReplicaStoreSettingsResult = typeof ReplicaStoreSettingsResult.Type;

export const REPLICA_STORE_SETTINGS_AGGREGATE_TYPE = "replica-store-settings";
export const REPLICA_STORE_SETTINGS_CHANGED = "replica.store-settings-changed@1";

export const decodeReplicaStoreS3Settings = Schema.decodeUnknownSync(ReplicaStoreS3Settings);
export const decodeReplicaStoreSettings = Schema.decodeUnknownSync(ReplicaStoreSettings);
export const decodeReplicaStoreSettingsView = Schema.decodeUnknownSync(ReplicaStoreSettingsView);
export const decodeReplicaStoreSettingsCommand = Schema.decodeUnknownSync(
  ReplicaStoreSettingsCommand,
);
export const decodeReplicaStoreSettingsResult = Schema.decodeUnknownSync(
  ReplicaStoreSettingsResult,
);
