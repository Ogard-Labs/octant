import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AgentRunAuthority } from "./agentRun";
import {
  CanvasActor,
  CanvasId,
  CanvasSourceManifest,
  CanvasSourceId,
  CanvasSourceVersion,
  CanvasVersionId,
} from "./canvas";
import {
  CanvasCardSchemaVersion,
  CanvasOriginThreadId,
  CanvasScope,
  CanvasWorkspaceScope,
} from "./canvasCards";
import { CanvasSkillContribution } from "./canvasSkill";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import {
  ExtensionPackageVersion,
  SourceQualifiedSkillId,
  StandaloneSkillScope,
} from "./extensions";

export const CANVAS_REFRESH_MAX_PARAMETERS = 32;
export const CANVAS_REFRESH_PARAMETER_VALUE_MAX_CHARS = 512;
export const CANVAS_REFRESH_MESSAGE_MAX_CHARS = 1_024;
const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedNonEmptyText = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
const boundedToken = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.Trimmed.pipe(
    Schema.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(128),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    ),
    Schema.brand<B>(brand),
  );
// Values are typed server-owned references (opaque or ref) only. Free-form
// `literal:` text is intentionally rejected so a secret-shaped value can never
// be journaled in a durable recipe; the policy boundary enforces the same rule
// against independently constructed receipts.
const CanvasRefreshParameterValue = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(CANVAS_REFRESH_PARAMETER_VALUE_MAX_CHARS),
  Schema.isPattern(/^(?:opaque|ref):[A-Za-z0-9._:-]+$/),
);

export const CanvasRefreshRequestId = brandedUuid("CanvasRefreshRequestId");
export type CanvasRefreshRequestId = typeof CanvasRefreshRequestId.Type;
export const CanvasRefreshRecipeId = brandedUuid("CanvasRefreshRecipeId");
export type CanvasRefreshRecipeId = typeof CanvasRefreshRecipeId.Type;

export const CanvasRefreshParameter = Schema.Struct({
  key: boundedToken("CanvasRefreshParameterKey"),
  /** Values are server-owned opaque/ref references, never raw text or credentials. */
  value: CanvasRefreshParameterValue,
});
export type CanvasRefreshParameter = typeof CanvasRefreshParameter.Type;

export const CanvasRefreshSkill = Schema.Struct({
  /** Canonical source/name/digest identity, not the package UUID alone. */
  qualifiedId: SourceQualifiedSkillId,
  /** Some bundled/provider-native skills have no package version; identity is
   * still pinned by qualifiedId (which includes the source digest). */
  version: Schema.optional(ExtensionPackageVersion),
  scope: Schema.optional(StandaloneSkillScope),
});
export type CanvasRefreshSkill = typeof CanvasRefreshSkill.Type;

export const CANVAS_REFRESH_MAX_SKILL_OPTIONS = 64;

/**
 * A skill the host says is eligible to present a specific Canvas: trusted,
 * enabled, effective, and in scope for that Canvas's mode, Project, and thread.
 * A client cannot mint one — `qualifiedId` pins a source digest the renderer
 * has no way to know — so offering a choice at all requires the host to publish
 * the options. Selection carries no authority: the server reauthorizes the
 * chosen skill on the refresh itself and a contribution only ever adds
 * presentation metadata.
 */
export const CanvasRefreshSkillOption = Schema.Struct({
  skill: CanvasRefreshSkill,
  displayName: boundedNonEmptyText(128),
});
export type CanvasRefreshSkillOption = typeof CanvasRefreshSkillOption.Type;

export const CanvasRefreshSkillOptions = Schema.Array(CanvasRefreshSkillOption).check(
  Schema.isMaxLength(CANVAS_REFRESH_MAX_SKILL_OPTIONS),
);
export type CanvasRefreshSkillOptions = typeof CanvasRefreshSkillOptions.Type;

export const CanvasRefreshRecipe = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-refresh-recipe"),
  recipeId: CanvasRefreshRecipeId,
  canvasId: CanvasId,
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
  originThreadId: CanvasOriginThreadId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.check(Schema.isMaxLength(200)),
  parameters: Schema.Array(CanvasRefreshParameter).check(
    Schema.isMaxLength(CANVAS_REFRESH_MAX_PARAMETERS),
  ),
  // Refresh always reauthorizes at least one canonical source. Source-free
  // regeneration requires a separate authoritative generator contract.
  sourceManifest: CanvasSourceManifest.check(Schema.isMinLength(1)),
  skill: Schema.optional(CanvasRefreshSkill),
});
export type CanvasRefreshRecipe = typeof CanvasRefreshRecipe.Type;

