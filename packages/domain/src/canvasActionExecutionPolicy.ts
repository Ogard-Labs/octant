import {
  decodeCanvasActionRequest,
  type CanvasActionApproval,
  type CanvasActionDenialCode,
  type CanvasActionOutcome,
  type CanvasActionReport,
  type CanvasActionRequest,
} from "@octant/contracts/canvas-actions";
import { type CanvasVersion } from "@octant/contracts/canvas";
import { type CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
import {
  classifyCanvasActionCommand,
  isAllowlistedCanvasCommand,
  type CanvasActionCapability,
} from "./canvasActionPolicy";
import { clampCanvasAuthority } from "./canvasCardsPolicy";

/**
 * Pure reauthorization and approval boundary for executing an admitted Canvas
 * action (D1) through ordinary Octant authority (D2). It mirrors the Canvas
 * refresh policy: a renderer cannot widen authority by editing a request field,
 * because every side effect is re-checked here against the immutable Canvas
 * provenance and the active server workspace before any command is dispatched.
 */
export class CanvasActionPolicyRejected extends Error {
  override readonly name = "CanvasActionPolicyRejected";

  constructor(
    readonly denialCode: CanvasActionDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CanvasActionDenialCode, message: string): never {
  throw new CanvasActionPolicyRejected(code, message);
}

function sameWorkspace(left: CanvasWorkspaceScope, right: CanvasWorkspaceScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface CanvasActionValidationContext {
  readonly mode: "chat" | "work" | "code";
  readonly projectId: string | null;
  readonly hostId?: string;
  readonly workspace?: CanvasWorkspaceScope;
}

/**
 * Reauthorize an action request against the immutable Canvas provenance and the
 * active workspace. A stale head, a mismatched host/mode/thread/project, or a
 * provider/model that is no longer authorized fails closed with a precise
 * denial code. Returns the decoded, reauthorized request; callers reauthorize
 * provider/credential state after this pure boundary.
 */
export function authorizeCanvasAction(input: {
  readonly request: unknown;
  readonly current: CanvasVersion;
  readonly context: CanvasActionValidationContext;
}): CanvasActionRequest {
  let request: CanvasActionRequest;
  try {
    request = decodeCanvasActionRequest(input.request);
  } catch {
    reject("malformed-request", "Canvas action request is malformed.");
  }
  // Defense in depth: the decoded command literal is already constrained by the
  // contract union, but re-assert allowlist membership so the domain set stays
  // the authoritative enforcement boundary.
  if (!isAllowlistedCanvasCommand(request.block.command.command)) {
    reject(
      "unknown-command",
      `Canvas command '${request.block.command.command}' is not on the Octant allowlist.`,
    );
  }
  const provenance = input.current.definition.provenance;
  if (String(request.canvasId) !== String(input.current.canvasId)) {
    reject("scope-mismatch", "Canvas action does not match the Canvas.");
  }
  if (request.expectedSequence !== input.current.sequence) {
    reject("stale-version", "Canvas action expected sequence is stale.");
  }
  if (request.hostId !== provenance.hostId) {
    reject("scope-mismatch", "Canvas action host does not match the Canvas.");
  }
  if (input.context.hostId !== undefined && request.hostId !== input.context.hostId) {
    reject("scope-mismatch", "Canvas action host does not match the active host.");
  }
  if (request.mode !== provenance.mode) {
    reject("mode-mismatch", "Canvas action mode does not match the Canvas.");
  }
  if (input.context.mode !== request.mode) {
    reject("mode-mismatch", "Canvas action mode does not match the active workspace.");
  }
  if (String(request.originThreadId) !== String(provenance.threadId)) {
    reject("origin-thread-mismatch", "Canvas action thread does not match the Canvas.");
  }
  if (String(input.context.projectId ?? "") !== String(provenance.projectId ?? "")) {
    reject("scope-mismatch", "Canvas action Project does not match the active workspace.");
  }
  if (
    input.context.workspace !== undefined &&
    !sameWorkspace(request.workspace, input.context.workspace)
  ) {
    reject("scope-mismatch", "Canvas action workspace does not match the active server scope.");
  }
  if (String(request.providerInstanceId) !== String(provenance.providerInstanceId)) {
    reject("unauthorized", "Canvas action provider is no longer authorized.");
  }
  if (request.modelId !== provenance.modelId) {
    reject("unauthorized", "Canvas action model is no longer authorized.");
  }
  try {
    clampCanvasAuthority({
      requestedAuthority: request.requestedAuthority,
      scope: request.workspace,
    });
  } catch (error) {
    reject(
      "unauthorized",
      error instanceof Error ? error.message : "Canvas action authority is invalid.",
    );
  }
  return request;
}

/** Classify the reauthorized command back into its capability report. */
export function reportCanvasActionCapability(request: CanvasActionRequest): CanvasActionCapability {
  return classifyCanvasActionCommand(request.block.command);
}

/**
 * Approval gate. A command that creates a user-visible thread must arrive
 * explicitly approved; any command the user explicitly denied fails closed.
 * Read-only, non-approval commands proceed. This is a pure boundary the server
 * evaluates before any mutating dispatch.
 */
export function evaluateCanvasActionApproval(
  capability: CanvasActionCapability,
  approval: CanvasActionApproval,
): void {
  if (approval.kind === "denied") {
    reject("approval-denied", "The Canvas action was explicitly denied.");
  }
  if (capability.requiresApproval && approval.kind !== "approved") {
    reject(
      "approval-required",
      "This Canvas action creates a new thread and requires explicit approval.",
    );
  }
}

export interface CanvasActionPlan {
  readonly outcome: Extract<CanvasActionOutcome, "completed" | "requested">;
  readonly report: CanvasActionReport;
}

/**
 * The honest, representative effect an executed command produces. Read commands
 * resolve to an already-authorized navigation/selection. `request-refresh` and
 * `propose-thread` are handed off to their own subsystems and reported as
 * `requested`, never as a faked completion.
 */
export function planCanvasActionEffect(request: CanvasActionRequest): CanvasActionPlan {
  const command = request.block.command;
  switch (command.command) {
    case "canvas.open-source":
      return {
        outcome: "completed",
        report: { kind: "source-opened", sourceId: command.sourceId },
      };
    case "canvas.open-thread":
      return { outcome: "completed", report: { kind: "opened", reference: command.threadRef } };
    case "canvas.open-pull-request":
      return {
        outcome: "completed",
        report: { kind: "opened", reference: command.pullRequestRef },
      };
    case "canvas.filter-data":
      return {
        outcome: "completed",
        report: {
          kind: "data-filtered",
          target: command.target,
          filterCount: command.filters.length,
        },
      };
    case "canvas.attach-selection":
      return {
        outcome: "completed",
        report: { kind: "selection-attached", selectionCount: command.selection.length },
      };
    case "canvas.request-refresh":
      return {
        outcome: "requested",
        report: { kind: "refresh-requested", canvasId: request.canvasId },
      };
    case "canvas.propose-thread": {
      if (request.approval.kind !== "approved") {
        // Unreachable once the approval gate has run; fail closed if reached.
        reject(
          "approval-required",
          "A thread proposal cannot be planned without an approval decision.",
        );
      }
      return {
        outcome: "requested",
        report: { kind: "thread-proposed", approvalId: request.approval.approvalId },
      };
    }
  }
}

export interface CanvasActionOperationIdentity {
  readonly canvasId: string;
  readonly blockId: string;
}

/**
 * Structural identity for cancellation and idempotency correlation. A
 * cancellation or a duplicate request must name the same Canvas and action
 * block as the recorded operation, so a renderer cannot cancel or replay an
 * unrelated action by reusing a request id.
 */
export function sameCanvasActionIdentity(
  left: CanvasActionOperationIdentity,
  right: CanvasActionOperationIdentity,
): boolean {
  return left.canvasId === right.canvasId && left.blockId === right.blockId;
}
