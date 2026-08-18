import {
  decodeCanvasCreateDenialCode,
  decodeCanvasCreateReceipt,
  decodeCanvasCreateReceiptId,
  decodeCanvasCreateRequest,
  decodeCanvasThreadReferenceCard,
  decodeCanvasOriginThreadId,
  type CanvasCreateRequest,
  type CanvasCreateDenialCode,
  type CanvasCreateReceipt,
  type CanvasThreadReferenceCard,
  type CanvasWorkspaceScope,
} from "@octant/contracts/canvas-cards";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlockId,
  decodeCanvasId,
  decodeCanvasVersion,
  decodeCanvasVersionId,
  type CanvasActor,
  type CanvasBlock,
  type CanvasId,
  type CanvasVersion,
  type CanvasVersionId,
} from "@octant/contracts/canvas";
import type { AgentRunAuthority } from "@octant/contracts/agent-run";
import type { UtcTimestamp } from "@octant/contracts/events";
import type { ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";

export class CanvasCardsPolicyRejected extends Error {
  override readonly name = "CanvasCardsPolicyRejected";

  constructor(
    readonly denialCode: CanvasCreateDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(denialCode: CanvasCreateDenialCode, message: string): never {
  throw new CanvasCardsPolicyRejected(denialCode, message);
}

function decodeOrReject<T>(
  decode: (input: unknown) => T,
  input: unknown,
  denialCode: CanvasCreateDenialCode,
  message: string,
): T {
  try {
    return decode(input);
  } catch {
    return reject(denialCode, message);
  }
}

function scopeMode(scope: CanvasWorkspaceScope): "chat" | "work" | "code" {
  switch (scope.kind) {
    case "chat-virtual":
      return "chat";
    case "work-root":
      return "work";
    case "code-worktree":
      return "code";
  }
}

function assertScopeMatchesMode(request: CanvasCreateRequest): void {
  if (scopeMode(request.workspace) !== request.mode) {
    reject("mode-mismatch", "Canvas workspace scope does not match the requested mode.");
  }
}

function assertOriginThreadValid(request: CanvasCreateRequest): void {
  try {
    decodeCanvasOriginThreadId(request.originThreadId);
  } catch {
    reject(
      "origin-thread-mismatch",
      "Canvas origin thread is not a valid mode-specific thread identity.",
    );
  }
}

// A Canvas never changes host, mode, Project, root, or thread authority
// implicitly. Each mode enforces its hard authority boundary from the Canvas
// artifacts design before a create receipt can be admitted.
export function clampCanvasAuthority(input: {
  readonly requestedAuthority: AgentRunAuthority;
  readonly scope: CanvasWorkspaceScope;
}): AgentRunAuthority {
  const authority = input.requestedAuthority;
  const workspace = input.scope;
  if (
    workspace.kind === "chat-virtual" &&
    (authority.filesystem || authority.shell || authority.git)
  ) {
    reject(
      "chat-implicit-authority",
      "Chat Canvases cannot receive implicit filesystem, shell, or Git authority.",
    );
  }
  if (workspace.kind === "work-root" && (authority.shell || authority.git)) {
    reject(
      "work-implicit-authority",
      "Work Canvases cannot receive implicit shell or Git authority outside the confined root.",
    );
  }
  if (workspace.kind === "code-worktree" && workspace.verified !== true) {
    reject(
      "code-worktree-unverified",
      "A Code Canvas requires a verified worktree before admission.",
    );
  }
  return authority;
}

export function canvasCreateDenialReason(input: unknown): CanvasCreateDenialCode | null {
  let request: CanvasCreateRequest;
  try {
    request = decodeOrReject(
      decodeCanvasCreateRequest,
      input,
      "malformed-request",
      "Canvas create request is malformed.",
    );
  } catch (error) {
    if (error instanceof CanvasCardsPolicyRejected) return error.denialCode;
    return "malformed-request";
  }
  try {
    assertScopeMatchesMode(request);
    assertOriginThreadValid(request);
    clampCanvasAuthority({
      requestedAuthority: request.requestedAuthority,
      scope: request.workspace,
    });
  } catch (error) {
    if (error instanceof CanvasCardsPolicyRejected) return error.denialCode;
    return "malformed-request";
  }
  return null;
}

export function validateCanvasThreadReferenceCard(input: unknown): CanvasThreadReferenceCard {
  const card = decodeOrReject(
    decodeCanvasThreadReferenceCard,
    input,
    "malformed-request",
    "Canvas thread reference card is malformed.",
  );
  const scope = card.scope;
  if (scopeMode(scope.workspace) !== scope.mode) {
    reject("mode-mismatch", "Canvas reference card scope does not match its recorded mode.");
  }
  clampCanvasAuthority({ requestedAuthority: card.authority, scope: scope.workspace });
  try {
    decodeCanvasOriginThreadId(card.originThreadId);
  } catch {
    reject("origin-thread-mismatch", "Canvas reference card origin thread is invalid.");
  }
  return card;
}

export const validateCanvasCreateDenialCode = decodeCanvasCreateDenialCode;

export interface CanvasCreateActiveContext {
  readonly mode: "chat" | "work" | "code";
  readonly projectId: string | null;
  readonly hostId?: string;
  readonly workspace?: CanvasWorkspaceScope;
  readonly originThreadId?: string;
}

/**
 * Check the request against the server's active mode, Project, workspace, and
 * thread binding before any Canvas identity or journal side effect is created.
 */
export function authorizeCanvasCreateRequest(input: {
  readonly request: unknown;
  readonly activeContext: CanvasCreateActiveContext;
}): CanvasCreateRequest {
  const request = decodeOrReject(
    decodeCanvasCreateRequest,
    input.request,
    "malformed-request",
    "Canvas create request is malformed.",
  );
  assertScopeMatchesMode(request);
  assertOriginThreadValid(request);
  if (request.mode !== input.activeContext.mode) {
    reject("mode-mismatch", "Canvas create mode does not match the active workspace.");
  }
  const requestProjectId = request.workspace.projectId;
  if (String(requestProjectId ?? "") !== String(input.activeContext.projectId ?? "")) {
    reject("scope-mismatch", "Canvas create Project does not match the active workspace.");
  }
  if (input.activeContext.hostId !== undefined && request.hostId !== input.activeContext.hostId) {
    reject("scope-mismatch", "Canvas create host does not match the active workspace.");
  }
  if (
    input.activeContext.originThreadId !== undefined &&
    String(request.originThreadId) !== input.activeContext.originThreadId
  ) {
    reject("origin-thread-mismatch", "Canvas create thread does not match the active thread.");
  }
  if (
    input.activeContext.workspace !== undefined &&
    JSON.stringify(request.workspace) !== JSON.stringify(input.activeContext.workspace)
  ) {
    reject("scope-mismatch", "Canvas create workspace does not match the active workspace.");
  }
  clampCanvasAuthority({
    requestedAuthority: request.requestedAuthority,
    scope: request.workspace,
  });
  return request;
}

export interface AdmitCanvasCreateInput {
  readonly request: unknown;
  readonly receiptId: unknown;
  readonly canvasId: unknown;
  readonly versionId: unknown;
  readonly now: UtcTimestamp;
}

export type AdmitCanvasCreateResult = {
  readonly kind: "accepted";
  readonly receipt: CanvasCreateReceipt;
};

export function admitCanvasCreate(input: AdmitCanvasCreateInput): AdmitCanvasCreateResult {
  const request = decodeOrReject(
    decodeCanvasCreateRequest,
    input.request,
    "malformed-request",
    "Canvas create request is malformed.",
  );
  assertScopeMatchesMode(request);
  assertOriginThreadValid(request);
  const receiptId = decodeOrReject(
    decodeCanvasCreateReceiptId,
    input.receiptId,
    "malformed-request",
    "Canvas create receipt ID is invalid.",
  );
  const canvasId = decodeOrReject(
    decodeCanvasId,
    input.canvasId,
    "malformed-request",
    "Canvas identity is invalid.",
  );
  const versionId = decodeOrReject(
    decodeCanvasVersionId,
    input.versionId,
    "malformed-request",
    "Canvas version identity is invalid.",
  );

  const effectiveAuthority = clampCanvasAuthority({
    requestedAuthority: request.requestedAuthority,
    scope: request.workspace,
  });

  const receipt: CanvasCreateReceipt = {
    schemaVersion: request.schemaVersion,
    kind: "canvas-create-receipt",
    receiptId,
    requestId: request.requestId,
    canvasId,
    versionId,
    intent: request.intent,
    originThreadId: request.originThreadId,
    scope: {
      hostId: request.hostId,
      mode: request.mode,
      workspace: request.workspace,
    },
    title: request.title,
    effectiveAuthority,
    outcome: "ready",
    createdAt: input.now,
  };
  decodeOrReject(
    decodeCanvasCreateReceipt as (input: unknown) => CanvasCreateReceipt,
    receipt,
    "malformed-request",
    "Canvas create receipt could not be constructed.",
  );
  return { kind: "accepted", receipt };
}

export interface BuildCreateVersionInput {
  readonly request: CanvasCreateRequest;
  readonly admitted: AdmitCanvasCreateResult;
  readonly canvasId: CanvasId;
  readonly versionId: CanvasVersionId;
  readonly projectId: ProjectId;
  readonly actor: CanvasActor;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly createdAt: UtcTimestamp;
  /**
   * The document an author wrote, when one did.
   *
   * A canvas opened from the shell has no author yet and starts as its title.
   * A canvas an agent wrote arrives with its blocks, and those blocks are the
   * document — the prompt that asked for it is provenance, not content, and is
   * never echoed back into the page as though it were.
   */
  readonly blocks?: ReadonlyArray<CanvasBlock>;
}

export function buildCreateVersion(input: BuildCreateVersionInput): CanvasVersion {
  const authored = input.blocks;
  if (input.request.intent === "prompt" && input.request.prompt === undefined) {
    reject("invalid-prompt", "Canvas prompt is required.");
  }
  const blocks: CanvasBlock[] =
    authored !== undefined && authored.length > 0
      ? [...authored]
      : [
          {
            blockId: decodeCanvasBlockId("create-heading"),
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "heading",
            level: 1,
            text: input.request.title,
          },
        ];
  const definition = {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title: input.request.title,
    provenance: {
      mode: input.request.mode,
      hostId: input.request.hostId,
      projectId: input.projectId,
      threadId: input.request.originThreadId,
      actor: input.actor,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
      createdAt: input.createdAt,
    },
    sourceManifest: input.request.sourceManifest,
    blocks,
  };
  const version = decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: input.canvasId,
    versionId: input.versionId,
    sequence: 1,
    definition,
    createdBy: input.actor,
    createdAt: input.createdAt,
  });
  if (String(input.admitted.receipt.canvasId) !== String(input.canvasId)) {
    reject("scope-mismatch", "Canvas create receipt does not match the version identity.");
  }
  if (String(input.admitted.receipt.versionId) !== String(input.versionId)) {
    reject("scope-mismatch", "Canvas create receipt does not match the version identity.");
  }
  return version;
}

export function projectThreadReferenceCardFromVersion(input: {
  readonly version: CanvasVersion;
  readonly cardId: unknown;
  readonly authority: AgentRunAuthority;
  readonly request?: CanvasCreateRequest;
}): CanvasThreadReferenceCard {
  const version = decodeCanvasVersion(input.version);
  const provenance = version.definition.provenance;
  const workspace =
    input.request?.workspace ??
    (provenance.mode === "chat"
      ? { kind: "chat-virtual" as const, projectId: provenance.projectId }
      : provenance.mode === "work"
        ? {
            kind: "work-root" as const,
            projectId: provenance.projectId,
            rootId: provenance.threadId,
          }
        : {
            kind: "code-worktree" as const,
            projectId: provenance.projectId,
            repositoryId: `repo_${"0".repeat(64)}` as never,
            bindingRevisionId: "00000000-0000-4000-8000-000000000001" as never,
            checkoutId: provenance.threadId,
            verified: true,
          });
  const card = {
    schemaVersion: 1 as const,
    kind: "canvas-reference-card" as const,
    cardId: input.cardId,
    canvasId: version.canvasId,
    versionId: version.versionId,
    title: version.definition.title,
    scope: {
      hostId: provenance.hostId,
      mode: provenance.mode,
      workspace,
    },
    originThreadId: provenance.threadId,
    status: "ready" as const,
    authority: input.authority,
    actorId: provenance.actor.actorId,
    providerInstanceId: provenance.providerInstanceId,
    modelId: provenance.modelId,
    createdAt: version.createdAt,
    ...(version.definition.blocks[1]?.kind === "callout"
      ? { summary: version.definition.blocks[1].text }
      : {}),
    actionCount: 0,
  };
  return validateCanvasThreadReferenceCard(card);
}
