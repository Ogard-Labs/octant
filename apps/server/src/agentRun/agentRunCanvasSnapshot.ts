import {
  decodeAgentRunCanvasSnapshotResult,
  decodeCanvasCreateRequestId,
  decodeCanvasOriginThreadId,
  decodeProjectId,
  LOCAL_HOST_ID,
  type AgentRunCanvasSnapshotResult,
  type CanvasBlock,
  type CanvasWorkspaceScope,
  type OctantMode,
} from "@octant/contracts";
import { CANVAS_CARD_SCHEMA_VERSION } from "@octant/contracts/canvas-cards";

export interface AgentRunForestCanvasProject {
  readonly id: string;
  readonly type: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
}

export interface AgentRunForestCanvasCreateContext {
  readonly mode: "chat" | "work" | "code";
  readonly projectId: string | null;
  readonly hostId?: string;
  readonly workspace?: CanvasWorkspaceScope;
  readonly originThreadId?: string;
}

export interface CreateAgentRunForestCanvasSnapshotInput {
  readonly mode: OctantMode;
  readonly parentThreadId: string;
  readonly title: string;
  readonly blocks: ReadonlyArray<CanvasBlock>;
  readonly uuid: () => string;
  readonly resolveWorkspace: (input: {
    readonly mode: OctantMode;
    readonly threadId: string;
  }) => CanvasWorkspaceScope | undefined;
  readonly readProject: (projectId: string) => AgentRunForestCanvasProject | undefined;
  readonly readChatProjectId: (threadId: string) => string | undefined;
  readonly createCanvas: (
    request: unknown,
    context: AgentRunForestCanvasCreateContext,
    project: AgentRunForestCanvasProject,
    blocks: ReadonlyArray<CanvasBlock>,
  ) => {
    readonly kind: "accepted" | "denied";
    readonly message?: string;
    readonly card?: {
      readonly canvasId: unknown;
      readonly versionId: unknown;
      readonly title: string;
      readonly originThreadId: unknown;
      readonly scope: { readonly mode: OctantMode; readonly workspace: CanvasWorkspaceScope };
    };
  };
}

const DOCUMENT_AUTHORITY = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: false,
  subagents: false,
  executionPolicy: "plan" as const,
  permissionPersistence: "current-session" as const,
};

/**
 * Persist the forest as a Canvas document in the parent thread's own workspace.
 * Work/Code scope comes from the host resolver; Chat still needs the thread's
 * Project so the document can be opened from inventory.
 */
export function createAgentRunForestCanvasSnapshot(
  input: CreateAgentRunForestCanvasSnapshotInput,
): AgentRunCanvasSnapshotResult {
  if (input.blocks.length === 0) {
    return { kind: "denied", message: "This thread has no agent runs to save." };
  }
  const workspace = input.resolveWorkspace({
    mode: input.mode,
    threadId: input.parentThreadId,
  });
  if (workspace === undefined) {
    return { kind: "denied", message: "The thread's workspace is unavailable." };
  }

  const projectId = projectIdForSnapshot(workspace, input.parentThreadId, input.readChatProjectId);
  if (projectId === undefined) {
    return { kind: "denied", message: "The thread's Project is unavailable." };
  }
  const project = input.readProject(projectId);
  if (project === undefined || project.lifecycle !== "active" || project.type !== input.mode) {
    return { kind: "denied", message: "The thread's Project is unavailable." };
  }

  let originThreadId;
  try {
    originThreadId = decodeCanvasOriginThreadId(input.parentThreadId);
  } catch {
    return { kind: "denied", message: "The parent thread is not a valid Canvas origin." };
  }

  const contextProjectId = workspace.projectId === null ? null : String(workspace.projectId);
  const created = input.createCanvas(
    {
      schemaVersion: CANVAS_CARD_SCHEMA_VERSION,
      kind: "canvas-create",
      requestId: decodeCanvasCreateRequestId(input.uuid()),
      intent: "blank",
      hostId: LOCAL_HOST_ID,
      mode: input.mode,
      workspace,
      originThreadId,
      title: input.title,
      sourceManifest: [],
      requestedAuthority: DOCUMENT_AUTHORITY,
    },
    {
      mode: input.mode,
      projectId: contextProjectId,
      hostId: String(LOCAL_HOST_ID),
      workspace,
      originThreadId: String(originThreadId),
    },
    project,
    input.blocks,
  );
  if (created.kind !== "accepted" || created.card === undefined) {
    return {
      kind: "denied",
      message: created.message ?? "The host could not save this graph as a Canvas.",
    };
  }

  const openProjectId =
    created.card.scope.workspace.projectId === null ||
    created.card.scope.workspace.projectId === undefined
      ? decodeProjectId(project.id)
      : created.card.scope.workspace.projectId;

  return decodeAgentRunCanvasSnapshotResult({
    kind: "accepted",
    canvasId: created.card.canvasId,
    versionId: created.card.versionId,
    title: created.card.title,
    originThreadId: created.card.originThreadId,
    mode: created.card.scope.mode,
    projectId: openProjectId,
  });
}

function projectIdForSnapshot(
  workspace: CanvasWorkspaceScope,
  parentThreadId: string,
  readChatProjectId: (threadId: string) => string | undefined,
): string | undefined {
  if (workspace.projectId !== null && workspace.projectId !== undefined) {
    return String(workspace.projectId);
  }
  if (workspace.kind !== "chat-virtual") return undefined;
  return readChatProjectId(parentThreadId);
}
