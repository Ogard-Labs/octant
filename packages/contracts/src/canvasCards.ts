import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AgentRunAuthority } from "./agentRun";
import { CanvasId, CanvasPresentation, CanvasSourceManifest, CanvasVersionId } from "./canvas";
import { ChatThreadId } from "./chat";
import { CodeCheckoutId, CodeRepositoryId, CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";
import { ActorId, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { BindingRevisionId, ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ThreadCreationRootId } from "./threadCreation";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedNonEmptyText = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
const boundedText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const boundedToken = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.Trimmed.pipe(
    Schema.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(128),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    ),
    Schema.brand<B>(brand),
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
export const CanvasOriginThreadId = Schema.Union([ChatThreadId, WorkThreadId, CodeThreadId]);
export type CanvasOriginThreadId = typeof CanvasOriginThreadId.Type;

export const CanvasIntentKind = Schema.Literals(["blank", "template", "prompt"]);
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
export const CanvasWorkspaceScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat-virtual"),
    projectId: Schema.NullOr(ProjectId),
  }),
  Schema.Struct({
    kind: Schema.Literal("work-root"),
    projectId: ProjectId,
    rootId: ThreadCreationRootId,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-worktree"),
    projectId: ProjectId,
    repositoryId: CodeRepositoryId,
    bindingRevisionId: BindingRevisionId,
    checkoutId: CodeCheckoutId,
    verified: Schema.Boolean,
  }),
]);
export type CanvasWorkspaceScope = typeof CanvasWorkspaceScope.Type;

export const CanvasScope = Schema.Struct({
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
}).check(
  Schema.makeFilter((scope) => {
    if (scope.mode === "chat") return scope.workspace.kind === "chat-virtual";
    if (scope.mode === "work") return scope.workspace.kind === "work-root";
    return scope.workspace.kind === "code-worktree";
  }),
);
export type CanvasScope = typeof CanvasScope.Type;

export const CanvasCreateDenialCode = Schema.Literals([
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
]);
export type CanvasCreateDenialCode = typeof CanvasCreateDenialCode.Type;

export const CanvasCardStatus = Schema.Literals([
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
]);
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
}).check(
  Schema.makeFilter((request) => modeMatchesWorkspace(request.mode, request.workspace.kind)),
  Schema.makeFilter((request) => {
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
});
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
  modelId: ProviderModelId.check(Schema.isMaxLength(200)),
  createdAt: UtcTimestamp,
  summary: Schema.optional(boundedText(CANVAS_CARD_SUMMARY_MAX_CHARS)),
  actionCount: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(CANVAS_CARD_MAX_ACTIONS),
  ),
  /**
   * Where the thread shows this Canvas now, after the host's inline bound. A
   * host that predates the hint sends none, and the thread shows a card.
   */
  presentation: Schema.optional(CanvasPresentation),
  /** When the Canvas's first version was written, so a thread can place it in the turn that made it. */
  canvasCreatedAt: Schema.optional(UtcTimestamp),
});
export type CanvasThreadReferenceCard = typeof CanvasThreadReferenceCard.Type;

export const CanvasCreateResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    receipt: CanvasCreateReceipt,
    card: CanvasThreadReferenceCard,
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasCreateDenialCode,
    message: boundedNonEmptyText(1_024),
  }),
]);
export type CanvasCreateResult = typeof CanvasCreateResult.Type;

/**
 * The largest page a person may import, in UTF-8 bytes. What survives the
 * import must still fit one design frame and its stylesheet
 * (`CANVAS_MAX_DESIGN_MARKUP_LENGTH` each); this bound only keeps the host
 * from reading a file far larger than any page it could draw.
 */
export const CANVAS_HTML_IMPORT_MAX_BYTES = 262_144;

/**
 * A page a person brings into a new Canvas: a file they chose or markup they
 * pasted. It carries the same scope a create does, and the host checks it the
 * same way, so an import can never reach a Project or thread a create could
 * not. `title` is what the person typed; the host falls back to the file name.
 */
export const CanvasHtmlImportRequest = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-html-import"),
  requestId: CanvasCreateRequestId,
  hostId: HostId,
  mode: OctantMode,
  workspace: CanvasWorkspaceScope,
  originThreadId: CanvasOriginThreadId,
  requestedAuthority: AgentRunAuthority,
  source: Schema.Literals(["file", "paste"]),
  title: Schema.optional(boundedNonEmptyText(CANVAS_CARD_TITLE_MAX_CHARS)),
  fileName: Schema.optional(boundedNonEmptyText(CANVAS_CARD_TITLE_MAX_CHARS)),
  /** Bounded by the host in bytes, so an oversized page is refused as too large, not malformed. */
  html: Schema.String,
}).check(
  Schema.makeFilter((request) => modeMatchesWorkspace(request.mode, request.workspace.kind)),
);
export type CanvasHtmlImportRequest = typeof CanvasHtmlImportRequest.Type;

