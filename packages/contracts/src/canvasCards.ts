import { Schema } from "effect";
import { AgentRunAuthority } from "./agentRun";
import { CanvasId, CanvasSourceManifest, CanvasVersionId } from "./canvas";
import { ChatThreadId } from "./chat";
import { CodeCheckoutId, CodeRepositoryId, CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";
import { ActorId, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { BindingRevisionId, ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ThreadCreationRootId } from "./threadCreation";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedNonEmptyText = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));
const boundedText = (maxLength: number) => Schema.String.pipe(Schema.maxLength(maxLength));
const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    Schema.brand(brand),
  );

// Canvas cards are the durable bridge between a creation event and the
// originating thread. They are versioned independently from the rendering
// surface so a future renderer can be reviewed before it is advertised.
export const CANVAS_CARD_SCHEMA_VERSION = 1 as const;
export const CanvasCardSchemaVersion = Schema.Literal(CANVAS_CARD_SCHEMA_VERSION);
export type CanvasCardSchemaVersion = typeof CanvasCardSchemaVersion.Type;

export const CANVAS_CREATE_PROMPT_MAX_CHARS = 8_192;
export const CANVAS_CARD_TITLE_MAX_CHARS = 256;
export const CANVAS_CARD_SUMMARY_MAX_CHARS = 4_096;
export const CANVAS_CARD_MAX_ACTIONS = 16;

export const CanvasCreateRequestId = brandedUuid("CanvasCreateRequestId");
export type CanvasCreateRequestId = typeof CanvasCreateRequestId.Type;
export const CanvasCreateReceiptId = brandedUuid("CanvasCreateReceiptId");
export type CanvasCreateReceiptId = typeof CanvasCreateReceiptId.Type;
export const CanvasCardId = brandedUuid("CanvasCardId");
export type CanvasCardId = typeof CanvasCardId.Type;

// A Canvas originates in exactly one mode/thread/Project, so the origin
// thread identity is a union of the mode-specific thread IDs.
export const CanvasOriginThreadId = Schema.Union(ChatThreadId, WorkThreadId, CodeThreadId);
export type CanvasOriginThreadId = typeof CanvasOriginThreadId.Type;

export const CanvasIntentKind = Schema.Literal("blank", "template", "prompt");
export type CanvasIntentKind = typeof CanvasIntentKind.Type;

function modeMatchesWorkspace(
  mode: OctantMode,
  workspaceKind: "chat-virtual" | "work-root" | "code-worktree",
): boolean {
  if (mode === "chat") return workspaceKind === "chat-virtual";
  if (mode === "work") return workspaceKind === "work-root";
  return workspaceKind === "code-worktree";
}

// The creation/card workspace is the mode-specific bounded scope the Canvas
// may never leave implicitly. Chat canvases stay in virtual memory; Work
// canvases stay inside the confined root; Code canvases stay in the chosen
// worktree.
export const CanvasWorkspaceScope = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("chat-virtual"),
    projectId: Schema.NullOr(ProjectId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("work-root"),
    projectId: ProjectId,
    rootId: ThreadCreationRootId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-worktree"),
    projectId: ProjectId,
    repositoryId: CodeRepositoryId,
    bindingRevisionId: BindingRevisionId,
    checkoutId: CodeCheckoutId,
    verified: Schema.Boolean,
  }).annotations(strict),
);
export type CanvasWorkspaceScope = typeof CanvasWorkspaceScope.Type;

export const CanvasScope = Schema.Struct({
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
})
  .annotations(strict)
  .pipe(
    Schema.filter((scope) => {
      if (scope.mode === "chat") return scope.workspace.kind === "chat-virtual";
      if (scope.mode === "work") return scope.workspace.kind === "work-root";
      return scope.workspace.kind === "code-worktree";
    }),
  );
export type CanvasScope = typeof CanvasScope.Type;

export const CanvasCreateDenialCode = Schema.Literal(
  "mode-mismatch",
  "origin-thread-mismatch",
  "scope-mismatch",
  "chat-implicit-authority",
  "work-implicit-authority",
  "code-worktree-required",
  "code-worktree-unverified",
  "authority-widening",
  "invalid-prompt",
  "invalid-template",
  "malformed-request",
  "card-not-ready",
  "unauthorized",
  "unavailable",
);
export type CanvasCreateDenialCode = typeof CanvasCreateDenialCode.Type;

export const CanvasCardStatus = Schema.Literal(
  "creating",
  "ready",
  "limited",
  "stale",
  "offline",
  "unauthorized",
  "invalid",
  "interrupted",
  "oversized",
  "incompatible",
  "failed",
);
export type CanvasCardStatus = typeof CanvasCardStatus.Type;

