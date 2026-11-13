import { Schema } from "effect";
import { EventVersion } from "./events";
import {
  ExtensionComponentId,
  ExtensionContentDigest,
  ExtensionDiagnostic,
  ExtensionPackageId,
  ExtensionPackageManifest,
  ExtensionPackageVersion,
  ExtensionPublisherKeyFingerprint,
} from "./extensions";
import { ProjectId } from "./projects";
import { ToolExtensionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const versionedPackage = {
  packageId: ExtensionPackageId,
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
};
export const ExtensionTransactionId = Schema.UUID.pipe(Schema.brand("ExtensionTransactionId"));
export type ExtensionTransactionId = typeof ExtensionTransactionId.Type;
const transaction = { transactionId: ExtensionTransactionId };
const preparedPackage = { ...transaction, ...versionedPackage, manifest: ExtensionPackageManifest };
const packageOnly = { packageId: ExtensionPackageId };
const waitingPackage = { ...packageOnly, reason: ExtensionDiagnostic };

export const ExtensionLifecycleEventPayload = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("package-inspected"), ...versionedPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("install-requested"), ...versionedPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("update-requested"), ...versionedPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("rollback-requested"), ...versionedPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("install-prepared"), ...preparedPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("install-committed"), ...preparedPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("update-prepared"), ...preparedPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("update-committed"), ...preparedPackage }).annotations(
    strict,
  ),
  /**
   * The host took an unsigned package's update from the source the person
   * trusted, so the trust and the approvals given to `previousVersion` hold
   * for this version too. Journaled after the update's own commit; it is
   * what the Updated notice and its roll back read.
   */
  Schema.Struct({
    kind: Schema.Literal("update-kept-from-source"),
    ...versionedPackage,
    previousVersion: ExtensionPackageVersion,
    previousDigest: ExtensionContentDigest,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rollback-selected"),
    ...versionedPackage,
    manifest: ExtensionPackageManifest,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("disable-requested"), ...packageOnly }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("package-disabled"), ...packageOnly }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("disable-waiting"), ...waitingPackage }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("uninstall-requested"),
    ...packageOnly,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("uninstall-waiting"), ...waitingPackage }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("package-uninstalled"), ...packageOnly }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("transaction-interrupted"),
    operation: Schema.Literal("install", "update"),
    ...transaction,
    ...versionedPackage,
    reason: ExtensionDiagnostic,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("source-trust-changed"),
    trusted: Schema.Boolean,
  }).annotations(strict),
  /**
   * A signed package's publisher key, pinned for its package name and source
   * when the person first trusts a signed version. Journaled with that
   * trust, in the same append.
   */
  Schema.Struct({
    kind: Schema.Literal("publisher-pinned"),
    ...packageOnly,
    publisherKey: ExtensionPublisherKeyFingerprint,
  }).annotations(strict),
  /** The person re-trusted a new publisher: its key replaces the pinned one. */
  Schema.Struct({
    kind: Schema.Literal("publisher-replaced"),
    ...packageOnly,
    previousPublisherKey: ExtensionPublisherKeyFingerprint,
    publisherKey: ExtensionPublisherKeyFingerprint,
  }).annotations(strict),
  /** The person forgot the pinned publisher; the next trust pins anew. */
  Schema.Struct({
    kind: Schema.Literal("publisher-forgotten"),
    ...packageOnly,
    publisherKey: ExtensionPublisherKeyFingerprint,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("plugin-desired-state-changed"),
    desired: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("component-desired-state-changed"),
    componentId: ExtensionComponentId,
    desired: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("package-quarantined"),
    ...versionedPackage,
    reason: ExtensionDiagnostic,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("runtime-state-observed"),
    ...packageOnly,
    componentId: ExtensionComponentId,
    state: Schema.Literal(
      "starting",
      "ready",
      "stopping",
      "stopped",
      "disable-pending",
      "crashed",
      "quarantined",
      "draining",
      "effective",
      "broken",
      "unavailable",
      "interrupted",
      "waiting",
    ),
    reason: Schema.optional(ExtensionDiagnostic),
  }).annotations(strict),
);
export type ExtensionLifecycleEventPayload = typeof ExtensionLifecycleEventPayload.Type;

export const ExtensionLifecycleEvent = Schema.Struct({
  eventVersion: EventVersion.pipe(Schema.filter((version) => version === 1)),
  extensionId: ToolExtensionId,
  payload: ExtensionLifecycleEventPayload,
})
  .annotations(strict)
  .pipe(
    Schema.filter((event) => {
      const payload = event.payload;
      if (!("manifest" in payload)) return true;
      return (
        payload.manifest.extensionId === event.extensionId &&
        payload.manifest.packageId === payload.packageId &&
        payload.manifest.version === payload.version &&
        payload.manifest.digest === payload.digest
      );
    }),
  );
export type ExtensionLifecycleEvent = typeof ExtensionLifecycleEvent.Type;

export const decodeExtensionLifecycleEvent = Schema.decodeUnknownSync(ExtensionLifecycleEvent);

/**
 * A plugin pinned to a Project: offered on every Work or Code turn there
 * without a per-send selection. One aggregate per Project, like grants.
 */
