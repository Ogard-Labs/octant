import { Schema } from "effect";
import { ContentOrigin } from "./contentProvenance";
import { CorrelationId } from "./events";
import { ProjectId } from "./projects";
import { ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedToken = (maximumLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maximumLength),
    Schema.pattern(/^[a-z][a-z0-9-]*$/),
  );
const opaqueReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.filter((value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0")),
);

export const MAX_TOOL_ACTION_INTENT_BYTES = 4 * 1024;

export const ToolActionId = brandedUuid("ToolActionId");
export type ToolActionId = typeof ToolActionId.Type;
export const ToolCapabilityId = boundedToken(64).pipe(Schema.brand("ToolCapabilityId"));
export type ToolCapabilityId = typeof ToolCapabilityId.Type;
export const ToolHostId = brandedUuid("ToolHostId");
export type ToolHostId = typeof ToolHostId.Type;
/** Stable provider-neutral tool host identity for the single-host V1 runtime. */
export const LOCAL_TOOL_HOST_ID = Schema.decodeUnknownSync(ToolHostId)(
  "4f70656e-4f72-4269-9474-4c6f63616c31",
);
export const ToolRootId = brandedUuid("ToolRootId");
export type ToolRootId = typeof ToolRootId.Type;
export const ToolWorktreeId = brandedUuid("ToolWorktreeId");
export type ToolWorktreeId = typeof ToolWorktreeId.Type;
export const ToolExtensionId = brandedUuid("ToolExtensionId");
export type ToolExtensionId = typeof ToolExtensionId.Type;
export const ToolApprovalId = brandedUuid("ToolApprovalId");
export type ToolApprovalId = typeof ToolApprovalId.Type;
export const ToolEvidenceId = brandedUuid("ToolEvidenceId");
export type ToolEvidenceId = typeof ToolEvidenceId.Type;

export const ToolActionAuthority = Schema.Struct({
  hostId: ToolHostId,
  mode: Schema.Literal("chat", "work", "code"),
  projectId: ProjectId,
  rootId: Schema.optional(ToolRootId),
  worktreeId: Schema.optional(ToolWorktreeId),
  providerInstanceId: ProviderInstanceId,
  extension: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("core") }).annotations(strict),
    Schema.Struct({
      kind: Schema.Literal("trusted-extension"),
      extensionId: ToolExtensionId,
    }).annotations(strict),
  ),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (authority) => authority.worktreeId === undefined || authority.rootId !== undefined,
    ),
  );
export type ToolActionAuthority = typeof ToolActionAuthority.Type;

export const ToolActionCapability = Schema.Struct({
  id: ToolCapabilityId,
  version: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type ToolActionCapability = typeof ToolActionCapability.Type;

export const ToolActionApproval = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("not-required") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("pending") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("approved"), approvalId: ToolApprovalId }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("denied") }).annotations(strict),
);
export type ToolActionApproval = typeof ToolActionApproval.Type;

export const ToolActionRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  capability: ToolActionCapability,
  authority: ToolActionAuthority,
  intent: Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= MAX_TOOL_ACTION_INTENT_BYTES),
  ),
  approval: ToolActionApproval,
}).annotations(strict);
export type ToolActionRequest = typeof ToolActionRequest.Type;

export const ToolActionCancellation = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  reason: Schema.Literal("user-requested", "authority-revoked", "shutdown"),
}).annotations(strict);
export type ToolActionCancellation = typeof ToolActionCancellation.Type;

export const ToolEvidence = Schema.Struct({
  evidenceId: ToolEvidenceId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: Schema.Literal("tool-output", "observation", "validation-report"),
  reference: opaqueReference,
  /** Provenance origin for untrusted-content policy; never instructions. */
  origin: ContentOrigin,
}).annotations(strict);
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
    left.rootId === right.rootId &&
    left.worktreeId === right.worktreeId &&
    left.providerInstanceId === right.providerInstanceId &&
    left.extension.kind === right.extension.kind &&
    (left.extension.kind === "core" ||
      (right.extension.kind === "trusted-extension" &&
        left.extension.extensionId === right.extension.extensionId))
  );
}

const ToolActionFailureOutcome = Schema.Struct({
  kind: Schema.Literal(
    "unavailable",
    "unauthorized",
    "waiting",
    "interrupted",
    "inconclusive",
    "failed",
  ),
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  reason: boundedToken(128),
}).annotations(strict);

export const ToolActionOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("completed"),
    actionId: ToolActionId,
    correlationId: CorrelationId,
    authority: ToolActionAuthority,
    evidence: Schema.NonEmptyArray(ToolEvidence),
  })
    .annotations(strict)
    .pipe(
      Schema.filter((outcome) =>
        outcome.evidence.every(
          (evidence) =>
            evidence.actionId === outcome.actionId &&
            evidence.correlationId === outcome.correlationId &&
            sameToolActionAuthority(evidence.authority, outcome.authority),
        ),
      ),
    ),
  ToolActionFailureOutcome,
);
export type ToolActionOutcome = typeof ToolActionOutcome.Type;

export const decodeToolActionRequest = Schema.decodeUnknownSync(ToolActionRequest);
export const decodeToolActionId = Schema.decodeUnknownSync(ToolActionId);
export const decodeToolActionCapability = Schema.decodeUnknownSync(ToolActionCapability);
export const decodeToolActionAuthority = Schema.decodeUnknownSync(ToolActionAuthority);
export const decodeToolExtensionId = Schema.decodeUnknownSync(ToolExtensionId);
export const decodeToolActionCancellation = Schema.decodeUnknownSync(ToolActionCancellation);
export const decodeToolActionOutcome = Schema.decodeUnknownSync(ToolActionOutcome);
export const decodeToolEvidence = Schema.decodeUnknownSync(ToolEvidence);
