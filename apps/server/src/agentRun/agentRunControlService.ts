import {
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AgentRunAuthority,
  type AgentRunControlPreviewResult,
  type AgentRunControlRequest,
  type AgentRunControlResolvedFacts,
  type AgentRunCreationRequest,
  type AgentRunCreationWorkspace,
  type AgentRunRole,
  type AgentRunWorkspaceHandle,
  type AgentRunWorkspaceReceipt,
  type AgentRunWorkspaceRefusalReason,
  type OctantMode,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import {
  assertAgentRunRoleAllowedForMode,
  allowedAgentRunRolesForMode,
  deriveAgentRunRequestedAuthority,
  selectAgentRunExecutionKind,
  AgentRunPolicyRejected,
  type AgentRunExecutionSelection,
  type AgentRunNativeCapabilityEvidence,
} from "@octant/domain/agent-run-control-policy";
import type { AgentRunWorkspaceParentFacts } from "@octant/domain/agent-run-workspace-policy";
import {
  buildAgentRunRequestCommand,
  type AgentRunParentContextPort,
  type AgentRunPoolRoutingContext,
  type ProviderReadinessPort,
} from "./agentRunCreationService";
import type { AgentRunCodeWorkspaceContext } from "./agentRunWorkspaceService";

export interface AgentRunParentRouteFacts {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly reasoning?: string;
  readonly projectId?: string;
}

export interface AgentRunControlParentFacts {
  readonly parentMode: OctantMode;
  readonly parentAuthority: AgentRunAuthority;
  readonly liveAuthority: AgentRunAuthority;
  readonly workspaceParent: AgentRunWorkspaceParentFacts;
  readonly parentRoute: AgentRunParentRouteFacts;
  readonly codeWorkspace?: AgentRunCodeWorkspaceContext;
}

export interface AgentRunControlWorkspacePort {
  readonly prepare: (input: {
    readonly windowId: string;
    readonly parent: AgentRunWorkspaceParentFacts;
    readonly code?: AgentRunCodeWorkspaceContext;
  }) => Promise<
    | { readonly status: "prepared"; readonly workspace: AgentRunWorkspaceHandle }
    | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason }
  >;
  readonly confirm: (input: {
    readonly windowId: string;
    readonly parent: AgentRunWorkspaceParentFacts;
    readonly worktreeReceiptId: string;
  }) => Promise<
    | { readonly status: "confirmed"; readonly workspace: AgentRunWorkspaceHandle }
    | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason }
  >;
  readonly admit: (input: {
    readonly windowId: string;
    readonly requested: AgentRunCreationWorkspace;
    readonly role: AgentRunRole;
    readonly parent: AgentRunWorkspaceParentFacts;
  }) => Promise<
    | { readonly status: "admitted"; readonly workspace: AgentRunWorkspaceReceipt }
    | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason }
  >;
}

export class AgentRunControlRefused extends Error {
  override readonly name = "AgentRunControlRefused";
  constructor(
    readonly reason: AgentRunWorkspaceRefusalReason,
    message: string,
  ) {
    super(message);
  }
}

function workspaceKindFor(
  mode: OctantMode,
  role: AgentRunRole,
): AgentRunControlResolvedFacts["workspaceKind"] {
  if (mode === "chat") return "chat-virtual";
  if (mode === "work") return "work-root";
  if (role !== "implementation" && role !== "review") {
    throw new AgentRunControlRefused(
      "unsupported",
      "Code children are limited to implementation or review roles.",
    );
  }
  return "code-worktree";
}

function handleToRequestedWorkspace(handle: AgentRunWorkspaceHandle): AgentRunCreationWorkspace {
  if (handle.kind === "chat-virtual") {
    return { kind: "chat-virtual", mode: "chat", receiptId: handle.receiptId };
  }
  if (handle.kind === "work-root") {
    return { kind: "work-root", mode: "work", receiptId: handle.receiptId };
  }
  return {
    kind: "code-worktree",
    mode: "code",
    worktreeReceiptId: handle.worktreeReceiptId,
  };
}

/**
 * Derive the read-only facts a creation surface may show. The client never
 * supplies provider, model, workspace, or authority.
 */
export function resolveAgentRunControlFacts(input: {
  readonly parent: AgentRunControlParentFacts;
  readonly role?: AgentRunRole;
  readonly creationPosture: AgentRunControlResolvedFacts["creationPosture"];
  readonly nativeEvidence: AgentRunNativeCapabilityEvidence;
}): AgentRunControlResolvedFacts {
  const mode = input.parent.parentMode;
  if (input.role !== undefined) {
    try {
      assertAgentRunRoleAllowedForMode(mode, input.role);
    } catch (error) {
      if (error instanceof AgentRunPolicyRejected) {
        throw new AgentRunControlRefused("unsupported", error.message);
      }
      throw error;
    }
  }
  const role = input.role ?? allowedAgentRunRolesForMode(mode)[0];
  if (role === undefined) {
    throw new AgentRunControlRefused("unsupported", "This parent mode has no valid child role.");
  }
  let authority: AgentRunAuthority;
  try {
    authority = deriveAgentRunRequestedAuthority({
      mode,
      liveParentGrant: input.parent.liveAuthority,
    });
  } catch (error) {
    if (error instanceof AgentRunPolicyRejected) {
      throw new AgentRunControlRefused("wider-than-parent", error.message);
    }
    throw error;
  }
  const execution = selectAgentRunExecutionKind(input.nativeEvidence);
  const route = input.parent.parentRoute;
  return {
    mode,
    ...(route.projectId === undefined ? {} : { projectId: decodeProjectId(route.projectId) }),
    allowedRoles: [...allowedAgentRunRolesForMode(mode)],
    providerInstanceId: route.providerInstanceId,
    modelId: route.modelId,
    ...(route.reasoning === undefined ? {} : { reasoning: route.reasoning }),
    workspaceKind: workspaceKindFor(mode, role),
    authority,
    executionKind: execution.selectedExecutionKind,
    attemptedExecutionKind: execution.attemptedExecutionKind,
    ...(execution.nativeFallbackReason === undefined
      ? {}
      : { nativeFallbackReason: execution.nativeFallbackReason }),
    capabilityDegradations: [...execution.capabilityDegradations],
    creationPosture: input.creationPosture,
  };
}