/**
 * Why a page was not imported. `too-large`: past the import bound, or what
 * remains does not fit one design frame. `not-html`: no element at all, or
 * binary content. `unparseable`: a tag, comment, or script that never ends.
 * `empty`: nothing left to draw. `unsupported`: markup the design policy still
 * refuses after the import took out what it loads.
 */
export const CanvasHtmlImportRefusalReason = Schema.Literals([
  "too-large",
  "not-html",
  "unparseable",
  "empty",
  "unsupported",
]);
export type CanvasHtmlImportRefusalReason = typeof CanvasHtmlImportRefusalReason.Type;

/**
 * What the import took out of the page because a design frame loads nothing
 * and leaves nothing: files from the network, links out of the page, embedded
 * pages, form destinations, page settings, and SVG animation.
 */
export const CanvasHtmlImportDropKind = Schema.Literals([
  "script-file",
  "stylesheet",
  "file",
  "link",
  "embedded-document",
  "form-target",
  "page-setting",
  "svg-animation",
]);
export type CanvasHtmlImportDropKind = typeof CanvasHtmlImportDropKind.Type;

export const CANVAS_HTML_IMPORT_DROP_EXAMPLES = 3;
export const CANVAS_HTML_IMPORT_DROP_EXAMPLE_MAX_CHARS = 120;

export const CanvasHtmlImportDrop = Schema.Struct({
  kind: CanvasHtmlImportDropKind,
  count: PositiveInt,
  /** A few of the addresses or names taken out, cut short; shown as text, never as markup. */
  examples: Schema.Array(boundedNonEmptyText(CANVAS_HTML_IMPORT_DROP_EXAMPLE_MAX_CHARS)).check(
    Schema.isMaxLength(CANVAS_HTML_IMPORT_DROP_EXAMPLES),
  ),
});
export type CanvasHtmlImportDrop = typeof CanvasHtmlImportDrop.Type;

/**
 * `static`: the page holds no script and is drawn in a frame that runs
 * nothing. `running`: it holds inline script or event handlers and is a
 * design that runs script, under the same page, sandbox, and bridge as any
 * running design.
 */
export const CanvasHtmlImportFrame = Schema.Literals(["static", "running"]);
export type CanvasHtmlImportFrame = typeof CanvasHtmlImportFrame.Type;

export const CanvasHtmlImportResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("imported"),
    receipt: CanvasCreateReceipt,
    card: CanvasThreadReferenceCard,
    frame: CanvasHtmlImportFrame,
    dropped: Schema.Array(CanvasHtmlImportDrop),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: CanvasHtmlImportRefusalReason,
    message: boundedNonEmptyText(1_024),
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasCreateDenialCode,
    message: boundedNonEmptyText(1_024),
  }),
]);
export type CanvasHtmlImportResult = typeof CanvasHtmlImportResult.Type;

export const CanvasThreadReferenceCardsOutcome = Schema.Struct({
  mode: OctantMode,
  threadId: CanvasOriginThreadId,
  projectId: Schema.NullOr(ProjectId),
  cards: Schema.Array(CanvasThreadReferenceCard),
});
export type CanvasThreadReferenceCardsOutcome = typeof CanvasThreadReferenceCardsOutcome.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeCanvasCardSchemaVersion = Schema.decodeUnknownSync(
  CanvasCardSchemaVersion,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasCreateRequestId = Schema.decodeUnknownSync(
  CanvasCreateRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasCreateReceiptId = Schema.decodeUnknownSync(
  CanvasCreateReceiptId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasCardId = Schema.decodeUnknownSync(CanvasCardId, STRICT_DECODE_OPTIONS);
export const decodeCanvasOriginThreadId = Schema.decodeUnknownSync(
  CanvasOriginThreadId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasIntentKind = Schema.decodeUnknownSync(
  CanvasIntentKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasWorkspaceScope = Schema.decodeUnknownSync(
  CanvasWorkspaceScope,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasScope = Schema.decodeUnknownSync(CanvasScope, STRICT_DECODE_OPTIONS);
export const decodeCanvasCreateDenialCode = Schema.decodeUnknownSync(
  CanvasCreateDenialCode,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasCardStatus = Schema.decodeUnknownSync(
  CanvasCardStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasCreateRequest = Schema.decodeUnknownSync(
  CanvasCreateRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasCreateReceipt = Schema.decodeUnknownSync(
  CanvasCreateReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasCreateResult = Schema.decodeUnknownSync(
  CanvasCreateResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasThreadReferenceCard = Schema.decodeUnknownSync(
  CanvasThreadReferenceCard,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasHtmlImportRequest = Schema.decodeUnknownSync(
  CanvasHtmlImportRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasHtmlImportResult = Schema.decodeUnknownSync(
  CanvasHtmlImportResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasThreadReferenceCardsOutcome = Schema.decodeUnknownSync(
  CanvasThreadReferenceCardsOutcome,
  STRICT_DECODE_OPTIONS,
);
