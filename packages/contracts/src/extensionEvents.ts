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