export const CanvasRefreshRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-refresh"),
  requestId: CanvasRefreshRequestId,
  canvasId: CanvasId,
  recipe: CanvasRefreshRecipe,
  expectedSequence: PositiveInt,
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
  originThreadId: CanvasOriginThreadId,
  actor: CanvasActor,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.check(Schema.isMaxLength(200)),
  requestedAuthority: AgentRunAuthority,
});
export type CanvasRefreshRequest = typeof CanvasRefreshRequest.Type;

export const CanvasRefreshCancelRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-refresh-cancel"),
  requestId: CanvasRefreshRequestId,
  recipeId: CanvasRefreshRecipeId,
  canvasId: CanvasId,
});
export type CanvasRefreshCancelRequest = typeof CanvasRefreshCancelRequest.Type;

export const CanvasRefreshSourceStatus = Schema.Literals([
  "ready",
  "stale",
  "missing",
  "revoked",
  "offline",
  "incompatible",
  "unauthorized",
  "interrupted",
  "oversized",
  "failed",
]);
export type CanvasRefreshSourceStatus = typeof CanvasRefreshSourceStatus.Type;

export const CanvasRefreshSourceResult = Schema.Struct({
  sourceId: CanvasSourceId,
  status: CanvasRefreshSourceStatus,
  message: Schema.optional(boundedNonEmptyText(CANVAS_REFRESH_MESSAGE_MAX_CHARS)),
  observedVersion: Schema.optional(CanvasSourceVersion),
});
export type CanvasRefreshSourceResult = typeof CanvasRefreshSourceResult.Type;

export const CanvasRefreshOutcome = Schema.Literals([
  "ready",
  "limited",
  "partial",
  "cancelled",
  "failed",
]);
export type CanvasRefreshOutcome = typeof CanvasRefreshOutcome.Type;

export const CanvasRefreshReceipt = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-refresh-receipt"),
  requestId: CanvasRefreshRequestId,
  recipeId: CanvasRefreshRecipeId,
  recipe: Schema.optional(CanvasRefreshRecipe),
  canvasId: CanvasId,
  versionId: Schema.optional(CanvasVersionId),
  sequence: Schema.optional(PositiveInt),
  outcome: CanvasRefreshOutcome,
  sources: Schema.Array(CanvasRefreshSourceResult),
  completedAt: UtcTimestamp,
  recoveryReason: Schema.optional(boundedNonEmptyText(CANVAS_REFRESH_MESSAGE_MAX_CHARS)),
});
export type CanvasRefreshReceipt = typeof CanvasRefreshReceipt.Type;

/** Durable journal payload for refresh idempotency and cancellation replay. */
export const CanvasRefreshReceiptRecorded = Schema.Struct({
  receipt: CanvasRefreshReceipt,
});
export type CanvasRefreshReceiptRecorded = typeof CanvasRefreshReceiptRecorded.Type;

export const CANVAS_REFRESH_RECEIPT_RECORDED = "canvas.refresh-receipt-recorded@1";

export const CanvasRefreshDenialCode = Schema.Literals([
  "malformed-request",
  "unavailable",
  "unauthorized",
  "scope-mismatch",
  "mode-mismatch",
  "origin-thread-mismatch",
  "stale-version",
  "revoked",
  "offline",
  "incompatible",
  "cancelled",
]);
export type CanvasRefreshDenialCode = typeof CanvasRefreshDenialCode.Type;

export const CanvasRefreshResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    receipt: CanvasRefreshReceipt,
    /**
     * Provenance for the trusted skill that shaped this refresh, when one did.
     * The host already resolves the contribution to authorize the refresh;
     * returning it lets a viewer audit where a layout came from. It is
     * presentation metadata only and never grants authority.
     */
    contribution: Schema.optional(CanvasSkillContribution),
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasRefreshDenialCode,
    message: boundedNonEmptyText(CANVAS_REFRESH_MESSAGE_MAX_CHARS),
  }),
]);
export type CanvasRefreshResult = typeof CanvasRefreshResult.Type;

export const decodeCanvasRefreshRequestId = Schema.decodeUnknownSync(
  CanvasRefreshRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasRefreshRecipeId = Schema.decodeUnknownSync(
  CanvasRefreshRecipeId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasRefreshRequest = Schema.decodeUnknownSync(
  CanvasRefreshRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasRefreshCancelRequest = Schema.decodeUnknownSync(
  CanvasRefreshCancelRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasRefreshSourceResult = Schema.decodeUnknownSync(
  CanvasRefreshSourceResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasRefreshReceipt = Schema.decodeUnknownSync(
  CanvasRefreshReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasRefreshReceiptRecorded = Schema.decodeUnknownSync(
  CanvasRefreshReceiptRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasRefreshResult = Schema.decodeUnknownSync(
  CanvasRefreshResult,
  STRICT_DECODE_OPTIONS,
);

// Kept as a named type import target for callers that need the exact scope
// shape without re-exporting a second Canvas authority model.
export type CanvasRefreshScope = CanvasScope;
