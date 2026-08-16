import type { CanvasClient } from "@octant/client-runtime";
import type { CanvasId } from "@octant/contracts/canvas";
import {
  type CanvasActionApproval,
  type CanvasActionBlock,
  type CanvasActionCancelRequest,
  type CanvasActionRequest,
  type CanvasActionRequestId,
  type CanvasActionResult,
} from "@octant/contracts/canvas-actions";
import type { CanvasOriginThreadId, CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
import type { AgentRunAuthority } from "@octant/contracts/agent-run";
import type { HostId } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import {
  evaluateCanvasActionAvailability,
  type CanvasActionAvailability,
} from "@octant/domain/canvas-action-availability-policy";
import type { CanvasActor } from "@octant/contracts/canvas";

/**
 * Host-owned context needed to build a reauthorizable action request. Every
 * field is provenance the renderer merely forwards; the server re-checks all of
 * it before any side effect, so the renderer widens no authority by holding it.
 */
export interface CanvasActionRequestContext {
  readonly canvasId: CanvasId;
  readonly expectedSequence: number;
  readonly hostId: HostId;
  readonly mode: OctantMode;
  readonly workspace: CanvasWorkspaceScope;
  readonly originThreadId: CanvasOriginThreadId;
  readonly actor: CanvasActor;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly requestedAuthority: AgentRunAuthority;
  /** Host verdicts surfaced by the availability policy (default: authorized). */
  readonly authorized?: boolean;
  readonly available?: boolean;
  /** Mint a request id; defaults to `crypto.randomUUID`. Injectable for tests. */
  readonly newRequestId?: () => CanvasActionRequestId;
}

function requestIdFor(context: CanvasActionRequestContext): CanvasActionRequestId {
  if (context.newRequestId !== undefined) return context.newRequestId();
  return crypto.randomUUID() as CanvasActionRequestId;
}

/**
 * The approval the renderer forwards. A mutating command that creates a new
 * user-visible thread must arrive already approved by the host; read-only
 * commands are `not-required`. The renderer never mints an approval decision.
 */
function approvalFor(
  block: CanvasActionBlock,
  approval: CanvasActionApproval | undefined,
): CanvasActionApproval {
  if (approval !== undefined) return approval;
  return block.command.command === "canvas.propose-thread"
    ? { kind: "pending" }
    : { kind: "not-required" };
}

export function buildCanvasActionRequest(
  block: CanvasActionBlock,
  context: CanvasActionRequestContext,
  approval?: CanvasActionApproval,
): CanvasActionRequest {
  return {
    schemaVersion: 1,
    kind: "canvas-action",
    requestId: requestIdFor(context),
    canvasId: context.canvasId,
    block,
    expectedSequence: context.expectedSequence,
    hostId: context.hostId,
    mode: context.mode,
    workspace: context.workspace,
    originThreadId: context.originThreadId,
    actor: context.actor,
    providerInstanceId: context.providerInstanceId,
    modelId: context.modelId,
    requestedAuthority: context.requestedAuthority,
    approval: approvalFor(block, approval),
  } as CanvasActionRequest;
}

function buildCancelRequest(
  block: CanvasActionBlock,
  context: CanvasActionRequestContext,
  requestId: CanvasActionRequestId,
): CanvasActionCancelRequest {
  return {
    schemaVersion: 1,
    kind: "canvas-action-cancel",
    requestId,
    canvasId: context.canvasId,
    blockId: block.blockId,
  } as CanvasActionCancelRequest;
}

export interface CanvasActionRuntime {
  readonly availability: (block: CanvasActionBlock) => CanvasActionAvailability;
  readonly onExecute: (block: CanvasActionBlock) => Promise<CanvasActionResult>;
  readonly onCancel?: (block: CanvasActionBlock) => Promise<CanvasActionResult>;
}

/**
 * Wire a {@link CanvasClient} to the accessible action panel. The returned
 * `availability` verdict fails closed to unavailable when the transport lacks
 * `executeAction`; `onCancel` is only exposed when the transport supports it,
 * so the panel never offers a control the host cannot honor.
 */
export function createCanvasActionRuntime(
  client: Pick<CanvasClient, "executeAction" | "cancelAction">,
  context: CanvasActionRequestContext,
): CanvasActionRuntime {
  const canExecuteActions = typeof client.executeAction === "function";
  // Correlate a cancellation with the request id the execute used, so a cancel
  // can never target an unrelated in-flight operation.
  const requestIds = new Map<string, CanvasActionRequestId>();

  const availability: CanvasActionRuntime["availability"] = (block) =>
    evaluateCanvasActionAvailability(block, {
      mode: context.mode,
      canExecuteActions,
      ...(context.authorized === undefined ? {} : { authorized: context.authorized }),
      ...(context.available === undefined ? {} : { available: context.available }),
    });

  const onExecute: CanvasActionRuntime["onExecute"] = async (block) => {
    if (client.executeAction === undefined) {
      return { kind: "denied", denialCode: "unavailable", message: "Actions are unavailable." };
    }
    const request = buildCanvasActionRequest(block, context);
    requestIds.set(String(block.blockId), request.requestId);
    return client.executeAction(request);
  };

  if (typeof client.cancelAction !== "function") {
    return { availability, onExecute };
  }

  const cancelAction = client.cancelAction;
  const onCancel: NonNullable<CanvasActionRuntime["onCancel"]> = async (block) => {
    const requestId = requestIds.get(String(block.blockId));
    if (requestId === undefined) {
      return { kind: "denied", denialCode: "cancelled", message: "Nothing to cancel." };
    }
    return cancelAction(buildCancelRequest(block, context, requestId));
  };

  return { availability, onExecute, onCancel };
}
