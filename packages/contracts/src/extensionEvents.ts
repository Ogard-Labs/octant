import { Schema } from "effect";
import { EventVersion } from "./events";
import {
  ExtensionComponentId,
  ExtensionContentDigest,
  ExtensionDiagnostic,
  ExtensionPackageId,
  ExtensionPackageManifest,
  ExtensionPackageVersion,
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

export const EXTENSION_TOOL_GRANT_AGGREGATE = "extension-tool-grant";
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
 * One MCP tool in one Project. The provider-facing tool name is left out on
 * purpose: it embeds the thread, and a grant holds across a Project's threads.
 */
const toolGrantSubject = {
  projectId: ProjectId,
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  componentId: ExtensionComponentId,
  mcpToolName: ExtensionMcpToolName,
};
/** What the person saw when they answered: any difference asks again. */
const toolGrantBinding = {
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  definitionDigest: ExtensionToolDefinitionDigest,
};

/** Identifiers and digests only: never the arguments or result of a call. */
export const ExtensionToolGrantRecorded = Schema.Struct({
  grantId: ExtensionToolGrantId,
  ...toolGrantSubject,
  ...toolGrantBinding,
}).annotations(strict);
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
  projectId: ProjectId,
  reason: ExtensionToolGrantRevocationReason,
}).annotations(strict);
export type ExtensionToolGrantRevoked = typeof ExtensionToolGrantRevoked.Type;

export const decodeExtensionToolGrantRecorded = Schema.decodeUnknownSync(
  ExtensionToolGrantRecorded,
);
export const decodeExtensionToolGrantRevoked = Schema.decodeUnknownSync(ExtensionToolGrantRevoked);
