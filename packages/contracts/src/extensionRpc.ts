import { Schema } from "effect";
import { AggregateVersion, EventVersion, GlobalSequence, UtcTimestamp } from "./events";
import {
  ExtensionActivationScope,
  ExtensionCapability,
  ExtensionCatalogId,
  ExtensionCatalogEpoch,
  ExtensionComponentId,
  ExtensionComponentKind,
  ExtensionCompatibility,
  ExtensionContentDigest,
  ExtensionDiagnostic,
  ExtensionEffectivePackageState,
  ExtensionLicense,
  ExtensionPackageId,
  ExtensionPackageState,
  ExtensionPackageVersion,
  ExtensionSlug,
  ExtensionSkillCollision,
  ExtensionSource,
  ExtensionProvenance,
  SourceQualifiedSkill,
  StandaloneSkillRecord,
} from "./extensions";
import { ToolExtensionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const boundedText = (maximumLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximumLength));
const opaqueCursor = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const packageTarget = {
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
};
const versionedTarget = {
  ...packageTarget,
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
};
const stateCommandVersion = EventVersion.pipe(Schema.filter((version) => version === 1));
const desiredStateMutation = {
  commandVersion: stateCommandVersion,
  extensionId: ToolExtensionId,
  expectedStateVersion: AggregateVersion,
};

export const ExtensionEffectiveStateQuery = Schema.Struct({
  scope: ExtensionActivationScope,
  expectedCatalogEpoch: Schema.optional(ExtensionCatalogEpoch),
}).annotations(strict);
export type ExtensionEffectiveStateQuery = typeof ExtensionEffectiveStateQuery.Type;

export const ExtensionToolApproval = Schema.Struct({
  approvalId: Schema.UUID,
  threadId: Schema.UUID,
  projectId: Schema.optional(Schema.UUID),
  packageId: ExtensionPackageId,
  componentId: ExtensionComponentId,
  providerToolName: boundedText(256),
  mcpToolName: boundedText(256),
  inputJson: Schema.String.pipe(Schema.maxLength(64 * 1024)),
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type ExtensionToolApproval = typeof ExtensionToolApproval.Type;

export const ExtensionToolApprovalList = Schema.Array(ExtensionToolApproval);
export type ExtensionToolApprovalList = typeof ExtensionToolApprovalList.Type;

export const ExtensionToolApprovalDecision = Schema.Struct({
  approvalId: Schema.UUID,
  decision: Schema.Literal("approved", "denied"),
}).annotations(strict);
export type ExtensionToolApprovalDecision = typeof ExtensionToolApprovalDecision.Type;

export const ExtensionCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("search-catalog"),
    query: boundedText(256),
    catalogId: Schema.optional(ExtensionCatalogId),
    cursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("search-skills"),
    query: boundedText(256),
    cursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("preview-skill"), source: ExtensionSource }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("preview-package"), source: ExtensionSource }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("inspect-package"),
    source: ExtensionSource,
    expectedDigest: Schema.optional(ExtensionContentDigest),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("install-package"), ...versionedTarget }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("update-package"), ...versionedTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("rollback-package"), ...versionedTarget }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("uninstall-package"), ...packageTarget }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("install-skill"), ...versionedTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("update-skill"), ...versionedTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("remove-skill"), ...packageTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("reconcile-skills") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-source-trust"),
    ...desiredStateMutation,
    trusted: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-plugin-desired"),
    ...desiredStateMutation,
    desired: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-component-desired"),
    ...desiredStateMutation,
    componentId: ExtensionComponentId,
    desired: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("query-effective-state"),
    commandVersion: stateCommandVersion,
    ...ExtensionEffectiveStateQuery.fields,
  }).annotations(strict),
);
export type ExtensionCommand = typeof ExtensionCommand.Type;

export const ExtensionSnapshot = Schema.Struct({
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  packages: Schema.Array(ExtensionPackageState).pipe(Schema.maxItems(4096)),
  skills: Schema.optional(Schema.Array(StandaloneSkillRecord).pipe(Schema.maxItems(4096))),
  collisions: Schema.Array(ExtensionSkillCollision).pipe(Schema.maxItems(4096)),
}).annotations(strict);
export type ExtensionSnapshot = typeof ExtensionSnapshot.Type;

export const ExtensionEffectiveSnapshot = Schema.Struct({
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  scope: ExtensionActivationScope,
  catalogEpoch: ExtensionCatalogEpoch,
  catalogStatus: Schema.Literal("available", "offline"),
  stale: Schema.Boolean,
  packages: Schema.Array(ExtensionEffectivePackageState).pipe(Schema.maxItems(4096)),
  collisions: Schema.Array(ExtensionSkillCollision).pipe(Schema.maxItems(4096)),
}).annotations(strict);
export type ExtensionEffectiveSnapshot = typeof ExtensionEffectiveSnapshot.Type;