export const EXTENSION_PROJECT_PIN_AGGREGATE = "extension-project-pin";
export const EXTENSION_PROJECT_PIN_EVENT_NAMES = {
  changed: "extension.project-pin-changed@1",
} as const;
export const ExtensionProjectPinChanged = Schema.Struct({
  projectId: ProjectId,
  extensionId: ToolExtensionId,
  pinned: Schema.Boolean,
}).annotations(strict);
export type ExtensionProjectPinChanged = typeof ExtensionProjectPinChanged.Type;
export const decodeExtensionProjectPinChanged = Schema.decodeUnknownSync(
  ExtensionProjectPinChanged,
);

/**
 * A person switched a plugin built into Octant on or off. One aggregate per
 * bundled plugin, by its extension id. Nothing is installed or removed: the
 * plugin's code ships with the app, and switching it off keeps its data.
 */
export const BUNDLED_PLUGIN_SWITCH_AGGREGATE = "extension-bundled-plugin-switch";
export const BUNDLED_PLUGIN_SWITCH_EVENT_NAMES = {
  switched: "extension.bundled-plugin-switched@1",
} as const;
export const BundledPluginSwitched = Schema.Struct({
  extensionId: ToolExtensionId,
  desired: Schema.Boolean,
}).annotations(strict);
export type BundledPluginSwitched = typeof BundledPluginSwitched.Type;
export const decodeBundledPluginSwitched = Schema.decodeUnknownSync(BundledPluginSwitched);

export const EXTENSION_TOOL_GRANT_AGGREGATE = "extension-tool-grant";
/**
 * The aggregate that holds grants remembered for the account, which a Chat
 * thread outside a Project records and uses. A Project's grants live on the
 * aggregate with that Project's id.
 */
export const EXTENSION_TOOL_GRANT_ACCOUNT_AGGREGATE_ID = "e7700000-0000-4000-8000-000000000001";
export const EXTENSION_TOOL_GRANT_EVENT_NAMES = {
  recorded: "extension.tool-grant-recorded@1",
  revoked: "extension.tool-grant-revoked@1",
} as const;

const sha256Digest = Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/));
export const ExtensionToolGrantId = sha256Digest.pipe(Schema.brand("ExtensionToolGrantId"));
export type ExtensionToolGrantId = typeof ExtensionToolGrantId.Type;
/** SHA-256 of one MCP tool's name, description, and input schema as its server listed them. */
export const ExtensionToolDefinitionDigest = sha256Digest.pipe(
  Schema.brand("ExtensionToolDefinitionDigest"),
);
export type ExtensionToolDefinitionDigest = typeof ExtensionToolDefinitionDigest.Type;
export const ExtensionMcpToolName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));

/**
 * One MCP tool, or every tool of one MCP server, in one Project or for the
 * account. `projectId` is absent on a grant for the account, which a Chat
 * thread outside a Project records. `mcpToolName` is absent on a grant for
 * the whole server. The provider-facing tool name is left out on purpose: it
 * embeds the thread, and a grant holds across threads.
 *
 * `threadId` is present only on the answer a person gave a server's prompt on
 * a thread that had taken in outside content. That answer covers the server
 * on that thread alone, so it names no tool, and it is journaled here so it
 * ends with the package's grants and outlives a host restart.
 */
const toolGrantSubject = {
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(Schema.UUID),
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  componentId: ExtensionComponentId,
  mcpToolName: Schema.optional(ExtensionMcpToolName),
};
/**
 * What the person saw when they answered: any difference asks again. A grant
 * for the whole server has no `definitionDigest`, because it covers tools
 * whose listings the person never saw; it binds the package alone.
 */
const toolGrantBinding = {
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  definitionDigest: Schema.optional(ExtensionToolDefinitionDigest),
};

/** The fields of a recorded grant, for a schema that lists grants. */
export const extensionToolGrantRecordedFields = {
  grantId: ExtensionToolGrantId,
  ...toolGrantSubject,
  ...toolGrantBinding,
};

/** Identifiers and digests only: never the arguments or result of a call. */
export const ExtensionToolGrantRecorded = Schema.Struct(extensionToolGrantRecordedFields)
  .annotations(strict)
  .pipe(
    // A tool's grant names the tool and its listing; a server's names neither.
    Schema.filter(
      (grant) =>
        (grant.mcpToolName === undefined) === (grant.definitionDigest === undefined) &&
        (grant.threadId === undefined || grant.mcpToolName === undefined),
    ),
  );
export type ExtensionToolGrantRecorded = typeof ExtensionToolGrantRecorded.Type;

export const ExtensionToolGrantRevocationReason = Schema.Literal(
  "person",
  "plugin-uninstalled",
  "trust-revoked",
  "rolled-back",
);
export type ExtensionToolGrantRevocationReason = typeof ExtensionToolGrantRevocationReason.Type;

export const ExtensionToolGrantRevoked = Schema.Struct({
  grantId: ExtensionToolGrantId,
  /** Absent for a grant remembered for the account. */
  projectId: Schema.optional(ProjectId),
  reason: ExtensionToolGrantRevocationReason,
}).annotations(strict);
export type ExtensionToolGrantRevoked = typeof ExtensionToolGrantRevoked.Type;

export const decodeExtensionToolGrantRecorded = Schema.decodeUnknownSync(
  ExtensionToolGrantRecorded,
);
export const decodeExtensionToolGrantRevoked = Schema.decodeUnknownSync(ExtensionToolGrantRevoked);
