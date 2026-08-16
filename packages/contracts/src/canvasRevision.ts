import { Schema } from "effect";
import { AgentRunAuthority } from "./agentRun";
import {
  CanvasActor,
  CanvasId,
  CanvasVersion,
  CanvasVersionId,
  CANVAS_SCHEMA_VERSION,
} from "./canvas";
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

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedNonEmptyText = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));
const boundedText = (maxLength: number) => Schema.String.pipe(Schema.maxLength(maxLength));

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

export const CanvasReviseDenialCode = Schema.Literal(
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
);
export type CanvasReviseDenialCode = typeof CanvasReviseDenialCode.Type;

export const CanvasReviseRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-revise"),
  requestId: CanvasReviseRequestId,
  canvasId: CanvasId,
  expectedSequence: Schema.Int.pipe(Schema.positive()),
  prompt: boundedNonEmptyText(CANVAS_REVISION_PROMPT_MAX_CHARS),
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
  originThreadId: CanvasOriginThreadId,
  actor: CanvasActor,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.pipe(Schema.maxLength(200)),
  requestedAuthority: AgentRunAuthority,
})
  .annotations(strict)
  .pipe(Schema.filter((request) => modeMatchesWorkspace(request.mode, request.workspace.kind)));
export type CanvasReviseRequest = typeof CanvasReviseRequest.Type;

export const CanvasReviseOutcome = Schema.Literal("ready", "limited", "failed");
export type CanvasReviseOutcome = typeof CanvasReviseOutcome.Type;

export const CanvasReviseReceipt = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-revise-receipt"),
  receiptId: CanvasReviseReceiptId,
  requestId: CanvasReviseRequestId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  outcome: CanvasReviseOutcome,
  createdAt: UtcTimestamp,
  recoveryReason: Schema.optional(boundedText(1_024)),
}).annotations(strict);
export type CanvasReviseReceipt = typeof CanvasReviseReceipt.Type;

export const CanvasReviseResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("accepted"), receipt: CanvasReviseReceipt }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasReviseDenialCode,
    message: boundedNonEmptyText(1_024),
  }).annotations(strict),
);
export type CanvasReviseResult = typeof CanvasReviseResult.Type;

/**
 * Opaque version-history row. Carries identity, provenance metadata, and a
 * bounded prompt summary — never definition bodies, source manifests, or secrets.
 */
export const CanvasVersionHistoryEntry = Schema.Struct({
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  schemaVersion: Schema.Literal(CANVAS_SCHEMA_VERSION),
  title: boundedNonEmptyText(256),
  createdAt: UtcTimestamp,
  createdBy: CanvasActor,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.pipe(Schema.maxLength(200)),
  promptSummary: Schema.optional(boundedText(512)),
}).annotations(strict);
export type CanvasVersionHistoryEntry = typeof CanvasVersionHistoryEntry.Type;

export const CanvasVersionHistory = Schema.Struct({
  canvasId: CanvasId,
  currentVersionId: CanvasVersionId,
  entries: Schema.Array(CanvasVersionHistoryEntry).pipe(
    Schema.maxItems(CANVAS_MAX_VERSION_HISTORY),
  ),
}).annotations(strict);
export type CanvasVersionHistory = typeof CanvasVersionHistory.Type;

export const CanvasHistoryOutcome = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("ready"), history: CanvasVersionHistory }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: boundedNonEmptyText(1_024),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }).annotations(strict),
);
export type CanvasHistoryOutcome = typeof CanvasHistoryOutcome.Type;

export const decodeCanvasReviseRequestId = Schema.decodeUnknownSync(CanvasReviseRequestId);
export const decodeCanvasReviseReceiptId = Schema.decodeUnknownSync(CanvasReviseReceiptId);
export const decodeCanvasReviseDenialCode = Schema.decodeUnknownSync(CanvasReviseDenialCode);
export const decodeCanvasReviseRequest = Schema.decodeUnknownSync(CanvasReviseRequest);
export const decodeCanvasReviseReceipt = Schema.decodeUnknownSync(CanvasReviseReceipt);
export const decodeCanvasReviseResult = Schema.decodeUnknownSync(CanvasReviseResult);
export const decodeCanvasVersionHistoryEntry = Schema.decodeUnknownSync(CanvasVersionHistoryEntry);
export const decodeCanvasVersionHistory = Schema.decodeUnknownSync(CanvasVersionHistory);
export const decodeCanvasHistoryOutcome = Schema.decodeUnknownSync(CanvasHistoryOutcome);