export const ExtensionCatalogEntry = Schema.Struct({
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  slug: ExtensionSlug,
  displayName: boundedText(128),
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  source: ExtensionSource,
}).annotations(strict);
export type ExtensionCatalogEntry = typeof ExtensionCatalogEntry.Type;

export const MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH = 128 * 1024;

export const ExtensionPackageReviewComponent = Schema.Struct({
  id: ExtensionComponentId,
  kind: ExtensionComponentKind,
  displayName: boundedText(128),
  declaredCapabilities: Schema.Array(ExtensionCapability).pipe(Schema.maxItems(32)),
  instructions: Schema.optional(boundedText(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH)),
}).annotations(strict);
export type ExtensionPackageReviewComponent = typeof ExtensionPackageReviewComponent.Type;

export const ExtensionPackageReview = Schema.Struct({
  description: Schema.optional(boundedText(4096)),
  provenance: ExtensionProvenance,
  license: ExtensionLicense,
  compatibility: ExtensionCompatibility,
  declaredCapabilities: Schema.Array(ExtensionCapability).pipe(Schema.maxItems(32)),
  components: Schema.Array(ExtensionPackageReviewComponent).pipe(
    Schema.minItems(1),
    Schema.maxItems(256),
  ),
}).annotations(strict);
export type ExtensionPackageReview = typeof ExtensionPackageReview.Type;

export const ExtensionPackagePreview = Schema.Struct({
  entry: ExtensionCatalogEntry,
  review: ExtensionPackageReview,
  diagnostics: Schema.Array(ExtensionDiagnostic).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type ExtensionPackagePreview = typeof ExtensionPackagePreview.Type;

export const SkillMarketplaceEntry = Schema.Struct({
  skill: SourceQualifiedSkill,
  source: ExtensionSource,
  version: ExtensionPackageVersion,
  displayName: boundedText(128),
  description: Schema.optional(boundedText(2048)),
  provenance: ExtensionProvenance,
}).annotations(strict);
export type SkillMarketplaceEntry = typeof SkillMarketplaceEntry.Type;

export const SkillPackagePreview = Schema.Struct({
  entry: SkillMarketplaceEntry,
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  license: ExtensionLicense,
  instructions: Schema.optional(boundedText(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH)),
  diagnostics: Schema.Array(ExtensionDiagnostic).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type SkillPackagePreview = typeof SkillPackagePreview.Type;

export const ExtensionCommandFailure = Schema.Struct({
  category: Schema.Literal(
    "invalid",
    "unauthorized",
    "blocked",
    "stale",
    "unavailable",
    "interrupted",
    "waiting",
    "failed",
  ),
  message: boundedText(1024).pipe(
    Schema.filter(
      (message) => !message.includes("/") && !message.includes("\\") && !message.includes("\0"),
    ),
  ),
}).annotations(strict);
export type ExtensionCommandFailure = typeof ExtensionCommandFailure.Type;

export const ExtensionCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("catalog-search-results"),
    entries: Schema.Array(ExtensionCatalogEntry).pipe(Schema.maxItems(256)),
    nextCursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("skill-search-results"),
    entries: Schema.Array(SkillMarketplaceEntry).pipe(Schema.maxItems(256)),
    nextCursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("skill-package-preview"),
    preview: SkillPackagePreview,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("package-preview"),
    preview: ExtensionPackagePreview,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("package-inspected"),
    preview: ExtensionPackagePreview,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("extension-state-updated"),
    snapshot: ExtensionSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("extension-effective-state"),
    snapshot: ExtensionEffectiveSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("extension-command-failed"),
    failure: ExtensionCommandFailure,
  }).annotations(strict),
);
export type ExtensionCommandResult = typeof ExtensionCommandResult.Type;

export const decodeExtensionCommand = Schema.decodeUnknownSync(ExtensionCommand);
export const decodeExtensionSnapshot = Schema.decodeUnknownSync(ExtensionSnapshot);
export const decodeExtensionEffectiveStateQuery = Schema.decodeUnknownSync(
  ExtensionEffectiveStateQuery,
);
export const decodeExtensionEffectiveSnapshot = Schema.decodeUnknownSync(
  ExtensionEffectiveSnapshot,
);
export const decodeExtensionCommandResult = Schema.decodeUnknownSync(ExtensionCommandResult);
export const decodeExtensionCommandFailure = Schema.decodeUnknownSync(ExtensionCommandFailure);
export const decodeExtensionToolApproval = Schema.decodeUnknownSync(ExtensionToolApproval);
export const decodeExtensionToolApprovalList = Schema.decodeUnknownSync(ExtensionToolApprovalList);
export const decodeExtensionToolApprovalDecision = Schema.decodeUnknownSync(
  ExtensionToolApprovalDecision,
);
