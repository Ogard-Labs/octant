import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ContentOrigin } from "./contentProvenance";
import { CorrelationId } from "./events";
import { ProjectId } from "./projects";
import { ToolExtensionId } from "./extensionIdentity";
import { ProviderInstanceId } from "./providers";

export { ToolExtensionId } from "./extensionIdentity";

const encoder = new TextEncoder();
const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedToken = (maximumLength: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[a-z][a-z0-9-]*$/),
  );
const opaqueReference = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
  ),
);

export const MAX_TOOL_ACTION_INTENT_BYTES = 4 * 1024;

export const ToolActionId = brandedUuid("ToolActionId");
export type ToolActionId = typeof ToolActionId.Type;
export const ToolCapabilityId = boundedToken(64).pipe(Schema.brand("ToolCapabilityId"));
export type ToolCapabilityId = typeof ToolCapabilityId.Type;
export const ToolHostId = brandedUuid("ToolHostId");
export type ToolHostId = typeof ToolHostId.Type;
/** Stable provider-neutral tool host identity for the single-host V1 runtime. */
export const LOCAL_TOOL_HOST_ID = Schema.decodeUnknownSync(
  ToolHostId,
  STRICT_DECODE_OPTIONS,
)("4f70656e-4f72-4269-9474-4c6f63616c31");
export const ToolRootId = brandedUuid("ToolRootId");
export type ToolRootId = typeof ToolRootId.Type;
export const ToolWorktreeId = brandedUuid("ToolWorktreeId");
export type ToolWorktreeId = typeof ToolWorktreeId.Type;
export const ToolApprovalId = brandedUuid("ToolApprovalId");
export type ToolApprovalId = typeof ToolApprovalId.Type;
export const ToolEvidenceId = brandedUuid("ToolEvidenceId");
export type ToolEvidenceId = typeof ToolEvidenceId.Type;

const ToolActionExtension = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("core") }),
  Schema.Struct({
    kind: Schema.Literal("trusted-extension"),
    extensionId: ToolExtensionId,
  }),
]);

const toolActionAuthorityFields = {
  hostId: ToolHostId,
  providerInstanceId: ProviderInstanceId,
  extension: ToolActionExtension,
};

/**
 * Chat has a real thread and provider authority but no implicit filesystem
 * scope. Work and Code retain their required Project identity; Code may also
 * carry its current root and checkout binding.
 */
export const ToolActionAuthority = Schema.Union([
  Schema.Struct({
    ...toolActionAuthorityFields,
    mode: Schema.Literal("chat"),
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    ...toolActionAuthorityFields,
    mode: Schema.Literal("work"),
    projectId: ProjectId,
    rootId: Schema.optional(ToolRootId),
    worktreeId: Schema.optional(ToolWorktreeId),
  }).check(
    Schema.makeFilter(
      (authority) => authority.worktreeId === undefined || authority.rootId !== undefined,
    ),
  ),
  Schema.Struct({
    ...toolActionAuthorityFields,
    mode: Schema.Literal("code"),
    projectId: ProjectId,
    rootId: Schema.optional(ToolRootId),
    worktreeId: Schema.optional(ToolWorktreeId),
  }).check(
    Schema.makeFilter(
      (authority) => authority.worktreeId === undefined || authority.rootId !== undefined,
    ),
  ),
]);
export type ToolActionAuthority = typeof ToolActionAuthority.Type;

export const ToolActionCapability = Schema.Struct({
  id: ToolCapabilityId,
  version: PositiveInt,
});
export type ToolActionCapability = typeof ToolActionCapability.Type;

export const ToolActionApproval = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-required") }),
  Schema.Struct({ kind: Schema.Literal("pending") }),
  Schema.Struct({ kind: Schema.Literal("approved"), approvalId: ToolApprovalId }),
  Schema.Struct({ kind: Schema.Literal("denied") }),
]);
export type ToolActionApproval = typeof ToolActionApproval.Type;

export const ToolActionRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  capability: ToolActionCapability,
  authority: ToolActionAuthority,
  intent: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= MAX_TOOL_ACTION_INTENT_BYTES),
  ),
  approval: ToolActionApproval,
});
export type ToolActionRequest = typeof ToolActionRequest.Type;

export const ToolActionCancellation = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  reason: Schema.Literals(["user-requested", "authority-revoked", "shutdown"]),
});
export type ToolActionCancellation = typeof ToolActionCancellation.Type;

export const ToolEvidence = Schema.Struct({
  evidenceId: ToolEvidenceId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: Schema.Literals(["tool-output", "observation", "validation-report"]),
  reference: opaqueReference,
  /** Provenance origin for untrusted-content policy; never instructions. */
  origin: ContentOrigin,
});
export type ToolEvidence = typeof ToolEvidence.Type;

/** Structural equality for tool action authority scopes. Exported so the
 *  domain policy layer reuses the same comparison rather than duplicating it. */
export function sameToolActionAuthority(
  left: ToolActionAuthority,
  right: ToolActionAuthority,
): boolean {
  return (
    left.hostId === right.hostId &&
    left.mode === right.mode &&
    left.projectId === right.projectId &&
    ("rootId" in left ? left.rootId : undefined) ===
      ("rootId" in right ? right.rootId : undefined) &&
    ("worktreeId" in left ? left.worktreeId : undefined) ===
      ("worktreeId" in right ? right.worktreeId : undefined) &&
    left.providerInstanceId === right.providerInstanceId &&
    left.extension.kind === right.extension.kind &&
    (left.extension.kind === "core" ||
      (right.extension.kind === "trusted-extension" &&
        left.extension.extensionId === right.extension.extensionId))
  );
}

const ToolActionFailureOutcome = Schema.Struct({
  kind: Schema.Literals([
    "unavailable",
    "unauthorized",
    "waiting",
    "interrupted",
    "inconclusive",
    "failed",
  ]),
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  reason: boundedToken(128),
});

export const ToolActionOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("completed"),
    actionId: ToolActionId,
    correlationId: CorrelationId,
    authority: ToolActionAuthority,
    evidence: Schema.NonEmptyArray(ToolEvidence),
  }).check(
    Schema.makeFilter((outcome) =>
      outcome.evidence.every(
        (evidence) =>
          evidence.actionId === outcome.actionId &&
          evidence.correlationId === outcome.correlationId &&
          sameToolActionAuthority(evidence.authority, outcome.authority),
      ),
    ),
  ),
  ToolActionFailureOutcome,
]);
export type ToolActionOutcome = typeof ToolActionOutcome.Type;

export const decodeToolActionRequest = Schema.decodeUnknownSync(
  ToolActionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolActionId = Schema.decodeUnknownSync(ToolActionId, STRICT_DECODE_OPTIONS);
export const decodeToolActionCapability = Schema.decodeUnknownSync(
  ToolActionCapability,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolActionAuthority = Schema.decodeUnknownSync(
  ToolActionAuthority,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolApprovalId = Schema.decodeUnknownSync(ToolApprovalId, STRICT_DECODE_OPTIONS);
export const decodeToolExtensionId = Schema.decodeUnknownSync(
  ToolExtensionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolActionCancellation = Schema.decodeUnknownSync(
  ToolActionCancellation,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolActionOutcome = Schema.decodeUnknownSync(
  ToolActionOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolEvidence = Schema.decodeUnknownSync(ToolEvidence, STRICT_DECODE_OPTIONS);
