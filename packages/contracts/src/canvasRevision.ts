import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AgentRunAuthority } from "./agentRun";
import { CanvasActor, CanvasId, CanvasSchemaVersion, CanvasVersionId } from "./canvas";
import {
  CANVAS_CREATE_PROMPT_MAX_CHARS,
  CanvasCardSchemaVersion,
  CanvasOriginThreadId,
  CanvasWorkspaceScope,
} from "./canvasCards";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedNonEmptyText = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
const boundedText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));

export const CANVAS_REVISION_PROMPT_MAX_CHARS = CANVAS_CREATE_PROMPT_MAX_CHARS;
export const CANVAS_MAX_VERSION_HISTORY = 128;

export const CanvasReviseRequestId = brandedUuid("CanvasReviseRequestId");
export type CanvasReviseRequestId = typeof CanvasReviseRequestId.Type;
export const CanvasReviseReceiptId = brandedUuid("CanvasReviseReceiptId");
export type CanvasReviseReceiptId = typeof CanvasReviseReceiptId.Type;

function modeMatchesWorkspace(
  mode: OctantMode,
  workspaceKind: "chat-virtual" | "work-root" | "code-worktree",
): boolean {
  if (mode === "chat") return workspaceKind === "chat-virtual";
  if (mode === "work") return workspaceKind === "work-root";
  return workspaceKind === "code-worktree";
}

export const CanvasReviseDenialCode = Schema.Literals([
  "mode-mismatch",
  "origin-thread-mismatch",
  "scope-mismatch",
  "chat-implicit-authority",
  "work-implicit-authority",
  "code-worktree-unverified",
  "authority-widening",
  "invalid-prompt",
  "malformed-request",
  "stale-version",
  "unauthorized",
  "unavailable",
]);
export type CanvasReviseDenialCode = typeof CanvasReviseDenialCode.Type;

export const CanvasReviseRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-revise"),
  requestId: CanvasReviseRequestId,
  canvasId: CanvasId,
  expectedSequence: PositiveInt,
  prompt: boundedNonEmptyText(CANVAS_REVISION_PROMPT_MAX_CHARS),
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
  originThreadId: CanvasOriginThreadId,
  actor: CanvasActor,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.check(Schema.isMaxLength(200)),
  requestedAuthority: AgentRunAuthority,
}).check(
  Schema.makeFilter((request) => modeMatchesWorkspace(request.mode, request.workspace.kind)),
);
export type CanvasReviseRequest = typeof CanvasReviseRequest.Type;

export const CanvasReviseOutcome = Schema.Literals(["ready", "limited", "failed"]);
export type CanvasReviseOutcome = typeof CanvasReviseOutcome.Type;

export const CanvasReviseReceipt = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-revise-receipt"),
  receiptId: CanvasReviseReceiptId,
  requestId: CanvasReviseRequestId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: PositiveInt,
  outcome: CanvasReviseOutcome,
  createdAt: UtcTimestamp,
  recoveryReason: Schema.optional(boundedText(1_024)),
});
export type CanvasReviseReceipt = typeof CanvasReviseReceipt.Type;

export const CanvasReviseResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("accepted"), receipt: CanvasReviseReceipt }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasReviseDenialCode,
    message: boundedNonEmptyText(1_024),
  }),
]);
export type CanvasReviseResult = typeof CanvasReviseResult.Type;

/**
 * Opaque version-history row. Carries identity, provenance metadata, and a
 * bounded prompt summary — never definition bodies, source manifests, or secrets.
 */
export const CanvasVersionHistoryEntry = Schema.Struct({
  versionId: CanvasVersionId,
  sequence: PositiveInt,
  schemaVersion: CanvasSchemaVersion,
  title: boundedNonEmptyText(256),
  createdAt: UtcTimestamp,
  createdBy: CanvasActor,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.check(Schema.isMaxLength(200)),
  promptSummary: Schema.optional(boundedText(512)),
});
export type CanvasVersionHistoryEntry = typeof CanvasVersionHistoryEntry.Type;

export const CanvasVersionHistory = Schema.Struct({
  canvasId: CanvasId,
  currentVersionId: CanvasVersionId,
  entries: Schema.Array(CanvasVersionHistoryEntry).check(
    Schema.isMaxLength(CANVAS_MAX_VERSION_HISTORY),
  ),
});
export type CanvasVersionHistory = typeof CanvasVersionHistory.Type;

export const CanvasHistoryOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), history: CanvasVersionHistory }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: boundedNonEmptyText(1_024),
  }),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }),
]);
export type CanvasHistoryOutcome = typeof CanvasHistoryOutcome.Type;

export const decodeCanvasReviseRequestId = Schema.decodeUnknownSync(
  CanvasReviseRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasReviseReceiptId = Schema.decodeUnknownSync(
  CanvasReviseReceiptId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasReviseDenialCode = Schema.decodeUnknownSync(
  CanvasReviseDenialCode,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasReviseRequest = Schema.decodeUnknownSync(
  CanvasReviseRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasReviseReceipt = Schema.decodeUnknownSync(
  CanvasReviseReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasReviseResult = Schema.decodeUnknownSync(
  CanvasReviseResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasVersionHistoryEntry = Schema.decodeUnknownSync(
  CanvasVersionHistoryEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasVersionHistory = Schema.decodeUnknownSync(
  CanvasVersionHistory,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasHistoryOutcome = Schema.decodeUnknownSync(
  CanvasHistoryOutcome,
  STRICT_DECODE_OPTIONS,
);