export function previewAgentRunControl(input: {
  readonly parent: AgentRunControlParentFacts;
  readonly role?: AgentRunRole;
  readonly creationPosture: AgentRunControlResolvedFacts["creationPosture"];
  readonly nativeEvidence: AgentRunNativeCapabilityEvidence;
}): AgentRunControlPreviewResult {
  try {
    return { status: "ready", facts: resolveAgentRunControlFacts(input) };
  } catch (error) {
    if (error instanceof AgentRunControlRefused) {
      return { status: "refused", reason: error.reason };
    }
    throw error;
  }
}

export async function prepareAdmittedControlWorkspace(input: {
  readonly windowId: string;
  readonly parent: AgentRunControlParentFacts;
  readonly role: AgentRunRole;
  readonly workspace: AgentRunControlWorkspacePort;
}): Promise<
  | { readonly status: "admitted"; readonly workspace: AgentRunWorkspaceReceipt }
  | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason }
> {
  const prepared = await input.workspace.prepare({
    windowId: input.windowId,
    parent: input.parent.workspaceParent,
    ...(input.parent.codeWorkspace === undefined ? {} : { code: input.parent.codeWorkspace }),
  });
  if (prepared.status === "refused") return prepared;
  let handle = prepared.workspace;
  if (handle.kind === "code-worktree" && handle.confirmation !== "confirmed") {
    const confirmed = await input.workspace.confirm({
      windowId: input.windowId,
      parent: input.parent.workspaceParent,
      worktreeReceiptId: String(handle.worktreeReceiptId),
    });
    if (confirmed.status === "refused") return confirmed;
    handle = confirmed.workspace;
  }
  return input.workspace.admit({
    windowId: input.windowId,
    requested: handleToRequestedWorkspace(handle),
    role: input.role,
    parent: input.parent.workspaceParent,
  });
}

const PLACEHOLDER_RECEIPT_ID = "00000000-0000-4000-8000-000000000000";

export function requestWorkspaceFor(admitted: AgentRunWorkspaceReceipt): AgentRunCreationWorkspace {
  if (admitted.kind === "chat-virtual") {
    return { kind: "chat-virtual", mode: "chat" };
  }
  if (admitted.kind === "work-root") {
    return {
      kind: "work-root",
      mode: "work",
      receiptId: PLACEHOLDER_RECEIPT_ID as never,
    };
  }
  return {
    kind: "code-worktree",
    mode: "code",
    worktreeReceiptId: PLACEHOLDER_RECEIPT_ID as never,
  };
}

export function buildControlCreationRequest(input: {
  readonly control: AgentRunControlRequest;
  readonly facts: AgentRunControlResolvedFacts;
  readonly workspace: AgentRunCreationWorkspace;
}): AgentRunCreationRequest {
  return {
    requestId: input.control.requestId,
    parentThreadId: input.control.parentThreadId,
    ...(input.control.parentRunId === undefined ? {} : { parentRunId: input.control.parentRunId }),
    role: input.control.role,
    task: input.control.task,
    mode: input.facts.mode,
    providerInstanceId: decodeProviderInstanceId(String(input.facts.providerInstanceId)),
    modelId: decodeProviderModelId(String(input.facts.modelId)),
    ...(input.facts.reasoning === undefined ? {} : { reasoning: input.facts.reasoning }),
    requestedAuthority: input.facts.authority,
    workspace: input.workspace,
    ...(input.control.pool === undefined ? {} : { pool: input.control.pool }),
    ...(input.control.includeParentContext === true ? { includeParentContext: true } : {}),
  };
}

export function buildControlRequestCommand(input: {
  readonly control: AgentRunControlRequest;
  readonly parent: AgentRunControlParentFacts;
  readonly creationPosture: AgentRunControlResolvedFacts["creationPosture"];
  readonly nativeEvidence: AgentRunNativeCapabilityEvidence;
  readonly admittedWorkspace: AgentRunWorkspaceReceipt;
  readonly providerReadiness: ProviderReadinessPort;
  readonly uuid: () => string;
  readonly parentContext?: AgentRunParentContextPort;
  readonly poolRouting?: AgentRunPoolRoutingContext;
}): ReturnType<typeof buildAgentRunRequestCommand> {
  const facts = resolveAgentRunControlFacts({
    parent: input.parent,
    role: input.control.role,
    creationPosture: input.creationPosture,
    nativeEvidence: input.nativeEvidence,
  });
  const execution: AgentRunExecutionSelection = selectAgentRunExecutionKind(input.nativeEvidence);
  const request = buildControlCreationRequest({
    control: input.control,
    facts,
    workspace: requestWorkspaceFor(input.admittedWorkspace),
  });
  return buildAgentRunRequestCommand({
    request,
    creationPosture: input.creationPosture,
    providerReadiness: input.providerReadiness,
    uuid: input.uuid,
    admittedWorkspace: input.admittedWorkspace,
    executionSelection: execution,
    nativeEvidence: input.nativeEvidence,
    ...(input.parentContext === undefined ? {} : { parentContext: input.parentContext }),
    ...(input.poolRouting === undefined ? {} : { poolRouting: input.poolRouting }),
  });
}