export const CanvasCreateRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-create"),
  requestId: CanvasCreateRequestId,
  intent: CanvasIntentKind,
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
  originThreadId: CanvasOriginThreadId,
  title: boundedNonEmptyText(CANVAS_CARD_TITLE_MAX_CHARS),
  prompt: Schema.optional(boundedText(CANVAS_CREATE_PROMPT_MAX_CHARS)),
  templateId: Schema.optional(boundedToken("CanvasTemplateId")),
  sourceManifest: CanvasSourceManifest,
  requestedAuthority: AgentRunAuthority,
})
  .annotations(strict)
  .pipe(
    Schema.filter((request) => modeMatchesWorkspace(request.mode, request.workspace.kind)),
    Schema.filter((request) => {
      if (request.intent === "prompt" && request.prompt === undefined) return false;
      if (request.intent !== "prompt" && request.prompt !== undefined) return false;
      if (request.intent === "template" && request.templateId === undefined) return false;
      return true;
    }),
  );
export type CanvasCreateRequest = typeof CanvasCreateRequest.Type;

export const CanvasCreateReceipt = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-create-receipt"),
  receiptId: CanvasCreateReceiptId,
  requestId: CanvasCreateRequestId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  intent: CanvasIntentKind,
  originThreadId: CanvasOriginThreadId,
  scope: CanvasScope,
  title: boundedNonEmptyText(CANVAS_CARD_TITLE_MAX_CHARS),
  effectiveAuthority: AgentRunAuthority,
  outcome: CanvasCardStatus,
  createdAt: UtcTimestamp,
  recoveryReason: Schema.optional(boundedText(1_024)),
}).annotations(strict);
export type CanvasCreateReceipt = typeof CanvasCreateReceipt.Type;

export const CanvasThreadReferenceCard = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-reference-card"),
  cardId: CanvasCardId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  title: boundedNonEmptyText(CANVAS_CARD_TITLE_MAX_CHARS),
  scope: CanvasScope,
  originThreadId: CanvasOriginThreadId,
  status: CanvasCardStatus,
  authority: AgentRunAuthority,
  actorId: ActorId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.pipe(Schema.maxLength(200)),
  createdAt: UtcTimestamp,
  summary: Schema.optional(boundedText(CANVAS_CARD_SUMMARY_MAX_CHARS)),
  actionCount: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(CANVAS_CARD_MAX_ACTIONS),
  ),
}).annotations(strict);
export type CanvasThreadReferenceCard = typeof CanvasThreadReferenceCard.Type;

export const CanvasCreateResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    receipt: CanvasCreateReceipt,
    card: CanvasThreadReferenceCard,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasCreateDenialCode,
    message: boundedNonEmptyText(1_024),
  }).annotations(strict),
);
export type CanvasCreateResult = typeof CanvasCreateResult.Type;

export const CanvasThreadReferenceCardsOutcome = Schema.Struct({
  mode: OctantMode,
  threadId: CanvasOriginThreadId,
  projectId: Schema.NullOr(ProjectId),
  cards: Schema.Array(CanvasThreadReferenceCard),
}).annotations(strict);
export type CanvasThreadReferenceCardsOutcome = typeof CanvasThreadReferenceCardsOutcome.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeCanvasCardSchemaVersion = Schema.decodeUnknownSync(CanvasCardSchemaVersion);
export const decodeCanvasCreateRequestId = Schema.decodeUnknownSync(CanvasCreateRequestId);
export const decodeCanvasCreateReceiptId = Schema.decodeUnknownSync(CanvasCreateReceiptId);
export const decodeCanvasCardId = Schema.decodeUnknownSync(CanvasCardId);
export const decodeCanvasOriginThreadId = Schema.decodeUnknownSync(CanvasOriginThreadId);
export const decodeCanvasIntentKind = Schema.decodeUnknownSync(CanvasIntentKind);
export const decodeCanvasWorkspaceScope = Schema.decodeUnknownSync(CanvasWorkspaceScope);
export const decodeCanvasScope = Schema.decodeUnknownSync(CanvasScope);
export const decodeCanvasCreateDenialCode = Schema.decodeUnknownSync(CanvasCreateDenialCode);
export const decodeCanvasCardStatus = Schema.decodeUnknownSync(CanvasCardStatus);
export const decodeCanvasCreateRequest = Schema.decodeUnknownSync(CanvasCreateRequest);
export const decodeCanvasCreateReceipt = Schema.decodeUnknownSync(CanvasCreateReceipt);
export const decodeCanvasCreateResult = Schema.decodeUnknownSync(CanvasCreateResult);
export const decodeCanvasThreadReferenceCard = Schema.decodeUnknownSync(CanvasThreadReferenceCard);
export const decodeCanvasThreadReferenceCardsOutcome = Schema.decodeUnknownSync(
  CanvasThreadReferenceCardsOutcome,
);
