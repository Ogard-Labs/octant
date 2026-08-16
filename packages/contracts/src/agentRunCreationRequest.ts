import { Schema } from "effect";
import {
  AgentRunAuthority,
  AgentRunId,
  AgentRunParentThreadId,
  AgentRunRequestId,
  AgentRunRole,
} from "./agentRun";
import { WorktreeReceiptId } from "./code";
import { OctantMode } from "./modes";
import { MultiModelPool } from "./multiModelPool";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Workspace target for an explicit one-off child creation request.
 *
 * - Chat virtual scratch is accepted as a client-declared kind (no filesystem).
 * - Code children supply only a managed worktree receipt id; the server
 *   resolves and verifies isolation before admission. Clients cannot claim
 *   `verified: true` or absolute worktree paths.
 * - Work Project/root children remain a follow-up (authoritative root
 *   resolution is not accepted from a client proposal).
 */
export const AgentRunCreationWorkspace = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("chat-virtual"),
    mode: Schema.Literal("chat"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-worktree"),
    mode: Schema.Literal("code"),
    worktreeReceiptId: WorktreeReceiptId,
  }).annotations(strict),
);
export type AgentRunCreationWorkspace = typeof AgentRunCreationWorkspace.Type;

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
      if (request.mode === "code") {
        return request.workspace.kind === "code-worktree" && request.workspace.mode === "code";
      }
      // Work child creation is not admitted in this slice.
      return false;
    }),
  );
export type AgentRunCreationRequest = typeof AgentRunCreationRequest.Type;

export const decodeAgentRunCreationRequest = Schema.decodeUnknownSync(AgentRunCreationRequest);
