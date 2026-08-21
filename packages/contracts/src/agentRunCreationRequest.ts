import { Schema } from "effect";
import {
  AgentRunAuthority,
  AgentRunId,
  AgentRunParentThreadId,
  AgentRunRequestId,
  AgentRunRole,
  AgentRunWorkspaceReceiptId,
  AgentRunWorkspaceRefusalReason,
} from "./agentRun";
import { WorktreeReceiptId } from "./code";
import { OctantMode } from "./modes";
import { MultiModelPool } from "./multiModelPool";
import { BindingRevisionId, ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Workspace target for an explicit one-off child creation request.
 *
 * Clients name a server-issued receipt only. They never supply absolute
 * paths or claim `verified: true`. Chat may omit a receipt when the host
 * synthesizes the research-only virtual workspace from the parent thread;
 * Work and Code always present the id returned by prepare (and, for Code,
 * confirm).
 */
export const AgentRunCreationWorkspace = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("chat-virtual"),
    mode: Schema.Literal("chat"),
    receiptId: Schema.optional(AgentRunWorkspaceReceiptId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("work-root"),
    mode: Schema.Literal("work"),
    receiptId: AgentRunWorkspaceReceiptId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-worktree"),
    mode: Schema.Literal("code"),
    worktreeReceiptId: WorktreeReceiptId,
  }).annotations(strict),
);
export type AgentRunCreationWorkspace = typeof AgentRunCreationWorkspace.Type;

/**
 * Renderer-facing handle for a prepared child workspace. Paths and
 * client-claimed verification are forbidden here; the server resolves them
 * at confirmation and admission.
 */
export const AgentRunWorkspaceHandle = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("chat-virtual"),
    mode: Schema.Literal("chat"),
    receiptId: AgentRunWorkspaceReceiptId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("work-root"),
    mode: Schema.Literal("work"),
    receiptId: AgentRunWorkspaceReceiptId,
    projectId: ProjectId,
    bindingRevisionId: BindingRevisionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-worktree"),
    mode: Schema.Literal("code"),
    worktreeReceiptId: WorktreeReceiptId,
    confirmation: Schema.Literal("prepared", "confirmed"),
  }).annotations(strict),
);
export type AgentRunWorkspaceHandle = typeof AgentRunWorkspaceHandle.Type;

export const AgentRunWorkspacePreparationRequest = Schema.Struct({
  parentThreadId: AgentRunParentThreadId,
}).annotations(strict);
export type AgentRunWorkspacePreparationRequest = typeof AgentRunWorkspacePreparationRequest.Type;

export const AgentRunWorkspaceConfirmationRequest = Schema.Struct({
  parentThreadId: AgentRunParentThreadId,
  worktreeReceiptId: WorktreeReceiptId,
}).annotations(strict);
export type AgentRunWorkspaceConfirmationRequest = typeof AgentRunWorkspaceConfirmationRequest.Type;

export const AgentRunWorkspaceRefused = Schema.Struct({
  status: Schema.Literal("refused"),
  reason: AgentRunWorkspaceRefusalReason,
}).annotations(strict);
export type AgentRunWorkspaceRefused = typeof AgentRunWorkspaceRefused.Type;

export const AgentRunWorkspacePreparationResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("prepared"),
    workspace: AgentRunWorkspaceHandle,
  }).annotations(strict),
  AgentRunWorkspaceRefused,
);
export type AgentRunWorkspacePreparationResult = typeof AgentRunWorkspacePreparationResult.Type;

export const AgentRunWorkspaceConfirmationResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("confirmed"),
    workspace: AgentRunWorkspaceHandle,
  }).annotations(strict),
  AgentRunWorkspaceRefused,
);
export type AgentRunWorkspaceConfirmationResult = typeof AgentRunWorkspaceConfirmationResult.Type;

/**
 * Client-supplied facts for proposing a bounded child run. The server never
 * trusts `creationPosture`, capacity, authority ceilings, or routing-receipt
 * fields from a client: it re-resolves the effective posture from
 * `AgentRunPolicySettings`, derives the mode authority ceiling and live parent
 * grant itself, verifies Code worktree receipts server-side, and builds the
 * immutable `AgentRunRoutingReceipt` from these explicit, bounded facts rather
 * than accepting one pre-built by the caller.
 */
export const AgentRunCreationRequest = Schema.Struct({
  requestId: AgentRunRequestId,
  parentThreadId: AgentRunParentThreadId,
  parentRunId: Schema.optional(AgentRunId),
  role: AgentRunRole,
  task: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8192)),
  mode: OctantMode,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  reasoning: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  requestedAuthority: AgentRunAuthority,
  workspace: AgentRunCreationWorkspace,
  /**
   * Optional one-off multi-model pool selection for this child. The
   * server resolves exactly one immutable route from it before admission;
   * the request's provider/model above is the pool's requested candidate.
   */
  pool: Schema.optional(MultiModelPool),
  /**
   * Admit this child with the parent thread's own recent conversation.
   *
   * A child created from a thread usually continues that thread's question,
   * and without this it is admitted with nothing but its task. The client
   * asks; it never supplies the content. The server reads the parent thread it
   * already authorized for this creation, bounds the selection, and stores it
   * against that thread under the admission's snapshot id, so a child can never
   * be handed context its parent could not read, deleting the thread destroys
   * the selection taken from it, and a host that cannot resolve the selection
   * refuses the creation instead of admitting an empty one.
   */
  includeParentContext: Schema.optional(Schema.Boolean),
})
  .annotations(strict)
  .pipe(
    Schema.filter((request) => {
      if (request.mode === "chat") {
        return request.workspace.kind === "chat-virtual" && request.workspace.mode === "chat";
      }
      if (request.mode === "work") {
        return request.workspace.kind === "work-root" && request.workspace.mode === "work";
      }
      return request.workspace.kind === "code-worktree" && request.workspace.mode === "code";
    }),
  );
export type AgentRunCreationRequest = typeof AgentRunCreationRequest.Type;

export const decodeAgentRunCreationRequest = Schema.decodeUnknownSync(AgentRunCreationRequest);
export const decodeAgentRunWorkspaceHandle = Schema.decodeUnknownSync(AgentRunWorkspaceHandle);
export const decodeAgentRunWorkspacePreparationRequest = Schema.decodeUnknownSync(
  AgentRunWorkspacePreparationRequest,
);
export const decodeAgentRunWorkspaceConfirmationRequest = Schema.decodeUnknownSync(
  AgentRunWorkspaceConfirmationRequest,
);
export const decodeAgentRunWorkspacePreparationResult = Schema.decodeUnknownSync(
  AgentRunWorkspacePreparationResult,
);
export const decodeAgentRunWorkspaceConfirmationResult = Schema.decodeUnknownSync(
  AgentRunWorkspaceConfirmationResult,
);
